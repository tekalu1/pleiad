// tests/browser/history-window.cjs の種。320 発言の会話を fake のデータ置き場に置く（ADR 0902）。
//   - 窓の外（古い側）に visualize の提示 1 件と、窓の中（新しい側）に 2 件。本文は大きい（印になる）
//   - 古い側の 3 番目の発言にだけ「ひつじ印」という語がある（脇の検索から飛ぶと、窓の手前を読み足して着く）
// 使い方: node tests/browser/history-window-seed.mjs <空のデータ置き場> <作業ディレクトリ>
import fs from "node:fs";
import path from "node:path";

const [dir, cwd] = process.argv.slice(2);
if (!dir || !cwd) throw new Error("usage: node history-window-seed.mjs <data dir> <cwd>");
fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
fs.mkdirSync(path.join(dir, "presents"), { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

const ID = "history-window";
const start = Date.parse("2026-09-28T09:00:00+09:00");
const paragraph = n => `段落 ${n}。` + "素早い茶色の狐がのろまな犬を飛び越える。".repeat(4);
const reply = i => `答え ${i}\n\n${Array.from({ length: 1 + (i % 5) * 3 }, (_, n) => paragraph(n + 1)).join("\n\n")}`;
const pad = k => String(k).padStart(2, "0");
const messages = [];
const presents = [];
const visualize = (turn, name) => {
  const reference = `visualize{"path":"${cwd}/${name}.html","title":"${name}"}`;
  presents.push({
    at: new Date(start + (turn * 3 + 1) * 60_000).toISOString(), kind: "visualization", caption: name, path: `${cwd}/${name}.html`, id: name, reference, by: "agent",
    content: `<!doctype html><html><body><h1 id="title">${name}</h1><pre>${"図の中身 ".repeat(1200)}</pre></body></html>`,
  });
  return reference;
};
for (let i = 0; i < 160; i++) {
  const at = k => new Date(start + (i * 3 + k) * 60_000).toISOString();
  messages.push({ role: "user", text: i === 2 ? "この羊の件を見てください: ひつじ印" : `質問 ${pad(i)}`, uuid: `claude:hw:u${i}`, at: at(0), backend: "claude" });
  let text = reply(i);
  if (i === 5) text += `\n${visualize(i, "old-chart")}\n`;
  if (i === 150) text += `\n${visualize(i, "new-chart-a")}\n`;
  if (i === 155) text += `\n${visualize(i, "new-chart-b")}\n`;
  messages.push({ role: "assistant", text, uuid: `claude:hw:a${i}`, at: at(1), backend: "claude" });
}
const info = { sessionId: ID, title: "History window", cwd, createdAt: start, lastModified: Date.parse(messages.at(-1).at) };
fs.writeFileSync(path.join(dir, "conversations", `${ID}.json`), JSON.stringify({ messages }));
fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify({
  [ID]: { segments: [{ backend: "claude", nativeId: `n-${ID}` }], info, backend: "fake", nativeId: null, base: messages.length },
}));
fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify({
  [ID]: { backend: "fake", title: info.title, cwd, createdAt: info.createdAt, lastModified: info.lastModified },
}));
fs.writeFileSync(path.join(dir, "presents", `${ID}.jsonl`), presents.map(p => JSON.stringify(p)).join("\n") + "\n");
console.log(`seeded ${ID}: ${messages.length} messages, ${presents.length} presents`);
