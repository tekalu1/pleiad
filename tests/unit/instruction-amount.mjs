// 指示の量（ADR 0056「① 量を見せる」、docs/design.md「指示の量」）。LLM は呼ばない
//   - 画面の数（自分で書いた分の出どころ・目安の何倍か・棒の全長）
//   - 探索の行の量（@参照の行と rules の frontmatter を除いた、渡す本文で数える）
//   - Pleiad が足した分の内訳（実際に渡した文だけ。バックエンドの渡し方で変わる）
//   - エージェント任せの指示の見積もり（そのエージェントの規則で探す。条件付きの rules は数えない）
//   - サーバー越し: 会話の記録に Pleiad が足した分が残る・目安の設定
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { instructionAmount, budgetOf, DEFAULT_BUDGET } from '../../web/instruction-amount.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { plyParts } from '../../core/instruction-amount.mjs';
import { scanContext } from '../../core/context-scan.mjs';
import { resolveRuntime, contextTools } from '../../core/context-runtime.mjs';
import { createContextSession } from '../../core/context-session.mjs';
import { DEFAULT_SCAN } from '../../core/context-settings.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'instruction-amount';
export const title = '指示の量: 自分で書いた分と Pleiad が足した分・目安・エージェント任せの見積もり';

export default async function (t) {
  // ---- 画面の数
  const rows = [{ scope: 'user', tokens: 4900 }, { scope: 'directory', tokens: 5000 }, { scope: 'directory', root: 'D:/extra', tokens: 2200 }];
  const a = instructionAmount({ rows, parts: [{ id: 'visualize', tokens: 1600 }, { id: 'skills', tokens: 2500 }], budget: 5000 });
  t.ok('自分で書いた分をユーザーとこの場所に分け、足した場所は足した段の側に数える', a.user === 4900 && a.dir === 7200 && a.own === 12100 && a.ply === 4100 && a.total === 16200, JSON.stringify(a));
  t.ok('目安は自分で書いた分にだけ当て、何倍かを小数 1 桁で出す', a.ratio === 2.4 && a.scale === 16200, String(a.ratio));
  const under = instructionAmount({ rows: [{ scope: 'user', tokens: 1000 }], parts: [{ id: 'agents', tokens: 9000 }], budget: 5000 });
  t.ok('Pleiad が足す分が多くても、自分で書いた分が目安の内なら知らせない', under.ratio === 0 && under.total === 10000);
  const small = instructionAmount({ rows: [{ scope: 'user', tokens: 300 }], parts: [], budget: 5000 });
  t.ok('合計が目安より小さいときは、棒の全長を目安に合わせる（線が棒の中に収まる）', small.scale === 5000);
  t.ok('わずかに超えたときも 1.0 倍とは言わない', instructionAmount({ rows: [{ scope: 'user', tokens: 5010 }], budget: 5000 }).ratio === 1.1);
  t.ok('目安の既定は 5,000、壊れた値は既定に戻す', budgetOf({}) === DEFAULT_BUDGET && DEFAULT_BUDGET === 5000 && budgetOf({ instructionBudget: 8000 }) === 8000
    && budgetOf({ instructionBudget: 5.5 }) === 5000 && budgetOf({ instructionBudget: 10 }) === 5000);

  // ---- Pleiad が足した分の内訳
  const context = { skills: 'Skills: - a', guide: 'guide text' };
  const added = [{ id: 'delegate', inserted: true, text: '委譲の進め方' }, { id: 'child', inserted: false, reason: 'target' }];
  const claudeLike = plyParts({ plyAgents: true, context, visualize: 'visualize '.repeat(40), browser: null, agents: 'agents text', added });
  t.ok('ply_agents を受け取るバックエンドは Visualize・委譲ツール・Pleiad の指示・案内・Skills を数え、渡さなかったブラウザーは載せない',
    claudeLike.map(p => p.id).join() === 'visualize,skills,agents,added,guide' && claudeLike.find(p => p.id === 'added').tokens === estimateTokens('委譲の進め方'), JSON.stringify(claudeLike));
  const agyLike = plyParts({ plyAgents: false, context, visualize: 'visualize', browser: 'browser', agents: 'agents text', added });
  t.ok('受け取らないバックエンド（antigravity）には Visualize と委譲ツールの説明を数えない', agyLike.map(p => p.id).join() === 'skills,added,guide,browser', JSON.stringify(agyLike));
  t.ok('何も渡していなければ空', plyParts({ plyAgents: true }).length === 0);

  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-instruction-amount-')));
  const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  let host, client;
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(home, '.claude', 'CLAUDE.md'), 'USER_CLAUDE '.repeat(20));
    await write(path.join(home, '.codex', 'AGENTS.md'), 'USER_CODEX '.repeat(10));
    await write(path.join(cwd, 'AGENTS.md'), 'ROOT_AGENTS '.repeat(30));
    await write(path.join(cwd, 'CLAUDE.md'), '@AGENTS.md\n日本語の注意書き');
    await write(path.join(cwd, '.claude', 'rules', 'always.md'), '---\ndescription: x\n---\nALWAYS_RULE');
    await write(path.join(cwd, '.claude', 'rules', 'scoped.md'), '---\npaths: ["src/**"]\n---\nSCOPED_RULE '.repeat(1) + 'x'.repeat(400));
    const scanOptions = { home, claudeHome: path.join(home, '.claude'), codexHome: path.join(home, '.codex') };

    // ---- 探索の行の量: 渡す本文で数える
    const plan = source => ({ user: { roots: [], kinds: { instruction: { sources: [source], excludePaths: [] }, skill: null, mcp: null } },
      directory: { roots: [], kinds: { instruction: { sources: [source], excludePaths: [] }, skill: null, mcp: null } }, mcp: { disabled: [], prefer: {} } });
    const scan = await scanContext({ cwd, plan: plan('claude') }, scanOptions);
    const find = name => scan.entries.find(e => e.kind === 'instruction' && e.name === name);
    t.ok('@参照の行は数えない（参照先は別の行で数える）', find('CLAUDE.md') && scan.entries.filter(e => e.name === 'CLAUDE.md').some(e => e.tokens === estimateTokens('日本語の注意書き')),
      JSON.stringify(scan.entries.map(e => [e.name, e.tokens])));
    t.ok('rules は frontmatter を除いた本文で数える', find('always.md')?.tokens === estimateTokens('ALWAYS_RULE'), String(find('always.md')?.tokens));

    // ---- Pleiad がそろえる会話の記録の行と、ply_context の内訳
    const policy = { version: 1, cwd, owners: { instruction: 'ply', skill: 'native', mcp: 'native' }, user: { ...DEFAULT_SCAN, sources: [] }, directory: { ...DEFAULT_SCAN, sources: ['common'] } };
    const runtime = await resolveRuntime(policy, { ...scanOptions, locale: 'ja' });
    const supplied = runtime.report.entries.find(e => e.kind === 'instruction' && e.status === 'supplied');
    t.ok('渡した指示の記録の行に量が付く', supplied?.tokens === estimateTokens('ROOT_AGENTS '.repeat(30)), JSON.stringify(supplied));
    const helpers = contextTools(runtime);
    t.ok('ply_context の内訳: 案内はファイルを包む文と子孫の指示の案内で、本文を含まない', helpers.sections.guide.includes(agentT('ja', 'context.prompt.descendants'))
      && helpers.sections.guide.includes(path.join(cwd, 'AGENTS.md')) && !helpers.sections.guide.includes('ROOT_AGENTS') && helpers.sections.skills === '', helpers.sections.guide.slice(0, 200));

    // ---- エージェント任せの指示の見積もり
    const session = createContextSession({ store: null, snapshots: null, scanOptions });
    const claude = await session.nativeInstructions(cwd, 'claude');
    const names = claude.entries.map(e => `${e.scope}:${e.name}`).sort().join();
    t.ok('Claude の規則で探す（CLAUDE.md・@参照先・rules。条件付きの rules は数えない）', names === 'directory:AGENTS.md,directory:CLAUDE.md,directory:always.md,user:CLAUDE.md', names);
    t.ok('見積もりの行にも同じ数え方の量が付く', claude.entries.find(e => e.name === 'always.md')?.tokens === estimateTokens('ALWAYS_RULE'));
    const codex = await session.nativeInstructions(cwd, 'codex');
    t.ok('Codex の規則で探す（AGENTS.md だけ）', codex.entries.map(e => `${e.scope}:${e.name}`).sort().join() === 'directory:AGENTS.md,user:AGENTS.md', JSON.stringify(codex.entries.map(e => e.path)));
    t.ok('読み方を知らないエージェントは数えない（entries: null）', (await session.nativeInstructions(cwd, 'antigravity')).entries === null);

    // ---- サーバー越し: 会話の記録と目安の設定
    host = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open(host);
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'instruction', value: { owner: 'ply', user: { sources: [], excludePaths: [] }, directory: { sources: ['common'], excludePaths: [] } } });
    const s = await client.cmd('newSession', { cwd, backend: 'fake' });
    const turn = await client.runTurn({ ...s, prompt: 'hello' }, { ms: 60_000 });
    const record = await client.cmd('sessionContext', s);
    const ids = (record?.plyParts ?? []).map(p => p.id).join();
    t.ok('会話の記録に Pleiad が足した分が残る（Visualize・委譲ツール・Pleiad の指示・案内。内蔵ブラウザーの無い会話にブラウザーの説明は数えない）',
      turn.outcome === 'ok' && ids === 'visualize,agents,added,guide' && record.plyParts.every(p => p.tokens > 0), ids);
    t.ok('渡した指示の行に量が付く', record.report.entries.find(e => e.kind === 'instruction' && e.status === 'supplied')?.tokens === estimateTokens('ROOT_AGENTS '.repeat(30)));
    const usage = turn.events.filter(e => e.type === 'contextUsage');
    t.ok('ターンの記録の知らせ（contextUsage）にも載る', usage.at(-1)?.plyParts?.map(p => p.id).join() === ids);
    const native = await client.cmd('nativeInstructions', { cwd, backend: 'antigravity' });
    t.ok('nativeInstructions は読むだけのコマンドとして届く', native.entries === null);

    let prefs = await client.cmd('setPref', { key: 'instructionBudget', value: 8000 });
    t.ok('目安を保存する', prefs.instructionBudget === 8000);
    const refused = async value => { try { await client.cmd('setPref', { key: 'instructionBudget', value }); return false; } catch { return true; } };
    t.ok('整数でない・範囲の外の目安は断る', await refused(5.5) && await refused(10) && await refused('9000'));
    prefs = await client.cmd('setPref', { key: 'instructionBudget', value: null });
    t.ok('null で既定に戻す（保存から消える）', !Object.hasOwn(prefs, 'instructionBudget'));
  } finally {
    client?.close();
    await host?.stop?.();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
