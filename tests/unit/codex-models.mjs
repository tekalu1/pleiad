// codex の model/list の読み方と覚え方。子プロセスは使わず、RPC の境界だけを差し替える。
//   - nextCursor を追って全ページ読む。1 ページでも落ちたら全体を失敗にする（半端な一覧を覚えない）
//   - 覚えるのは TTL の間だけ。失敗は覚えない。引き直しに失敗したら前の一覧を出す
//   - ログイン・ログアウトで捨てる。途中だった引きの結果（前のアカウントの一覧）も覚えない
//   - タイトル生成のモデルは一覧から選ぶ（titleModel）
import { backend, forgetModels, titleModel } from "../../core/backends/codex.mjs";
import { rpc } from "../../core/backends/codex-rpc.mjs";

export const name = "codex-models";
export const title = "codex のモデル一覧をページを追って読み、少しの間だけ覚える";

const CWD = "codex-models-test";   // config/read の覚えを他のテストと分ける
const row = (id, extra = {}) => ({ id, model: id, displayName: id, hidden: false, isDefault: false,
  defaultReasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium"].map(reasoningEffort => ({ reasoningEffort })), ...extra });
const ids = (models) => Object.keys(models).filter(Boolean).join(",");

export default async function (t) {
  const originals = { request: rpc.request, onNotify: rpc.onNotify };
  const ttl = process.env.AGENT_HOST_CODEX_MODELS_TTL_MS;
  const quiet = console.error;
  let pages = [];                 // cursor（最初は null）-> 応答（関数なら呼ぶ）
  const asked = [];               // model/list に渡った params
  let notify = null;
  rpc.onNotify = (fn) => { notify = fn; return () => { notify = null; }; };
  rpc.request = async (method, params) => {
    if (method === "config/read") return { config: {} };
    if (method === "account/logout") return {};
    if (method === "account/login/start") return { loginId: "lg1", authUrl: "https://auth.example.invalid/" };
    if (method !== "model/list") throw new Error(`unexpected RPC: ${method}`);
    asked.push(params);
    const page = pages[params.cursor ?? null];
    if (!page) throw new Error(`知らない cursor: ${params.cursor}`);
    return typeof page === "function" ? page() : page;
  };
  const twoPages = (second = "b") => ({
    null: { data: [row("a", { isDefault: true })], nextCursor: "c1" },
    c1: { data: [row(second), row("secret", { hidden: true })], nextCursor: null },
  });
  console.error = () => {};   // 失敗の行（わざと落とす）で出力を汚さない

  try {
    forgetModels();
    delete process.env.AGENT_HOST_CODEX_MODELS_TTL_MS;

    // ---- ページを追う
    pages = twoPages();
    let models = await backend.models(CWD);
    t.ok("nextCursor を追って 2 ページとも読む", ids(models) === "a,b", ids(models));
    t.ok("2 ページ目は cursor を渡して引く",
      asked.length === 2 && asked[0].cursor === undefined && asked[1].cursor === "c1", JSON.stringify(asked));
    t.ok("既定（isDefault）は 1 ページ目のものに解決される", models[""].resolvesTo === "a", JSON.stringify(models[""]));

    // ---- 覚える・同時の呼び出しは分け合う
    await backend.models(CWD);
    t.ok("TTL の間は引き直さない", asked.length === 2, `${asked.length} 回`);
    forgetModels();
    asked.length = 0;
    await Promise.all([backend.models(CWD), backend.models(CWD), backend.models(CWD)]);
    t.ok("同時に来た呼び出しは 1 回の引きを分け合う", asked.length === 2, `${asked.length} 回`);

    // ---- TTL が切れたら引き直す
    process.env.AGENT_HOST_CODEX_MODELS_TTL_MS = "0";
    pages = twoPages("c");
    models = await backend.models(CWD);
    t.ok("TTL が切れたら引き直して新しい一覧を返す", ids(models) === "a,c", ids(models));

    // ---- 引き直しの失敗。2 ページ目で落ちたら、半端な一覧ではなく前に引けた一覧を出す
    pages = { null: { data: [row("x")], nextCursor: "c1" }, c1: () => { throw new Error("落ちた"); } };
    models = await backend.models(CWD);
    t.ok("引き直しに失敗したら前に引けた一覧を出す", ids(models) === "a,c", ids(models));
    pages = twoPages("d");
    models = await backend.models(CWD);
    t.ok("失敗は覚えず、次の呼び出しで引き直す", ids(models) === "a,d", ids(models));
    delete process.env.AGENT_HOST_CODEX_MODELS_TTL_MS;

    // ---- 前の一覧が無いときの失敗は「既定に従う」だけ。覚えない
    forgetModels();
    pages = { null: { data: [row("x")], nextCursor: "c1" }, c1: () => { throw new Error("落ちた"); } };
    models = await backend.models(CWD);
    t.ok("途中のページで落ちたら半端な一覧を返さない", ids(models) === "" && "" in models, ids(models));
    pages = twoPages();
    models = await backend.models(CWD);
    t.ok("失敗を覚えていないので、TTL の中でも次で引ける", ids(models) === "a,b", ids(models));

    // ---- ページの上限。cursor が終わらない応答で回り続けない
    forgetModels();
    asked.length = 0;
    pages = { null: { data: [row("a")], nextCursor: "loop" }, loop: { data: [row("a")], nextCursor: "loop" } };
    models = await backend.models(CWD);
    t.ok("ページの上限で止め、失敗として扱う", asked.length === 20 && ids(models) === "", `${asked.length} 回 / ${ids(models)}`);

    // ---- ログアウト・ログインで捨てる
    forgetModels();
    pages = twoPages();
    await backend.models(CWD);
    pages = twoPages("after-logout");
    await backend.auth.logout();
    models = await backend.models(CWD);
    t.ok("ログアウトしたら TTL の中でも引き直す", ids(models) === "a,after-logout", ids(models));

    pages = twoPages("after-login");
    const events = [];
    const login = backend.auth.login({ emit: (e) => events.push(e) });
    for (let i = 0; i < 50 && !notify; i += 1) await new Promise((r) => setTimeout(r, 1));
    notify?.("account/login/completed", { loginId: "lg1", success: true });
    await login;
    models = await backend.models(CWD);
    t.ok("ログインが終わったら引き直す",
      ids(models) === "a,after-login" && events.some((e) => e.phase === "done"), ids(models));

    // 引いている途中にログアウトした。その結果（前のアカウントの一覧）は覚えない
    forgetModels();
    let release;
    const held = new Promise((r) => { release = r; });
    pages = { null: () => held.then(() => ({ data: [row("old")], nextCursor: null })) };
    const stale = backend.models(CWD);
    await new Promise((r) => setTimeout(r, 1));
    await backend.auth.logout();
    pages = { null: { data: [row("new")], nextCursor: null } };
    const fresh = backend.models(CWD);
    release();
    await stale;
    models = await fresh;
    const again = await backend.models(CWD);
    t.ok("ログアウトの前に始まった引きの結果は覚えない",
      ids(models) === "new" && ids(again) === "new", `${ids(models)} / ${ids(again)}`);

    // ---- タイトル生成のモデル（純関数）
    const m = (entries) => Object.fromEntries([["", { label: "既定に従う" }], ...entries]);
    const low = { efforts: ["low", "medium"] };
    t.ok("gpt-5.6-luna があればそれを low で",
      JSON.stringify(titleModel(m([["gpt-6", low], ["gpt-5.4-mini", low], ["gpt-5.6-luna", low]])))
        === JSON.stringify({ model: "gpt-5.6-luna", effort: "low" }));
    t.ok("Luna の別の版は mini より先",
      titleModel(m([["gpt-5.4-mini", low], ["gpt-5.7-luna", low]])).model === "gpt-5.7-luna");
    t.ok("Luna が無ければ mini / nano / spark の順",
      titleModel(m([["gpt-5.3-codex-spark", low], ["gpt-5-nano", low], ["gpt-5.4-mini", low]])).model === "gpt-5.4-mini"
        && titleModel(m([["gpt-5.3-codex-spark", low], ["gpt-5-nano", low]])).model === "gpt-5-nano");
    t.ok("表示名でも探す", titleModel(m([["x-small", { label: "GPT-5 Mini", ...low }]])).model === "x-small");
    t.ok("語の一部（minimal / gemini）では当てない",
      !titleModel(m([["gpt-minimal", low], ["gemini-pro", low]])).model);
    t.ok("軽いモデルが無ければ model を渡さず codex の既定に任せる（段が分からなければ low）",
      JSON.stringify(titleModel(m([["gpt-6", low]]))) === JSON.stringify({ effort: "low" }));
    t.ok("選んだモデルが low を持たなければ effort を渡さない",
      JSON.stringify(titleModel(m([["gpt-5.4-mini", { efforts: ["medium", "high"] }]]))) === JSON.stringify({ model: "gpt-5.4-mini" })
        && JSON.stringify(titleModel({ "": { efforts: ["high"] } })) === "{}");
    t.ok("一覧が空・無しでも落ちない", JSON.stringify(titleModel(null)) === JSON.stringify({ effort: "low" }));

    // suggestTitle が一覧から選んだものを runTurn に渡す（一覧に無いモデルを名指ししない）
    forgetModels();
    pages = { null: { data: [row("gpt-6", { isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }] })], nextCursor: null } };
    const runTurn = backend.runTurn;
    let passed = null;
    backend.runTurn = async (o) => { passed = o; o.emit({ type: "text.delta", text: "題" }); o.emit({ type: "turnResult", outcome: "ok" }); };
    try {
      const text = await backend.suggestTitle({ transcript: "…" });
      t.ok("Luna も軽いモデルも無ければ、既定のモデル・段のままタイトルを作る",
        text === "題" && passed && passed.model === undefined && passed.effort === undefined,
        JSON.stringify({ model: passed?.model, effort: passed?.effort }));
    } finally { backend.runTurn = runTurn; }
  } finally {
    Object.assign(rpc, originals);
    console.error = quiet;
    if (ttl === undefined) delete process.env.AGENT_HOST_CODEX_MODELS_TTL_MS;
    else process.env.AGENT_HOST_CODEX_MODELS_TTL_MS = ttl;
    forgetModels();
  }
}
