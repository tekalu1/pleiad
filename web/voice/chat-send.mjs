// 声で確定した発言を Chats の会話へ送る（承認済み 2026-10-07。docs/voice-call.md「送信」）。
//
// 入力欄を通さない。入力欄に書いて submit() を呼ぶやり方は、送信中（submittingMessages）なら黙って return して 2 通目が入力欄に残り、
// 1 通目は await のあとで入力欄を読むので 2 通目が混ざり、書きかけの文にも触れていた。ここでは本文を直に sendMessage へ渡し、
// 受理された発言を会話の中の行に置く（状態は web/voice/delivery.mjs の 3 つの言い方）。呼ぶ側（index.mjs）が直列に呼ぶので、順番は守られる。
import { t } from '../i18n.mjs';

const READY_POLL_MS = 100;
const READY_MAX_MS = 8000;

/**
 * @param {object} o
 * @param {{ current: string|null, busy: boolean, loadingSession: string|null, cwd: string, mode: string }} o.state
 * @param {(command: string, args?: object) => Promise<any>} o.cmd
 * @param {() => string} o.randomId
 * @param {() => string|null} o.freshId  作ったばかりの会話を開いている間の id（client.mjs の freshSessionId）
 * @param {() => Promise<string|null>} o.ensureSession  会話がまだ無い（作っている途中）なら作って、できた id を返す。できなければ null
 * @param {() => Promise<void>} o.settingsSettled  設定の保存が済むまで待つ
 * @param {(sessionId: string, messageId: string, text: string) => void} o.place  受理された発言を会話の行に置く（送信中の一行つき）
 * @param {ReturnType<import('./delivery.mjs').createVoiceDelivery>} o.delivery
 * @param {(ms: number) => Promise<void>} [o.sleep]
 */
export function createChatVoiceSender({ state, cmd, randomId, freshId, ensureSession, settingsSettled, place, delivery, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  /** 会話を開いている途中・切り替えている途中は、終わるまで待つ（submit() はこの間、黙って送らない） */
  async function settled() {
    for (let waited = 0; (state.busy || state.loadingSession) && waited < READY_MAX_MS; waited += READY_POLL_MS) await sleep(READY_POLL_MS);
  }

  /** 送る。受理されたら返る。送れなかったら投げる（発言は入力欄へ戻さない。画面は失敗の一行を出す） */
  return async function send(text) {
    let sessionId = state.current;
    if (!sessionId || sessionId === freshId()) sessionId = await ensureSession();
    if (!sessionId) throw new Error(t('voice.note.notSent'));
    await settled();
    await settingsSettled().catch(() => {});
    if (state.current !== sessionId) throw new Error(t('voice.note.notSent'));   // 話している間に別の会話へ移った
    const messageId = randomId();
    delivery.claim(messageId);
    try {
      await cmd('sendMessage', { sessionId, messageId, prompt: text, cwd: state.cwd.trim() || undefined, mode: state.mode });
    } catch (e) { delivery.release(messageId); throw e; }
    if (state.current === sessionId) place(sessionId, messageId, text);
    return { sessionId, messageId };
  };
}
