// リモートの画面から PC の内蔵ブラウザーを見る・操作する（docs/inapp-browser.md「リモートから見る」、ADR 0041）。
// ページを持つのはデスクトップ版の main（desktop/browser-screencast.cjs）。ここは worker 側で、
//   - parentPortScreencast: main との口（依頼と応答、フレーム・状態・終わりの受け取り、ack）
//   - createScreencastHub: 会話ごとに見ている端末を束ね、フレームを配り、間引いて ack を返す。見る端末がいなくなったら止める
// フレームは Chromium が変化のあったときだけ出し、ack を返すまで次を出さない。ack は
// 「見ている端末がみな受け取った（または ackTimeout が過ぎた）」かつ「前のフレームから minInterval が過ぎた」ときに返す。
// 端末の受け取りを待つので、中継の遅い回線では自然に頻度が下がる。
// 映像の出どころは 2 つ（bridge を差し替える）。内蔵ブラウザー（main が持つ。上の parentPortScreencast）と、エージェントの Chrome の窓
// （core/chrome/screencast.mjs。同じ形の bridge。args.source === 'chrome'）。Chrome の窓はホストの画面からもリモートの端末からも見られ、入力は受けない（見るだけ）。
// hub は source を messages に載せ、画面が内蔵ブラウザーの映像と取り違えないようにする。
// main が居なくなった（更新）ときは、ページ（内蔵ブラウザーのタブ）ごと消えるので、見ている端末へ ended('away') を送って畳む
// （待っていた依頼は失敗にし、新しい main の browser-screencast-ready まで ready は false。docs/zero-downtime-update/design.md §7.2）。

export const QUALITY = {
  auto: { quality: 55, minInterval: 200, maxScale: 2 },   // 最大 5 fps
  low: { quality: 30, minInterval: 500, maxScale: 1 },    // 最大 2 fps
};

export function parentPortScreencast(port, { timeoutMs = 15_000 } = {}) {
  if (!port) return null;
  const pending = new Map();
  let next = 0, ready = false;
  const listeners = { frame: new Set(), state: new Set(), ended: new Set(), away: new Set() };
  port.on('message', event => {
    const message = event?.data ?? event;
    switch (message?.type) {
      case 'browser-screencast-ready': ready = true; return;
      case 'browser-screencast-frame': for (const fn of listeners.frame) fn(message.sessionId, message.frame); return;
      case 'browser-screencast-state': for (const fn of listeners.state) fn(message.sessionId, message.state); return;
      case 'browser-screencast-ended': for (const fn of listeners.ended) fn(message.sessionId, message.reason); return;
      case 'browser-screencast': {
        const item = pending.get(message.id);
        if (!item) return;
        pending.delete(message.id); clearTimeout(item.timer);
        if (message.ok) item.resolve(message.result ?? {}); else item.reject(new Error(message.error || 'screencast failed'));
      }
    }
  });
  // 名前付きパイプの口（main が付け直す）で main が切れた。見ている端末の画は戻らないので、依頼を落とし、ready を下げて、畳ませる
  port.on('disconnect', () => {
    ready = false;
    for (const [id, item] of [...pending]) { pending.delete(id); clearTimeout(item.timer); item.reject(new Error('main is away')); }
    for (const fn of listeners.away) fn();
  });
  const on = kind => fn => { listeners[kind].add(fn); return () => listeners[kind].delete(fn); };
  return {
    get ready() { return ready; },
    request(action, sessionId, args = {}) {
      return new Promise((resolve, reject) => {
        const id = `sc${++next}`;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('screencast timeout')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: 'browser-screencast', id, action, sessionId, ...args });
      });
    },
    ack(sessionId, frameId) { port.postMessage({ type: 'browser-screencast-ack', sessionId, frameId }); },
    onFrame: on('frame'), onState: on('state'), onEnded: on('ended'), onAway: on('away'),
  };
}

export const SCREENCAST_COMMANDS = ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav'];

/**
 * WS のコマンドを処理する（core/server.mjs から呼ぶ）。戻り値は { ok, result } か { ok: false, code }。
 * 内蔵ブラウザーの映像は、リモートの接続（ADR 0010 の isLocalRequest が false）からだけ受ける。ホストの画面には内蔵ブラウザーそのものがある。
 * args.source === 'chrome' は、エージェントの Chrome の窓の映像（chrome = { hub, bridge }）。ホストの画面もリモートも見られるが、見るだけ（移動は view-only）。
 * 入力はリモートの端末からだけ受け、端末が引き継いでいる間かは bridge（core/chrome/screencast.mjs）が決める（それ以外は view-only）。
 * 入力・移動は、その会話を見ている接続からだけ。
 * snapshotFile({ sessionId, id, at }) は可視化の写しを書き出して file: の URL を返す（見つからなければ null）
 */
