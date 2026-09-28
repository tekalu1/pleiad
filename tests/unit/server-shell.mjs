// 入力欄の `!`（シェルの行。ADR 0054）をサーバー越しに通す。LLM は呼ばない（fake と tests/lib/fake-codex.mjs）。
//   - fake（Claude と同じくホストで走らせる）: すぐ返り、出力と終了コードを流す。送信待ちに入らない。エージェントは返答しない。
//     次の発言のターンで CLI の `!` と同じ 2 行を先に渡し、「渡した」を出す。開き直した履歴は kind: 'shell'（終了コードつき）
//   - 止める・同じ runId は 2 度走らせない・会話の無い id は断る
//   - Codex: thread/shellCommand（threadId・command・timeoutMs）で走らせ、userShell の item はエージェントのツールにしない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-shell';
export const title = '入力欄の `!` をサーバー越しに: 走らせる・送信待ちに入らない・次の発言で渡す・履歴・Codex の thread/shellCommand';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-shell-')));
  const log = path.join(scratch, 'codex.log');
  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`, FAKE_CODEX_LOG: log },
    dataDir: path.join(scratch, 'data'), timeoutMs: 60_000,
  });
  const c = await open({ ...server, autoAllow: true });
  try {
    // ---- fake（ホストで走らせる）
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    const from = c.mark();
    const reply = await c.cmd('runShell', { sessionId, runId: 'shell-run-0001', command: 'echo from-shell; exit 2', cwd: ROOT });
    t.ok('runShell は走り出したら返す', reply.runId === 'shell-run-0001');
    const done = await c.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-run-0001', { from, ms: 20_000 });
    const events = c.since(from);
    t.ok('shell.start → shell.output → shell.done の順に、会話の id を付けて流す',
      events.find(e => e.type === 'shell.start')?.sessionId === sessionId
      && events.some(e => e.type === 'shell.output' && e.text.includes('from-shell')) && done.exitCode === 2);
    t.ok('エージェントは返答しない（ターンが始まらない）', !events.some(e => e.type === 'turnEnd' || e.type === 'text.delta' || e.type === 'userMessage'));
    t.ok('送信待ちに入らない', (await c.cmd('listMessages', { sessionId })).length === 0);
    const dup = await c.cmd('runShell', { sessionId, runId: 'shell-run-0001', command: 'echo again', cwd: ROOT });
    t.ok('同じ runId の送り直しは走らせない', dup.duplicate === true && c.since(from).filter(e => e.type === 'shell.start').length === 1);

    let loaded = await c.cmd('loadSession', { sessionId });
    const pendingRow = loaded.messages.find(m => m.kind === 'shell');
    t.ok('開き直すと、まだ渡していない行が出る（終了コードつき）', pendingRow?.pending === true && pendingRow.exitCode === 2 && pendingRow.stdout.includes('from-shell'), JSON.stringify(loaded.messages));

    // 次の発言で渡す
    const turnFrom = c.mark();
    await c.cmd('sendMessage', { sessionId, messageId: 'shell-next-0001', prompt: 'echo:見た？' });
    await c.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: turnFrom, ms: 20_000 });
    const handed = c.since(turnFrom).find(e => e.type === 'shell.handed');
    t.ok('次の発言が渡ったら「渡した」を出す', handed?.runIds?.includes('shell-run-0001'), JSON.stringify(c.since(turnFrom).map(e => e.type)));
    loaded = await c.cmd('loadSession', { sessionId });
    const rows = loaded.messages.filter(m => m.kind === 'shell');
    const userIdx = loaded.messages.findIndex(m => m.role === 'user' && !m.kind);
    t.ok('渡した後の履歴は kind: shell の 1 行（渡した・終了コードつき）で、人の発言より前', rows.length === 1 && !rows[0].pending && rows[0].exitCode === 2
      && rows[0].command === 'echo from-shell; exit 2' && loaded.messages.indexOf(rows[0]) < userIdx, JSON.stringify(loaded.messages.map(m => [m.role, m.kind, m.text])));

    // 止める
    const stopFrom = c.mark();
    await c.cmd('runShell', { sessionId, runId: 'shell-stop-0001', command: 'echo go; sleep 30', cwd: ROOT });
    await c.waitFor(e => e.type === 'shell.output' && e.runId === 'shell-stop-0001', { from: stopFrom, ms: 20_000 });
    loaded = await c.cmd('loadSession', { sessionId });
    t.ok('走っている分も開き直した会話に出る', loaded.messages.some(m => m.runId === 'shell-stop-0001' && m.running === true));
    t.ok('stopShell で止める', (await c.cmd('stopShell', { runId: 'shell-stop-0001' })).stopped === true);
    const stopped = await c.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-stop-0001', { from: stopFrom, ms: 10_000 });
    t.ok('止めたら stopped で終わる', stopped.stopped === true && stopped.exitCode === null);

    const bad = await c.cmd('runShell', { sessionId: 'no-such-session', runId: 'shell-bad-0001', command: 'ls' }).then(() => null, e => e.message);
    t.ok('会話の無い id は断る', Boolean(bad));

    // ---- Codex（thread/shellCommand）
    const first = await c.runTurn({ backend: 'codex', prompt: 'hello', cwd: ROOT });
    const threadId = first.sessionId;
    t.ok('Codex の会話ができる', Boolean(threadId));
    const codexFrom = c.mark();
    await c.cmd('runShell', { sessionId: threadId, runId: 'shell-codex-0001', command: 'git fail', cwd: ROOT });
    const codexDone = await c.waitFor(e => e.type === 'shell.done' && e.runId === 'shell-codex-0001', { from: codexFrom, ms: 20_000 });
    t.ok('Codex: 出力を流し、終了コードを出す', codexDone.exitCode === 1 && codexDone.stdout?.includes('fake out')
      && c.since(codexFrom).some(e => e.type === 'shell.output' && e.runId === 'shell-codex-0001'), JSON.stringify(codexDone));
    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(l => l.method === 'thread/shellCommand');
    t.ok('Codex: thread/shellCommand に threadId・command・timeoutMs（10 分）を渡す', calls.length === 1 && calls[0].threadId === threadId && calls[0].command === 'git fail' && calls[0].timeoutMs === 600000, JSON.stringify(calls));
    t.ok('Codex: userShell の item をエージェントのツールにしない', !c.since(codexFrom).some(e => e.type === 'tool.start'));
    loaded = await c.cmd('loadSession', { sessionId: threadId });
    const codexRow = loaded.messages.find(m => m.kind === 'shell');
    t.ok('Codex: 履歴の userShell は kind: shell（終了コードつき・まだ渡していない）', codexRow?.exitCode === 1 && codexRow.pending === true && codexRow.command === 'git fail', JSON.stringify(loaded.messages));
    const nextFrom = c.mark();
    await c.runTurn({ sessionId: threadId, prompt: 'next' });
    t.ok('Codex: 次の発言が渡ったら「渡した」を出す', c.since(nextFrom).some(e => e.type === 'shell.handed' && e.runIds.includes('shell-codex-0001')));
    loaded = await c.cmd('loadSession', { sessionId: threadId });
    t.ok('Codex: 次の発言の後は渡した行になる', loaded.messages.find(m => m.kind === 'shell')?.pending !== true);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
