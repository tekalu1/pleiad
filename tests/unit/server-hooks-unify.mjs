// Hooks を Pleiad がそろえる（ADR 0048）をサーバー越しに通す。LLM は呼ばない（Codex・agy は身代わり。ホームは使い捨ての場所）。
//   - 切り替えの確認（止まる・動き続ける・取り込める）→ 担当と取り込みを 1 回で保存
//   - Codex: thread の config に hooks（登録）と state（自分の定義に trusted_hash、ネイティブに enabled:false）。発火は Pleiad の分だけ・漏れなし。
//            担当を戻すとロード済みのスレッドを外して読み直し、ネイティブが戻る
//   - agy: 置き場の .agents/hooks.json で登録（アダプター越し）が走り、ユーザー・作業場所の同じ名前は止まる。発火はアダプターの記録から
//   - 会話の右パネルのデータ（渡した・止めた・渡せなかった・発火）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { containsPath } from '../../core/context-settings.mjs';

export const name = 'server-hooks-unify';
export const title = 'Hooks を Pleiad がそろえる: 切り替えの確認と保存・Codex の thread config・agy の置き場・右パネルのデータ';

const logLines = async file => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
const textOf = turn => turn.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-hooks-unify-')));
  const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo');
  const write = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
  const baseEnv = { USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') };
  let host, client;
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(home, '.codex', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }] } });
    await write(path.join(cwd, '.codex', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo project-guard' }] }] } });
    const log = path.join(tmp, 'codex.log');
    host = await startServer({ dataDir: path.join(tmp, 'data'), timeoutMs: 60_000, env: { ...baseEnv, AGENT_HOST_BACKENDS: 'codex',
      AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`, FAKE_CODEX_HOOK_TRUST: 'trusted', FAKE_CODEX_PLUGIN_HOOK: '1', FAKE_CODEX_LOG: log } });
    client = await open({ ...host, autoAllow: true });

    // ---- 切り替えの確認（この場所。会話の右パネルの「この場所だけ変える」と同じ）
    const preview = await client.cmd('hooksUnifyPreview', { cwd, direction: 'ply' });
    const guard = preview.stops.find(s => s.agent === 'codex' && s.scope === 'project');
    t.ok('確認: ユーザー・プロジェクトの Codex の定義は止まる行（取り込める）', guard?.importable && preview.stops.some(s => s.agent === 'codex' && s.scope === 'user'), JSON.stringify(preview.stops));
    t.ok('確認: Codex のプラグインの定義は動き続ける行（秘密は伏せる）', preview.keeps.some(k => k.agent === 'codex' && k.scope === 'plugin') && !JSON.stringify(preview).includes('SECRET-PLUGIN'));
    const plain = await client.cmd('newSession', { cwd, backend: 'codex' });
    const before = await client.runTurn({ ...plain, prompt: 'hello', mode: 'full' }, { ms: 60_000 });
    const nativeRuns = await client.cmd('sessionHooks', { sessionId: before.sessionId ?? plain.sessionId, cwd, backend: 'codex' });
    t.ok('エージェント任せの会話: ネイティブの hooks が走る（Codex の通知で見える）', nativeRuns.observable && nativeRuns.runs.some(r => r.source === 'project') && !nativeRuns.unify, JSON.stringify(nativeRuns.runs));

    // 登録（Claude の形の PreToolUse を Codex へ。アダプター越し）＋ ネイティブの 1 件を取り込んで、この場所の担当を Pleiad に
    await client.cmd('savePlyHook', { value: { name: 'claude-guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: 'node guard.mjs', targets: ['codex', 'antigravity'] } });
    const saved = await client.cmd('setHooksOwner', { place: cwd, value: { owner: 'ply', disabled: [] }, imports: [guard.id] });
    t.ok('担当と取り込みを 1 回で保存（取り込んだ定義は元のファイルから読み直す）', saved.place.value.owner === 'ply' && saved.place.override && saved.hooks.some(h => h.importedFrom?.scope === 'project' && h.agent === 'codex'));
    t.ok('エージェントの設定ファイルは書き換えない', (await fs.readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8')).includes('project-guard')
      && !(await fs.readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8')).includes('claude-guard'));
    const forged = await client.cmd('setHooksOwner', { place: cwd, value: { owner: 'ply' }, imports: ['not-a-row'] }).then(() => null, e => e);
    t.ok('見つからない行は取り込まない（画面から来た定義は使わない）', forged && /取り込めない/.test(forged.message));

    const s = await client.cmd('newSession', { cwd, backend: 'codex' });
    const turn = await client.runTurn({ ...s, prompt: 'hello', mode: 'full' }, { ms: 60_000 });
    const sid = turn.sessionId ?? s.sessionId;
    const started = (await logLines(log)).filter(l => l.method === 'turn/start' && l.hooks).at(-1);
    const state = started?.hooks?.state ?? {};
    const keys = Object.keys(state);
    t.ok('Codex: thread の config に登録（sessionFlags の key に trusted_hash）', keys.some(k => k.includes('<session-flags>') && /^sha256:/.test(state[k].trusted_hash))
      && started.hooks.PreToolUse.length === 2 && /hook-adapter-[0-9a-f]{12}\.mjs" claude codex PreToolUse/.test(started.hooks.PreToolUse[0].hooks[0].command), JSON.stringify(started?.hooks));
    t.ok('Codex: ユーザー・プロジェクトの定義は enabled:false、プラグインは止めない', keys.filter(k => state[k].enabled === false).length === 2 && !keys.some(k => k.includes('plugins')));
    const panel = await client.cmd('sessionHooks', { sessionId: sid, cwd, backend: 'codex' });
    t.ok('発火は Pleiad が渡した定義だけ（止めたネイティブは走らない・漏れなし）', panel.runs.length > 0 && panel.runs.every(r => r.pleiad && r.source === 'sessionFlags' && !r.leak), JSON.stringify(panel.runs));
    t.ok('右パネル: 渡したもの・止めたもの・動き続けるものを会話の記録に残す', panel.unify?.owner === 'ply' && panel.unify.supplied.length === 2 && panel.unify.stopped.length === 2
      && panel.unify.kept.some(k => k.source === 'plugin') && panel.unify.supplied.every(x => x.via === 'threadConfig'), JSON.stringify(panel.unify));

    // 同じスレッドで担当を戻す: ロード済みのスレッドを外して読み直し、ネイティブが戻る
    const back = await client.cmd('hooksUnifyPreview', { cwd, direction: 'native' });
    t.ok('戻すときの確認: 再開するネイティブの定義を並べる', back.direction === 'native' && back.stops.some(x => x.scope === 'project'));
    await client.cmd('setHooksOwner', { place: cwd, value: null });
    const again = await client.runTurn({ sessionId: sid, prompt: 'hello', mode: 'full' }, { ms: 60_000 });
    const lines = await logLines(log);
    const last = lines.filter(l => l.method === 'turn/start').at(-1);
    t.ok('担当を戻したターン: スレッドを外して読み直し、hooks の config を渡さない', again.outcome === 'ok' && last.hooks === null, JSON.stringify(last));
    const restored = await client.cmd('sessionHooks', { sessionId: sid, cwd, backend: 'codex' });
    t.ok('ネイティブの発火が戻る', restored.runs.slice(-4).some(r => r.source === 'project' && !r.pleiad));
    client.close(); await host.stop(); client = null; host = null;

    // ---- agy（身代わり）: 置き場の .agents/hooks.json と、名前で止めるネイティブ
    const deny = path.join(tmp, 'agy-deny.mjs').replace(/\\/g, '/');
    await write(deny, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'pleiad deny' })));");
    const allow = path.join(tmp, 'allow.mjs').replace(/\\/g, '/');
    await write(allow, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ decision: 'allow' })));");
    await write(path.join(home, '.gemini', 'config', 'hooks.json'), { user_probe: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: `node ${allow}` }] }] } });
    await write(path.join(cwd, '.agents', 'hooks.json'), { ws_probe: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${allow}` }] }] } });
    host = await startServer({ dataDir: path.join(tmp, 'data-agy'), timeoutMs: 60_000, env: { ...baseEnv, AGENT_HOST_BACKENDS: 'antigravity',
      AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"` } });
    client = await open(host);
    const a0 = await client.cmd('newSession', { cwd, backend: 'antigravity' });
    const nativeTurn = await client.runTurn({ ...a0, prompt: 'agy-hooks' }, { ms: 60_000 });
    t.ok('agy・エージェント任せ: ユーザーと作業場所の定義が走る', /user_probe:allow/.test(textOf(nativeTurn)) && /ws_probe:allow/.test(textOf(nativeTurn)), textOf(nativeTurn));
    const reg = await client.cmd('savePlyHook', { value: { name: 'agy-deny', agent: 'antigravity', event: 'PreToolUse', matcher: 'run_command', command: `node ${deny}`, targets: ['antigravity'] } });
    await client.cmd('setHooksOwner', { place: null, value: { owner: 'ply', disabled: [] } });
    const a1 = await client.cmd('newSession', { cwd, backend: 'antigravity' });
    const plyTurn = await client.runTurn({ ...a1, prompt: 'agy-hooks' }, { ms: 60_000 });
    const text = textOf(plyTurn);
    t.ok('agy・Pleiad がそろえる: 登録（アダプター越し）の deny だけが走り、ネイティブは名前で止まる', text === `hooks:pleiad-${reg.id}:deny`, text);
    const agyPanel = await client.cmd('sessionHooks', { sessionId: plyTurn.sessionId ?? a1.sessionId, cwd, backend: 'antigravity' });
    t.ok('agy: 発火は Pleiad が渡した分だけ観測できる（アダプターの記録）', agyPanel.observed === 'pleiad' && agyPanel.runs.some(r => r.pleiad && r.id === reg.id && r.phase === 'response'), JSON.stringify(agyPanel.runs));
    t.ok('agy: 止めた名前を会話の記録に残す', agyPanel.unify.stopped.map(r => r.name).sort().join() === 'user_probe,ws_probe' && agyPanel.unify.supplied[0].name === `pleiad-${reg.id}`);
    t.ok('agy: 元の設定ファイルは変えない', (await fs.readFile(path.join(cwd, '.agents', 'hooks.json'), 'utf8')).includes('ws_probe') && !(await fs.readFile(path.join(cwd, '.agents', 'hooks.json'), 'utf8')).includes('enabled'));
  } finally {
    client?.close(); await host?.stop();
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-server-hooks-unify-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
