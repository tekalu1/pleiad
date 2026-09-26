// 文のトークン数の見積もり（設定 › コンテキストの「Pleiad の指示」の合計・シートの本文の下）。
// トークナイザーは持たないので、英数字と記号は 4 文字で 1、それ以外（日本語など）は 1 文字で 1 と数える。
// 画面とサーバー（core/ply-instructions.mjs）で同じ数を出すため、どちらもこれを使う。
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 0;
  let ascii = 0, other = 0;
  for (const ch of s) { if (ch.codePointAt(0) < 0x80) ascii++; else other++; }
  return Math.ceil(ascii / 4) + other;
}
