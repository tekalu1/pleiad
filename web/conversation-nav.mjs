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

// ---------------------------------------------------------------- 目次と会話内検索（web/conversation-toc.mjs）の判定

/** 検索の対象の段。発言 ⊂ ＋返答 ⊂ ＋ツール（次の段は前の段を含む） */
export const SCOPES = ['user', 'answer', 'tool'];
const RANK = { user: 0, answer: 1, tool: 2 };
/** その種類の項目が、この段で対象になるか */
export const inScope = (scope, kind) => RANK[kind] <= RANK[scope];

/**
 * 検索語の一致（重ならない・大文字小文字を区別しない）。[{ start, end }]。空の検索語は一致なし。
 * 小文字にして長さが変わる文字（İ など）を含むときは、位置がずれないよう大文字小文字を区別して探す
 */
export function matchRanges(text, query) {
  const q = String(query ?? '');
  const source = String(text ?? '');
  if (!q) return [];
  let hay = source.toLowerCase(), needle = q.toLowerCase();
  if (hay.length !== source.length || needle.length !== q.length) { hay = source; needle = q; }
  const out = [];
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) out.push({ start: at, end: at + needle.length });
  return out;
}
export const countMatches = (text, query) => matchRanges(text, query).length;

/**
 * 段ごとの件数（札に出す数）。次の段は前の段を含む。検索していなければ項目数、検索中は一致数。
 * entries: [{ kind, hits }]
 */
export function scopeTallies(entries, searching) {
  const each = { user: 0, answer: 0, tool: 0 };
  for (const e of entries) each[e.kind] += searching ? e.hits : 1;
  return { user: each.user, answer: each.user + each.answer, tool: each.user + each.answer + each.tool };
}

/**
 * 対象の段の中の一致に、文書の順で通し番号を振る（entry.hitStart。一致の無い項目・対象外は -1）。返すのは一致の総数
 * entries は文書の順
 */
export function assignHits(entries, scope) {
  let total = 0;
  for (const e of entries) {
    if (inScope(scope, e.kind) && e.hits > 0) { e.hitStart = total; total += e.hits; } else e.hitStart = -1;
  }
  return total;
}

/** 通し番号 index の一致を持つ項目（assignHits の後）。無ければ null */
export function entryOfHit(entries, index) {
  let found = null;
  for (const e of entries) { if (e.hitStart >= 0 && e.hitStart <= index) found = e; else if (e.hitStart > index) break; }
  return found && index < found.hitStart + found.hits ? found : null;
}

/** 目次に並べる項目。対象の段で絞り、検索中は一致のある項目だけ。newestFirst なら新しい順（一致の番号の順は変えない） */
export function listRows(entries, { scope, searching, newestFirst }) {
  const rows = entries.filter((e) => inScope(scope, e.kind) && (!searching || e.hits > 0));
  return newestFirst ? rows.reverse() : rows;
}

/**
 * 一致のまわりの抜粋。最初の一致の少し手前から（手前が切れたら cut）。改行と連続する空白は 1 つの空白に畳んでから探す。
 * 一致が無ければ null
 */
export function excerptAround(text, query, { before = 14, after = 120 } = {}) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  const [first] = matchRanges(flat, query);
  if (!first) return null;
  const from = Math.max(0, first.start - before);
  return { cut: from > 0, head: flat.slice(from, first.start), hit: flat.slice(first.start, first.end), tail: flat.slice(first.end, first.end + after) };
}

/** ツール呼び出しの入力（JSON の文字列）から、対象の要約。command・path・url・pattern など最初に見つかったもの。無ければ空 */
export function toolTarget(inputText) {
  let input;
  try { input = JSON.parse(inputText); } catch { return ''; }
  if (!input || typeof input !== 'object') return '';
  for (const key of ['command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'query', 'prompt', 'description']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key].replace(/\s+/g, ' ').trim();
  }
  const first = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  return first ? first.replace(/\s+/g, ' ').trim() : '';
}
