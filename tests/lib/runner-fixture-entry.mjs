// tests/unit/runner-contract.mjs の試験用の入口。tests/run.mjs と同じ作りで、登録だけを tests/lib/runner-fixtures/ の小さな suite にする。
//   RUNNER_FIXTURE_FILES  登録する suite（"./fx-pass-a.mjs" の JSON 配列）
//   RUNNER_FIXTURE_WEIGHTS  時間の重み（既定 tests/lib/runner-fixtures/weights.json）
process.env.AGENT_HOST_LOCALE ||= "ja";
import * as testEnv from "./test-env.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "runner-fixtures");
const code = await main({
  suites: JSON.parse(process.env.RUNNER_FIXTURE_FILES ?? "[]"),
  baseDir: dir,
  unitDir: null,
  argv: process.argv.slice(2),
  root: path.resolve(here, "..", ".."),
  weightsFile: process.env.RUNNER_FIXTURE_WEIGHTS ?? path.join(dir, "weights.json"),
  testEnv,
});
await testEnv.cleanupTestData();
process.exit(code);
