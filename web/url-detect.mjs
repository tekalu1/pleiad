// 文中の裸の URL（docs/design-system.md「文中の URL」）。AI の本文・自分の発言・知らせ・委譲の依頼が同じ判定を使う。
// 範囲は ASCII の字まで（RFC 3986 の字）。日本語の字・句読点・括弧（。、」）など）は巻き込まない。
// 日本語のパスは `[記事](…)` の Markdown のリンクなら今どおり開ける。DOM に触れない（tests/unit/url-links.mjs）。

// 始まりは http:// と https:// だけ。直前が英数字・+ . - @ なら作らない（xhttps://）。日本語の字の直後は作る。
export const URL_SOURCE = String.raw`(?<![A-Za-z0-9+.\-@])https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+`;

const MAX_LENGTH = 2000;
const TRAILING = /[.,:;!?'*_~]$/;
const count = (s, c) => s.split(c).length - 1;

/**
 * 正規表現で拾った字から、リンクにする範囲を決める。末尾の句読点と、対にならない ) ] は外す（`Fish_(disambiguation)` は残る）。
 * http(s) で読めて、ホストがあり、ユーザー名・パスワードが無く、2,000 字以内のものだけ返す。リンクにしないときは null
 */
export function bareUrl(match) {
  let u = String(match ?? '');
  for (;;) {
    if (TRAILING.test(u)) { u = u.slice(0, -1); continue; }
    const close = u.at(-1), open = close === ')' ? '(' : close === ']' ? '[' : null;
    if (open && count(u, open) < count(u, close)) { u = u.slice(0, -1); continue; }
    break;
  }
  if (!u || u.length > MAX_LENGTH) return null;
  try {
    const p = new URL(u);
    if ((p.protocol === 'http:' || p.protocol === 'https:') && p.hostname && !p.username && !p.password) return u;
  } catch { /* 読めないものはリンクにしない */ }
  return null;
}

const WHOLE = new RegExp(`^${URL_SOURCE}$`);
/** 字の全体が 1 つの URL のときだけ、その URL（インラインコードの中身の判定） */
export function wholeUrl(s) {
  const c = String(s ?? '');
  return WHOLE.test(c) && bareUrl(c) === c ? c : null;
}

/** 地の文から URL を拾う。[{ start, end, url }]（end は含まない）。リンクにしない候補は飛ばして、その次の字から読み直す */
export function findUrls(text) {
  const s = String(text ?? '');
  const re = new RegExp(URL_SOURCE, 'g');
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const url = bareUrl(m[0]);
    if (!url) { re.lastIndex = m.index + 1; continue; }
    out.push({ start: m.index, end: m.index + url.length, url });
    re.lastIndex = m.index + url.length;
  }
  return out;
}
