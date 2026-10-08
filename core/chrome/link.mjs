// 接続の子（core/chrome/link-child.mjs）へのサーバー側の口（ADR 0167）。
// 接続の子は保持役（core/holder/）の子で、Chrome への ws を持つ。サーバーはパイプでつなぎ、ws の代わりに LinkSocket を core/chrome/connection.mjs の WebSocketImpl に渡す。
//   openChromeLink({ holder, dataDir, root, key })  … 保持役の welcome の子から札（kind: 'chrome-link'）で接続の子を探してつなぐ。無ければ起こす。つなげなければ null（今のサーバー内の ws）
//   ChromeLink { welcome, WebSocketImpl, adopted(), setCarry(carry), handOff(), quit(), onLost(fn) }
//     welcome   … 接続の子の挨拶（phase: idle | upgrading | open、port、path、upgradeAt、gen、firstId、sessions、carry）
//     adopted() … 引き継ぐ接続（phase が open か upgrading のときだけ。LinkSocket）。idle なら null
//     setCarry  … 中継の状態を預ける（変わるたびに呼ぶ。200 ms でまとめる。CARRY_MAX_BYTES を越えたら預けない）
//     handOff   … 引き継ぎの stash の段: 預かり物を送り終えて、ws を閉じずにパイプを離す
//     quit      … Pleiad の終了・切るとき: 接続の子に ws（確認を待つ upgrade も）を閉じさせて終わらせる
// LinkSocket は ws パッケージの WebSocket の必要な分だけ（open・unexpected-response・error・close・message、send・terminate・close）。
// 接続の世代（gen）で、閉じた接続の遅れた知らせを今の接続に混ぜない（open ごとに増やし、opened・fail・closed に載って戻る）。
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { connectHolder } from '../holder/client.mjs';
import { LINK_VERSION, LINK_CARD_KIND, CARRY_MAX_BYTES, HELLO_TIMEOUT_MS, LineReader, controlLine, parseControl, linkPipeName } from './link-wire.mjs';

export { LINK_VERSION, LINK_CARD_KIND };
const CHILD = fileURLToPath(new URL('./link-child.mjs', import.meta.url));
/** サーバーが 10 分つながらなければ、保持役が接続の子を止める（Pleiad が居なくなった後に Chrome への接続を残さない） */
export const LINK_KEEP_MS = 10 * 60 * 1000;
const CARRY_DEBOUNCE_MS = 200;
const START_WAIT_MS = 10_000;
const START_POLL_MS = 100;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 切り替え: 実行場所の置き場があり（保持役を使える配布版）、引き継ぎが有効で、AGENT_HOST_CHROME_LINK が off でないとき */
export function chromeLinkEnabled({ runtimeRoot, handover, env = process.env, bootValue } = {}) {
  const flag = String(bootValue ?? env.AGENT_HOST_CHROME_LINK ?? '').trim().toLowerCase();
  return Boolean(runtimeRoot) && Boolean(handover) && flag !== 'off';
}

/** 札から読み直す。形が合わなければ null */
export function readLinkCard(card) {
  if (card?.kind !== LINK_CARD_KIND || typeof card.pipe !== 'string' || typeof card.secret !== 'string' || !card.pipe || !card.secret) return null;
  return { kind: card.kind, v: card.v, pipe: card.pipe, secret: card.secret };
}

/** ws の代わり。link が出す opened・fail・closed と CDP の行を、ws のイベントとして出す */
export class LinkSocket extends EventEmitter {
  constructor(link, { url, gen, state = null }) {
    super();
    this.link = link; this.gen = gen; this.finished = false;
    this.readyState = state === 'open' ? 1 : 0;
    link.attach(this);
    if (url) queueMicrotask(() => { if (!this.finished) link.control('open', { url, gen }); });
  }

  /** 接続の子の知らせ（link が gen を確かめて渡す） */
  deliver(name, value) {
    if (this.finished) return;
    if (name === 'opened') { this.readyState = 1; this.emit('open'); }
    else if (name === 'fail') {
      this.finish();
      if (value?.status > 0) { this.emit('unexpected-response', null, { statusCode: value.status, resume() {} }); }
      else if (value?.code) this.emit('error', Object.assign(new Error(String(value.code)), { code: value.code }));
      this.emit('close', 1006);
    } else if (name === 'closed') { this.finish(); this.emit('close', value?.code ?? 1006); }
  }

  message(text) { if (!this.finished) this.emit('message', text); }

  finish() { this.finished = true; this.readyState = 3; this.link.detach(this); }

  send(data) {
    if (this.finished) throw new Error('not open');
    this.link.line(data);
  }

