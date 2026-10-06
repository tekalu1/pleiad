// 偽の Chrome（第 3 段以降も育てる）。リモートデバッグのトグルがオンの Chrome の見え方だけを真似る。
//   - 一時の User Data に DevToolsActivePort を書き、loopback の動的ポートで /devtools/browser/<id> の upgrade だけ受ける（/json/version は 404）
//   - permission: 'hold' のとき、upgrade は approve() まで保留する。保留ごとに偽の確認の窓（dialogs()）を作る
//   - cancel() は利用者の「キャンセル」: 保留の upgrade を HTTP 403 で断り（実機の見え方）、確認の窓も消す。expire() は Chrome の約 5 分の打ち切り: socket を壊し（見え方は未確認なので 403 とは別の形）、確認の窓は残す
//   - closeDialog(id) は確認の窓を閉じる（本物の WM_CLOSE と同じに、upgrade は即座に 403 で断られる）
//   - turnOff() は確認の「[設定] でオフにする」: 壊し、DevToolsActivePort を消し、ポートを閉じる。restart() はポートと経路を変えて書き直す
//   - CDP は tests/lib/fake-chrome-browser.mjs の小さなブラウザー（窓・タブ・flatten のセッション・Fetch）が答える。受けたメソッドは calls に残す
// 本物の Chrome・本物の LOCALAPPDATA は読まない。
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createFakeBrowser } from './fake-chrome-browser.mjs';

const CRLF = String.fromCharCode(13, 10);

export async function startFakeChrome({ permission = 'auto', product = 'Chrome/154.0.8037.97', userDataDir = null, userTabs } = {}) {
  const dir = userDataDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'ply-fake-chrome-'));
  const ownsDir = !userDataDir;
  const wss = new WebSocketServer({ noServer: true });
  const open = new Set();        // 開いた ws（接続済み）
  const pending = [];            // { socket, req, head, dialogId }
  const dialogs = new Map();     // dialogId -> { stale }
  const sockets = new Set();
  const dialogListeners = new Set();
  let server = null;
  let port = 0;
  let wsPath = '';
  let mode = permission;
  let dialogSeq = 0;
  const self = { dir, userDataDir: dir, calls: [], upgrades: 0 };
  const browser = createFakeBrowser({ product, calls: self.calls, ...(userTabs ? { userTabs } : {}) });
  self.browser = browser;

  const writeFile = () => fs.writeFile(path.join(dir, 'DevToolsActivePort'), `${port}\n${wsPath}\n`);
  const removeFile = () => fs.rm(path.join(dir, 'DevToolsActivePort'), { force: true });

  function serve(req, socket) {
    browser.serve(socket);
    socket.on('close', () => open.delete(socket));
    open.add(socket);
    void req;
  }
  function accept(entry) {
    wss.handleUpgrade(entry.req, entry.socket, entry.head, ws => serve(entry.req, ws));
  }
  function removeDialog(entry) { dialogs.delete(entry.dialogId); }
  /** 本物の Chrome が、拒否された upgrade に返す応答 */
  function deny(entry) { try { entry.socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/html\r\nContent-Length: 19\r\nConnection: close\r\n\r\nForbidden request.\n'); } catch { entry.socket.destroy(); } }

  async function listen() {
    server = http.createServer((req, res) => { res.writeHead(404); res.end('not found'); });
    server.on('connection', s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); });
    server.on('upgrade', (req, socket, head) => {
      if (new URL(req.url, 'http://x').pathname !== wsPath) { socket.destroy(); return; }
      self.upgrades += 1;
      if (mode === 'auto') { accept({ req, socket, head }); return; }
      // 想定外の応答（403 以外の HTTP）
      if (mode === 'error') { socket.end('HTTP/1.1 500 Internal Server Error' + CRLF + 'Content-Length: 0' + CRLF + 'Connection: close' + CRLF + CRLF); return; }
      const entry = { req, socket, head, dialogId: `dlg${++dialogSeq}` };
      pending.push(entry);
      dialogs.set(entry.dialogId, { stale: false });
      // 利用者の側（Pleiad）から ws だけ閉じても、確認の窓は Chrome に残る（実機で確認。2026-10-06）
      socket.on('close', () => { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); if (dialogs.has(entry.dialogId)) dialogs.get(entry.dialogId).stale = true; });
      for (const fn of [...dialogListeners]) fn(entry.dialogId);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    wsPath = `/devtools/browser/${crypto.randomUUID()}`;
    await writeFile();
  }
  async function shutdown() {
    for (const e of [...pending]) { e.socket.destroy(); }
    pending.length = 0;
    for (const ws of [...open]) ws.terminate();
    for (const s of [...sockets]) s.destroy();
    await new Promise(resolve => server?.close(() => resolve()) ?? resolve());
    server = null;
  }
  await listen();

  Object.assign(self, {
    get port() { return port; },
    get wsPath() { return wsPath; },
    /** 保留中の確認の数 */
    pending: () => pending.length,
    openCount: () => open.size,
    /** 偽の os が見る確認の窓（id と、打ち切りで残ったものか） */
    dialogs: () => [...dialogs].map(([id, d]) => ({ id, stale: d.stale })),
    onDialog: fn => { dialogListeners.add(fn); return () => dialogListeners.delete(fn); },
    setPermission(next) { mode = next; },
    /** 「許可する」。保留中を全部通す */
    approve() { for (const e of pending.splice(0)) { removeDialog(e); accept(e); } },
    /** 「キャンセル」: 保留を壊し、確認の窓も消える */
    cancel() { for (const e of pending.splice(0)) { removeDialog(e); deny(e); } },
    /** Chrome の打ち切り: 保留を壊すが、確認の窓は残る */
    expire() { for (const e of pending.splice(0)) { dialogs.get(e.dialogId).stale = true; e.socket.destroy(); } },
    /** 確認の窓を閉じる（WM_CLOSE）。保留が壊れる。閉じたのが残っていた窓なら窓だけ消える */
    closeDialog(id) {
      if (!dialogs.has(id)) return false;
      const i = pending.findIndex(e => e.dialogId === id);
      if (i >= 0) { const [e] = pending.splice(i, 1); dialogs.delete(id); deny(e); }
      dialogs.delete(id);
      return true;
    },
    /** ws だけ閉じる（許可の取り消し）。ファイルとポートはそのまま */
    dropConnections() { for (const ws of [...open]) ws.terminate(); },
    /** 確認の「[設定] でオフにする」・トグルを戻した */
    async turnOff() { dialogs.clear(); await shutdown(); await removeFile(); },
    /** トグルをオンに戻す（新しいポートと経路で書き直す） */
    async turnOn() { if (!server) await listen(); },
    /** Chrome を閉じて開き直した: ポートと経路が変わる */
    async restart() { dialogs.clear(); await shutdown(); await listen(); },
    /** Chrome が閉じた: ファイルを消し、ポートも閉じる */
    async stop() { dialogs.clear(); await shutdown(); await removeFile(); if (ownsDir) await fs.rm(dir, { recursive: true, force: true }); },
    /** ファイルだけ書き直す（古い値の再現。ポートは閉じたまま） */
    async writeStale(stalePort) { await fs.writeFile(path.join(dir, 'DevToolsActivePort'), `${stalePort}\n/devtools/browser/${crypto.randomUUID()}\n`); },
    async removeActivePortFile() { await removeFile(); },
  });
  return self;
}
