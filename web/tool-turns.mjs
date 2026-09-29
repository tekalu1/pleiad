// 読むだけの筋（委譲した子の詳細）の履歴の整え方。
// 走っている子（web/stream-messages.mjs）と Claude の記録は、ツールだけの発言を 1 件ずつ区切る。そのままだと発言ごとに 1 行になり、
// まとまり（「≡ ツール実行 N」）にならない。メインパネルのライブ（state.bundle）と同じく、本文か人の発言が来るまで 1 つの発言にまとめる。
// 考えた内容を持つ発言と、本文の後ろにツールが続く発言は、区切りのまま。

/** @param {object[]} messages NormalizedMessage の並び。元は変えない */
export function mergeToolTurns(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out.at(-1);
    const mergeable = prev && prev.role === 'assistant' && m.role === 'assistant' && prev.toolCalls?.length && !m.thinking
      && (m.text ? !prev.text && !m.toolCalls?.length : Boolean(m.toolCalls?.length));
    if (!mergeable) { out.push(m); continue; }
    out[out.length - 1] = { ...prev, toolCalls: [...prev.toolCalls, ...(m.toolCalls ?? [])], ...(m.text ? { text: m.text } : {}) };
  }
  return out;
}
