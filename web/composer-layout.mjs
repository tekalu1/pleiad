// 入力欄と上端の、DOM を触らない決まり（承認済みのモック docs/mockups/phone-composer-header.html、
// docs/design-system.md「入力欄」「入力欄の設定」）。client.mjs・composer-controls.mjs・attach-menu.mjs が使い、
// tests/unit/composer-layout.mjs が直接確かめる。

/** 字の欄の上限の行数。マウスは 10 行、タッチは 6 行。その先は欄の中でスクロール */
export const PROMPT_LINES = { mouse: 10, touch: 6 };

/**
 * 字の欄の高さの上限（px）。行の高さ × 上限の行数 + 上下の余白。
 * 画面が低いとき（スマホでキーボードが出ている）は画面の 40% でも止める。ただし 1 行より低くはしない
 *   line: 行の高さ（px）、pad: 上下の余白の合計、touch: 指で使う画面か、viewport: 画面の高さ
 */
export function promptMaxHeight({ line, pad = 0, touch = false, viewport = Infinity }) {
  const lines = touch ? PROMPT_LINES.touch : PROMPT_LINES.mouse;
  const byLines = Math.ceil(line * lines + pad);
  const byScreen = Number.isFinite(viewport) ? Math.floor(viewport * 0.4) : Infinity;
  return Math.max(Math.ceil(line + pad), Math.min(byLines, byScreen));
}

/**
 * モデルのチップの字を「名前」と「 · 段」に分ける。狭いときは名前だけを … で詰め、段は削らない。
 * 区切り（ · ）が無ければ全部が名前
 */
export function splitChipLabel(label) {
  const text = String(label ?? '');
  const i = text.lastIndexOf(' · ');
  if (i <= 0) return { head: text, tail: '' };
  return { head: text.slice(0, i), tail: text.slice(i) };
}

/**
 * 添付（クリップ）で出どころを選ばせるか。選ばせないなら null（クリップはすぐ OS のファイルの選択を出す）。
 *   - リモートの窓（plyRemote。デスクトップ版・モバイル版の殻）: 選ばせる。「フォルダーを送る…」はデスクトップ版だけ
 *   - それ以外（ブラウザー）: サーバーが「この接続はホストの画面からではない」（hostCapabilities の osActions === false）
 *     と答えたときだけ選ばせる。まだ答えが無い（undefined）・ホストの画面（true）なら選ばせない
 * @returns {null | { folder: boolean }}
 */
export function attachSources({ remote, osActions } = {}) {
  if (remote && typeof remote === 'object' && typeof remote.hostId === 'string' && remote.hostId) return { folder: remote.shell !== 'mobile' };
  if (osActions === false) return { folder: false };
  return null;
}

/**
 * 添付の札に付ける出どころ（'host' | 'device'）。出どころを選べない接続（ホストの画面）では付けない（null）。
 * 印の無い古い下書きは、画像（手元から送ったもの）だけ device とみなし、それ以外は付けない
 */
export function attachOrigin(item, sources) {
  if (!sources || !item) return null;
  if (item.from === 'host' || item.from === 'device') return item.from;
  return item.dataUri ? 'device' : null;
}

/**
 * パスを場所のパンくずに分ける。区切りごとに押せるよう、先頭からそこまでのパスを添える。
 *   Windows: D:\dev\pleiad → [{ name: 'D:', path: 'D:\' }, { name: 'dev', path: 'D:\dev' }, { name: 'pleiad', path: 'D:\dev\pleiad' }]
 *   POSIX:   /home/me → [{ name: '/', path: '/' }, { name: 'home', path: '/home' }, { name: 'me', path: '/home/me' }]
 */
export function crumbs(p) {
  const text = String(p ?? '');
  if (!text) return [];
  const win = /^[a-z]:/i.test(text) || text.includes('\\');
  const sep = win ? '\\' : '/';
  const parts = text.split(/[\\/]+/).filter(Boolean);
  const out = [];
  if (!win) out.push({ name: '/', path: '/' });
  let acc = '';
  parts.forEach((name, i) => {
    if (win) acc = i === 0 ? `${name}${sep}` : `${acc.replace(/[\\/]+$/, '')}${sep}${name}`;
    else acc = `${acc}/${name}`;
    out.push({ name, path: acc });
  });
  return out;
}

/** フォルダーのパスとその中の名前をつなぐ（区切りはパスに合わせる） */
export function joinPath(dir, name) {
  const d = String(dir ?? '');
  const sep = d.includes('\\') || /^[a-z]:/i.test(d) ? '\\' : '/';
  return d.replace(/[\\/]+$/, '') + sep + name;
}
