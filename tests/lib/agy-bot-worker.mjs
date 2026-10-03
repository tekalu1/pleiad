// bot の人格とフォルダーを antigravity に渡す形（core/backends/antigravity.mjs の runTurn の botInstructions・botFolders）を、別プロセスで確かめる。
// 身代わりの agy（tests/lib/fake-agy.mjs）は、エージェント定義の本文を返す台本（prompt = agent-body）と、起こされた引数の控えを持つ。
// バックエンドを読み込むだけで置き場の掃除が走るので、置き場を一時ディレクトリにしてから読み込む（tests/lib/agy-partial-worker.mjs と同じ）。
// 判定は { label, pass, detail } の配列を JSON で stdout に出す（tests/unit/bot-instructions.mjs が t.ok にする）
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agy-bot-")));
const argsFile = path.join(scratch, "args.json");
process.env.AGENT_HOST_DATA = scratch;
process.env.AGENT_HOST_AGY_BIN = `node "${path.join(ROOT, "tests", "lib", "fake-agy.mjs")}"`;
process.env.FAKE_AGY_ARGS_FILE = argsFile;
process.env.FAKE_AGY_AGENT_FILE = path.join(scratch, "agent.json");

const { backend, botSessionKey } = await import("../../core/backends/antigravity.mjs");

const checks = [];
const ok = (label, pass, detail = "") => checks.push({ label, pass: Boolean(pass), detail: String(detail) });
const launches = async () => JSON.parse(await fs.readFile(argsFile, "utf8").catch(() => "[]")).filter((a) => a.includes("--print="));

const cwd = path.join(scratch, "work"), extra = path.join(scratch, "extra"), other = path.join(scratch, "other");
for (const d of [cwd, extra, other]) await fs.mkdir(d, { recursive: true });

async function turn({ sessionId = null, botInstructions = null, botFolders = null, prompt = "agent-body" }) {
  const events = [];
  let id = sessionId;
  await backend.runTurn({
    prompt, sessionId, cwd, mode: "yolo", model: "", effort: "", locale: "ja", signal: null, control: null,
    emit: (e) => { events.push(e); if (e.type === "session") id = e.sessionId; },
    ...(botInstructions ? { botInstructions } : {}), ...(botFolders ? { botFolders } : {}),
  });
  return { id, text: events.filter((e) => e.type === "text.delta").map((e) => e.text).join("") };
}

try {
  // ---- 人格はエージェント定義の本文に入り、フォルダーは --add-dir に入る
  const first = await turn({ botInstructions: "BOT-PERSONA-ONE", botFolders: { additionalDirectories: [extra] } });
  const l1 = await launches();
  ok("人格の文がエージェントの本文（システムプロンプト）に入る", first.text.includes("BOT-PERSONA-ONE"), first.text.slice(0, 200));
  ok("カスタムエージェントで起こす（--agent）", l1.length === 1 && l1[0].includes("--agent"), JSON.stringify(l1[0]));
  const dirs = (a) => a.flatMap((x, i) => (x === "--add-dir" ? [a[i + 1]] : []));
  ok("cwd と bot のフォルダーを --add-dir に渡す", dirs(l1[0]).includes(cwd) && dirs(l1[0]).includes(extra), JSON.stringify(dirs(l1[0])));

  // ---- 同じ人格・同じフォルダーなら起こし直さない
  await turn({ sessionId: first.id, botInstructions: "BOT-PERSONA-ONE", botFolders: { additionalDirectories: [extra] } });
  ok("同じ人格・フォルダーのターンは起こし直さない", (await launches()).length === 1, String((await launches()).length));

  // ---- 人格を直したら起こし直し、新しい人格が本文に入る
  const changed = await turn({ sessionId: first.id, botInstructions: "BOT-PERSONA-TWO", botFolders: { additionalDirectories: [extra] } });
  ok("人格を直すと agy を起こし直す（人格のハッシュが判定に入る）", (await launches()).length === 2, String((await launches()).length));
  ok("起こし直した後は新しい人格だけが本文にある", changed.text.includes("BOT-PERSONA-TWO") && !changed.text.includes("BOT-PERSONA-ONE"), changed.text.slice(0, 200));
  ok("起こし直しても同じ会話を続ける（--conversation）", (await launches())[1].includes("--conversation"));

  // ---- フォルダーを変えても起こし直す
  await turn({ sessionId: first.id, botInstructions: "BOT-PERSONA-TWO", botFolders: { additionalDirectories: [extra, other] } });
  const l3 = await launches();
  ok("フォルダーを変えると起こし直し、新しいフォルダーを --add-dir に渡す", l3.length === 3 && dirs(l3[2]).includes(other), JSON.stringify(dirs(l3.at(-1) ?? [])));

  // ---- bot でない会話は今までどおり（エージェント定義なし）
  const plain = await turn({});
  const l4 = await launches();
  ok("bot でない会話は --agent を付けず、人格の印も無い", l4.length === 4 && !l4[3].includes("--agent") && botSessionKey(null, null) === null && !plain.text.includes("BOT-PERSONA"), JSON.stringify(l4[3]));
  ok("人格の印は人格が同じなら同じ・違えば違う", botSessionKey("a", null) === botSessionKey("a", { additionalDirectories: [] })
    && botSessionKey("a", null) !== botSessionKey("b", null) && botSessionKey("a", { additionalDirectories: ["/x"] }) !== botSessionKey("a", null));

  // ---- 固定文の「覚えて」の 1 文も、ほかのバックエンドと同じく本文に届く（agy は人格の文をそのまま本文に入れる）
  const { botInstructions: build } = await import("../../core/bots/sessions.mjs");
  const real = build({ id: "b_1", name: "Owl", icon: "🦉", persona: "" }, "ja");
  const withReal = await turn({ botInstructions: real });
  ok("判断して覚える案内と内蔵メモリを使わない指示が agy のエージェントの本文にも届く",
    withReal.text.includes("自分の判断で `memory.write` に覚えてよい") && withReal.text.includes("Claude 内蔵のメモリや作業場所の外のファイルには書かない"), withReal.text.slice(0, 400));
} catch (error) {
  ok("worker が最後まで走る", false, error?.stack ?? error);
} finally {
  console.log(JSON.stringify(checks));
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
}
