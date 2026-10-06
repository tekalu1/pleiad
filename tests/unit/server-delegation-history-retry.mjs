// 委譲の子のターンの後に、履歴の読み出しが一時的な SQLite のエラー（Codex の `(code: 1546) disk I/O error`）で失敗する形。
// fake の台本 "history-ioerr <回数> <本文>" で、その後の getMessages を <回数> だけ失敗させる。サーバー全体を通す（LLM は呼ばない）。
// 2026-09-27 以降、作業と報告を終えた Codex の子が、このエラーで「失敗」になっていた（docs/agent-delegation.md「子の結果」）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'server-delegation-history-retry';
export const title = '委譲の子の履歴が一時的に読めない: 読み直して読めれば普通の完了・読めなければ流れた返答で注意書き付きの完了';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-delegation-ioerr-'));
  const server = await startServer({ dataDir: scratch, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_TASK_SILENCE_MINUTES: '0' } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const taskOf = async (taskId) => (await c.cmd('agentTasks')).find((r) => r.taskId === taskId);
  const until = async (fn, ms = 30000) => {
    const deadline = Date.now() + ms;
    for (;;) { const v = await fn(); if (v || Date.now() > deadline) return v; await sleep(50); }
  };
  const delegate = async (task) => {
    const from = c.mark();
    await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task }) });
    const ev = await c.waitFor((e) => e.type === 'tool.result' && String(e.text).includes('"taskId"'), { from, ms: 30000 });
    return { parent: ev.sessionId, task: JSON.parse(ev.text) };
  };
  const notices = async (sessionId) => (await c.cmd('loadSession', { sessionId })).messages.filter((m) => m.internalTaskNotice);
  try {
    // ---- 1. 2 回失敗してから読める: 読み直して、いつもどおりの完了
    {
      const { task } = await delegate('history-ioerr 2 子の報告: 読み直しで読めた');
      const done = await until(async () => { const r = await taskOf(task.taskId); return ['completed', 'failed'].includes(r?.status) ? r : null; });
      t.ok('読み直して読めたら completed・結果は報告・注意書きは無い', done?.status === 'completed' && done.result === '子の報告: 読み直しで読めた' && !done.error,
        JSON.stringify({ status: done?.status, result: done?.result, error: done?.error }));
    }

    // ---- 1b. ターンの後の取り込み（core/conversations.mjs）は 4 回とも読めず、結果の読み出しの読み直しで読める
    {
      const { task } = await delegate('history-ioerr 5 子の報告: 取り込みは見送り、結果は読めた');
      const done = await until(async () => { const r = await taskOf(task.taskId); return ['completed', 'failed'].includes(r?.status) ? r : null; });
      t.ok('取り込みが読めなくてもターンは失敗にせず、結果は読み直しで読む', done?.status === 'completed' && done.result === '子の報告: 取り込みは見送り、結果は読めた' && !done.error,
        JSON.stringify({ status: done?.status, result: done?.result, error: done?.error }));
      const child = await c.cmd('loadSession', { sessionId: task.sessionId });
      t.ok('見送った取り込みは、次に会話を読むときに入る', child.messages.some((m) => m.role === 'assistant' && m.text === '子の報告: 取り込みは見送り、結果は読めた'));
    }

    // ---- 2. 読み直しても失敗し続ける: 失敗にせず、流れた最後の返答で注意書き付きの完了
    {
      const { parent, task } = await delegate('history-ioerr 99 子の報告: 履歴は読めないが作業は終えた');
      const done = await until(async () => { const r = await taskOf(task.taskId); return r?.notification === 'sent' ? r : null; });
      t.ok('読めないままでも failed にせず completed', done?.status === 'completed', JSON.stringify({ status: done?.status, error: done?.error }));
      t.ok('結果は実行中に流れた最後の返答', done?.result === '子の報告: 履歴は読めないが作業は終えた', done?.result);
      t.ok('注意書きに読めなかったことと元のエラーを載せる', String(done?.error).includes('一時的なエラーで読み出せませんでした') && String(done?.error).includes('(code: 1546)'), done?.error);
      const text = (await notices(parent)).find((m) => m.text.includes(task.taskId))?.text ?? '';
      t.ok('完了通知にも報告と注意書きが載る', text.includes('子の報告: 履歴は読めないが作業は終えた') && text.includes('一時的なエラーで読み出せませんでした'), text.slice(0, 400));
    }
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
