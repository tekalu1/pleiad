// 発言の「編集して再送信」「再送信」が消すものの見立てと、その文（docs/design-system.md「発言の操作 › 送り直し」、docs/message-fork.md、ADR 0102・0177）。
// 送り直すと消えるもの（後ろの発言・返答・走っている返答）を数え、入力欄の上の「編集中」の帯（web/composer/edit-mode.mjs）に出す文と
// ボタンの名前を作る。Chats と、チャンネルのスレッドが同じものを使う。
import { svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { toolChange } from './render.mjs';

const glyph = (paths) => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const p of paths) svg.append(p);
  return svg;
};
const stroke = (d) => svgEl('path', { d });
export const sendGlyph = () => glyph([stroke('M21 3L10 14M21 3l-7 18-4-7-7-4z')]);
export const branchGlyph = () => glyph([svgEl('circle', { cx: 6, cy: 5, r: 2 }), svgEl('circle', { cx: 6, cy: 19, r: 2 }),
  svgEl('circle', { cx: 18, cy: 9, r: 2 }), stroke('M6 7v10M18 11c0 4-6 3-12 6')]);
export const penGlyph = () => glyph([stroke('M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3')]);

/**
 * 送り直すと消えるものの見立て。messages は履歴（loadSession の messages）、index は送り直す発言の添字。
 * users は後ろの自分の発言の数（スラッシュコマンド・`!` の行・システム側の行は数えない）、
 * any は消えるものが 1 つでもあるか（後ろの発言・返答・走っている返答）、files はファイルを変えた返答が消える範囲にあるか。
 * 走っている返答（running）は履歴にまだ無いことがあるので、呼び手が渡す
 */
export function tailInfo(messages, index, { running = false, forkOnly = false } = {}) {
  const after = messages.slice(index + 1);
  return {
    saved: after.length,
    // 委譲の完了通知として送った発言（internalTaskNotice）も人の発言ではない
    users: after.filter(m => m.role === 'user' && !m.kind && !m.internalTaskNotice).length,
    files: after.some(m => (m.toolCalls ?? []).some(call => toolChange(call?.name, call?.input))),
    running: Boolean(running),
    // 委譲された作業の会話は同じ会話では送り直せない（分岐して送るだけ。サーバーも断る）
    forkOnly: Boolean(forkOnly),
    any: after.length > 0 || Boolean(running),
  };
}

/** 帯に出す文（消えるもの・止まるもの・戻らないもの）。texts.running は文の差し替え（スレッドは「元の会話」を「このスレッド」に） */
export function tailLines(tail, texts = {}) {
  if (tail.forkOnly) return [t('chat.resend.delegated')];
  const lines = [];
  if (tail.saved > 0) lines.push(tail.users > 0 ? t('chat.resend.removeUsers', { count: tail.users }) : t('chat.resend.removeReplies'));
  if (tail.running) lines.push(texts.running ?? t('chat.resend.running'));
  if (tail.files) lines.push(t('chat.resend.files'));
  return lines;
}

/** ［送り直す］の名前（走っている返答があれば［止めて送り直す］）と、読み上げに足す「消えるもの」 */
export function sendLabels(tail) {
  const label = tail.running ? t('chat.resend.stopSend') : t('chat.resend.send');
  const removes = tail.saved > 0
    ? (tail.users > 0 ? t('chat.resend.removesUsers', { count: tail.users }) : t('chat.resend.removesReplies'))
    : tail.running ? t('chat.resend.removesRunning') : '';
  return { label, aria: removes ? t('chat.resend.sendLabel', { label, removes }) : label };
}