export async function screencastCommand({ command, args = {}, local, hub, bridge, client, snapshotFile, chrome = null }) {
  const viaChrome = args.source === 'chrome';
  if (viaChrome) {
    if (!chrome?.hub || !chrome.bridge?.ready) return { ok: false, code: 'unavailable' };
    ({ hub, bridge } = chrome);
    if (command === 'browserScreencastNav' || (command === 'browserScreencastInput' && local)) return { ok: false, code: 'view-only' };
    if (command === 'browserScreencast' && (args.url != null || args.visualization)) return { ok: false, code: 'view-only' };
  } else if (local) return { ok: false, code: 'remote-only' };
  if (!hub || !bridge?.ready) return { ok: false, code: 'unavailable' };
  const sessionId = args.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) return { ok: false, code: 'invalid-session' };
  try {
    switch (command) {
      case 'browserScreencast': {
        let url, fileUrl;
        if (args.visualization) {
          const v = args.visualization;
          fileUrl = await snapshotFile?.({ sessionId: typeof v.sessionId === 'string' ? v.sessionId : sessionId, id: v.id, at: v.at });
          if (!fileUrl) return { ok: false, code: 'not-found' };
        } else if (args.url != null) {
          if (typeof args.url !== 'string' || !/^https?:\/\//i.test(args.url)) return { ok: false, code: 'invalid-url' };
          url = args.url;
        }
        return { ok: true, result: await hub.watch(client, sessionId, { url, fileUrl, width: args.width, height: args.height, scale: args.scale, quality: args.quality }) };
      }
      case 'browserScreencastStop': await hub.unwatch(client, sessionId); return { ok: true, result: {} };
      case 'browserScreencastAck': hub.received(client, sessionId, Number(args.seq)); return { ok: true, result: {} };
      case 'browserScreencastInput': case 'browserScreencastNav': {
        if (!hub.watching(client, sessionId)) return { ok: false, code: 'not-watching' };
        if (command === 'browserScreencastInput') await bridge.request('input', sessionId, { input: args.input });
        else await bridge.request('navigate', sessionId, { nav: args.action, url: args.url });
        return { ok: true, result: {} };
      }
      default: return { ok: false, code: 'unknown' };
    }
  } catch (error) {
    const code = String(error?.message ?? '');
    return { ok: false, code: ['invalid-url', 'invalid-input', 'not-watching', 'no-window', 'view-only'].includes(code) ? code : 'failed' };
  }
}

/**
 * @param bridge parentPortScreencast の戻り値（テストでは偽物）
 * client は { send(message) }。message は WS の { kind: 'screencast', type: frame|state|ended, sessionId, ... }
 */
