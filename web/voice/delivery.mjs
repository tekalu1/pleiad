// 声で送った発言の配送の一行（Chats の会話。承認済み 2026-10-07。docs/design-system.md「通話モード」）。
//
// 声で送ったものは、入力欄を通さず、必ず会話の中の行に置く。状態の言い方は 3 つにそろえる:
//   渡しました      ✓ ＋「AI に渡しました」（エージェントが受け取った）
//   差し込み待ち    回る弧 ＋「差し込み待ち · 次の区切りで渡します」（作業中のターンへ割り込ませている最中。すぐ渡る）
//   送信待ち        時計 ＋「送信待ち · この作業が終わると送ります」＋［取り消す］（いまは渡せず順番待ち。面を一段薄くする）
// 記号（✓・弧・時計）＋字＋面の濃さで区別し、色だけに頼らない。ほかの発言（入力欄から送ったもの）の言い方は変えない。
import { el, svgEl } from '../dom.mjs';
import { runMark } from '../arc.mjs';
import { t } from '../i18n.mjs';

const CHECK = 'M5 12l4 4L19 6';
const CLOCK_HANDS = 'M12 7v5l3 2';

function icon(kind) {
  const svg = svgEl('svg', { class: 'i s vc-dl-ico', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  if (kind === 'check') svg.append(svgEl('path', { d: CHECK }));
  else svg.append(svgEl('circle', { cx: 12, cy: 12, r: 8 }), svgEl('path', { d: CLOCK_HANDS }));
  return svg;
}

/** 送信待ちが何を待っているか（core/message-queue.mjs の waiting）。声の言い方（時計の一行）の字 */
function queuedText(wait) {
  if (wait?.reason === 'order') return t('voice.delivery.queuedOrder');
  if (wait?.reason === 'limit') return t('voice.delivery.queuedLimit');
  return t('voice.delivery.queued');
}

/**
 * @param {object} o
 * @param {(item: { id: string }) => Promise<void>} o.cancel  送信待ちを取り消す
 */
export function createVoiceDelivery({ cancel }) {
  const owned = new Set();     // 声で送った messageId（行を作るとき・出来事が来たとき、声の行として描く）
  return {
    /** 送る前に控える（受理の応答より先に userMessage が届いても、声の行として作れるように） */
    claim(messageId) { owned.add(messageId); if (owned.size > 200) owned.delete(owned.values().next().value); },
    release(messageId) { owned.delete(messageId); },
    owns: (messageId) => owned.has(messageId),
    /** 行（.mw）を声の行にする */
    adopt(row) { row.dataset.vcVoice = '1'; },
    isVoice: (row) => row?.dataset?.vcVoice === '1',
    /**
     * 配送の一行を描く。kind: sending | pending | sent（markDelivery と同じ）。ほかの kind（late）は false を返し、呼ぶ側の既定の描き方に任せる
     */
    mark(row, kind) {
      const status = row.querySelector('.outbox-status');
      if (!status || !['sending', 'pending', 'sent'].includes(kind)) return false;
      row.classList.remove('vc-queued');
      status.classList.remove('outbox-status-failed', 'vc-dl-queued');
      status.classList.add('vc-dl');
      status.classList.toggle('outbox-status-mark', kind !== 'sent');
      status.dataset.vcDl = kind;
      if (kind === 'sent') {
        status.replaceChildren(icon('check'), document.createTextNode(t('voice.delivery.sent')));
        // AI に渡った: 受け取りの一言（ホスト）の起点（index.mjs が messageId で突き合わせて handed を送る）
        window.dispatchEvent(new CustomEvent('ply:voice-delivered', { detail: { messageId: row.dataset.messageId ?? null } }));
      }
      else status.replaceChildren(runMark(), document.createTextNode(kind === 'pending' ? t('voice.delivery.pending') : t('chat.delivery.sending')));
      return true;
    },
    /** 送信待ち（作業中で渡せない）。時計 ＋ 字 ＋ ［取り消す］。面を一段薄くする */
    queued(row, item) {
      const status = row.querySelector('.outbox-status');
      if (!status) return;
      const first = status.dataset.vcDl !== 'queued';
      row.classList.add('vc-queued');
      status.classList.remove('outbox-status-failed', 'outbox-status-mark');
      status.classList.add('vc-dl', 'vc-dl-queued');
      status.dataset.vcDl = 'queued';
      const button = el('button', 'btn', t('outbox.cancel'));
      button.type = 'button';
      button.onclick = async () => {
        button.disabled = true;
        try { await cancel(item); }
        catch (e) { button.disabled = false; status.title = String(e?.message ?? e); }
      };
      status.replaceChildren(icon('clock'), document.createTextNode(queuedText(item.waiting)), button);
      if (first) window.dispatchEvent(new CustomEvent('ply:voice-queued', { detail: { id: item.id } }));   // 効果音（index.mjs）が待ちに入ったことを知る
    },
  };
}
