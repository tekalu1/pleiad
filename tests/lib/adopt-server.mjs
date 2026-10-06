// tests/unit/adopt-finished.mjs の入口（旧サーバー A の役）。core/server.mjs をそのまま起こし（startServer の隔離のまま）、
// 画面からは入れない「付け直しに渡す」口（handOffTurn。2d が呼ぶ）を通す。
// テストが ADOPT_SCENES_DIR/<場面>.go に入力の JSON を書くと場面を走らせ、結果を <場面>.done に { ok, value | error } で書く。
import fs from 'node:fs';
import path from 'node:path';

const dir = process.env.ADOPT_SCENES_DIR;
if (!dir) throw new Error('adopt-server: ADOPT_SCENES_DIR is not set');
const { handOffTurn } = await import('../../core/server.mjs');

const scenes = {
  // 走っているターンを付け直しに渡し、札（{ card, secrets }）を返す。バックエンドを呼ぶ前なら呼ぶまで待つ（上限 5 秒）
  handOff: async ({ sessionId }) => {
    const end = Date.now() + 5000;
    for (;;) {
      const taken = handOffTurn(sessionId);
      if (taken) return taken;
      if (Date.now() > end) throw new Error(`handOffTurn(${sessionId}) returned null`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
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
