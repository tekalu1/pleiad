// host が離れたときの挙動。
//
// 直した不具合:
//   ターン実行中に WS が切れると、承認が要るツールが全部その場で deny され、
//   しかもターンは走り続けた。読み取り系（AUTO_ALLOW）だけ通るので
//   「何時間も動いているのに成果ゼロ」になる。
//
// 期待:
//   A. 切れているあいだの承認は deny されず保留される
//   B. 猶予内に戻れば聞き直され、許可すればツールが実際に実行される
//   C. 猶予を過ぎたら deny を返し続けずにターンごと中断する
//
// 猶予を短くしたサーバが要るので、このテストだけ専用のサーバで動かす（tests/e2e.mjs が用意する）。
// 途中で誰かが繋いでいると猶予が始まらないので、接続は常に1本だけにする。
import path from "node:path";
import fs from "node:fs/promises";
import { sleep } from "../lib/ws-client.mjs";

export const name = "disconnect";
export const title = "切断・再接続・猶予切れ";

export const serverEnv = { AGENT_HOST_GRACE_MS: "15000" };

export default async function (t, ctx) {
  const grace = Number(ctx.serverEnv?.AGENT_HOST_GRACE_MS ?? 15000);
  const prompt = (f) => `Write ツールで ${f} に "x" と1行書いて。説明不要。`;

  // ---- A + B: 猶予内に戻る ------------------------------------------------
  const out = path.join(ctx.work, "disconnect-out.md");
  await fs.rm(out, { force: true });

  const a = await ctx.open();
  a.cmd("runTurn", { prompt: prompt(out), sessionId: null, cwd: ctx.work, mode: "default" }).catch(() => {});
  await sleep(2500);          // 承認要求より前に切る（保留の経路を通す）
  t.note("承認を返さずに切断");
  a.close();
  await sleep(4000);

  const b = await ctx.open({ autoAllow: true });
  t.ok("再接続でターンが生きている", b.ready.resumedTurn === true, `resumedTurn=${b.ready.resumedTurn}`);

  const ended = await b.waitFor((e) => e.type === "turnEnd", { ms: 180_000 }).then(() => true, () => false);
  t.ok("再接続したターンが最後まで走る", ended, ended ? "" : "turnEnd が来なかった");
  const perm = b.events.find((e) => e.type === "permission");
  t.ok("切断中の承認が deny されず届く", Boolean(perm), perm?.toolName ?? "来ない");
  t.ok("許可したツールが実行された", await fs.access(out).then(() => true, () => false), out);
  await fs.rm(out, { force: true });
  b.close();
  await sleep(500);

  // ---- C: 猶予切れ ---------------------------------------------------------
  const out2 = path.join(ctx.work, "disconnect-out2.md");
  await fs.rm(out2, { force: true });

  const c = await ctx.open();
  c.cmd("runTurn", { prompt: prompt(out2), sessionId: null, cwd: ctx.work, mode: "default" }).catch(() => {});
  await sleep(3000);
  t.note(`切断して戻らない。猶予 ${grace / 1000} 秒 + 余裕を待つ`);
  c.terminate();              // 行儀よく閉じず、host が突然消えた状況にする
  await sleep(grace + 10_000);

  const d = await ctx.open();
  t.ok("猶予切れでターンが中断される", d.ready.resumedTurn === false, `resumedTurn=${d.ready.resumedTurn}`);
  t.ok("中断されたのでファイルは作られない", !(await fs.access(out2).then(() => true, () => false)));
  await fs.rm(out2, { force: true });
  d.close();
}
