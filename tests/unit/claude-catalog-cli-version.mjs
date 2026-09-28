// Claude のモデル一覧のキャッシュ（core/backends/claude.mjs の loadCatalog）は 30 分の TTL で覚えるが、
// claude update で CLI の実体が変わったら、待たずに引き直したい（2026-09-29、2.1.284 で Sonnet 5.5 が増えた例）。
// 版の目印は CLI の実体（sdk.executable() のパス）の mtime・size。実際の CLI・LLM は呼ばず、
// setClaudeSdkForTest で probe と executable を差し替えて確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-catalog-cli-version";
export const title = "Claude のモデル一覧: CLI の版が変わったら TTL の中でも引き直す";

const CWD = process.cwd();
const ROW_V1 = { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", description: "Sonnet 5 · test" };
const ROW_V2 = { value: "claude-sonnet-5-5", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" };

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-catalog-cli-"));
  const exe = path.join(dir, "claude-fake-cli");
  fs.writeFileSync(exe, "v1");

  let calls = 0;
  let rows = [ROW_V1];
  const restore = setClaudeSdkForTest({
    executable: () => exe,
    cliSigThrottleMs: 0,   // テストでは間引かない
    probe: async () => { calls += 1; return { rows, efforts: {}, applied: true }; },
  });

  try {
    let models = await claude.models(CWD);
    t.ok("初回は一覧を引く", calls === 1, `${calls} 回`);
    t.ok("版 1 の一覧が返る", Object.hasOwn(models, "claude-sonnet-5") && !Object.hasOwn(models, "claude-sonnet-5-5"),
      Object.keys(models).join(","));

    models = await claude.models(CWD);
    t.ok("CLI の実体（mtime・size）が変わらない間は 30 分の TTL の中で引き直さない", calls === 1, `${calls} 回`);

    // claude update と同じ形。実体の内容が変わり、mtime・size の両方が変わる
    fs.writeFileSync(exe, "v2-longer-content-after-update");
    rows = [ROW_V1, ROW_V2];
    models = await claude.models(CWD);
    t.ok("CLI の版が変わったら TTL の中でも引き直す", calls === 2, `${calls} 回`);
    t.ok("引き直した一覧に新しいモデルが出る", Object.hasOwn(models, "claude-sonnet-5-5"), Object.keys(models).join(","));

    // 版が変わらないまま、もう一度は引き直さない
    models = await claude.models(CWD);
    t.ok("引き直した後も、版が変わらない間は覚えたままでよい", calls === 2, `${calls} 回`);

    // stat できない（未導入・削除された）ときは、目印無し扱いで今までどおり TTL のまま動く
    fs.rmSync(exe);
    models = await claude.models(CWD);
    t.ok("CLI の実体が読めなくなっても（stat 失敗）、目印無しとして TTL の中では引き直さない", calls === 2, `${calls} 回`);
    t.ok("その間も前に引けた一覧を出す", Object.hasOwn(models, "claude-sonnet-5-5"), Object.keys(models).join(","));
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