export function createScreencastHub({ bridge, source = null, ackTimeout = 3000, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const tag = source ? { source } : {};
  const sessions = new Map();   // sessionId -> { clients: Map<client, { waiting }>, seq, frameId, sentAt, timer, settings, state, stats }

  function entryOf(sessionId) { return sessions.get(sessionId) ?? null; }
  const deliver = (client, message) => { try { client.send(message); } catch {} };

  bridge.onFrame((sessionId, frame) => {
    const entry = entryOf(sessionId);
    if (!entry || !frame || typeof frame.data !== 'string') return;
    const seq = ++entry.seq;
    entry.frameId = frame.id;
    entry.sentAt = now();
    entry.firstAt ??= entry.sentAt;
    entry.stats.frames++;
    entry.stats.bytes += Math.floor(frame.data.length * 3 / 4);
    entry.stats.maxBytes = Math.max(entry.stats.maxBytes, Math.floor(frame.data.length * 3 / 4));
    for (const [client, info] of entry.clients) {
      info.waiting = seq;
      deliver(client, { kind: 'screencast', ...tag, type: 'frame', sessionId, seq, data: frame.data, metadata: frame.metadata ?? {} });
    }
    schedule(sessionId);
  });
  bridge.onState((sessionId, state) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    entry.state = state;
    for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'state', sessionId, state });
  });
  bridge.onEnded((sessionId, reason) => {
    const entry = entryOf(sessionId);
    if (!entry) return;
    drop(sessionId);
    for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'ended', sessionId, reason });
  });
  // main が居なくなった（更新）: 見ている端末へ終わりを知らせ、全部畳む。戻った main の前の続きは無い（タブの中身は一度切れる）
  bridge.onAway?.(() => {
    for (const sessionId of [...sessions.keys()]) {
      const entry = entryOf(sessionId);
      drop(sessionId);
      for (const client of entry.clients.keys()) deliver(client, { kind: 'screencast', ...tag, type: 'ended', sessionId, reason: 'away' });
    }
  });

  /** 次のフレームを許す（Chromium へ ack）時を決める */
  function schedule(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry || entry.frameId == null) return;
    clearTimer(entry.timer); entry.timer = null;
    const waiting = [...entry.clients.values()].some(info => info.waiting != null);
    const elapsed = now() - entry.sentAt;
    const interval = QUALITY[entry.settings.quality]?.minInterval ?? QUALITY.auto.minInterval;
    if (waiting && elapsed < ackTimeout) { entry.timer = setTimer(() => schedule(sessionId), ackTimeout - elapsed); return; }
    if (elapsed < interval) { entry.timer = setTimer(() => schedule(sessionId), interval - elapsed); return; }
    const frameId = entry.frameId;
    entry.frameId = null;
    for (const info of entry.clients.values()) info.waiting = null;
    bridge.ack(sessionId, frameId);
  }

  function drop(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry) return;
    clearTimer(entry.timer);
    sessions.delete(sessionId);
  }

  /** 見始める。url か fileUrl（サーバーが確かめた可視化の写し）があれば新しいタブで開く。同じ会話を見ている端末とはタブを共有する */
  async function watch(client, sessionId, { url, fileUrl, width, height, scale, quality = 'auto' } = {}) {
    const level = QUALITY[quality] ? quality : 'auto';
    const settings = { width, height, scale: Math.min(Number(scale) || 1, QUALITY[level].maxScale), quality: level };
    const options = { url, fileUrl, width, height, scale: settings.scale, quality: QUALITY[level].quality };
    let entry = entryOf(sessionId);
    const created = !entry;
    if (!entry) {
      entry = { clients: new Map(), seq: 0, frameId: null, sentAt: 0, timer: null, settings, state: null, stats: { frames: 0, bytes: 0, maxBytes: 0 }, firstAt: null };
      sessions.set(sessionId, entry);
    }
    entry.settings = settings;
    entry.clients.set(client, { waiting: null });
    let result;
    try { result = await bridge.request('start', sessionId, { options }); }
    catch (error) {
      entry.clients.delete(client);
      if (created && !entry.clients.size) drop(sessionId);
      throw error;
    }
    if (result?.state) entry.state = result.state;
    return { tabId: result?.tabId ?? null, state: entry.state };
  }

  async function unwatch(client, sessionId) {
    const entry = entryOf(sessionId);
    if (!entry || !entry.clients.delete(client)) return;
    if (entry.clients.size) { schedule(sessionId); return; }
    drop(sessionId);
    await bridge.request('stop', sessionId).catch(() => {});
  }

  /** 接続が切れた端末を、見ているすべての会話から外す */
  function forget(client) {
    for (const [sessionId, entry] of sessions) if (entry.clients.has(client)) void unwatch(client, sessionId);
  }

  /** 端末がフレームを描き終えた */
  function received(client, sessionId, seq) {
    const info = entryOf(sessionId)?.clients.get(client);
    if (!info || info.waiting == null || seq < info.waiting) return;
    info.waiting = null;
    schedule(sessionId);
  }

  function watching(client, sessionId) { return !!entryOf(sessionId)?.clients.has(client); }

  function stats(sessionId) {
    const entry = entryOf(sessionId);
    if (!entry) return null;
    const seconds = entry.firstAt != null ? Math.max(1, (entry.sentAt - entry.firstAt) / 1000) : 1;
    const { frames, bytes, maxBytes } = entry.stats;
    return { frames, bytes, maxBytes, avgBytes: frames ? Math.round(bytes / frames) : 0, fps: frames > 1 ? +(frames / seconds).toFixed(2) : frames };
  }

  return { watch, unwatch, forget, received, watching, stats, sessions: () => [...sessions.keys()] };
}
