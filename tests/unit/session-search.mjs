// セッション検索の core（core/session-search.mjs。docs/design.md「セッション検索」・ADR 0080）。
// 純粋な部分（語の解釈・照合・関連度・抜粋）と、写しを持つ部分（読み込み・更新・partial）を、偽の一覧と偽の読み手で確かめる。
import {
  parseQuery, fold, placeName, findRanges, makeExcerpt, extractMessages, normalizeInput, encodeCursor, createSessionSearch,
} from "../../core/session-search.mjs";

export const name = "session-search";
export const title = "セッション検索: 照合の規則・関連度の順・抜粋の ranges・写しの更新と partial";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);

const msg = (role, text, extra = {}) => ({ role, text, uuid: `${role}-${text.slice(0, 6)}-${Math.random().toString(36).slice(2, 6)}`, at: new Date(NOW).toISOString(), ...extra });

/** 一覧と本文を渡せる、検索の入れ物。now は固定して関連度の新しさを再現できるようにする */
function make(sessions, { delay = 0, ...rest } = {}) {
  const bodies = new Map(sessions.map((s) => [s.id, s.messages ?? []]));
  const calls = { stored: [], full: [] };
  const rows = sessions.map(({ messages, ...row }) => row);
  const search = createSessionSearch({
    listSessions: async () => rows.map((r) => ({ ...r })),
    readStored: async (id) => { calls.stored.push(id); if (delay) await new Promise((r) => setTimeout(r, delay)); return bodies.get(id) ?? null; },
    readFull: async (id) => { calls.full.push(id); if (delay) await new Promise((r) => setTimeout(r, delay)); return bodies.get(id) ?? []; },
    now: () => NOW,
    ...rest,
  });
  return { search, bodies, rows, calls };
}

const row = (id, extra = {}) => ({ id, title: id, status: null, cwd: "D:\\dev\\app", backend: "claude", lastModified: NOW - DAY, delegation: null, ...extra });
const ids = (r) => r.sessions.map((s) => s.sessionId);