  /** こちらから閉じる。接続の子に ws を閉じさせ、'close' はすぐ出す（接続の子は答えない） */
  terminate() {
    if (this.finished) return;
    this.finish();
    this.link.control('close');
    queueMicrotask(() => this.emit('close', 1006));
  }
  close() { this.terminate(); }

  /** 引き継ぎ: ws は閉じずに、こちらの側だけを終える（'close' は出さない） */
  release() { this.finished = true; this.readyState = 3; }
}

/** 接続の子へパイプでつなぐ。挨拶（hello）に welcome が返れば { socket, welcome, reader }。つなげない・合わない・遅いときは null */
function connectPipe(card, { timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(card.pipe);
    let done = false;
    const finish = value => { if (done) return; done = true; clearTimeout(timer); if (!value) socket.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const reader = new LineReader({ onLine(line) {
      const control = parseControl(line);
      if (control?.name === 'welcome' && control.value && !done) finish({ socket, welcome: control.value, reader });
    } });
    socket.on('data', chunk => reader.push(chunk));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
    socket.on('connect', () => socket.write(controlLine('hello', { secret: card.secret, v: LINK_VERSION })));
  });
}

class ChromeLink {
  constructor({ socket, welcome, reader, log, onGone }) {
    this.socket = socket; this.welcome = welcome; this.reader = reader; this.log = log;
    this.current = null;          // 今の LinkSocket
    this.gen = Number(welcome.gen) || 0;
    this.lostFns = new Set();
    this.ended = false;           // handOff・quit 済み
    this.carryTimer = null; this.carryPending = undefined; this.lastCarryJson = null;
    this.onGone = onGone;
    reader.onLine = line => this.onLine(line);
    socket.on('close', () => this.onClose());
    socket.on('error', () => {});
    const self = this;
    this.WebSocketImpl = class { constructor(url) { return new LinkSocket(self, { url, gen: ++self.gen }); } };
  }

  onLine(line) {
    const control = parseControl(line);
    if (!control) { this.current?.message(line.toString('utf8')); return; }
    const { name, value } = control;
    if (name !== 'opened' && name !== 'fail' && name !== 'closed') return;
    if (!this.current) {
      // 引き継ぎの直後（adopted() の前）に届いた知らせは、挨拶の相を書き換えて残す
      if (value?.gen === this.gen && !this.adoptedOnce) this.welcome = { ...this.welcome, phase: name === 'opened' ? 'open' : 'idle' };
      return;
    }
    if (value?.gen !== this.current.gen) return;   // 閉じた接続の遅れた知らせ
    this.current.deliver(name, value);
  }

  onClose() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.carryTimer);
    const socket = this.current;
    this.current = null;
    if (socket && !socket.finished) { socket.finish(); socket.emit('close', 1006); }
    for (const fn of [...this.lostFns]) { try { fn(); } catch { /* 聞き手の失敗は口を壊さない */ } }
    this.onGone?.();
  }

  // LinkSocket から
  attach(socket) {
    const previous = this.current;
    this.current = socket;
    if (previous && previous !== socket && !previous.finished) { previous.finish(); queueMicrotask(() => previous.emit('close', 1006)); }
  }
  detach(socket) { if (this.current === socket) this.current = null; }
  line(text) { if (!this.ended && !this.socket.destroyed) this.socket.write(`${text}\n`); }
  control(name, value) { if (!this.ended && !this.socket.destroyed) this.socket.write(controlLine(name, value)); }

  /** 引き継ぐ接続。phase が open か upgrading のときだけ */
  adopted() {
    const phase = this.welcome.phase;
    if (phase !== 'open' && phase !== 'upgrading') return null;
    this.adoptedOnce = true;
    return new LinkSocket(this, { gen: this.gen, state: phase });
  }

  setCarry(carry) {
    if (this.ended) return;
    this.carryPending = carry;
    if (this.carryTimer) return;
    this.carryTimer = setTimeout(() => { this.carryTimer = null; this.flushCarry(); }, CARRY_DEBOUNCE_MS);
  }

  flushCarry() {
    clearTimeout(this.carryTimer); this.carryTimer = null;
    if (this.carryPending === undefined || this.ended) return;
    const carry = this.carryPending; this.carryPending = undefined;
    const json = JSON.stringify(carry ?? null);
    if (Buffer.byteLength(json, 'utf8') > CARRY_MAX_BYTES) { this.log?.('chrome-link: carry too large, not stored'); return; }
    if (json === this.lastCarryJson) return;
    this.lastCarryJson = json;
    this.control('carry', { carry: carry ?? null });
  }

  /** パイプがまだ生きている（handOff・quit・切れた後は false） */
  get alive() { return !this.ended; }

  onLost(fn) { this.lostFns.add(fn); return () => this.lostFns.delete(fn); }

  /** 引き継ぎの stash の段: 預かり物を送り終えて、ws は閉じずにパイプを離す（接続の子は次のつなぎ手を待つ） */
  async handOff() {
    if (this.ended) return;
    this.flushCarry();
    this.ended = true;
    this.current?.release(); this.current = null;
    await new Promise(resolve => this.socket.end(resolve));
    this.socket.destroy();
  }

  /** Pleiad の終了・切る: 接続の子に ws を閉じさせて終わらせる */
  async quit() {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.carryTimer);
    this.current?.release(); this.current = null;
    if (!this.socket.destroyed) this.socket.write(controlLine('quit'));
    // 子が終わってパイプが閉じるまで待つ（サーバーが先に終わると、子の使用中の印が少しの間残る）。待ちすぎない
    await new Promise(resolve => { this.socket.once('close', resolve); this.socket.end(); setTimeout(resolve, 1500).unref?.(); });
    this.socket.destroy();
  }
}

