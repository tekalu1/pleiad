// Claude のモデル一覧（core/backends/claude.mjs の loadCatalog）は、手元に古い一覧・別の作業場所で取れた一覧があれば、
// 引き直し（CLI を起こして 10 秒ほど掛かる）を待たずに返し、引き直しは裏で走らせる。
// 新しい会話の作成（createSession）が models(cwd) を待つので、ここが遅いと会話を作るたびに待たされた。
// 実際の CLI は呼ばず、setClaudeSdkForTest で遅い probe と executable を差し替えて確かめる。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backend as claude, setClaudeSdkForTest } from "../../core/backends/claude.mjs";

export const name = "claude-catalog-stale";
export const title = "Claude のモデル一覧: 手元に一覧があれば引き直しを待たない";

const ROW_V1 = { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", description: "Sonnet 5 · test" };
const ROW_V2 = { value: "claude-sonnet-5-5", resolvedModel: "claude-sonnet-5-5", description: "Sonnet 5.5 · test" };
const has = (models, id) => Object.hasOwn(models, id);
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

export default async function (t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-catalog-stale-"));
  const exe = path.join(dir, "claude-fake-cli");
  fs.writeFileSync(exe, "v1");   // 他のテストが覚えた一覧と目印が食い違うので、一覧は忘れた状態から始まる
  const cwdA = path.join(dir, "a"), cwdB = path.join(dir, "b"), cwdC = path.join(dir, "c");
  for (const d of [cwdA, cwdB, cwdC]) fs.mkdirSync(d);

  const probes = [];   // 遅い probe。resolve / reject を手で呼ぶまで返らない
  const calls = (cwd) => probes.filter((p) => p.cwd === cwd).length;
  let instant = null;   // 立っている間は、probe はすぐ返す
  const restore = setClaudeSdkForTest({
    executable: () => exe,
    cliSigThrottleMs: 0,
    probe: (cwd) => instant
      ? Promise.resolve({ rows: instant, efforts: {}, applied: true })
      : new Promise((resolve, reject) => probes.push({ cwd, resolve, reject })),
  });
  const realNow = Date.now, realError = console.error;
  const keepAlive = setInterval(() => {}, 1000);   // 待ちの timer は unref なので、probe が返らない間にプロセスが終わらないようにする
  const timed = async (fn) => { const at = realNow(); const v = await fn(); return { v, ms: realNow() - at }; };

  try {
    // 手元に何も無い初回は、引き直しの結果を待って答える
    instant = [ROW_V1];
    let r = await timed(() => claude.models(cwdA));
    t.ok("初回は引いた一覧で答える", has(r.v, "claude-sonnet-5") && calls(cwdA) === 0, Object.keys(r.v).join(","));
    instant = null;

    // 別の作業場所の初めて: 別の条件で取れた一覧で先に答え、引き直しは裏で走る
    r = await timed(() => claude.models(cwdB));
    t.ok("初めての作業場所は、別の作業場所で取れた一覧を待たずに返す", r.ms < 1000 && has(r.v, "claude-sonnet-5"), `${r.ms}ms ${Object.keys(r.v).join(",")}`);
    t.ok("その間に引き直しが 1 回だけ裏で走る", calls(cwdB) === 1, `${calls(cwdB)} 回`);
    await claude.models(cwdB);
    t.ok("引き直しの途中でもう一度聞いても、引き直しを重ねない", calls(cwdB) === 1, `${calls(cwdB)} 回`);
    probes.find((p) => p.cwd === cwdB).resolve({ rows: [ROW_V1, ROW_V2], efforts: {}, applied: true });
    await tick();
    r = await timed(() => claude.models(cwdB));
    t.ok("引き直しが終われば、その作業場所の一覧で答える", has(r.v, "claude-sonnet-5-5") && calls(cwdB) === 1, `${calls(cwdB)} 回 ${Object.keys(r.v).join(",")}`);

    // TTL が切れても、古い一覧を待たずに返して裏で取り直す
    Date.now = () => realNow() + 31 * 60_000;
    r = await timed(() => claude.models(cwdB));
    t.ok("TTL 切れでも古い一覧を待たずに返す", r.ms < 1000 && has(r.v, "claude-sonnet-5-5"), `${r.ms}ms`);
    t.ok("TTL 切れの取り直しが裏で 1 回走る", calls(cwdB) === 2, `${calls(cwdB)} 回`);
    probes.filter((p) => p.cwd === cwdB)[1].resolve({ rows: [ROW_V2], efforts: {}, applied: true });
    await tick();
    r = await timed(() => claude.models(cwdB));
    t.ok("取り直した一覧に差し替わる", has(r.v, "claude-sonnet-5-5") && !has(r.v, "claude-sonnet-5") && calls(cwdB) === 2, `${calls(cwdB)} 回 ${Object.keys(r.v).join(",")}`);
    Date.now = realNow;

    // 取り直しが失敗したら、古い一覧のまま。CATALOG_RETRY（60 秒）の間は引き直しを重ねない
    console.error = () => {};
    Date.now = () => realNow() + 62 * 60_000;
    await claude.models(cwdB);
    probes.filter((p) => p.cwd === cwdB)[2].reject(new Error("probe failed"));
    await tick();
    r = await timed(() => claude.models(cwdB));
    t.ok("取り直しが失敗しても古い一覧で答える", has(r.v, "claude-sonnet-5-5"), Object.keys(r.v).join(","));
    t.ok("失敗の再試行待ちの間は引き直しを重ねない", calls(cwdB) === 3, `${calls(cwdB)} 回`);
    Date.now = realNow;

    // 一覧が無い作業場所の取り直しが失敗しても、別の作業場所の一覧で答え続ける（固定の一覧へ戻らない）
    Date.now = () => realNow() + 100 * 60_000;
    r = await timed(() => claude.models(cwdC));
    probes.find((p) => p.cwd === cwdC).reject(new Error("probe failed"));
    await tick();
    const again = await timed(() => claude.models(cwdC));
    t.ok("初めての作業場所の取り直しが失敗しても、別の作業場所で取れた一覧で答える",
      has(r.v, "claude-sonnet-5-5") && has(again.v, "claude-sonnet-5-5") && again.ms < 1000 && calls(cwdC) === 1,
      `${calls(cwdC)} 回 ${Object.keys(again.v).join(",")}`);
    Date.now = realNow;

    // 会話を作るときの確かめ（validModel）も待たない
    const v = await timed(() => claude.validModel("claude-sonnet-5-5", cwdC));
    t.ok("validModel も古い一覧で答える", v.v === true && v.ms < 1000, `${v.v} ${v.ms}ms`);

    // 手元に何も無い（CLI が更新されて一覧を忘れた）間は待つが、待つのは CATALOG_WAIT までを全員で共有する
    fs.writeFileSync(exe, "v2-longer-content-after-update");
    setClaudeSdkForTest({});   // Date.now を進めた間に覚えた CLI の目印を捨てる
    const cwdD = path.join(dir, "d"), cwdE = path.join(dir, "e");
    fs.mkdirSync(cwdD); fs.mkdirSync(cwdE);
    const cold = await timed(() => claude.models(cwdD));
    t.ok("一覧が何も無いときは数秒だけ待ち、引けなければ固定の一覧で答える",
      cold.ms >= 2000 && cold.ms < 6000 && has(cold.v, "opus") && !has(cold.v, "claude-sonnet-5-5"), `${cold.ms}ms ${Object.keys(cold.v).join(",")}`);
    const next = await timed(() => claude.models(cwdE));
    const nextEfforts = await timed(() => claude.models(cwdD));
    t.ok("続けて聞いても待ちを重ねない", next.ms < 500 && nextEfforts.ms < 500, `${next.ms}ms ${nextEfforts.ms}ms`);
    // 引けたら、待っていた作業場所もそれ以外もその一覧で答える
    for (const p of probes.filter((p) => p.cwd === cwdD || p.cwd === cwdE)) p.resolve({ rows: [ROW_V2], efforts: {}, applied: true });
    await tick();
    const warm = await timed(() => claude.models(cwdD));
    t.ok("引けた後はその一覧で答える", has(warm.v, "claude-sonnet-5-5") && warm.ms < 500, `${warm.ms}ms`);
  } finally {
    Date.now = realNow;
    console.error = realError;
    clearInterval(keepAlive);
    restore();
    for (const p of probes) p.resolve({ rows: [ROW_V1], efforts: {}, applied: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