export default async function (t) {
  // ------------------------------------------------------------ 語の解釈
  const terms = (q) => parseQuery(q).map((x) => (x.exact ? `"${x.needle}"` : x.needle));
  t.ok("空白区切りは別の語（全角の空白も）", terms("有料　翻訳  CI").join("|") === "有料|翻訳|ci", terms("有料　翻訳  CI").join("|"));
  t.ok("\"…\" は空白を含めて 1 語で、畳まない", terms('"Hello World" ＣＩ').join("|") === '"Hello World"|ci');
  t.ok("閉じていない \" は最後までを 1 語にする", terms('foo "bar baz').join("|") === 'foo|"bar baz"');
  t.ok("空の語・同じ語は捨てる", terms('"" a a "a"').join("|") === 'a|"a"', terms('"" a a "a"').join("|"));
  t.ok("NFKC: 全角英数・半角カナ・合字を畳む", fold("ＣＩ ﬁle ｶﾞｲﾄﾞ") === "ci file ガイド", fold("ＣＩ ﬁle ｶﾞｲﾄﾞ"));
  t.ok("場所はフォルダー名だけ（区切りの違い・末尾の区切り）", placeName("D:\\dev\\pleiad\\") === "pleiad" && placeName("/home/u/dev/app") === "app" && placeName(null) === "");
  let threw = false; try { parseQuery(Array.from({ length: 13 }, (_, i) => `w${i}`).join(" ")); } catch { threw = true; }
  t.ok("語が多すぎるときは黙って切らず断る", threw);

  // ------------------------------------------------------------ 照合
  {
    const { search } = make([
      row("a", { title: "請求書の自動化", cwd: "D:\\dev\\billing", messages: [msg("user", "ＣＩ の設定を見直したい"), msg("assistant", "GitHub Actions のワークフローを直しました。")] }),
      row("b", { title: "その他", cwd: "D:\\dev\\billing", messages: [msg("user", "別の話"), msg("assistant", "Hello World を出力する")] }),
      row("c", { title: "ci", cwd: "D:\\dev\\other", messages: [] }),
    ]);
    const q = async (query, filters, more = {}) => search.search({ query, filters, ...more });
    await search.idle().catch(() => {});
    await q("");   // 始動
    await search.idle();
    t.ok("全角半角を畳んだ部分一致（ci が ＣＩ に当たる）", ids(await q("ci")).includes("a"));
    t.ok("大小を区別しない（github actions）", ids(await q("github")).join() === "a");
    t.ok("日本語の部分一致", ids(await q("設定")).join() === "a");
    t.ok("語は AND（別々の発言に当たってもよい）", ids(await q("設定 github")).join() === "a");
    t.ok("1 語でも当たらなければ外れる", ids(await q("設定 存在しない")).length === 0);
    t.ok("題・本文のどちらに当たってもよい（請求書 + ワークフロー）", ids(await q("請求書 ワークフロー")).join() === "a");
    t.ok('"…" は大小・全角半角を畳まない', ids(await q('"Hello World"')).join() === "b" && ids(await q('"hello world"')).length === 0 && ids(await q('"ci"')).join() === "c");
    t.ok("\"…\" は空白を含む句を 1 語で探す", ids(await q('"World を"')).join() === "b");
    t.ok("場所はフォルダー名だけに当てる（パスの途中の dev は当たらない）", ids(await q("dev")).length === 0 && ids(await q("billing")).sort().join() === "a,b");
    t.ok("場所の絞り込みは作業ディレクトリの完全一致", ids(await q("", { cwd: "D:/dev/billing/" })).sort().join() === "a,b" && ids(await q("", { cwd: "D:\\dev" })).length === 0);
    t.ok("状態の絞り込み（null は状態なし）", ids(await q("", { status: null })).length === 3 && ids(await q("", { status: "進行中" })).length === 0);
    t.ok("バックエンドの絞り込み", ids(await q("", { backends: ["codex"] })).length === 0 && ids(await q("", { backends: ["claude", "codex"] })).length === 3);
    t.ok("sessionIds でこの会話の中だけを探す", ids(await q("ci", { sessionIds: ["c"] })).join() === "c");
    const r = await q("github");
    t.ok("結果の形（会話の平らな一覧・title/status/cwd/backend/lastModified）", r.total === 1 && r.sessions[0].title === "請求書の自動化" && r.sessions[0].backend === "claude" && r.sessions[0].cwd === "D:\\dev\\billing" && r.sessions[0].status === null && r.sessions[0].lastModified === NOW - DAY);
    t.ok("matched は当たった場所（本文）", r.sessions[0].matched.join() === "message" && (await q("請求書")).sessions[0].matched.join() === "title" && (await q("billing")).sessions[0].matched.join() === "place");
    t.ok("語が無ければ絞り込みだけで並ぶ（新しい順・hits は空）", (await q("")).sessions.every((s) => s.hits.length === 0 && s.matched.length === 0));
  }

  // ------------------------------------------------------------ 発言者・ツールの入力・委譲・期間
  {
    const call = (command) => ({ id: "t1", name: "Bash", input: { command, description: "noise-word" }, result: { text: "huge-output-word" } });
    const { search } = make([
      row("p", { title: "p", messages: [msg("user", "deploy をお願い"), msg("assistant", "deploy しました"), msg("assistant", "", { toolCalls: [call("git worktree remove ../x")] })] }),
      row("q", { title: "q", messages: [msg("assistant", "deploy の手順です")] }),
      row("kid", { title: "kid", delegation: { taskId: "t", parentSessionId: "p", manager: "ply" }, messages: [msg("user", "deploy 子")] }),
      row("old", { title: "old", lastModified: NOW - 40 * DAY, messages: [msg("user", "deploy 古い")] }),
      row("sys", { title: "sys", messages: [{ role: "user", kind: "command", text: "deploy", uuid: "k" }, { role: "assistant", thinking: "deploy", text: "", uuid: "th" }, msg("assistant", "", { toolCalls: [{ id: "x", name: "Read", input: { file_path: "a.txt" }, result: { text: "deploy output" } }] })] }),
    ]);
    const q = (query, filters, more) => search.search({ query, filters, ...more });
    await q(""); await search.idle();
    t.ok("発言者 user: 自分の発言に当たる会話だけ", ids(await q("deploy", { speaker: "user" })).sort().join() === "old,p");
    t.ok("発言者 assistant", ids(await q("deploy", { speaker: "assistant" })).sort().join() === "p,q");
    t.ok("委譲の子は既定で含めない・includeDelegated で含める", !ids(await q("deploy")).includes("kid") && ids(await q("deploy", { includeDelegated: true })).includes("kid"));
    const kid = (await q("deploy", { includeDelegated: true })).sessions.find((s) => s.sessionId === "kid");
    t.ok("委譲の子には依頼元の会話が付く", kid?.parentSessionId === "p");
    t.ok("期間: since / until（ISO も epoch ms も）", ids(await q("deploy", { since: NOW - 7 * DAY })).sort().join() === "p,q"
      && ids(await q("deploy", { until: new Date(NOW - 30 * DAY).toISOString() })).join() === "old"
      && ids(await q("", { since: NOW - 7 * DAY, includeDelegated: true })).sort().join() === "kid,p,q,sys");
    t.ok("ツールの入力は既定で対象外", ids(await q("worktree")).length === 0);
    const tool = await q("worktree", { includeToolInputs: true });
    t.ok("includeToolInputs で入力のコマンドに当たる（role: tool・matched: toolInput）", ids(tool).join() === "p" && tool.sessions[0].matched.join() === "toolInput" && tool.sessions[0].hits[0].role === "tool" && tool.sessions[0].hits[0].excerpt.includes("worktree remove"));
    t.ok("ツールの入力の短い項目だけ（description・出力・thinking・システム行は対象外）", ids(await q("noise-word", { includeToolInputs: true })).length === 0
      && ids(await q("huge-output-word", { includeToolInputs: true })).length === 0 && !ids(await q("deploy", { sessionIds: ["sys"] })).length);
    t.ok("ファイルのパスにも当たる", ids(await q("a.txt", { includeToolInputs: true })).join() === "sys");
  }

  // ------------------------------------------------------------ 関連度と並び
  {
    const mk = (id, title, texts, lastModified = NOW - DAY) => row(id, { title, lastModified, messages: texts.map((x, i) => msg(i % 2 ? "assistant" : "user", x, { at: new Date(NOW - i * 1000).toISOString() })) });
    const { search } = make([
      mk("bodyonly", "雑談", ["翻訳 の話"]),
      mk("title", "翻訳 の検討", ["関係のない話"]),
      mk("many", "雑談2", ["翻訳 1", "翻訳 2", "翻訳 3", "翻訳 4", "翻訳 5", "翻訳 6", "翻訳 7"]),
      mk("fresh", "雑談3", ["翻訳 の話"], NOW),
      mk("ancient", "翻訳 の検討 古い", ["関係のない話"], NOW - 400 * DAY),
    ]);
    const q = (query, more) => search.search({ query, ...more });
    await q(""); await search.idle();
    const rel = await q("翻訳");
    t.ok("関連度: 題に当たる会話が、本文の 1 件だけの会話より先", ids(rel).indexOf("title") < ids(rel).indexOf("bodyonly") && ids(rel).indexOf("title") < ids(rel).indexOf("fresh"), ids(rel).join());
    t.ok("関連度: 一致した発言が多い会話が、少ない会話より先", ids(rel).indexOf("many") < ids(rel).indexOf("bodyonly"), ids(rel).join());
    t.ok("関連度: 同じ条件なら新しい会話が先（新しさは 30 日で 1 減る）", ids(rel).indexOf("fresh") < ids(rel).indexOf("bodyonly"), ids(rel).join());
    t.ok("関連度: 同じ題の一致なら新しい会話が先（新しさの項）", ids(rel).indexOf("ancient") > ids(rel).indexOf("title"), ids(rel).join());
    t.ok("関連度: 新しさの減点には上限があり、1 年前の会話も題に当たれば新しい本文だけの当たりより先", ids(rel).indexOf("ancient") < ids(rel).indexOf("bodyonly"), ids(rel).join());
    const old400 = rel.sessions.find((s) => s.sessionId === "ancient").score, fresh = rel.sessions.find((s) => s.sessionId === "title").score;
    t.ok("関連度: 減点は 90 日で頭打ち（400 日前と 1 日前の差は 3 未満）", fresh - old400 > 2.9 && fresh - old400 <= 3.0, `${fresh - old400}`);
    const two = make([
      row("together", { title: "t1", messages: [msg("user", "alpha beta 同じ発言")] }),
      row("apart", { title: "t2", messages: [msg("user", "alpha だけ"), msg("assistant", "beta だけ")] }),
    ]);
    await two.search.search({ query: "" }); await two.search.idle();
    t.ok("関連度: 全部の語が 1 つの発言に揃えば加点", ids(await two.search.search({ query: "alpha beta" }))[0] === "together", ids(await two.search.search({ query: "alpha beta" })).join());
    const rec = await q("翻訳", { sort: "recent" });
    t.ok("recent: 新しい順（同時刻は id 順）", ids(rec).join() === "fresh,bodyonly,many,title,ancient", ids(rec).join());
    t.ok("recent: lastModified の降順", rec.sessions.every((s, i, a) => i === 0 || a[i - 1].lastModified >= s.lastModified));
    t.ok("score は関連度の順に降順", rel.sessions.every((s, i, a) => i === 0 || a[i - 1].score >= s.score));
    t.ok("hitCount は一致した発言の数", rel.sessions.find((s) => s.sessionId === "many").hitCount === 7 && rel.sessions.find((s) => s.sessionId === "title").hitCount === 0);

    // 上限と続き
    const p1 = await q("翻訳", { limit: 2 });
    t.ok("limit と nextCursor（total は当たった会話の数）", p1.sessions.length === 2 && p1.total === 5 && typeof p1.nextCursor === "string");
    const p2 = await q("翻訳", { limit: 2, cursor: p1.nextCursor });
    const p3 = await q("翻訳", { limit: 2, cursor: p2.nextCursor });
    t.ok("cursor で続きを重ならず最後まで引ける", [...ids(p1), ...ids(p2), ...ids(p3)].join() === ids(rel).join() && p3.nextCursor === undefined, [...ids(p1), ...ids(p2), ...ids(p3)].join());
    let bad = 0; for (const cursor of ["!!", encodeCursor(-1).replace(/./, "x")]) { try { await q("翻訳", { cursor }); } catch (e) { if (e instanceof TypeError) bad++; } }
    t.ok("壊れた cursor は TypeError", bad === 2);
    t.ok("limit は最大 200・hitsPerSession は最大 10 に収める", normalizeInput({ limit: 9999, hitsPerSession: 99 }).limit === 200 && normalizeInput({ hitsPerSession: 99 }).hitsPerSession === 10 && normalizeInput({}).limit === 50 && normalizeInput({}).hitsPerSession === 1);
  }

  // ------------------------------------------------------------ 抜粋と ranges
  {
    const long = `${"前置きの文。".repeat(30)}ここに Needle と 設定 がある。\n\n  改行と   空白は畳む。${"後ろの文。".repeat(60)}`;
    const m = extractMessages([msg("user", long)])[0];
    const rs = findRanges(m.text, m.folded, parseQuery("needle 設定"));
    t.ok("findRanges は元の文字の位置を返す（大小の違いを越える）", rs.length === 2 && m.text.slice(...rs[0]) === "Needle" && m.text.slice(...rs[1]) === "設定", JSON.stringify(rs));
    const ex = makeExcerpt(m.text, rs);
    t.ok("抜粋は一致の手前 16 字から約 140 字・改行と連続空白は 1 つ", ex.excerpt.length <= 140 && !/\s\s|\n/.test(ex.excerpt) && ex.excerpt.indexOf("Needle") === 16, `${ex.excerpt.length} ${ex.excerpt.indexOf("Needle")}`);
    t.ok("ranges は抜粋の中の位置で、一致の字を指す", ex.ranges.map(([a, b]) => ex.excerpt.slice(a, b)).join("|") === "Needle|設定", JSON.stringify(ex.ranges));
    const folded = extractMessages([msg("assistant", "…前置き… ｶﾞｲﾄﾞ ＣＩ ﬁle 本文…")])[0];
    const fr = findRanges(folded.text, folded.folded, parseQuery("ガイド ci file"));
    t.ok("畳むと長さが変わる文字があっても ranges は元の文字を指す", fr.map(([a, b]) => folded.text.slice(a, b)).join("|") === "ｶﾞｲﾄﾞ|ＣＩ|ﬁle", fr.map(([a, b]) => folded.text.slice(a, b)).join("|"));
    const exact = findRanges("Foo foo FOO", "foo foo foo", parseQuery('"foo"'));
    t.ok("\"…\" の ranges は大小を畳まない", exact.length === 1 && exact[0][0] === 4);
    t.ok("先頭付近の一致は手前に余白を取らない・末尾でも壊れない", makeExcerpt("abc needle", [[4, 10]]).excerpt === "abc needle" && makeExcerpt("x", []).excerpt === "x");
    t.ok("サロゲートペアを窓の端で割らない", !/[\ud800-\udbff]$|^[\udc00-\udfff]/.test(makeExcerpt("😀".repeat(100) + "needle" + "😀".repeat(100), [[200, 206]]).excerpt));

    // 抜粋に選ぶ発言: 題に無い語を多く含む発言 → 語を多く含む発言 → 新しい発言
    const { search } = make([
      row("pick", { title: "alpha の会話", messages: [
        msg("user", "alpha だけを含む発言", { uuid: "only-title-term", at: new Date(NOW).toISOString() }),
        msg("assistant", "beta を含む発言", { uuid: "non-title-term", at: new Date(NOW - 5000).toISOString() }),
        msg("assistant", "alpha と beta の両方", { uuid: "both", at: new Date(NOW - 9000).toISOString() }),
        msg("user", "beta だけの新しい発言", { uuid: "newer-beta", at: new Date(NOW - 1000).toISOString() }),
      ] }),
    ]);
    await search.search({ query: "" }); await search.idle();
    const h = (await search.search({ query: "alpha beta", hitsPerSession: 4 })).sessions[0].hits.map((x) => x.uuid);
    t.ok("抜粋の順: 題に無い語を多く含む発言 → 語を多く含む → 新しい", h.join() === "both,newer-beta,non-title-term,only-title-term", h.join());
    t.ok("hit は uuid・index・role・at・excerpt・ranges を持つ", (await search.search({ query: "beta" })).sessions[0].hits[0].index >= 0);
  }

  // ------------------------------------------------------------ 写しの読み込み・partial・更新
  {
    const sessions = Array.from({ length: 6 }, (_, i) => row(`s${i}`, { title: `会話${i}`, lastModified: NOW - i * 1000, messages: [msg("user", `共通の語 本文${i}`)] }));
    const fx = make(sessions, { delay: 20, concurrency: 2 });
    const r0 = await fx.search.search({ query: "共通の語" });
    t.ok("起動直後は読めた分で答え partial: true", r0.partial === true && r0.total < 6, `${r0.total} partial=${r0.partial}`);
    t.ok("status: indexed と pending", fx.search.status().indexed + fx.search.status().pending >= 6 && fx.search.status().pending > 0);
    await fx.search.idle();
    const r1 = await fx.search.search({ query: "共通の語" });
    t.ok("読み込みが終われば partial: false・全件に当たる", r1.partial === false && r1.total === 6);
    const st = fx.search.status();
    t.ok("status: 全部写した（pending 0・updatedAt あり）", st.indexed === 6 && st.pending === 0 && Number.isFinite(st.updatedAt), JSON.stringify(st));
    t.ok("最初は保存分から読み、足りない所だけ全量を読む", fx.calls.stored.length === 6 && fx.calls.full.length === 0, JSON.stringify(fx.calls));

    // loadSession・ターンの終わりで読んだ履歴の取り込み
    t.ok("ingest で、読んだ履歴を写しに入れる", fx.search.ingest("s0", [msg("user", "取り込んだ新しい本文")], { sig: NOW }) === true);
    t.ok("取り込んだ分に当たる・置き換えた古い本文には当たらない", ids(await fx.search.search({ query: "取り込んだ" })).join() === "s0" && !ids(await fx.search.search({ query: "本文0" })).includes("s0"));
    t.ok("より新しい写しがあれば、遅れて届いた古い読み込みで巻き戻さない", fx.search.ingest("s0", [msg("user", "古い読み込み")], { sig: NOW - 5000 }) === false && ids(await fx.search.search({ query: "古い読み込み" })).length === 0);
    t.ok("会話の本文ではない行は写さない（kind・thinking・ツールの出力）", fx.search.ingest("s1", [{ role: "user", kind: "command", text: "/model" }, { role: "assistant", text: "", thinking: "考え" }], { sig: NOW }) && ids(await fx.search.search({ query: "model" })).length === 0);

    // lastModified が写しより新しい会話は、探すときに全量を読み直す
    fx.bodies.set("s2", [msg("user", "CLI 側で進んだ末尾")]);
    fx.rows.find((r) => r.id === "s2").lastModified = NOW + 60_000;
    let clock = NOW;
    const stale = createSessionSearch({
      listSessions: async () => fx.rows.map((r) => ({ ...r })), readStored: async (id) => fx.bodies.get(id) ?? null,
      readFull: async (id) => { fx.calls.full.push(id); return fx.bodies.get(id) ?? []; }, now: () => clock, rereadCooldownMs: 0,
    });
    await stale.search({ query: "" }); await stale.idle();
    fx.bodies.set("s2", [msg("user", "さらに進んだ末尾")]);
    fx.rows.find((r) => r.id === "s2").lastModified = NOW + 120_000;
    clock = NOW + 200_000;   // 読み直した写しの sig が lastModified 以後になる（実際の時計と同じ）
    const after = await stale.search({ query: "さらに進んだ" });
    t.ok("lastModified が写しより新しい会話は、探すときに読み直す", ids(after).join() === "s2" && fx.calls.full.includes("s2"), JSON.stringify(fx.calls.full));
    t.ok("読み直しが間に合えば partial ではない", after.partial === false);

    // 読み直しが遅いときは待ち切らず、古い写しで答えて partial
    const slow = make([row("z", { lastModified: NOW + 1, messages: [msg("user", "古い本文")] })], { staleWaitMs: 30, rereadCooldownMs: 0, delay: 0 });
    await slow.search.search({ query: "" }); await slow.search.idle();
    slow.rows[0].lastModified = NOW + 9_999_999;
    const gate = { release: null };
    const slowSearch = createSessionSearch({
      listSessions: async () => slow.rows.map((r) => ({ ...r })), readStored: async () => [msg("user", "古い本文")],
      readFull: () => new Promise((resolve) => { gate.release = () => resolve([msg("user", "新しい本文")]); }),
      now: () => NOW, staleWaitMs: 30, rereadCooldownMs: 0,
    });
    await slowSearch.search({ query: "" }); await slowSearch.idle().catch(() => {});
    gate.release?.(); await slowSearch.idle();
    slow.rows[0].lastModified = NOW + 9_999_999;
    const late = await slowSearch.search({ query: "古い本文" });
    t.ok("読み直しが遅いときは待ち切らず、古い写しで答えて partial: true", late.partial === true && ids(late).join() === "z", JSON.stringify({ partial: late.partial, ids: ids(late) }));
    gate.release?.(); await slowSearch.idle();
    t.ok("読み直しが終われば新しい写しに当たる", ids(await slowSearch.search({ query: "新しい本文" })).join() === "z");

    // 読めなかった会話は partial を立て続けない・一覧から消えた会話の写しは捨てる
    const errors = [];
    const broken = createSessionSearch({
      listSessions: async () => [row("ok", { messages: [] }), row("ng")], readStored: async (id) => { if (id === "ng") throw new Error("boom"); return [msg("user", "読めた本文")]; },
      readFull: async () => { throw new Error("boom"); }, now: () => NOW, onError: (id) => errors.push(id),
    });
    await broken.search({ query: "" }); await broken.idle();
    const res = await broken.search({ query: "読めた" });
    t.ok("読めなかった会話があっても残りに答え、partial を立て続けない", ids(res).join() === "ok" && res.partial === false && errors.join() === "ng", JSON.stringify({ ids: ids(res), partial: res.partial, errors }));

    let live = [row("keep"), row("gone")];
    const prune = createSessionSearch({ listSessions: async () => live, readStored: async (id) => [msg("user", `${id} の本文`)], readFull: async () => [], now: () => NOW });
    await prune.search({ query: "" }); await prune.idle();
    live = [row("keep")];
    for (let i = 0; i < 3; i++) await prune.search({ query: "" });
    t.ok("一覧から消えた会話の写しは（続けて消えていたとき）捨てる", prune.status().indexed === 1);

    // stop 後は読み込まない
    const stopped = make([row("x", { messages: [msg("user", "x")] })]);
    stopped.search.stop(); stopped.search.refresh("x");
    t.ok("stop した後は読み込みを始めない", stopped.calls.stored.length + stopped.calls.full.length === 0);
  }
}
