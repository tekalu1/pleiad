// codex OAuth の移植分（core/auth/）。**ネットワークは使わない**。
//
// 測るのは「移植でずれると黙って壊れるところ」だけ:
//   - PKCE の形（43 文字の base64url）
//   - 貼り戻し入力の 4 形式
//   - state 不一致がネットワーク呼び出しの**前**に落ちること
//   - auth-profiles.json が procway と同じ形・ロック・tmp+rename で書かれること
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePKCE } from "../../core/auth/pkce.mjs";
import {
  createCodexAuthorizationFlow,
  exchangeCodexAuthorizationCode,
  parseCodexRedirect,
  OPENAI_CODEX_OAUTH_CONSTANTS as K,
} from "../../core/auth/openai-codex-oauth.mjs";
import * as tokens from "../../core/auth/procway-token-store.mjs";

export const name = "oauth-codex";
export const title = "codex OAuth の形とトークンの置き場";

const B64URL43 = /^[A-Za-z0-9_-]{43}$/;

export default async function (t) {
  // ---- PKCE
  const { verifier, challenge } = await generatePKCE();
  t.ok("verifier は 43 文字の base64url", B64URL43.test(verifier), verifier);
  t.ok("challenge は 43 文字の base64url", B64URL43.test(challenge), challenge);
  const again = await generatePKCE();
  t.ok("毎回違う", again.verifier !== verifier);

  // ---- authorize URL
  const flow = await createCodexAuthorizationFlow();
  const url = new URL(flow.url);
  t.ok("state は 32 桁の hex", /^[0-9a-f]{32}$/.test(flow.state), flow.state);
  t.ok("authorize 先が変わっていない", `${url.origin}${url.pathname}` === K.AUTHORIZE_URL, url.href.slice(0, 60));
  t.ok("redirect_uri は localhost:1455 固定",
    url.searchParams.get("redirect_uri") === "http://localhost:1455/auth/callback",
    url.searchParams.get("redirect_uri"));
  t.ok("codex フローの非標準パラメータが 3 つとも付く",
    url.searchParams.get("id_token_add_organizations") === "true"
      && url.searchParams.get("codex_cli_simplified_flow") === "true"
      && url.searchParams.get("originator") === "agent-host",
    url.searchParams.get("originator"));
  t.ok("PKCE は S256", url.searchParams.get("code_challenge_method") === "S256");

  // ---- 貼り戻し入力の 4 形式
  const cases = [
    ["フル URL", "http://localhost:1455/auth/callback?code=abc&state=xyz", { code: "abc", state: "xyz" }],
    ["code#state", "abc#xyz", { code: "abc", state: "xyz" }],
    ["生クエリ", "code=abc&state=xyz", { code: "abc", state: "xyz" }],
    ["裸の code", "abc", { code: "abc", state: undefined }],
  ];
  for (const [label, input, want] of cases) {
    const got = parseCodexRedirect(input);
    t.ok(`貼り戻しを読める: ${label}`,
      got.code === want.code && got.state === want.state,
      JSON.stringify(got));
  }
  t.ok("空文字は何も返さない", Object.keys(parseCodexRedirect("   ")).length === 0);

  // ---- state 不一致は fail-fast（fetch まで行かない）
  const realFetch = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called += 1; throw new Error("ここには来ないはず"); };
  try {
    await exchangeCodexAuthorizationCode({
      code: "abc", verifier: "v", expectedState: "aaa", receivedState: "bbb",
    }).then(
      () => t.ok("state 不一致で落ちる", false, "通ってしまった"),
      (err) => t.ok("state 不一致で落ちる", err.message === "State mismatch", err.message),
    );
    t.ok("state 検証はネットワークの前", called === 0, `fetch を ${called} 回呼んだ`);
  } finally {
    globalThis.fetch = realFetch;
  }

  // ---- auth-profiles.json（procway と同じ形式・同じ置き場）
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-host-auth-")));
  try {
    const file = tokens.authProfilesPath(scratch);
    t.ok("置き場は ~/.procway/ai-agent/auth-profiles.json",
      file === path.join(scratch, ".procway", "ai-agent", "auth-profiles.json"), file);

    t.ok("ファイルが無くても空を返す", (await tokens.readProfile("codex", { homeDir: scratch })) === null);

    const creds = { access: "eyJ.a.b", refresh: "r1", expires: 1789012345678, accountId: "acc_12345678" };
    await tokens.writeOAuthProfile("codex", "openai-codex", creds, { homeDir: scratch });

    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const p = raw.profiles?.codex;
    t.ok("procway と同じ形で書かれる",
      p?.provider === "openai-codex" && p?.mode === "oauth"
        && p?.credentials?.refresh === "r1" && p?.credentials?.expires === 1789012345678,
      JSON.stringify(p));
    t.ok("updatedAt が入る", typeof p?.updatedAt === "string" && !Number.isNaN(Date.parse(p.updatedAt)), p?.updatedAt);
    t.ok("tmp ファイルを残さない",
      (await fs.readdir(path.dirname(file))).filter((f) => f.includes(".tmp-")).length === 0);
    t.ok("ロックを残さない", !(await fs.readdir(path.dirname(file))).includes("auth-profiles.json.lock"));

    // 丸ごと置換（マージしない）— procway 側の updateAuthProfile と同じ約束
    await tokens.updateProfile("codex", () => ({ provider: "openai-codex", mode: "oauth", credentials: { access: "z" } }),
      { homeDir: scratch });
    const after = await tokens.readProfile("codex", { homeDir: scratch });
    t.ok("更新はマージせず丸ごと置き換える", after.credentials.refresh === undefined,
      JSON.stringify(after.credentials));

    // 同時書き込み。ロックが効いていれば JSON は壊れない
    await Promise.all([...Array(6)].map((_, i) =>
      tokens.writeOAuthProfile(`p${i}`, "openai-codex", { access: `a${i}` }, { homeDir: scratch })));
    const store = JSON.parse(await fs.readFile(file, "utf8"));
    t.ok("並行書き込みでも壊れない", Object.keys(store.profiles).length === 7,
      Object.keys(store.profiles).join(","));

    await tokens.deleteProfile("codex", { homeDir: scratch });
    t.ok("消せる", (await tokens.readProfile("codex", { homeDir: scratch })) === null);

    // 壊れた JSON は黙って空にしない
    await fs.writeFile(file, "{ broken", "utf8");
    await tokens.readProfile("codex", { homeDir: scratch }).then(
      () => t.ok("壊れた JSON は例外にする", false, "通ってしまった"),
      (err) => t.ok("壊れた JSON は例外にする", /JSON として読めない/.test(err.message), err.message),
    );
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
