// 入力欄の設定のチップ・一覧に出す字を決める関数（DOM を触らない。tests/unit/composer-labels.mjs から直接呼ぶ）。
// 画面の組み立ては web/composer-controls.mjs、仕様は docs/design-system.md「入力欄の設定」。

/**
 * モデルの表示。'' は実際に当たるモデルの名前にする（resolvesTo）。分からなければ '' の行の名前（「既定に従う」など）
 * @returns {{ id: string, entry: object|null, label: string }}
 */
export function resolvedModel(models, value) {
  const id = value || models?.[""]?.resolvesTo || "";
  const entry = models?.[id] ?? null;
  const label = id ? entry?.label ?? id : models?.[""]?.resolvedLabel ?? models?.[""]?.label ?? "既定に従う";
  return { id, entry, label };
}

/**
 * エフォートの段。efforts は core/effort.mjs の effortOptions の形。
 * 既定の段が分からない（resolvesTo が無い）ときは「既定」の段を作らない（本当の段ではないため）。
 * そのとき値が ''（既定に従う）なら unset: スライダーのつまみはどの段も指さない
 * @returns {{ stops: string[], def: string|null, current: string, unset: boolean }}
 */
export function effortStops(efforts, value) {
  const levels = Object.keys(efforts ?? {}).filter((k) => k !== "");
  const raw = efforts?.[""]?.resolvesTo ?? null;
  const def = raw && levels.includes(raw) ? raw : null;
  if (!levels.length) return { stops: [], def: null, current: "", unset: false };
  const current = value && levels.includes(value) ? value : def ?? "";
  return { stops: levels, def, current, unset: !current };
}

/** チップの字: 「Opus 5.5 · high」。段を持たないモデル・段が分からない（既定に従う）ときは名前だけ */
export function modelChipLabel(models, model, efforts, effort) {
  const { label } = resolvedModel(models, model);
  const { current } = effortStops(efforts, effort);
  return current ? `${label} · ${current}` : label;
}

/**
 * モデルの一覧に出す行の id。隠した行は選んでいるとき・既定のときだけ。
 * 段違いを系統（family）にまとめた一覧（antigravity。core/backends/antigravity-models.mjs）は、系統ごとに 1 行:
 * 選んでいる id > 既定の id > 表に出す id の順で、その系統を代表させる
 */
export function modelRowIds(models, value) {
  const def = models?.[""]?.resolvesTo;
  const ids = Object.keys(models ?? {}).filter((id) => id !== "" && (!models[id].hidden || id === value || id === def));
  const pick = new Map();   // family -> id
  for (const id of ids) {
    const family = models[id].family;
    if (!family) continue;
    const prev = pick.get(family);
    const rank = (x) => (x === value ? 0 : x === def ? 1 : models[x].hidden ? 3 : 2);
    if (prev === undefined || rank(id) < rank(prev)) pick.set(family, id);
  }
  return ids.filter((id) => !models[id].family || pick.get(models[id].family) === id);
}

/** 系統の中に既定の id があるか（系統の行に「既定」の札を付ける） */
export function holdsDefault(models, id) {
  const def = models?.[""]?.resolvesTo;
  if (!def) return false;
  return id === def || Boolean(models[id]?.family && models[id].family === models[def]?.family);
}

// ---------------------------------------------------------------- 接続先

/** 長い字を真ん中で詰める（モデル ID は頭と末尾で見分けることが多い） */
export function middleEllipsis(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * 接続先を選ぶエージェントのモデルのチップの字: 「接続先 · モデル」（段が決まっていれば「 · 段」）。
 * 接続先の名前とモデル ID はそれぞれ長さを詰め、段は削らない（末尾が切れると段が見えなくなるため）。
 * 全体の字は title に出す（full。モデルは省かない元の ID）
 * @returns {{ text: string, full: string }}
 */
export function endpointChipLabel({ connection, model, fullModel, effort } = {}) {
  // model はチップに出す短い形（ID の `/` より前を省いたもの）、fullModel は title に出す元の ID
  const parts = [connection || "接続先を選ぶ", fullModel || model, effort].filter(Boolean);
  const full = parts.join(" · ");
  const text = [middleEllipsis(connection || "接続先を選ぶ", 18), model ? middleEllipsis(model, 26) : "", effort || ""].filter(Boolean).join(" · ");
  return { text, full };
}
