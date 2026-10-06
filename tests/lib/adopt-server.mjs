// tests/unit/adopt-finished.mjs・adopt-held.mjs の入口（旧サーバー A の役）。core/server.mjs をそのまま起こし（startServer の隔離のまま）、
// 画面からは入れない「付け直しに渡す」口（handOffTurn。2d が呼ぶ）を通す。
// テストが ADOPT_SCENES_DIR/<場面>.go に入力の JSON を書くと場面を走らせ、結果を <場面>.done に { ok, value | error } で書く。
// 場面: handOff（札を取る）・handOffNow（待たずに 1 回だけ。準備中などは null）・handOffHeld（台本 held: のターンを、札を取って保持役に detach して手を離す。2b-5）・
// pauseHeld（held: のターンの読みを止める／再開）・muteHeld（held: のターンの偽の CLI への書き込みを止める／戻す。2b-6）・
// handOffTurnOnly / handOffDetach（手を離す前半と後半を分ける。間に偽の CLI の出力が来ても、このサーバーは締めず読み捨てて ack する。
// 渡った合図が B の再生の側に来る形。2b-7）
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.ADOPT_SCENES_DIR;
if (!dir) throw new Error('adopt-server: ADOPT_SCENES_DIR is not set');
const { handOffTurn } = await import('../../core/server.mjs');
const { handOffHeld, pauseHeld, muteHeld } = await import('../../core/backends/fake.mjs');
const { conversation } = await import('../../core/conversations.mjs');

// 走っているターンを付け直しに渡し、札（{ card, secrets }）を返す。バックエンドを呼ぶ前なら呼ぶまで待つ（上限 5 秒）
async function handOff({ sessionId }) {
  const end = Date.now() + 5000;
  for (;;) {
    const taken = handOffTurn(sessionId);
    if (taken) return taken;
    if (Date.now() > end) throw new Error(`handOffTurn(${sessionId}) returned null`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const stashed = new Map();
// 偽の CLI を見ているのはネイティブの会話の id（委譲の子・下書きから始めた会話は、会話の id と違う）。会話の記録（core/conversations.mjs）から引く
const nativeIdOf = async sessionId => (await conversation(sessionId))?.nativeId ?? sessionId;
const scenes = {
  handOff,
  // 待たずに 1 回だけ（準備中・バックエンドを呼ぶ前は null）
  handOffNow: async ({ sessionId }) => handOffTurn(sessionId),
  // サーバーの手を離す（札を取る。このサーバーは締めない）→ バックエンドの手を離す（札を保持役の子に置いて detach）。2d の順序
  handOffHeld: async input => {
    const taken = await handOff(input);
    await handOffHeld(await nativeIdOf(input.sessionId), taken.card);
    return taken;
  },
  // 手を離す前半だけ: 札を取る（このサーバーは以後このターンを締めず、出来事を流さない）。札は後半まで預かる
  handOffTurnOnly: async input => {
    const taken = await handOff(input);
    stashed.set(input.sessionId, taken);
    return taken;
  },
  // 後半: 預かった札を保持役の子に置いて detach する（前半の後に ack した行は、B の再生の側に来る）
  handOffDetach: async ({ sessionId }) => {
    const taken = stashed.get(sessionId);
    if (!taken) throw new Error(`handOffDetach: no stashed card (${sessionId})`);
    stashed.delete(sessionId);
    await handOffHeld(await nativeIdOf(sessionId), taken.card);
    return taken;
  },
  pauseHeld: async ({ sessionId, paused }) => pauseHeld(sessionId, paused),
  muteHeld: async ({ sessionId, muted }) => muteHeld(sessionId, muted),
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
