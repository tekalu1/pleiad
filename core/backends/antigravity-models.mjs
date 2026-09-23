// Antigravity（`agy`）のモデル一覧とエフォートの対応。プロセスを起こさない純粋な関数だけを置く（テストから直接呼ぶ）。
//
// **agy のエフォートは「同じ基底モデルの段違いを選ぶ」だけ**（agy 1.2.8 で確認。docs/multi-backend.md §2.8 にも写した）:
//   - `agy models` は `id<TAB>表示名` を 1 行ずつ出す。段違いは別の id で並ぶ
//     （gemini-3.8-flash-high「Gemini 3.8 Flash (High)」/ -medium / -low。gemini-3.1-pro は high / low だけ）
//   - `--effort` は「その基底モデルの段違いの id を選ぶ」フラグ（changelog 1.1.5: "select a model's reasoning-effort
//     variant"。/model の選択画面も基底モデルでまとめて段をゲージで選ぶ）。関数名も EffortsForBase / ModelForBaseEffort
//   - 段違いが 1 つしか無いモデル（claude-sonnet-4-6、claude-opus-4-6-thinking、gpt-oss-120b-medium）には効かない
//     （"Effort isn't adjustable for %s" / "--effort is not supported for model %q"）
//   - 段付きの id と違う段を同時に渡すと失敗しうる（"--model %s conflicts with --effort=%s"）
// そこで Pleiad は **`--model` と `--effort` を同時に渡さない**。段は同じ系統の段違いの id に解決して `--model` だけ渡す（agyTarget）。
//
// 一覧の形（core/effort.mjs が読む）: 段違いはすべて id のまま載せ（保存済みの会話がどの id でも引ける）、
// 系統（family）ごとに 1 つだけを表に出す（残りは hidden）。各 id の efforts は系統の段、defaultEffort はその id 自身の段。
// つまり「gemini-3.8-flash-low を選んで、段を high へ動かす」は「gemini-3.8-flash-high を使う」と同じ意味になる。

/** agy の段の並び（弱い → 強い）。`agy --help` の `--effort (low|medium|high)` */
export const AGY_LEVELS = ["low", "medium", "high"];

const NL = String.fromCharCode(10);
const LEVEL_ID = /^(.+)-(low|medium|high)$/;
const LEVEL_LABEL = /^(.*?)\s*\((low|medium|high)\)\s*$/i;

/**
 * `agy models` の出力を行に分ける。見出し（Fetching… など）と id でない行は捨てる。
 * 表示名が無い行（古い agy・身代わり）は id を名前にする。
 * @returns {{ id: string, label: string }[]}
 */
export function parseAgyModels(text) {
  const rows = [];
  for (const raw of String(text ?? "").split(NL)) {
    const line = raw.replace(/\r$/, "").trim();
    if (!line || /^(Fetching|Available|Error)/i.test(line)) continue;
    // 「id<TAB>表示名」。タブが無ければ 2 つ以上の空白で区切る
    const [id, ...rest] = line.split(/\t|\s{2,}/);
    if (!/^[A-Za-z0-9][\w.\-]*$/.test(id?.trim() ?? "")) continue;
    const label = rest.join(" ").trim();
    rows.push({ id: id.trim(), label: label || id.trim() });
  }
  return rows;
}

/**
 * agy のログから、`--model` を付けずに起こしたときに選ばれていたモデルの表示名を取る。
 * agy は起動のたびに `Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"` を書く
 * （既定・/model で保存した選択。設定ファイルには出ない）。**公開の口ではない**ので、取れなければ null。
 */
export function defaultLabelFromLog(text) {
  const m = /Propagating selected model override to backend: label="([^"]+)"/.exec(String(text ?? ""));
  return m ? m[1] : null;
}

