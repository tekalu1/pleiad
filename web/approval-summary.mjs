// 承認カードの決着後の一行に添える、操作の対象の要約（docs/design-system.md §4.5「承認カード」）。
// 同じツールの承認が続いても見分けが付くよう、入力のうち対象を表す値を 1 つだけ選ぶ。DOM を触らない（tests/unit から直接呼ぶ）。

// 対象を表すキー（エージェントごとに名前が違う）。先にあるものを優先する
const TARGET_KEYS = ['path', 'file_path', 'notebook_path', 'AbsolutePath', 'TargetFile', 'command', 'cmd', 'url', 'pattern', 'query'];

/** 入力から対象の要約（1 行）。見つからなければ最初の文字列の値、それも無ければ '' */
export function approvalTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '';
  const pick = (v) => (typeof v === 'string' && v.trim() ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') && v.length ? v.join(' ') : '');
  for (const key of TARGET_KEYS) {
    const v = pick(input[key]);
    if (v) return oneLine(v);
  }
  for (const v of Object.values(input)) {
    const s = pick(v);
    if (s) return oneLine(s);
  }
  return '';
}

/** 改行と連続する空白を 1 つの空白にし、長すぎるものは切る（全体は title に出す） */
function oneLine(s) {
  const text = String(s).replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
