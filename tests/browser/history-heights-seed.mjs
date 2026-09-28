// tests/browser/history-heights.cjs の種。長い会話（240 件、実寸は仮の高さ 160px より大きいものも小さいものもある）を、
// 切り替え済みの会話の保存分として fake のデータ置き場に置く（fake の会話は起動ごとに消えるが、保存分は残る）。
// 使い方: node tests/browser/history-heights-seed.mjs <空のデータ置き場> <作業ディレクトリ>
import fs from "node:fs";
import path from "node:path";

const [dir, cwd] = process.argv.slice(2);
if (!dir || !cwd) throw new Error("usage: node history-heights-seed.mjs <data dir> <cwd>");
fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const ID = "history-heights";
const start = Date.parse("2026-09-28T09:00:00+09:00");
const paragraph = n => `Paragraph ${n}. ` + "The quick brown fox jumps over the lazy dog. ".repeat(6);
const reply = i => {
  const size = [1, 12, 40, 2, 60, 8][i % 6];
  const parts = Array.from({ length: size }, (_, n) => paragraph(n + 1));
  if (size > 10) parts.push("```js\n" + Array.from({ length: size }, (_, n) => `const line${n} = ${n};`).join("\n") + "\n```");
  return `Reply ${i}.\n\n${parts.join("\n\n")}`;
};
const messages = [];
for (let i = 0; i < 120; i++) {
  const at = t => new Date(start + (i * 2 + t) * 60_000).toISOString();
  messages.push({ role: "user", text: `Question ${i}`, uuid: `claude:hh:u${i}`, at: at(0), backend: "claude" });
  messages.push({ role: "assistant", text: reply(i), uuid: `claude:hh:a${i}`, at: at(1), backend: "claude" });
}
const info = { sessionId: ID, title: "History heights", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
fs.writeFileSync(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify({
  [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: null, base: messages.length },
}));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
  [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified },
}));
console.log(`seeded ${ID}: ${messages.length} messages`);
