// 最近の場所（cwd-recent-places）のテスト。
// - ユーザーが Pleiad で使った実在する場所のみが候補になる。
// - 委譲の子の会話（sidecar に delegation がある）、Pleiad の外の会話（sidecar に cwd が無い）、
//   存在しない場所（消えたフォルダー）は候補に出ない。
// - 一覧の cwd 自体は保持される。
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { startServer, ROOT } from "../lib/server.mjs";
import { open, sleep } from "../lib/ws-client.mjs";

export const name = "cwd-recent-places";
export const title = "最近の場所の候補: Pleiadで使った実在フォルダーのみ・委譲やネイティブ一覧や消えた場所を除外";

const prompt = (name, args) => "ply:" + JSON.stringify({ name, arguments: args });

export default async function (t) {
  // =========================================================================
  // 1. web/client.mjs の cwdOptions() の単体テスト (vm 実行)
  // =========================================================================
  const clientSource = (await fs.readFile(new URL("../../web/client.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const funcStart = clientSource.indexOf("function cwdOptions()");
  if (funcStart < 0) throw new Error("client.mjs に cwdOptions が無い");
  const funcCode = clientSource.slice(funcStart, clientSource.indexOf("\n}", funcStart) + 2);

  const state = { sessions: [] };
  const context = vm.createContext({
    state,
    relTime: (ms) => `${ms}ms ago`,
  });
  vm.runInContext(funcCode, context);

  // 1-1. 空の一覧
  t.ok("セッションが無ければ候補は空", context.cwdOptions().length === 0);

  // 1-2. 様々なセッションが混在するケース
  state.sessions = [
    // ユーザーが Pleiad で使った実在する場所 A（2つのセッションがあり、最新の lastModified が採用される）
    { id: "s1", place: "/path/to/projectA", cwd: "/path/to/projectA", lastModified: 1000 },
    { id: "s2", place: "/path/to/projectA", cwd: "/path/to/projectA", lastModified: 2500 },
    // ユーザーが Pleiad で使った実在する場所 B
    { id: "s3", place: "/path/to/projectB", cwd: "/path/to/projectB", lastModified: 2000 },
    // 委譲の子の会話（place が null）
    { id: "s4", place: null, cwd: "/path/to/delegation-worktree", delegation: { parentSessionId: "s1" }, lastModified: 3000 },
    // Pleiad 外（Claude Code CLI 等）の会話（place が null）
    { id: "s5", place: null, cwd: "/path/to/cli-project", lastModified: 4000 },
    // 削除されたフォルダーの会話（place が null）
    { id: "s6", place: null, cwd: "/path/to/deleted-dir", lastModified: 5000 },
  ];

  const options = context.cwdOptions();
  t.ok("委譲・外部CLI・削除済みフォルダーは候補に含まれない", options.length === 2, `件数=${options.length}`);
  t.ok("候補の並びは最新の lastModified 降順（projectA が先頭）",
    options[0]?.value === "/path/to/projectA" && options[0]?.time === 2500 &&
    options[1]?.value === "/path/to/projectB" && options[1]?.time === 2000,
    JSON.stringify(options));
  t.ok("候補に hint と time が含まれる",
    options[0]?.hint === "2500ms ago" && typeof options[0]?.time === "number");

  // 1-3. 12件上限の確認
  state.sessions = Array.from({ length: 20 }, (_, i) => ({
    id: `s-many-${i}`,
    place: `/path/to/place-${i}`,
    cwd: `/path/to/place-${i}`,
    lastModified: 1000 + i,
  }));
  const limitedOptions = context.cwdOptions();
  t.ok("候補の上限は12件", limitedOptions.length === 12);
  t.ok("最新の12件が降順で並ぶ",
    limitedOptions[0].value === "/path/to/place-19" && limitedOptions[11].value === "/path/to/place-8");

  // =========================================================================
  // 2. core/server.mjs の sessionRow() 単体検証
  // =========================================================================
  const serverSource = (await fs.readFile(new URL("../../core/server.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const rowStart = serverSource.indexOf("function sessionRow(");
  if (rowStart < 0) throw new Error("server.mjs に sessionRow が無い");
  const rowCode = serverSource.slice(rowStart, serverSource.indexOf("\n}", rowStart) + 2);

  const rowCtx = vm.createContext({
    compactionScheduler: { get: () => null },
    interruptedOf: () => null,
    agentLocaleOf: () => null,
    statusChangedByAi: () => null,
    toMs: (v) => (typeof v === "number" ? v : null),
  });
  vm.runInContext(rowCode, rowCtx);

  const fakeBackend = { id: "fake", capabilities: {} };
  // A. sidecar に cwd があり、delegation がない（ユーザーの通常の会話）
  const normalRow = rowCtx.sessionRow(fakeBackend, null, { id: "t1", cwd: "/user/dir" });
  t.ok("sessionRow: ユーザーの会話は place に cwd が入る", normalRow.place === "/user/dir" && normalRow.cwd === "/user/dir");

  // B. sidecar に delegation がある（委譲の子会話）
  const delRow = rowCtx.sessionRow(fakeBackend, null, { id: "t2", cwd: "/worktree/dir", delegation: { parentSessionId: "t1" } });
  t.ok("sessionRow: 委譲の子会話は place が null", delRow.place === null && delRow.cwd === "/worktree/dir");

  // C. sidecar に cwd がない（ネイティブのみの会話）
  const nativeOnlyRow = rowCtx.sessionRow(fakeBackend, { sessionId: "t3", cwd: "/cli/dir" }, { id: "t3" });
  t.ok("sessionRow: sidecar に cwd がない会話は place が null", nativeOnlyRow.place === null && nativeOnlyRow.cwd === "/cli/dir");

  // =========================================================================
  // 3. サーバー統合テスト (startServer 経由)
  // =========================================================================
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-cwd-places-")));
  const dataDir = path.join(scratch, "data");
  await fs.mkdir(dataDir, { recursive: true });

  // テスト用の一時フォルダーを作成
  const existingDirA = path.join(scratch, "project-alpha");
  const existingDirB = path.join(scratch, "project-beta");
  const deletedDir = path.join(scratch, "project-deleted");
  // deletedDir は作成せずに存在しないフォルダーとして扱う
  await fs.mkdir(existingDirA, { recursive: true });
  await fs.mkdir(existingDirB, { recursive: true });

  // サーバー起動前にシードデータを配置
  const seedSessions = {
    "sess-seeded-delegated": {
      backend: "fake",
      cwd: existingDirB,
      delegation: { parentSessionId: "p1", kind: "mechanical" },
      createdAt: 1000,
      lastModified: 1000,
    },
    "sess-seeded-native-only": {
      backend: "fake",
      // cwd がない
      createdAt: 2000,
      lastModified: 2000,
    },
    "sess-seeded-deleted": {
      backend: "fake",
      cwd: deletedDir,
      createdAt: 3000,
      lastModified: 3000,
    },
  };
  await fs.writeFile(path.join(dataDir, "sessions.json"), JSON.stringify(seedSessions, null, 2), "utf8");

  const server = await startServer({
    env: { AGENT_HOST_BACKENDS: "fake" },
    dataDir,
    timeoutMs: 30_000,
  });

  const c = await open({
    port: server.port,
    token: server.token,
  });

  try {
    // 3-1. 実在するフォルダーで新しいセッションを作成
    const sessA = await c.cmd("newSession", { backend: "fake", cwd: existingDirA });

    let list = await c.cmd("listSessions");
    const rowA = list.find((s) => s.id === sessA.sessionId);
    t.ok("実在するフォルダーの会話は place にそのパスが入る", rowA?.place === existingDirA, `place=${rowA?.place}`);
    t.ok("実在するフォルダーの会話は cwd にもそのパスが入る", rowA?.cwd === existingDirA, `cwd=${rowA?.cwd}`);

    // 3-2. 存在しないフォルダーの会話（sess-seeded-deleted）
    const rowDeleted = list.find((s) => s.id === "sess-seeded-deleted");
    t.ok("存在しないフォルダーの会話は place が null になる", rowDeleted?.place === null, `place=${rowDeleted?.place}`);
    t.ok("存在しないフォルダーの会話でも cwd は保持される", rowDeleted?.cwd === deletedDir, `cwd=${rowDeleted?.cwd}`);

    // 3-3. 委譲の子セッション（sess-seeded-delegated）
    const rowDelegated = list.find((s) => s.id === "sess-seeded-delegated");
    t.ok("委譲の子会話は実在するフォルダーでも place が null になる",
      rowDelegated?.place === null, `place=${rowDelegated?.place}`);
    t.ok("委譲の子会話でも cwd は保持される",
      rowDelegated?.cwd === existingDirB, `cwd=${rowDelegated?.cwd}`);

    // 3-4. ネイティブ一覧からのみで sidecar に cwd が無いセッション（sess-seeded-native-only）
    const rowNativeOnly = list.find((s) => s.id === "sess-seeded-native-only");
    t.ok("sidecar に cwd が無い会話は place が null になる",
      rowNativeOnly?.place === null, `place=${rowNativeOnly?.place}`);

    // 3-5. 実際の ply_delegate フローによる委譲の子セッションの検証
    await c.runTurn({
      sessionId: sessA.sessionId,
      prompt: prompt("ply_delegate", { kind: "mechanical", backend: "fake", task: "echo:CHILD_TASK", title: "子会話テスト" }),
    });
    // 子会話が完了するのを少し待つ
    await sleep(200);

    list = await c.cmd("listSessions");
    const childRow = list.find((s) => s.delegation?.parentSessionId === sessA.sessionId);
    t.ok("ply_delegate で作成された本物の子会話も place が null になる",
      Boolean(childRow) && childRow.place === null, `child place=${childRow?.place}`);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
