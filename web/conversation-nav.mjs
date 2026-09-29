// 会話の移動（docs/design-system.md「会話の移動」、ADR 0059）の、DOM を使わない部品。
// 発言の抜粋（上に残る問い・地図の浮く面・目次の行）、件数の札、目次の並び・絞り込み、検索の一致の数え方。
// 画面の部品は web/conversation-nav-view.mjs（残る問い・最新へ・地図）と web/conversation-toc.mjs（目次と検索）。
import { t } from './i18n.mjs';
import { ATTACHMENT_LINE } from './timeline.mjs';

const FENCE = /```[\s\S]*?```/g;
/** 添付の行 `[添付] パス` から、ファイル名だけを取る（区切りは / と \ の両方） */
const baseName = (path) => String(path).trim().replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || String(path).trim();

/**
 * 利用者の発言を、抜粋の部品に分ける。改行と連続する空白は 1 つの空白に畳み、コードブロックは「‹コード›」、
 * 添付の行（`[添付] パス`）は本文の後ろに「添付 ファイル名」として回す（本文が先に見えるように）。
 * 返す形: [{ token?: string, text?: string }]。token は弱い字で出す印
 * @param {string} text
 */
export function userPieces(text) {
  const files = [];
  const kept = String(text ?? '').split(/\r?\n/).filter((line) => {
    const m = ATTACHMENT_LINE.exec(line.trim());
    if (!m) return true;
    files.push(baseName(m[1]));
    return false;
  }).join('\n');
  const out = [];
  kept.split(FENCE).forEach((part, k) => {
    if (k) out.push({ token: t('nav.token.code') });
    const collapsed = part.replace(/\s+/g, ' ').trim();
    if (collapsed) out.push({ text: collapsed });
  });
  for (const name of files) out.push({ token: t('nav.token.attachment'), text: name });
  return out;
}

/** 抜粋の全文（クリップしない）。上に残る問いの title・目次の行の title・読み上げ名に使う */
export const piecesText = (pieces) => pieces.map((p) => [p.token, p.text].filter(Boolean).join(' ')).join(' ');
export const summaryOf = (text) => piecesText(userPieces(text));

/** 抜粋を HTML 要素の列にする（token は弱い字の span、text は textContent）。差し込み先の要素に append する */
export function appendPieces(target, pieces) {
  pieces.forEach((p, i) => {
    if (i) target.append(' ');
    if (p.token) {
      const span = document.createElement('span');
      span.className = 'nav-token';
      span.textContent = p.token;
      target.append(span);
      if (p.text) target.append(' ');
    }
    if (p.text) target.append(p.text);
  });
}

/** 件数の札。100 以上は 99+（全数は title で見せる） */
export const badge = (n) => (n > 99 ? '99+' : String(n));
