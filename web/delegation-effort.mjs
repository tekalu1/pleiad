// 委譲の子の思考の強さ（設定 › 委譲の段・候補ごとの強さ。docs/agent-delegation.md「子の思考の強さ」、ADR 0164）の、DOM を触らない部分。
// 決め方（上書き → 段の既定 → そのモデルに合わせる）はサーバー（core/delegation-routing.mjs の decideEffort）が子を作るときに決める。
// ここは、画面が「今これで走る」と見せるための同じ決め方と、選択肢の組み立て。core も語彙と合わせ方をここから読む（二重に持たない）。

/** 思考の強さの語彙（弱い → 強い）。モデルが持つ強さはこの部分集合 */
export const EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * 持たない強さを、そのモデルが持つ中でいちばん近い下の強さに合わせる（xhigh → high）。
 * 下に何も無ければ持つ中でいちばん弱いもの。持つ強さが無ければ null
 */
export function fitEffort(levels, wanted) {
  const have = EFFORT_LEVELS.filter(l => (levels ?? []).includes(l));
  if (!have.length) return null;
  if (have.includes(wanted)) return wanted;
  const below = have.filter(l => EFFORT_LEVELS.indexOf(l) < EFFORT_LEVELS.indexOf(wanted));
  return below.length ? below.at(-1) : have[0];
}

/**
 * 候補 1 つの行に出す強さ。capability はサーバーが候補ごとに返す { levels, fixed }（無ければ、持ち方が分からない候補）。
 *   kind: 'fixed'（強さがモデル名に入る）・'none'（強さを持たない）・'level'（選べる）
 *   level の中身: value（今これで走る強さ。会話の既定が未設定なら null）・source（override / tier / conversation）・
 *     asked（合わせたときの元の強さ）・own（上書きの値。無ければ undefined）・changed（段の既定と違う上書き）・options（選べる強さ）
 * conversation はそのエージェントの会話の既定の強さ（'' なら未設定）
 */
export function candidateEffort({ settings, tier, candidate, capability, conversation = '' }) {
  if (capability?.fixed) return { kind: 'fixed', value: capability.fixed };
  if (capability && !capability.levels?.length) return { kind: 'none' };
  const options = capability ? EFFORT_LEVELS.filter(l => capability.levels.includes(l)) : [...EFFORT_LEVELS];
  const row = settings?.efforts?.[tier] ?? {};
  const own = Object.hasOwn(row, candidate) ? row[candidate] : undefined;
  const tierDefault = row['*'] ?? '';
  const raw = own !== undefined ? own : tierDefault;
  const source = raw === '' ? 'conversation' : own !== undefined ? 'override' : 'tier';
  const wanted = raw === '' ? conversation : raw;
  const value = wanted ? fitEffort(options, wanted) : null;
  return { kind: 'level', value, source, own, tierDefault, tierValue: tierDefault ? fitEffort(options, tierDefault) : null, options, changed: own !== undefined && own !== tierDefault,
    ...(wanted && value !== wanted ? { asked: wanted } : {}), conversationValue: conversation ? fitEffort(options, conversation) : null };
}

/** 段の見出しの「段の既定」に出す値と、既定から外れているか。'' は会話の既定に従う */
export function tierEffort({ settings, defaults, tier }) {
  const value = settings?.efforts?.[tier]?.['*'] ?? '';
  return { value, changed: value !== (defaults?.efforts?.[tier]?.['*'] ?? '') };
}

/**
 * 段の既定を変えた後の efforts（段ごとの { '*': 段の既定, [候補]: 上書き }）。
 * 上書きの value は undefined なら外す（段の既定に従う）、'' なら会話の既定に従う。key '*' は段の既定
 */
export function withEffort(efforts, tier, key, value) {
  const next = structuredClone(efforts ?? {});
  next[tier] = { ...(next[tier] ?? {}) };
  if (value === undefined) delete next[tier][key]; else next[tier][key] = value;
  return next;
}
