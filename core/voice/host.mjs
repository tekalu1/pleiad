// 通話モードのホスト側の口（core/server.mjs が 1 つ作る）。docs/voice-call.md「構成」。
//
//   upgrade(req, socket, head)  /voice-ws への接続（トークンは呼び出し側が確かめ済み）。音声はバイナリ、制御は JSON。/ws とは別の口（音声の高頻度のバイナリを、
//                               大きなイベントの JSON と同じ口に混ぜない）。キーを持つこの PC の画面からだけ受ける（リモートの端末からは受けない）
//   onEvent(event)              server.mjs の emitGlobal から全部の出来事を受け、通話が見ている会話（chat = 会話の id、thread = そのスレッドの bot の会話）の
//                               text.delta・text.end・tool.start・userMessage・turnEnd だけを通話へ渡す（tool.start は名前だけ。引数・コマンド・ファイル名は通話へ渡さない。待ちの実況の種類を決めるため）。まだ見ていない会話の直近 3 秒は覚えておき、見始めたら渡す
//                               （新しい会話は最初のターンで id が決まるため、見る先の更新が数 ms 遅れても最初の文を落とさない）
//   status() / checkKey / keysChanged   設定 › 通話。使う OpenRouter のキーは設定 › API キー（core/api-keys.mjs。ADR 0155）で選んだもの（apiKey が返す）で、画面へも返さない
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { normalizeKey } from '../delegation-judges.mjs';
import { createVoiceSession } from './session.mjs';
import { createVoiceUsage } from './usage.mjs';
import { normalizeVoiceSettings } from './settings.mjs';
import { ACK_COUNT, TOOL_KINDS } from './wait-voice.mjs';
import { redactKey, voiceBaseUrl } from './openrouter.mjs';

export const VOICE_PATH = '/voice-ws';
const AGENT_EVENTS = new Set(['text.delta', 'text.end', 'tool.start', 'userMessage', 'turnEnd']);
const RECENT_MS = 3000;
const RECENT_SESSIONS = 8;
const RECENT_EVENTS = 400;
const THREAD_CACHE = 256;

/**
 * @param {object} d
 * @param {string} d.dataDir
 * @param {() => Promise<string|null>} d.apiKey  通話に使うキー（設定 › API キーで選んだもの。「使わない」・未登録なら null で、何も送らない）
 * @param {() => Promise<object|null>} [d.keyStorage]  キーの置き場の暗号化の状態（画面の注意の材料）
 * @param {() => Promise<object>} d.getPrefs
 * @param {() => string} d.uiLang
 * @param {(key: string, params?: object) => string} d.t
 * @param {(sessionId: string) => Promise<{ channelId: string, threadId: string }|null>} d.resolveThread  bot の会話が属するスレッド
 * @param {(req: import('node:http').IncomingMessage) => boolean} d.isLocal
 * @param {(line: string, fields?: object) => void} [d.log]
 */
