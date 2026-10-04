// fake バックエンド（core/backends/fake.mjs）の「ゲート」を、テストから開ける。
//
// 台本 "bg 1 gate:<名前>" の裏の子や、途中送信の "HOLD_CONFIRM:<名前>" は、実時間でなく、テストがゲートを開いたときに進む。
// server は別プロセスなので、ゲートの実体は使い捨てのディレクトリのファイル。起動する server の env に gates.env を足す。
//
//   const gates = await createFakeGates(scratch);
//   const server = await startServer({ env: { AGENT_HOST_BACKENDS: "fake", ...gates.env }, dataDir });
//   … prompt: "bg 1 gate:child-a" …
//   await gates.open("child-a");          // 子が終わる
//   await fakeSignal(server, "steer-declined");   // fake が受理しなかった合図（fake.mjs の announce。server の標準出力の 1 行）が出るまで待つ
import fs from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fake が server の標準出力へ出す合図（core/backends/fake.mjs の announce）を待つ。startServer の tail は直近の 200 行 */
export async function fakeSignal(server, name, ms = 30_000) {
  const end = Date.now() + ms;
  while (!server.tail(200).includes(`fake-signal: ${name}`)) {
    if (Date.now() > end) throw new Error(`fake の合図 ${name} が ${ms}ms 出なかった\n${server.tail(10)}`);
    await sleep(20);
  }
}

/** parent の下に使い捨てのゲートのディレクトリを作る（parent ごと消す前提なので、後始末は持たない） */
export async function createFakeGates(parent) {
  const dir = await fs.mkdtemp(path.join(parent, "gates-"));
  return {
    env: { AGENT_HOST_FAKE_GATE_DIR: dir },
    /** ゲートを開く。開いたものは閉じない（名前は場面ごとに分ける） */
    async open(name) { await fs.writeFile(path.join(dir, name), ""); },
  };
}
