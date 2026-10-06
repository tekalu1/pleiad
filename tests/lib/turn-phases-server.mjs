// tests/unit/turn-phases.mjs の入口。core/server.mjs をそのまま起こし（startServer の隔離のまま）、画面や bot からは入れない
// ターンの道（canInvoke が偽で戻る・onStarted が投げる）と、endTurn・driveTurn を export された関数で直に通す。
// テストが TURN_PHASES_DIR/<場面>.go に入力の JSON を書くと場面を走らせ、結果を <場面>.done に { ok, value | error } で書く。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.TURN_PHASES_DIR;
if (!dir) throw new Error('turn-phases-server: TURN_PHASES_DIR is not set');
const { runTurn, driveTurn, endTurn } = await import('../../core/server.mjs');

const scenes = {
  // 準備の後、バックエンドを呼ぶ前に予約が無効になった（idle の圧縮の canInvoke）
  canInvoke: ({ sessionId, prompt }) => runTurn({ sessionId, prompt }, () => {}, { canInvoke: () => false }),
  // 始まりの合図（onStarted）が投げた。didStart が偽のまま後始末をして、投げ直す
  onStartedThrows: ({ sessionId, prompt }) => runTurn({ sessionId, prompt }, () => { throw new Error('onStarted-boom'); }),
  // canInvoke で戻ったターンは、後始末（saveContext）の失敗で turn.outcome が error に変わっても requeue を返す
  requeueReturn: async () => {
    const turn = {
      outcome: null, ended: false, info: { sessionId: null }, presentKey: 'turn-phases-requeue', key: 'new:turn-phases-requeue',
      backend: { id: 'fake' }, ac: { signal: { aborted: false } }, visualizations: { close: async () => {} },
    };
    // makeEmit と同じく、turnResult で turn.outcome を書き換える
    const emit = ev => { if (ev?.type === 'turnResult') turn.outcome = ev.outcome; };
    const ctx = {
      turn, emit, hooks: {}, sessionId: null, args: {}, didStart: true, backendInvoked: false,
      shellHandoff: null, shellHanded: false, runtimeContext: null, resolvedContext: null,
      saveContext: async () => { throw new Error('save failed'); }, abortFromTask: () => {},
    };
    const returned = await driveTurn(ctx, async () => ({ requeue: true, beforeInvoke: true }));
    return { returned, outcome: turn.outcome };
  },
  // endTurn を 2 回呼んでも 2 回目は何もしない（turn.ended）
  endTurnOnce: async () => {
    const turn = {
      outcome: 'ok', ended: false, info: { sessionId: null }, presentKey: 'turn-phases-end-once',
      backend: { id: 'fake' }, ac: { signal: { aborted: false } },
    };
    const types = [];
    const emit = ev => { types.push(ev?.type); };
    await endTurn(turn, emit, { record: false });
    const first = [...types];
    await endTurn(turn, emit, { record: false });
    return { ended: turn.ended, first, second: types.slice(first.length) };
  },
};

const running = new Set();
setInterval(() => {
  for (const [name, scene] of Object.entries(scenes)) {
    const go = path.join(dir, `${name}.go`);
    if (running.has(name) || !fs.existsSync(go)) continue;
    running.add(name);
    const input = JSON.parse(fs.readFileSync(go, 'utf8') || '{}');
    fs.rmSync(go);
    Promise.resolve().then(() => scene(input))
      .then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message ?? error) }))
      .then(out => { fs.writeFileSync(path.join(dir, `${name}.done`), JSON.stringify(out)); running.delete(name); });
  }
}, 20).unref();
