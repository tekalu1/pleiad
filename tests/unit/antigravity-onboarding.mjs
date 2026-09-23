// Antigravity の導線: **未インストール -> インストール -> 未ログイン -> ログイン -> 使える**。
//
// ここが他のエージェントと揃っていないと、入れても Pleiad からは使えないままになる。
// 実際に踏み抜いた穴を 2 つ、退行しないように留める:
//
//   1. `installation()` は **backend.id** で引かれる。実行ファイル名が `agy` だからと
//      INSTALL_URLS の鍵を `agy` にすると、`installation("antigravity")` が
//      「URL を持たない = 常にインストール済み」になり、**インストール導線が一度も出ない**
//   2. Windows のインストーラは `%LOCALAPPDATA%\\agy\\bin` へ置き、PATH はそのあと
//      `agy install` が書く。**起動済みの Pleiad は PATH の変更を拾えない**ので、
//      置き場を直接見ないと「入れたのに未インストールのまま」になり、Pleiad の再起動が要る
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, ROOT } from "../lib/server.mjs";
import { open } from "../lib/ws-client.mjs";

export const name = "antigravity-onboarding";
export const title = "Antigravity はインストールからログインまで通しで案内される";

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-agyonb-")));
  const fake = path.join(ROOT, "tests", "lib", "fake-agy.mjs");
  const localAppData = path.join(scratch, "local");
  const authFile = path.join(scratch, "signed-in");
  // Unix のインストーラは `$HOME/.local/bin` へ置く。本物の HOME を見ないよう使い捨てへ移す
  const win = process.platform === "win32";
  const home = path.join(scratch, "home");
  await fs.mkdir(localAppData, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  // 開発機に本物の agy が入っていても「入れる前」から始められるよう、agy のある PATH を外す
  const hasAgy = async (dir) => {
    for (const exe of win ? ["agy.exe", "agy.cmd", "agy"] : ["agy"]) {
      if (await fs.access(path.join(dir, exe)).then(() => true, () => false)) return true;
    }
    return false;
  };
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const pathDirs = [];
  for (const dir of (process.env[pathKey] ?? "").split(path.delimiter)) {
    if (dir && !(await hasAgy(dir))) pathDirs.push(dir);
  }

  // **AGENT_HOST_AGY_BIN を渡さない。** 本番と同じく findExecutable に探させる
  const server = await startServer({
    env: {
      AGENT_HOST_BACKENDS: "antigravity",
      [pathKey]: pathDirs.join(path.delimiter),
      LOCALAPPDATA: localAppData,
      FAKE_AGY_NEEDS_AUTH: "1",
      FAKE_AGY_AUTH_FILE: authFile,
      ...(win ? {} : { HOME: home }),
    },
    dataDir: path.join(scratch, "data"),
    timeoutMs: 30_000,
  });

  const c = await open({ port: server.port, token: server.token });

  try {
    // ---- 1. 入れる前
    const before = await c.cmd("authStatus", { backend: "antigravity" });
    t.ok("入れる前は未インストールとして出る", before.installed === false, JSON.stringify(before));
    t.ok("インストール先の案内が付く",
      String(before.installUrl).startsWith("https://antigravity.google/"), String(before.installUrl));
    t.ok("未インストールでもログインは扱えると申告する", before.supported === true, String(before.supported));

    // ---- 2. インストーラと同じ置き場に入れる。**PATH には入れない**
    // Windows は %LOCALAPPDATA%/agy/bin/agy.cmd、Unix は $HOME/.local/bin/agy（実行権付き）
    const bin = win ? path.join(localAppData, "agy", "bin") : path.join(home, ".local", "bin");
    await fs.mkdir(bin, { recursive: true });
    if (win) {
      await fs.writeFile(path.join(bin, "agy.cmd"), `@echo off\r\nnode "${fake}" %*\r\n`);
    } else {
      await fs.writeFile(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    }

    // ---- 3. 「再確認」だけで気づく（**Pleiad を再起動していない**）
    const installed = await c.cmd("authStatus", { backend: "antigravity" });
    t.ok("再起動せずにインストールを見つける", installed.installed === true, JSON.stringify(installed));
    t.ok("見つけた直後はまだ未ログイン", installed.loggedIn === false, JSON.stringify(installed));
    // 見つけられないままログインを見張ると、ログインの時間切れ（10 分）まで帰ってこない
    if (!installed.installed) return;

    // ---- 4. ログイン。**Pleiad からは回せない**ので、端末で叩くコマンドを案内して見張る
    //
    // agy は認可コードを端末からしか読まない（パイプした stdin は無視され 60 秒で時間切れ。
    // 実機で確認）。公式も「Authenticate once with an interactive agy session first」と書いている
    const mark = c.mark();
    const login = c.cmd("authLogin", { backend: "antigravity" });
    const card = await c.waitFor((e) => e.type === "auth" && e.phase === "url", { ms: 30_000, from: mark });
    t.ok("端末で叩くコマンドを案内する", String(card.url).includes("agy"), String(card.url));
    t.ok("端末でしかログインできないと伝える",
      String(card.message).includes("端末"), String(card.message));

    // 利用者が端末でログインを済ませた、に相当する（本物は OS の資格情報ストアに残る）
    await fs.writeFile(authFile, "ok");

    const done = await login;
    t.ok("端末でのログインを見張って自動で終わる", done.supported === true, JSON.stringify(done));
    t.ok("ログイン済みになる", done.loggedIn === true, JSON.stringify(done));

    // 受け取れない貼り付け欄を出さないため、capabilities で申告する
    const b = (await c.cmd("backends")).find((x) => x.id === "antigravity");
    t.ok("コードの貼り戻しは受けられないと申告する",
      b.capabilities?.submitCode === false, String(b.capabilities?.submitCode));

    // ---- 5. そのまま使える
    const turn = await c.runTurn(
      { prompt: "導線", sessionId: null, cwd: ROOT, backend: "antigravity", mode: "yolo" },
      { ms: 60_000 },
    );
    t.ok("ログイン後はそのままターンが通る", turn.outcome === "ok", String(turn.outcome));
  } finally {
    c.close();
    await server.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
