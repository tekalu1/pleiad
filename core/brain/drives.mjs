// 欲求の計算（ADR 0126）。数値 0〜1 を **コードで** 決める純粋な関数（モデルを呼ばない。SDK も DB も import しない）。
// 「体験」ではなく、ふるいと画面に見せる材料。好奇心・不安・人恋しさ・疲れの 4 つ。
//
//   computeDrives({ now, unread, loops, recent, lastHumanAt, failures, budgetUsed }) → { curiosity, anxiety, loneliness, fatigue }
//     unread … { human, bot, toMe }（前回の心拍から後の出来事の数。human = 人の投稿・bot = 他の bot の投稿・toMe = 自分宛ての @ を含む人の投稿）
//     loops … 開いている気がかり [{ due?: ms, updatedAt }]
//     recent … 思考の流れの末尾 [{ kind, text, at }]（新しいものが後ろ）
//     lastHumanAt … 人が最後に書いた時刻（ms。分からなければ null）
//     failures … 最近失敗で終わった bot のターンの数
//     budgetUsed … 今日の予算の使った割合 0〜1（分からなければ null）
//   similarity(a, b) → 0〜1  … 2 つの文の似かよい（2 文字ずつの重なり。日本語でも語の区切りに頼らない）。疲れ・繰り返しの測り方に使う
export const DRIVE_NAMES = Object.freeze(['curiosity', 'anxiety', 'loneliness', 'fatigue']);

const HOUR = 3_600_000;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const round2 = (n) => Math.round(clamp01(n) * 100) / 100;

const bigrams = (text) => {
  const s = [...String(text ?? '').toLowerCase().replace(/\s+/g, '')];
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s[i] + s[i + 1]);
  return out;
};

/** 2 つの文の似かよい（Jaccard。どちらかが 2 文字未満なら一致するときだけ 1） */
export function similarity(a, b) {
  const x = bigrams(a), y = bigrams(b);
  if (!x.size || !y.size) return String(a ?? '').trim() && String(a ?? '').trim() === String(b ?? '').trim() ? 1 : 0;
  let both = 0;
  for (const g of x) if (y.has(g)) both++;
  return both / (x.size + y.size - both);
}

/** 思考の行どうしの似かよいの平均（隣り合う行）。行が 2 つ未満なら 0 */
export function repetition(thoughts) {
  const rows = (thoughts ?? []).map((r) => (typeof r === 'string' ? r : r?.text)).filter((s) => String(s ?? '').trim());
  if (rows.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < rows.length; i++) sum += similarity(rows[i - 1], rows[i]);
  return sum / (rows.length - 1);
}

export function computeDrives({ now, unread = {}, loops = [], recent = [], lastHumanAt = null, failures = 0, budgetUsed = null } = {}) {
  const human = unread.human ?? 0, bot = unread.bot ?? 0, toMe = unread.toMe ?? 0;
  // 好奇心: 新しい出来事（他の bot の自発の分は軽く）と、答えの出ていない気がかりの数
  const fresh = clamp01((human + 0.4 * bot) / 3);
  const open = clamp01(loops.length / 6);
  const curiosity = 0.6 * fresh + 0.4 * open;
  // 不安: 期限の近い（過ぎた）気がかり・失敗したターン
  let due = 0;
  for (const l of loops) {
    if (!Number.isFinite(l.due)) continue;
    const left = l.due - now;
    due = Math.max(due, left <= 0 ? 1 : left <= 2 * HOUR ? 0.8 : left <= 24 * HOUR ? 0.4 : 0);
  }
  const anxiety = Math.max(due, 0) + Math.min(0.3, failures * 0.15);
  // 人恋しさ: 人の最後の投稿からの時間（12 時間で頭打ち）と、自分宛ての未返信
  const since = Number.isFinite(lastHumanAt) ? Math.max(0, now - lastHumanAt) / HOUR : null;
  const loneliness = since === null ? 0 : 0.7 * clamp01(since / 12) + 0.3 * clamp01(toMe);
  // 疲れ: 思考の行の量・同じことの繰り返し・予算の減り
  const thoughts = recent.filter((r) => r.kind === 'think');
  const fatigue = 0.4 * clamp01(thoughts.length / 40) + 0.4 * repetition(thoughts.slice(-6)) + 0.2 * (budgetUsed ?? 0);
  return { curiosity: round2(curiosity), anxiety: round2(anxiety), loneliness: round2(loneliness), fatigue: round2(fatigue) };
}
