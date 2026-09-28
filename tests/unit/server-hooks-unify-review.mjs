// Hooks を Pleiad がそろえる: レビューの指摘のうちサーバー越しに確かめるもの（fake-codex。LLM は呼ばない。ホームは使い捨て）。
//   必須 2: 圧縮も hooks の config を渡す・追跡していないロード済みのスレッドも外してから読み直す
//   必須 5: 確認した後に元の定義が変わったら取り込まない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { containsPath } from '../../core/context-settings.mjs';
import { rpc as shared } from '../../core/backends/codex-rpc.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';

export const name = 'server-hooks-unify-review';
export const title = 'Hooks を Pleiad がそろえる（レビュー）: 圧縮・分岐したスレッドへの config、確認後の定義の変更';

const logLines = async file => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));

export default async function (t) {
  const tempRoot = await fs.realpath(os.tmpdir());
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-server-hooks-review-')));
  const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo'), log = path.join(tmp, 'codex.log');
  const write = async (p, v) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2)); };
  let host, client;
  try {
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(cwd, '.codex', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo reviewed' }] }] } });
    host = await startServer({ dataDir: path.join(tmp, 'data'), timeoutMs: 60_000, env: { USERPROFILE: home, HOME: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      AGENT_HOST_BACKENDS: 'codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`, FAKE_CODEX_HOOK_TRUST: 'trusted', FAKE_CODEX_LOG: log } });
    client = await open({ ...host, autoAllow: true });

    // ---- 必須 5: 確認の後に同じ位置の定義を書き換えて送る → 取り込まない
    const preview = await client.cmd('hooksUnifyPreview', { cwd, direction: 'ply' });
    const row = preview.stops.find(s => s.scope === 'project');
    await write(path.join(cwd, '.codex', 'hooks.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unreviewed' }] }] } });
    const changed = await client.cmd('setHooksOwner', { place: cwd, value: { owner: 'ply', disabled: [] }, revision: preview.revision, imports: [{ id: row.id, digest: row.digest }] }).then(() => null, e => e);
    const plyView = await client.cmd('plyHooks', { cwd });
    t.ok('5: 確認した後に元の定義が変わったら保存しない（担当も変えない）', changed && /開き直して/.test(changed.message) && plyView.hooks.length === 0 && plyView.place.value.owner === 'native', changed?.message);
    const noTicket = await client.cmd('setHooksOwner', { place: cwd, value: { owner: 'ply', disabled: [] } }).then(() => null, e => e);
    t.ok('5: 確認票（revision）の無い担当の変更は受け付けない', Boolean(noTicket));

    // ---- 必須 2 A: エージェント任せで始めた会話 → 担当を Pleiad に → 圧縮
    // 圧縮は会話の id をそのまま渡すので、Codex の thread の id で始めた会話を使う（newSession の会話の圧縮は id を訳さない。別の件）
    const first = await client.runTurn({ backend: 'codex', cwd, prompt: 'hello', mode: 'full' }, { ms: 60_000 });
    const sid = first.sessionId;
    const p2 = await client.cmd('hooksUnifyPreview', { cwd, direction: 'ply' });
    await client.cmd('setHooksOwner', { place: cwd, value: { owner: 'ply', disabled: [] }, revision: p2.revision });
    const before = (await logLines(log)).length;
    const compactFrom = client.mark();
    await client.cmd('compactConversation', { sessionId: sid });
    // 圧縮のターンが終わる（turnEnd）まで会話は準備中の印が付いたままで、次の runTurn は断られる
    await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sid, { from: compactFrom, ms: 30_000 });
    for (let i = 0; i < 50 && !(await logLines(log)).slice(before).some(l => l.method === 'thread/compact/start'); i++) await new Promise(r => setTimeout(r, 100));
    const compactLog = (await logLines(log)).slice(before);
    const unsubAt = compactLog.findIndex(l => l.method === 'thread/unsubscribe' && l.threadId === sid);
    const resumeAt = compactLog.findIndex(l => l.method === 'thread/resume' && l.threadId === sid);
    t.ok('2A: 圧縮は、エージェント任せでロードしたスレッドを外してから hooks の config 付きで読み直す', unsubAt >= 0 && resumeAt > unsubAt && compactLog[resumeAt].hooks === true, JSON.stringify(compactLog.map(l => l.method)));
    const runsBefore = (await client.cmd('sessionHooks', { sessionId: sid, cwd, backend: 'codex' })).runs.length;
    const afterCompact = await client.runTurn({ sessionId: sid, prompt: 'again', mode: 'full' }, { ms: 60_000 });
    const turnLog = (await logLines(log)).filter(l => l.method === 'turn/start' && l.threadId === sid).at(-1);
    const runs = (await client.cmd('sessionHooks', { sessionId: sid, cwd, backend: 'codex' })).runs.slice(runsBefore);
    t.ok('2A: 続くターンも Pleiad の config で動き、ネイティブ（project）は走らない', afterCompact.outcome === 'ok' && turnLog?.hooks?.state && !runs.some(r => r.source === 'project' || r.leak), JSON.stringify(runs));

    client.close(); await host.stop(); client = null; host = null;

    // ---- 必須 2 B: Pleiad が追跡していないロード済みのスレッド（別の経路でロードしたもの）の最初のターン。
    // 共有の app-server（身代わり）で先に thread をロードしてから、実際の backend.runTurn に Pleiad の runtime を渡す
    const saved = { bin: process.env.AGENT_HOST_CODEX_BIN, log: process.env.FAKE_CODEX_LOG, trust: process.env.FAKE_CODEX_HOOK_TRUST };
    const log2 = path.join(tmp, 'codex2.log');
    try {
      shared.stop();
      Object.assign(process.env, { AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`, FAKE_CODEX_LOG: log2, FAKE_CODEX_HOOK_TRUST: 'trusted' });
      const loaded = await shared.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' });
      const tid = loaded.thread.id;
      const runtime = { agent: 'codex', cwd, supplied: [], table: {}, index: [], record: {} };
      const events = [];
      await codex.runTurn({ prompt: 'hello', sessionId: tid, cwd, mode: 'full', emit: e => events.push(e), askPermission: async () => ({ allow: true }), hooksRuntime: runtime });
      const lines = (await logLines(log2)).filter(l => l.threadId === tid);
      const u = lines.findIndex(l => l.method === 'thread/unsubscribe'), r = lines.findIndex(l => l.method === 'thread/resume');
      const start = lines.find(l => l.method === 'turn/start');
      const leaks = events.filter(e => e.type === 'hookRun' && e.leak);
      t.ok('2B: 追跡していないロード済みのスレッドも外してから config 付きで読み直す', u >= 0 && r > u && lines[r].hooks === true && Boolean(start?.hooks?.state), JSON.stringify(lines.map(l => l.method)));
      t.ok('2B: ネイティブ（project）は漏れない', !leaks.length && !events.some(e => e.type === 'hookRun' && e.source === 'project'), JSON.stringify(events.filter(e => e.type === 'hookRun')));
    } finally {
      shared.stop();
      for (const [k, v] of [['AGENT_HOST_CODEX_BIN', saved.bin], ['FAKE_CODEX_LOG', saved.log], ['FAKE_CODEX_HOOK_TRUST', saved.trust]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  } finally {
    client?.close(); await host?.stop();
    if (!containsPath(tempRoot, tmp) || !path.basename(tmp).startsWith('ply-server-hooks-review-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}
