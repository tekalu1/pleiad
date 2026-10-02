// 発言の「編集して再送信」「再送信」の送り方の帯（docs/design-system.md「発言の操作」、docs/message-fork.md、ADR 0089）。
// 送り直すと消えるもの（後ろの発言・返答・走っている返答）が 1 つでもあるとき、送り直す発言の直下に出す。
// 編集でも再送信でも同じ部品・同じ位置。［取り消し］［分岐して送る］（副）［送り直す］（主。右端）。
// 押した時点では何も消さず、消えるのは送った瞬間。消える範囲は薄く見せる（.doomed）。
import { el, svgEl } from './dom.mjs';
import { t } from './i18n.mjs';
import { isComposingKey } from './keyboard.mjs';
import { runMark } from './arc.mjs';
import { toolChange } from './render.mjs';

const glyph = (paths) => {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const p of paths) svg.append(p);
  return svg;
};
const stroke = (d) => svgEl('path', { d });
export const sendGlyph = () => glyph([stroke('M21 3L10 14M21 3l-7 18-4-7-7-4z')]);
const branchGlyph = () => glyph([svgEl('circle', { cx: 6, cy: 5, r: 2 }), svgEl('circle', { cx: 6, cy: 19, r: 2 }),
  svgEl('circle', { cx: 18, cy: 9, r: 2 }), stroke('M6 7v10M18 11c0 4-6 3-12 6')]);

/**
 * 送り直すと消えるものの見立て。messages は履歴（loadSession の messages）、index は送り直す発言の添字。
 * users は後ろの自分の発言の数（スラッシュコマンド・`!` の行・システム側の行は数えない）、
 * any は消えるものが 1 つでもあるか（後ろの発言・返答・走っている返答）、files はファイルを変えた返答が消える範囲にあるか。
 * 走っている返答（running）は履歴にまだ無いことがあるので、呼び手が渡す
 */
export function tailInfo(messages, index, { running = false } = {}) {
  const after = messages.slice(index + 1);
  return {
    saved: after.length,
    users: after.filter(m => m.role === 'user' && !m.kind).length,
    files: after.some(m => (m.toolCalls ?? []).some(call => toolChange(call?.name, call?.input))),
    running: Boolean(running),
    any: after.length > 0 || Boolean(running),
  };
}

let seq = 0;

/**
 * 帯を作る。onSend は［送り直す］、onBranch は［分岐して送る］、onCancel は［取り消し］（どれも押した直後に呼ぶ。
 * 送っている間は busy(true) で全部のボタンを止める）。返り値の node を発言の直下へ置く
 * @param {{ tail: ReturnType<typeof tailInfo>, onSend: () => void, onBranch: () => void, onCancel: () => void }} o
 */
export function buildBand({ tail, onSend, onBranch, onCancel }) {
  const node = el('div', 'resend-band');
  node.id = `resendBand${++seq}`;
  node.setAttribute('role', 'group');
  node.setAttribute('aria-label', t('chat.resend.group'));
  const lines = [];
  if (tail.saved > 0) lines.push(tail.users > 0 ? t('chat.resend.removeUsers', { count: tail.users }) : t('chat.resend.removeReplies'));
  if (tail.running) lines.push(t('chat.resend.running'));
  if (tail.files) lines.push(t('chat.resend.files'));
  lines.forEach((text, i) => node.append(el('div', i === 0 ? 'rb-t' : 'rb-sub', text)));

  const sendLabel = tail.running ? t('chat.resend.stopSend') : t('chat.resend.send');
  const acts = el('div', 'rb-acts');
  const cancel = el('button', 'btn rb-cancel', t('chat.resend.cancel'));
  const branch = el('button', 'btn btn-quiet rb-branch');
  const send = el('button', 'btn btn-primary rb-send');
  cancel.type = branch.type = send.type = 'button';
  branch.append(branchGlyph(), el('span', null, t('chat.resend.branch')));
  send.append(sendGlyph(), el('span', null, sendLabel));
  branch.setAttribute('aria-label', t('chat.resend.branchLabel'));
  branch.setAttribute('aria-keyshortcuts', 'Control+Shift+Enter Meta+Shift+Enter');
  branch.title = `${t('chat.resend.branch')} (Ctrl+Shift+Enter)`;
  const removes = tail.saved > 0 ? (tail.users > 0 ? t('chat.resend.removesUsers', { count: tail.users }) : t('chat.resend.removesReplies')) : t('chat.resend.removesRunning');
  send.setAttribute('aria-label', t('chat.resend.sendLabel', { label: sendLabel, removes }));
  send.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
  send.title = `${sendLabel} (Ctrl+Enter)`;
  cancel.onclick = () => onCancel();
  branch.onclick = () => onBranch();
  send.onclick = () => onSend();
  acts.append(cancel, branch, send);
  node.append(acts);
  const lead = lines.length ? node.firstChild : null;
  if (lead) lead.id = `${node.id}t`;

  let mark = null;
  return {
    node, cancel, branch, send, text: lines.join(' '),
    /** 送っている間は全部のボタンを止め、主のボタンに弧を出す（応答が返るまで） */
    busy(on) {
      node.toggleAttribute('aria-busy', on);
      for (const b of [cancel, branch, send]) b.disabled = on;
      mark?.remove();
      mark = null;
      if (on) { mark = runMark(); send.prepend(mark); }
    },
  };
}

/**
 * 編集欄・帯のキー。Ctrl/⌘+Enter = 送り直す、Ctrl/⌘+Shift+Enter = 分岐して送る、Esc = 取り消し。
 * 日本語入力の変換中は受けない。受けたら true
 */
export function resendKeys(event, { send, branch, cancel }) {
  if (isComposingKey(event)) return false;
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return true; }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault(); event.stopPropagation();
    (event.shiftKey ? branch : send)();
    return true;
  }
  return false;
}
