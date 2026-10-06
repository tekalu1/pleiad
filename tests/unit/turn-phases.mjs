// 段階 2 の 2b-1: runTurnInternal の分割（prepareTurn・beginTurn・launchTurn・driveTurn・releaseTurn）と
// endTurn の 1 回だけの印（turn.ended）。
// fake バックエンドの各台本で、turnEnd が 1 回・completedAt が 1 回・使用量が 1 件（AGENT_HOST_FAKE_USAGE=1）
// であることを数える。
// また endTurn を 2 回呼んでも 2 回目が何もしない（turn.ended で早期リターン）ことを単体で確かめる。
import { execFileSync } from 'node:child_process';
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
  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: 'fake',
      AGENT_HOST_FAKE_USAGE: '1',
      ...gates.env,
    },
    dataDir,
    timeoutMs: 30_000,
  });

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

      // DECLINE_STEER で途中送信を拒否させる
      const prevUsage = usageCount();
      await c.runTurn({ sessionId: parent, prompt: ply('ply_task_send', { taskId: task.taskId, message: 'echo:LATER DECLINE_STEER' }) }, { ms: TURN_WAIT_MS });

      // ゲートを開いて子タスクを完了させる
      gates.open('ph-steer');
      await awaitTask(parent, r => r.status === 'completed');

      // 子タスクは 1 ターン目で 1 回、queued だった指示の 2 ターン目で 1 回、計 2 回の turnEnd
      const childTurnEnds = c.since(markChild).filter(e => e.type === 'turnEnd' && e.sessionId === task.sessionId);
      t.ok('DECLINE_STEER: 各ターンで turnEnd が 1 回ずつ（計2回）', childTurnEnds.length === 2);
      t.ok('DECLINE_STEER: 使用量が各ターンで記録される', usageCount() >= prevUsage + 1);
    }

    // 11. endTurn を 2 回呼んでも 2 回目が何もしない単体テスト（子プロセスで直に呼ぶ）
    {
      const testCode = `
        import { endTurn } from './core/server.mjs';
        let emitCount = 0;
        const turn = {
          ended: false,
          outcome: 'ok',
          info: { sessionId: null },
          presentKey: 'test-present-key',
          backend: { id: 'fake' },
          ac: { signal: { aborted: false } },
        };
        const emit = () => { emitCount++; };
        await endTurn(turn, emit);
        const endedAfterFirst = turn.ended;
        const countAfterFirst = emitCount;
        await endTurn(turn, emit);
        const endedAfterSecond = turn.ended;
        const countAfterSecond = emitCount;
        process.stdout.write('__RESULT__' + JSON.stringify({
          endedAfterFirst,
          countAfterFirst,
          endedAfterSecond,
          countAfterSecond,
        }) + '__RESULT__');
        process.exit(0);
      `;
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', testCode], {
        cwd: ROOT,
        env: {
          ...process.env,
          AGENT_HOST_PORT: '0',
          AGENT_HOST_DATA: path.join(scratch, 'unit-data'),
          AGENT_HOST_BACKENDS: 'fake',
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      const match = out.match(/__RESULT__([\s\S]*?)__RESULT__/);
      t.ok('endTurn の結果が出力される', match !== null);
      if (match) {
        const parsed = JSON.parse(match[1]);
        t.ok('endTurn 1回目で ended: true になる', parsed.endedAfterFirst === true);
        t.ok('endTurn 1回目で emit が呼ばれる', parsed.countAfterFirst === 1);
        t.ok('endTurn 2回目で ended は true のまま', parsed.endedAfterSecond === true);
        t.ok('endTurn 2回目で emit は呼ばれない（何もしない）', parsed.countAfterSecond === parsed.countAfterFirst);
      }
    }
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