const cardOf = child => readLinkCard(child.label);

/**
 * Pleiad が終わるとき、保持役に子が 1 つも生きていなければ保持役も終わらせる（接続の子を起こすためだけに起こした保持役を、使用中の印ごと残さない）。
 * 保持役の親は 1 つなので、つなぎ直して最新の子の一覧を見る（後から合格した方が勝つ）。他の子（Codex・シェル）が生きていれば何もしない
 */
export async function stopHolderIfIdle({ dataDir, root, appVersion = '', connect = connectHolder } = {}) {
  let client;
  try { client = await connect({ dataDir, root, appVersion }); } catch { return false; }
  const busy = (client.welcome?.children ?? []).some(child => child.alive && !cardOf(child));   // 接続の子は今 quit した（終わる途中のことがある）
  if (busy) { client.close(); return false; }
  client.shutdown();
  await sleep(100);
  return true;
}

/** 子を止めて片付ける。kill は付いている親からしか転送されないので、先に attach する */
async function retire(holder, id) {
  try { await holder.attach(id); } catch { return; }
  holder.kill(id, { tree: true });
  await sleep(200);
  holder.release(id);
}

/**
 * 接続の子を見つけるか起こして、つなぐ。つなげなければ null（呼び出し側は今のサーバー内の ws に落ちる）。
 * holder は保持役への口（core/holder/client.mjs の HolderClient）。onGone は接続の子との縁が切れたとき（handOff・quit を除く）
 */
export async function openChromeLink({ holder, runtimeRoot, runtimeKey = '', log = () => {}, onGone, startWaitMs = START_WAIT_MS } = {}) {
  if (!holder?.connected) return null;
  const make = found => new ChromeLink({ ...found, log, onGone });
  // 居る接続の子
  for (const child of holder.welcome?.children ?? []) {
    const card = cardOf(child);
    if (!card) continue;
    if (!child.alive) { holder.release(child.id); continue; }
    const found = await connectPipe(card);
    if (!found) { log('chrome-link: existing child unreachable, replacing'); await retire(holder, child.id); continue; }
    if (found.welcome.v !== LINK_VERSION) {
      // 版が合わない: 終わらせて起こし直す（確認が 1 回出る）
      log(`chrome-link: version mismatch (child ${found.welcome.v}, server ${LINK_VERSION}), replacing`);
      found.socket.write(controlLine('quit'));
      found.socket.end();
      await sleep(200);
      await retire(holder, child.id);
      continue;
    }
    return make(found);
  }
  // 起こす
  const id = `chrome-link-${crypto.randomBytes(4).toString('hex')}`;
  const card = { kind: LINK_CARD_KIND, v: LINK_VERSION, pipe: linkPipeName(crypto.randomBytes(8).toString('hex')), secret: crypto.randomBytes(16).toString('hex') };
  const env = { ...process.env, PLEIAD_LINK_PIPE: card.pipe, PLEIAD_LINK_SECRET: card.secret, PLEIAD_LINK_ROOT: runtimeRoot ?? '', PLEIAD_LINK_KEY: runtimeKey ?? '' };
  if (!holder.spawn({ id, command: process.execPath, args: [CHILD], env, policy: 'none', label: card, keepMs: LINK_KEEP_MS })) return null;
  const deadline = Date.now() + startWaitMs;
  while (Date.now() < deadline) {
    const found = await connectPipe(card, { timeoutMs: 2000 });
    if (found) return make(found);
    await sleep(START_POLL_MS);
  }
  log('chrome-link: new child did not answer');
  await retire(holder, id);
  return null;
}
