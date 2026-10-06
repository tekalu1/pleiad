// 段階 2 の 2b-1: runTurnInternal の分割（prepareTurn・beginTurn・launchTurn・driveTurn・releaseTurn）と
// endTurn の 1 回だけの印（turn.ended）。
// fake バックエンドの各台本で、turnEnd が 1 回・completedAt が 1 回・使用量が 1 件（AGENT_HOST_FAKE_USAGE=1）
// であることを数える。分割で道が分かれた所（canInvoke が偽で戻る・onStarted が投げる・prepareTurn が投げる）も通す。
// 画面からは入れない道と endTurn・driveTurn の単体は、server を tests/lib/turn-phases-server.mjs の入口で起こして直に呼ぶ。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage } from '../lib/data-store.mjs';
import { createFakeGates } from '../lib/fake-gate.mjs';

export const name = 'turn-phases';
export const title = 'ターンの分割と endTurn の 1 回だけの印';

const ply = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const delegate = task => ply('ply_delegate', { kind: 'mechanical', backend: 'fake', task });

// 各ターンの待ちの上限（無制限に待って固まらないよう 10 秒に制限）
const TURN_WAIT_MS = 10_000;

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-turn-phases-'));
  const dataDir = path.join(scratch, 'data');
  const gates = await createFakeGates(scratch);
  const phasesDir = path.join(scratch, 'phases');
  await fs.mkdir(phasesDir);
  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: 'fake',
      AGENT_HOST_FAKE_USAGE: '1',
      TURN_PHASES_DIR: phasesDir,
      ...gates.env,
    },
    dataDir,
    timeoutMs: 30_000,
    entry: path.join(ROOT, 'tests', 'lib', 'turn-phases-server.mjs'),
  });
  // 入口（turn-phases-server.mjs）の場面を走らせ、結果を待つ
  const scene = async (name, input = {}) => {
    const done = path.join(phasesDir, `${name}.done`);
    await fs.writeFile(path.join(phasesDir, `${name}.go`), JSON.stringify(input));
    const end = Date.now() + TURN_WAIT_MS;
    while (Date.now() < end) {
      const text = await fs.readFile(done, 'utf8').catch(() => null);
      if (text) { await fs.rm(done); return JSON.parse(text); }
      await sleep(20);
    }
    throw new Error(`場面 ${name} が ${TURN_WAIT_MS}ms で終わらなかった
${server.tail(10)}`);
  };

  const c = await open({
    port: server.port,
    token: server.token,
    onEvent: async (ev, self) => {
      if (ev.type !== 'permission') return;
      if (ev.answers?.decline) {
        await self.cmd('resolvePermission', { id: ev.id, allow: false }).catch(() => {});
      } else {
        await self.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
      }
    },
  });

  try {
    const usageCount = () => (readUsage(dataDir)?.records ?? []).length;
    const usageOf = id => (readUsage(dataDir)?.records ?? []).filter(r => r.sessionId === id).length;
    const sessionMeta = id => (id ? readSessions(dataDir)[id] ?? null : null);

    // 1. echo:
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:hello' }, { ms: TURN_WAIT_MS });
      t.ok('echo: 成功', res.outcome === 'ok');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('echo: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('echo: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('echo: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 2. fail
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'fail' }, { ms: TURN_WAIT_MS });
      t.ok('fail: outcome は error', res.outcome === 'error');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('fail: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('fail: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('fail: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 3. slow（中断）
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      let ownId = null;
      const running = c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'slow' }, { ms: TURN_WAIT_MS });
      const ev = await c.waitFor(e => e.type === 'session' && e.sessionId, { from: mark, ms: 5000 });
      ownId = ev.sessionId;
      await c.cmd('abort', { sessionId: ownId });
      const res = await running;
      t.ok('slow: outcome は aborted', res.outcome === 'aborted');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === ownId);
      t.ok('slow: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(ownId);
      t.ok('slow: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('slow: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 4. limit <t>
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'limit 1000' }, { ms: TURN_WAIT_MS });
      t.ok('limit: outcome は limited', res.outcome === 'limited');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('limit: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('limit: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('limit: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 5. undelivered（プロンプトを渡す前に失敗、会話にも残らない）
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'undelivered' }, { ms: TURN_WAIT_MS });
      t.ok('undelivered: outcome は error', res.outcome === 'error');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd');
      t.ok('undelivered: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('undelivered: 会話に記録されない（completedAt なし）', meta === null || meta?.completedAt == null);
      t.ok('undelivered: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 6. compact
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'compact' }, { ms: TURN_WAIT_MS });
      t.ok('compact: outcome は ok', res.outcome === 'ok');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('compact: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('compact: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('compact: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 7. ask（承認して終わる）
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ask' }, { ms: TURN_WAIT_MS });
      t.ok('ask (allow): outcome は ok', res.outcome === 'ok');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('ask (allow): turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('ask (allow): completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('ask (allow): 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 8. ask（却下して終わる）
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const cDecline = await open({
        port: server.port,
        token: server.token,
        onEvent: async (ev, self) => {
          if (ev.type === 'permission') {
            await self.cmd('resolvePermission', { id: ev.id, allow: false }).catch(() => {});
          }
        },
      });
      const res = await cDecline.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ask' }, { ms: TURN_WAIT_MS });
      cDecline.close();
      t.ok('ask (deny): outcome は ok', res.outcome === 'ok');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('ask (deny): turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('ask (deny): completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('ask (deny): 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 9. hook-follow
    {
      const prevUsage = usageCount();
      const mark = c.mark();
      const res = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'hook-follow test' }, { ms: TURN_WAIT_MS });
      t.ok('hook-follow: outcome は ok', res.outcome === 'ok');
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === res.sessionId);
      t.ok('hook-follow: turnEnd は 1 回', turnEnds.length === 1);
      const meta = sessionMeta(res.sessionId);
      t.ok('hook-follow: completedAt は記録される', typeof meta?.completedAt === 'number');
      t.ok('hook-follow: 使用量は 1 件増える', usageCount() === prevUsage + 1);
    }

    // 10. 途中送信の requeue（DECLINE_STEER）
    {
      const tasksOf = async parent => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent);
      const awaitTask = async (parent, fn, ms = 15_000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const rows = await tasksOf(parent);
          if (rows[0] && fn(rows[0])) return rows[0];
          await sleep(50);
        }
        throw new Error('task timeout');
      };

      const markChild = c.mark();
      const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate('bg 1 gate:ph-steer') }, { ms: TURN_WAIT_MS })).sessionId;
      const task = await awaitTask(parent, r => r.status === 'running');
      await c.waitFor(e => e.type === 'phase' && e.sessionId === task.sessionId && e.state === 'waiting', { from: markChild, ms: 10_000 });

      // DECLINE_STEER で途中送信を拒否させる。子は門で止まっているので、この間に増える使用量は親の送信のターンの 1 件だけ
      const prevParentUsage = usageOf(parent);
      await c.runTurn({ sessionId: parent, prompt: ply('ply_task_send', { taskId: task.taskId, message: 'echo:LATER DECLINE_STEER' }) }, { ms: TURN_WAIT_MS });
      t.ok('DECLINE_STEER: 親の送信のターンの使用量は 1 件', usageOf(parent) === prevParentUsage + 1, `${usageOf(parent) - prevParentUsage}`);

      // ゲートを開いて子タスクを完了させる
      gates.open('ph-steer');
      await awaitTask(parent, r => r.status === 'completed');

      // 子タスクは 1 ターン目で 1 回、queued だった指示の 2 ターン目で 1 回、計 2 回の turnEnd
      const childEnded = e => e.type === 'turnEnd' && e.sessionId === task.sessionId;
      await c.waitFor(e => childEnded(e) && c.since(markChild).filter(childEnded).length >= 2, { from: markChild, ms: TURN_WAIT_MS }).catch(() => {});
      const childTurnEnds = c.since(markChild).filter(childEnded);
      t.ok('DECLINE_STEER: 各ターンで turnEnd が 1 回ずつ（計2回）', childTurnEnds.length === 2);
      t.ok('DECLINE_STEER: 子の使用量はターンごとに 1 件（計2件）', usageOf(task.sessionId) === 2, `${usageOf(task.sessionId)}`);
    }

    // 11〜13 で使う会話（fake の 1 ターン目を済ませておく）
    const base = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:base' }, { ms: TURN_WAIT_MS })).sessionId;
    // 続けて同じ会話でターンを始められる（switching・runtime.turns が残っていない）
    const nextTurnOk = async label => {
      const res = await c.runTurn({ sessionId: base, prompt: `echo:${label}` }, { ms: TURN_WAIT_MS });
      return res.outcome === 'ok';
    };

    // 11. canInvoke が偽（準備の後、バックエンドを呼ぶ前に戻す）
    {
      const prevUsage = usageOf(base);
      const prevCompleted = sessionMeta(base)?.completedAt;
      const mark = c.mark();
      const out = await scene('canInvoke', { sessionId: base, prompt: 'echo:NEVER' });
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === base);
      t.ok('canInvoke: runTurn は requeue を返す', out.ok && out.value === 'requeue', JSON.stringify(out));
      t.ok('canInvoke: turnEnd は 1 回で requeued', turnEnds.length === 1 && turnEnds[0].requeued === true && turnEnds[0].outcome === 'requeue');
      t.ok('canInvoke: バックエンドを呼ばない（返答が流れない）', !c.since(mark).some(e => e.type === 'text.delta' && e.sessionId === base));
      t.ok('canInvoke: 使用量も完了時刻も残さない', usageOf(base) === prevUsage && sessionMeta(base)?.completedAt === prevCompleted);
      t.ok('canInvoke: 後で同じ会話のターンを始められる', await nextTurnOk('after-requeue'));
    }

    // 12. onStarted が投げる（didStart が偽のまま後始末し、投げ直す）
    {
      const prevUsage = usageOf(base);
      const mark = c.mark();
      const out = await scene('onStartedThrows', { sessionId: base, prompt: 'echo:NEVER' });
      const turnEnds = c.since(mark).filter(e => e.type === 'turnEnd' && e.sessionId === base);
      t.ok('onStarted: 投げた例外がそのまま runTurn から出る', !out.ok && out.error === 'onStarted-boom', JSON.stringify(out));
      t.ok('onStarted: 失敗を知らせ、turnEnd は 1 回', turnEnds.length === 1
        && c.since(mark).some(e => e.type === 'turnResult' && e.sessionId === base && e.outcome === 'error'));
      t.ok('onStarted: バックエンドを呼ばない', !c.since(mark).some(e => e.type === 'text.delta' && e.sessionId === base));
      t.ok('onStarted: 始まっていないので使用量を残さない', usageOf(base) === prevUsage);
      t.ok('onStarted: 後で同じ会話のターンを始められる', await nextTurnOk('after-onstarted'));
    }

    // 13. prepareTurn が投げる（無い作業場所）。登録の前に断り、releaseTurn が会話を空ける
    {
      const mark = c.mark();
      const missing = path.join(scratch, 'missing-cwd');
      const err = await c.cmd('runTurn', { sessionId: base, prompt: 'echo:NEVER', cwd: missing }).then(() => null, e => e);
      t.ok('prepareTurn: 無い作業場所で断る', Boolean(err) && String(err.message ?? err).includes(missing), String(err?.message ?? err));
      t.ok('prepareTurn: 登録の前なので turnEnd も返答も出ない', !c.since(mark).some(e => e.sessionId === base && (e.type === 'turnEnd' || e.type === 'text.delta')));
      t.ok('prepareTurn: 後で同じ会話のターンを始められる', await nextTurnOk('after-prepare'));
    }

    // 14. canInvoke で戻ったターンは、後始末の失敗で turn.outcome が error に変わっても requeue を返す（分割前と同じ）
    {
      const out = await scene('requeueReturn');
      t.ok('driveTurn: canInvoke で戻ったら後始末の失敗によらず requeue を返す', out.ok && out.value.returned === 'requeue' && out.value.outcome === 'error', JSON.stringify(out));
    }

    // 15. endTurn を 2 回呼んでも 2 回目は何もしない
    {
      const out = await scene('endTurnOnce');
      t.ok('endTurn: 1 回目で turnEnd を出し ended が立つ', out.ok && out.value.ended === true && out.value.first.includes('turnEnd'), JSON.stringify(out));
      t.ok('endTurn: 2 回目は何も出さない', out.ok && out.value.second.length === 0);
    }
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