export function createVoiceHost({ dataDir, apiKey, keyStorage = async () => null, getPrefs, uiLang, t, resolveThread, isLocal, log = () => {}, fetch: fetchImpl, now = Date.now, env = process.env }) {
  const usage = createVoiceUsage({ file: path.join(dataDir, 'voice-usage.json'), now });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const sessions = new Set();
  const sockets = new Map();   // 通話 -> その接続（キーが変わったとき、通話の後始末だけでなく接続も閉じるため）
  let keyCache; // undefined = 未読、null = 無い
  let inUse = null; // 今の通話が hello で受け取ったキー（キーが差し替わった・選び直したときに、通話を切るかの比べ先）

  const getKey = async () => {
    if (keyCache === undefined) keyCache = normalizeKey(await apiKey().catch(() => null)) || null;
    return keyCache;
  };
  const config = (apiKey) => ({ baseUrl: voiceBaseUrl(env), apiKey, fetch: fetchImpl });

  // ---- 出来事の振り分け
  const threadOf = new Map();    // sessionId -> { channelId, threadId } | null
  const resolving = new Map();   // sessionId -> 出来事の列（解決を待っている間の分）
  const recent = new Map();      // sessionId -> { at, events }（どの通話も見ていない会話の直近）

  const deliver = (session, ev) => { try { session.onAgentEvent(ev); } catch (e) { log('voice.event_failed', { error: String(e?.message ?? e).slice(0, 200) }); } };
  const watches = (session, sessionId) => {
    const target = session.target;
    if (!target) return false;
    if (target.kind === 'chat') return target.sessionId === sessionId;
    const home = threadOf.get(sessionId);
    return Boolean(home) && home.channelId === target.channelId && home.threadId === target.threadId;
  };

  function dispatch(ev) {
    let seen = false;
    for (const s of sessions) if (watches(s, ev.sessionId)) { deliver(s, ev); seen = true; }
    return seen;
  }

  function remember(ev) {
    const t0 = now();
    let row = recent.get(ev.sessionId);
    if (!row || t0 - row.at > RECENT_MS) { row = { at: t0, events: [] }; recent.set(ev.sessionId, row); }
    row.events.push(ev);
    if (row.events.length > RECENT_EVENTS) row.events.shift();
    row.at = t0;
    if (recent.size > RECENT_SESSIONS) recent.delete(recent.keys().next().value);
  }

  /** 見る先が加わったとき、直近の出来事を渡す */
  function replayFor(session) {
    const target = session.target;
    if (target?.kind !== 'chat' || !target.sessionId) return;
    const row = recent.get(target.sessionId);
    if (!row || now() - row.at > RECENT_MS) return;
    recent.delete(target.sessionId);
    for (const ev of row.events) deliver(session, ev);
  }

  async function settleThread(sessionId, events) {
    let home = null;
    try { home = await resolveThread(sessionId); } catch { /* 引けなければ、どのスレッドの会話でもない */ }
    threadOf.set(sessionId, home ?? null);
    if (threadOf.size > THREAD_CACHE) threadOf.delete(threadOf.keys().next().value);
    resolving.delete(sessionId);
    for (const ev of events) if (!dispatch(ev)) remember(ev);
  }

  function onEvent(ev) {
    if (!sessions.size || !ev?.sessionId || !AGENT_EVENTS.has(ev.type)) return;
    if (ev.type === 'tool.start') ev = { type: ev.type, sessionId: ev.sessionId, name: String(ev.name ?? '').slice(0, 80) };
    const waiting = resolving.get(ev.sessionId);
    if (waiting) { waiting.push(ev); return; }
    if (!threadOf.has(ev.sessionId) && [...sessions].some((s) => s.target?.kind === 'thread')) {
      const events = [ev];
      resolving.set(ev.sessionId, events);
      settleThread(ev.sessionId, events);
      return;
    }
    if (!dispatch(ev)) remember(ev);
  }

  // ---- 接続
  function connect(ws) {
    const send = (o) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    const session = createVoiceSession({
      send,
      sendBinary: (b) => { if (ws.readyState === ws.OPEN) ws.send(b, { binary: true }); },
      close: () => { try { ws.close(1000); } catch { /* 閉じていた */ } },
      log,
      now,
      onTarget: () => replayFor(session),
      hello: async () => {
        const settings = normalizeVoiceSettings((await getPrefs()).voice);
        const apiKey = await getKey();
        inUse = apiKey;
        const lang = uiLang();
        return {
          settings, config: apiKey ? config(apiKey) : null, uiLang: lang, usage,
          phrases: {
            code: t('voice.skip.code', { lng: lang }), table: t('voice.skip.table', { lng: lang }), log: t('voice.skip.log', { lng: lang }),
            // 受け取りの一言・待ちの実況の決まった文（core/voice/wait-voice.mjs）
            wait: {
              // i18n-dynamic: voice.wait.ack.
              ack: Array.from({ length: ACK_COUNT }, (_, i) => t(`voice.wait.ack.${i + 1}`, { lng: lang })),
              // i18n-dynamic: voice.wait.tool.
              tool: Object.fromEntries([...TOOL_KINDS, 'still'].map((k) => [k, t(`voice.wait.tool.${k}`, { lng: lang })])),
            },
          },
          todayCallSeconds: (await usage.today()).callSeconds,
        };
      },
    });
    sessions.add(session);
    sockets.set(session, ws);
    ws.on('message', (data, isBinary) => { session.onMessage(isBinary ? data : data.toString(), isBinary).catch(() => {}); });
    ws.on('close', () => { session.close(); sessions.delete(session); sockets.delete(session); });
    ws.on('error', () => {});
  }

  return {
    /** server.on('upgrade') から。トークンは確かめ済み */
    upgrade(req, socket, head) {
      if (!isLocal(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => connect(ws));
    },
    onEvent,
    /** 設定 › 通話に出す状態。キーそのものは返さない */
    async status() {
      const [hasKey, storage, today] = await Promise.all([getKey().then(Boolean), keyStorage().catch(() => null), usage.today()]);
      return {
        hasKey,
        storage: storage ? { encrypted: storage.encrypted, backend: storage.backend, ...(storage.reason ? { reason: storage.reason } : {}) } : null,
        today: { callSeconds: Math.round(today.callSeconds), sttSeconds: Math.round(today.sttSeconds), ttsChars: today.ttsChars },
        active: sessions.size,
      };
    },
    /**
     * 使うキーが変わった（差し替え・選び直し・削除）。覚えたキーを捨て、通話中のキーと違えば通話を切る
     * （切らないと、消した・差し替える前のキーで送り続ける。次の通話は新しいキーで始まる）
     */
    async keysChanged() {
      keyCache = undefined;
      const now = await getKey();
      if (sessions.size && now !== inUse) {
        // 通話の後始末（session.close）だけでは接続が残るので、画面へ終わりの理由（fatal）を送って接続も閉じる
        const code = now ? 'key-changed' : 'no-key';
        for (const [s, ws] of [...sockets]) {
          try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'error', code, fatal: true })); ws.close(1000); } catch { /* 閉じていた */ }
          s.close();
        }
      }
    },
    /** キーが通るか（OpenRouter の GET /key）。'ok' | 'invalid' | 'unreachable' | 'nokey'。本文・キーは返さない */
    async checkKey() {
      const apiKey = await getKey();
      if (!apiKey) return 'nokey';
      try {
        const res = await (fetchImpl ?? fetch)(`${voiceBaseUrl(env)}/key`, { headers: { Authorization: `Bearer ${apiKey}`, 'X-Title': 'Pleiad' }, signal: AbortSignal.timeout(5000) });
        await res.body?.cancel().catch(() => {});
        return res.ok ? 'ok' : res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable';
      } catch (e) { log('voice.check_failed', { error: redactKey(String(e?.message ?? e), apiKey).slice(0, 120) }); return 'unreachable'; }
    },
    usage,
    async close() { for (const s of sessions) s.close(); await usage.flush().catch(() => {}); wss.close(); },
    /** テスト用 */
    get sessionCount() { return sessions.size; },
  };
}
