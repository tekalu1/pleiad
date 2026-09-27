// Hooks をサーバー越しに通す（fake バックエンド。LLM は呼ばない。ホームは使い捨ての場所へ向ける）。
//   - 設定の画面の探索（ユーザーだけ）・伏せ字・書き込み（dryRun の差分 → 書く）
//   - 会話の右パネル: その場所の定義と、受け取った発火の記録（画面へは流さず、会話に残す）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { containsPath } from '../../core/context-settings.mjs';
import { ROOT } from '../lib/server.mjs';

export const name = 'server-hooks';
export const title = 'Hooks の API: 探索・書き込み・会話の場所の定義と発火の記録';

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-hooks-')));
  const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo');
  const write = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v)); };
  let host, client;
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify --token SECRET-VALUE' }] }] } });
    await write(path.join(cwd, '.claude', 'settings.json'), { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo project' }] }] } });
    host = await startServer({ dataDir: path.join(tmp, 'data'), env: { AGENT_HOST_BACKENDS: 'fake', USERPROFILE: home, HOME: home,
      CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } });
    client = await open(host);

    const user = await client.cmd('scanHooks', { scope: 'user' });
    t.ok('設定の画面の探索はユーザーだけ（作業場所の定義を混ぜない）', user.entries.length === 1 && user.entries[0].event === 'Stop', JSON.stringify(user.entries.map(e => e.path)));
    t.ok('一覧の値は伏せ字', !JSON.stringify(user).includes('SECRET-VALUE'));
    const item = { op: 'add', agent: 'codex', scope: 'user', event: 'SessionStart', matcher: 'startup', command: 'echo hi' };
    const dry = await client.cmd('saveHooks', { items: [item], dryRun: true });
    t.ok('dryRun は書き先と差分だけ返す', dry.results[0].ok && dry.results[0].path === path.join(home, '.codex', 'hooks.json') && !(await fs.stat(dry.results[0].path).then(() => true, () => false)));
    await client.cmd('saveHooks', { items: [{ ...item, revision: dry.results[0].revision }] });
    const codex = JSON.parse(await fs.readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
    t.ok('書き込むと Codex の hooks.json（hooks の下にイベント）になる', codex.hooks.SessionStart[0].matcher === 'startup' && codex.hooks.SessionStart[0].hooks[0].command === 'echo hi');

    // ---- 会話の右パネル
    const session = await client.cmd('newSession', { cwd, backend: 'fake' });
    const turn = await client.runTurn({ ...session, prompt: 'hookruns' }, { ms: 60_000 });
    t.ok('発火の通知は画面の流れに出さない', turn.outcome === 'ok' && !turn.events.some(e => e.type === 'hookRun'));
    const fake = await client.cmd('sessionHooks', { sessionId: session.sessionId, cwd, backend: 'fake' });
    t.ok('受け取った発火の記録は会話に残る（開始・応答の順のまま）', fake.runs.length === 5 && fake.runs[0].phase === 'started' && fake.runs[1].outcome === 'success' && fake.runs.every(r => typeof r.at === 'number'), JSON.stringify(fake.runs));
    t.ok('hooks を読めないエージェントの会話は定義を探さない', fake.agent === null && fake.report === null);
    const claude = await client.cmd('sessionHooks', { sessionId: session.sessionId, cwd, backend: 'claude' });
    t.ok('Claude の会話: ユーザーと作業場所の定義、発火は観測できる', claude.observable && claude.report.entries.some(e => e.scope === 'project' && e.event === 'PostToolUse') && claude.report.entries.some(e => e.scope === 'user'));
    const pending = await client.cmd('sessionHooks', { sessionId: session.sessionId, cwd, backend: 'codex' });
    t.ok('一覧は先に返し、Codex の信頼状態は「確かめています」の印だけ付ける', pending.report.trustPending === true && pending.report.entries.every(e => e.trustPending && !('trust' in e)));
    const codexSide = await client.cmd('sessionHooks', { sessionId: session.sessionId, cwd, backend: 'codex', trust: true });
    t.ok('Codex の会話は観測できない（定義だけ）', codexSide.observable === false && codexSide.report.entries.every(e => e.agent === 'codex'));
    t.ok('Codex を使わない構成では信頼状態は「取得できません」', codexSide.report.entries.every(e => e.trust === null));
    client.close(); await host.stop(); client = null; host = null;

    // ---- Codex の app-server（身代わり）の hooks/list から信頼状態を取る
    await write(path.join(cwd, '.codex', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard' }] }] } });
    host = await startServer({ dataDir: path.join(tmp, 'data2'), timeoutMs: 30_000, env: { AGENT_HOST_BACKENDS: 'codex', USERPROFILE: home, HOME: home,
      CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`,
      FAKE_CODEX_HOOK_TRUST: 'untrusted', FAKE_CODEX_PLUGIN_HOOK: '1' } });
    client = await open(host);
    const trusted = await client.cmd('sessionHooks', { cwd, backend: 'codex', trust: true });
    const project = trusted.report.entries.find(e => e.scope === 'project' && e.event === 'PreToolUse');
    t.ok('Codex の会話: hooks/list の trustStatus を行に付ける', project?.trust?.status === 'untrusted' && project.trust.enabled === true, JSON.stringify(project?.trust));
    t.ok('Codex のプラグインの hooks も読み取りのみの行で出す（秘密は伏せる）', trusted.report.entries.some(e => e.scope === 'plugin' && e.readOnly) && !JSON.stringify(trusted).includes('SECRET-PLUGIN'));
  } finally {
    client?.close(); await host?.stop();
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-server-hooks-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