/** id と表示名の段が揃っているときだけ段違いとみなす（-medium の id に「(High)」は無いはずだが、揃わないものは混ぜない） */
function levelOf({ id, label }) {
  const a = LEVEL_ID.exec(id);
  const b = LEVEL_LABEL.exec(label);
  if (!a || !b || a[2] !== b[2].toLowerCase()) return null;
  return { base: a[1], level: a[2], name: b[1] };
}

/**
 * 行から Pleiad のモデル一覧（backend.models() の形）を組む。
 * @param {{ id: string, label: string }[]} rows parseAgyModels の結果
 * @param {string|null} defaultLabel defaultLabelFromLog の結果（表示名。id でもよい）
 */
export function buildAgyModels(rows, defaultLabel = null) {
  const groups = new Map();   // 基底 id -> [{ id, level, name }]
  for (const row of rows ?? []) {
    const v = levelOf(row);
    if (!v) continue;
    if (!groups.has(v.base)) groups.set(v.base, []);
    groups.get(v.base).push({ id: row.id, level: v.level, name: v.name });
  }
  const def = (rows ?? []).find((r) => r.label === defaultLabel || r.id === defaultLabel)?.id ?? null;
  const out = {};
  for (const row of rows ?? []) {
    const v = levelOf(row);
    const group = v ? groups.get(v.base) : null;
    // 段違いが 2 つ以上あるものだけ系統にまとめる。1 つだけ（gpt-oss-120b-medium）は表示名のまま・段なし
    if (!group || group.length < 2) {
      out[row.id] = { label: row.label, note: null, efforts: [], defaultEffort: null };
      continue;
    }
    const efforts = AGY_LEVELS.filter((l) => group.some((g) => g.level === l));
    // 表に出す 1 つ: 既定が入っていればそれ、無ければ medium（agy の /model も選んでいない系統は medium から）、無ければ先頭
    const shown = group.find((g) => g.id === def) ?? group.find((g) => g.level === "medium") ?? group[0];
    out[row.id] = {
      label: v.name, note: `段: ${efforts.join(" / ")}`,
      family: v.base, level: v.level, efforts, defaultEffort: v.level,
      // 段ごとの本当の id（エフォートの一覧の補足に出す）
      effortNotes: Object.fromEntries(group.map((g) => [g.level, g.id])),
      ...(shown.id === row.id ? {} : { hidden: true }),
    };
  }
  const target = def && out[def] ? def : null;
  out[""] = target
    ? { label: "既定に従う", note: "agy の設定をそのまま使う", resolvesTo: target, efforts: out[target].efforts, defaultEffort: out[target].defaultEffort,
      ...(out[target].effortNotes ? { effortNotes: out[target].effortNotes } : {}) }
    : {
      label: "既定（agy の設定）", note: "agy の設定をそのまま使う（Pleiad からは読めない）", efforts: [], defaultEffort: null,
      effortReason: "agy の既定のモデルが分からないため、段はモデルを選ぶと選べます",
    };
  return out;
}

/**
 * 実際に agy へ渡す `--model` / `--effort`。**両方は渡さない**（冒頭のコメント）。
 *   - 段の指定が無い: `--model`（'' なら何も渡さず agy の既定）
 *   - 段の指定がある: 同じ系統の段違いの id を `--model` に。段の無いモデル・系統に無い段なら段を捨てる
 *   - 一覧に無い（一覧を引けていない・既定が分からない）: model があればそれだけ。model も無ければ `--effort` だけ
 *     （agy は素の --effort を選ばれているモデルに当てる。changelog 1.1.10）
 * @returns {{ model?: string, effort?: string }}
 */
export function agyTarget(model, effort, models) {
  const m = model || undefined;
  if (!effort) return { model: m };
  const id = model || models?.[""]?.resolvesTo || "";
  const entry = id ? models?.[id] : null;
  if (entry?.family) {
    const sibling = Object.keys(models).find((k) => k && models[k].family === entry.family && models[k].level === effort);
    return { model: sibling ?? m };
  }
  if (entry) return { model: m };
  return m ? { model: m } : { effort };
}
