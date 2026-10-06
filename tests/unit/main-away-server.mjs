// main が居ない間の扱いを、本物のサーバー（core/server.mjs。AGENT_HOST_HANDOVER=on の名前付きパイプ）に偽の main（desktop/server-link.cjs）をつないで確かめる
// （無停止の更新 段階 1 の 1-5。docs/zero-downtime-update/design.md §7.2・§8）。
//   - つながるたびに最新の ready と言語が届く（付け直した main が locale を受け取る）
//   - main-leaving の後は、画面が居なくても猶予（AGENT_HOST_GRACE_MS）でターンを中断しない。戻った main の窓が付くまでの猶予は戻った時から数え直す
//   - main-leaving が無いまま切れて戻らなければ、今までどおり猶予で中断する（対照）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { createServerLink, readLinkInfo } = require('../../desktop/server-link.cjs');

export const name = 'main-away-server';
export const title = 'main が居ない間（サーバー越し）: 付け直しで ready・言語が届く・main-leaving の後は猶予で中断しない・main-leaving が無ければ中断する';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-main-away-'));
async function waitFor(check, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(20);
  }
}

/** 偽の main: パイプにつなぎ、受けたメッセージを溜める。secret・computer-ready-request には答える */
function fakeMain(dataDir) {
  let client = null;
  const seen = { messages: [] };
  const attach = () => {
    const info = readLinkInfo(dataDir);
    client = createServerLink({ pipe: info.pipe, secret: info.secret, appVersion: '0.0.1' });
    client.on('message', message => {
      seen.messages.push(message);
      if (message?.type === 'secret') client.postMessage({ type: 'secret', id: message.id, ok: true, value: message.op === 'status' ? { available: true, backend: 'dpapi' } : `x:${message.value}` });
    });
    return client;
  };
  return { seen, attach, get link() { return client; } };
}

/** 承認を聞かれたまま止まる fake のターンを走らせ、host（画面）が消えるまで進める */
async function startAskingTurn(server) {
  const away = await open({ port: server.port, token: server.token });
  const mark = away.mark();
  away.cmd('runTurn', { prompt: 'ask', sessionId: null, cwd: ROOT, backend: 'fake' }).catch(() => {});
  const started = await away.waitFor(e => e.type === 'session', { ms: 20_000, from: mark });
  const perm = await away.waitFor(e => e.type === 'permission', { ms: 20_000, from: mark });
  return { away, sessionId: started.sessionId, permissionId: perm.id };
}

export default async function (t) {
  const dirs = [];
  const boot = async () => {
    const dataDir = tempDir();
    dirs.push(dataDir);
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_HANDOVER: 'on', AGENT_HOST_GRACE_MS: '300' }, dataDir, timeoutMs: 60_000 });
    await waitFor(() => readLinkInfo(dataDir), 8000, 'main-link.json');
    return { server, dataDir };
  };
  try {
    // ---- main-leaving の後: 画面が居なくても、猶予でターンを中断しない
    {
      const { server, dataDir } = await boot();
      const main = fakeMain(dataDir);
      try {
        const link = main.attach();
        await link.connect();
        await waitFor(() => main.seen.messages.some(m => m.type === 'ready') && main.seen.messages.some(m => m.type === 'locale'), 8000, 'ready・locale');
        t.ok('最初のつながりで、最新の ready と言語（locale）が届く', main.seen.messages.find(m => m.type === 'ready').port === server.port && typeof main.seen.messages.find(m => m.type === 'locale').locale === 'string');
        const turn = await startAskingTurn(server);
        link.postMessage({ type: 'main-leaving', reason: 'update' });
        await sleep(100);                 // サーバーが main-leaving を受け取ってから
        link.leave();                     // main が終わる（shutdown は送らない）
        turn.away.close();                // 窓も無くなる
        // 猶予 300 ms + 保険のタイマー 500 ms を越えても、画面が居ないのは更新のため。ターンは止めない
        await sleep(1100);
        main.seen.messages.length = 0;
        await main.attach().connect();
        await waitFor(() => main.seen.messages.some(m => m.type === 'ready') && main.seen.messages.some(m => m.type === 'locale'), 8000, 'ready・locale（付け直し）');
        t.ok('付け直した main にも、最新の ready と言語が届く', main.seen.messages.find(m => m.type === 'ready').token === server.token && main.seen.messages.some(m => m.type === 'locale'));
        const back = await open({ port: server.port, token: server.token });
        try {
          const permission = await back.waitFor(e => e.type === 'permission' && e.id === turn.permissionId, { ms: 10_000 });
          const running = await back.cmd('running');
          t.ok('main-leaving の後は、画面が猶予を越えて居なくてもターンは中断されず、承認の待ちも残る（戻った画面に聞き直される）', Boolean(permission) && running.turns.length === 1 && running.turns[0].sessionId === turn.sessionId);
          await back.cmd('resolvePermission', { id: turn.permissionId, allow: true });
          await back.waitFor(e => e.type === 'turnEnd' && e.sessionId === turn.sessionId, { ms: 20_000 });
          t.ok('戻った画面が承認すればターンは最後まで進む（中断されていない）', (await back.cmd('running')).count === 0 && !back.events.some(e => e.type === 'turnEnd' && e.sessionId === turn.sessionId && e.outcome === 'aborted'));
        } finally { back.close(); }
      } finally { try { main.link?.kill(); } catch { /* 終わっていれば何もしない */ } await server.stop(); }
    }

    // ---- 対照: main-leaving が無いまま切れて戻らなければ、猶予が切れてターンを中断する（今までどおり）
    {
      const { server, dataDir } = await boot();
      const main = fakeMain(dataDir);
      try {
        const link = main.attach();
        await link.connect();
        const turn = await startAskingTurn(server);
        link.leave();                     // main-leaving を送らずに落ちた
        turn.away.close();
        await sleep(1100);
        await main.attach().connect();
        const back = await open({ port: server.port, token: server.token });
        try {
          await back.waitFor(e => e.type === 'turnEnd' && e.sessionId === turn.sessionId, { ms: 20_000 });
          const said = back.events.filter(e => e.type === 'text.delta').map(e => e.text).join('');
          t.ok('対照: main-leaving が無いまま猶予を越えて戻らなければ、今までどおり中断される（待っていた承認は deny）', said.startsWith('拒否された') && (await back.cmd('running')).count === 0, JSON.stringify(said));
        } finally { back.close(); }
      } finally { try { main.link?.kill(); } catch { /* 終わっていれば何もしない */ } await server.stop(); }
    }
  } finally {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}
