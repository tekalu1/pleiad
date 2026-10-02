// セッション検索の種。fake バックエンドの使い捨てのデータ置き場へ、会話の保存分（conversations/<id>.json）と sidecar を書く。
// サーバーを起動する前に呼ぶ。時刻は「今から何日前の何時」で決める（期間の絞り込みを今日の日付に依らず確かめられるように）。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 今日の 0 時（ローカル）から days 日前の hh:mm */
const at = (days, hm) => {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  d.setDate(d.getDate() - days);
  return d.getTime();
};

/**
 * @param {string} dir データ置き場
 * @param {string} cwdRoot 作業ディレクトリの親（pleiad・vtc-web・homepage を作る）
 * @returns {{ ids: object, cwds: object }}
 */
export function seedSearchData(dir, cwdRoot) {
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true });
  const cwds = { pleiad: `${cwdRoot}/pleiad`, vtc: `${cwdRoot}/vtc-web`, site: `${cwdRoot}/homepage` };
  for (const c of Object.values(cwds)) fs.mkdirSync(c, { recursive: true });

  let n = 0;
  const msg = (role, text, days, hm, extra = {}) => ({ role, text, uuid: `claude:n:${++n}`, at: new Date(at(days, hm)).toISOString(), backend: "claude", ...extra });
  const u = (text, days, hm) => msg("user", text, days, hm);
  const a = (text, days, hm) => msg("assistant", text, days, hm);
  const tool = (command, days, hm) => msg("assistant", "", days, hm, { toolCalls: [{ id: `call-${++n}`, name: "Bash", input: { command }, result: { text: "ok", isError: false } }] });

  const convs = {
    "ss-gateway": { title: "gateway のログが重複する", cwd: cwds.vtc, status: "進行中", messages: [
      u("gateway のログが 2 回ずつ出る。起動のたびに増えている気がする", 1, "21:20"),
      tool('rg -n "createLogger" gateway/src', 1, "21:22"),
      a("logger を 2 か所で初期化していました。gateway/src/index.ts の側を消し、logger.ts だけで作るようにします。", 1, "21:25"),
      tool("bun run src/index.ts", 1, "21:31"),
      a("1 行ずつになりました。起動のたびに増える件は、再読み込みで listener が残っていたためです。", 1, "21:40"),
    ] },
    "ss-search": { title: "セッション一覧の検索を速くする", cwd: cwds.pleiad, status: "進行中", messages: [
      u("サイドバーの検索で、会話の中身も探せるようにしたい。まず今の範囲を調べて", 1, "10:12"),
      a("今の検索は題・状態・作業ディレクトリだけが対象です。会話の本文は探していません。", 1, "10:14"),
      u("インデックスは要る？ 800 件くらいある", 1, "10:20"),
      tool("node temporary/scripts/session-search/bench.mjs", 1, "10:21"),
      a("本文だけなら 813 万字で、全件を走査しても 1 回 4〜7ms でした。今はインデックスを作らず、メモリに持って都度探すのを推します。", 1, "10:22"),
    ] },
    "ss-count": { title: "実データの量を数える", cwd: cwds.pleiad, status: null, delegation: { parentSessionId: "ss-search" }, messages: [
      u("~/.agent-host の会話の数と大きさを数えて（読み取りだけ）", 1, "10:16"),
      a("812 件・386MB。発言の本文は 813 万字で、残りの大半はツールの出力でした。", 1, "10:18"),
    ] },
    "ss-release": { title: "リリースノート beta.73", cwd: cwds.pleiad, status: "進行中", messages: [
      u("beta.73 のリリースノートを書いて", 1, "18:01"),
      a("内蔵ブラウザーで HTML を開く変更と、外部の読み込みの確認をまとめました。", 1, "18:05"),
    ] },
    "ss-paid": { title: "有料モードの切り替え", cwd: cwds.vtc, status: "レビュー待ち", messages: [
      u("STT と TTS を有料と無料で切り替えるモックを作って", 2, "09:30"),
      a("有料は gateway 経由のクラウド（Soniox の認識・Cartesia の読み上げ）、無料はブラウザの SpeechRecognition を使う形でモックを作りました。", 2, "09:58"),
      u("翻訳も含めるべき？", 2, "10:05"),
      a("翻訳は含めない案を推します。料金の大半は STT で、翻訳を端末ごとに切り替える意味は薄いためです。", 2, "10:07"),
      u("gateway が落ちたときは無料へ戻す？", 2, "10:30"),
      a("自動では戻さず、入力欄の上に「有料の認識につながりません」と出して、無料へ切り替えられるようにします。", 2, "10:34"),
      u("モックの文言をもう少し短く", 2, "11:02"),
      a("見出しを「認識と読み上げ」に縮め、説明の段落は消しました。", 2, "11:05"),
    ] },
    "ss-price": { title: "認識の料金を見積もる", cwd: cwds.vtc, status: null, delegation: { parentSessionId: "ss-paid" }, messages: [
      u("Soniox とブラウザの認識の料金を比べて。gateway の転送量も含めて", 2, "09:40"),
      a("1 時間あたり Soniox は約 0.12 ドル、gateway の転送は無視できる量でした。", 2, "09:50"),
    ] },
    "ss-e2e": { title: "E2E のポートがぶつかる", cwd: cwds.vtc, status: null, messages: [
      u("make e2e が EADDRINUSE で落ちる", 3, "14:00"),
      tool("Get-NetTCPConnection -State Listen", 3, "14:03"),
      a("storage の 9290 が別のスロットの auth と重なっていました。E2E_PORT_OFFSET を 300 にすれば 8 つとも空いています。", 3, "14:09"),
      tool("make e2e E2E_PORT_OFFSET=300", 3, "14:10"),
    ] },
    "ss-map": { title: "会話の地図の点が大きい", cwd: cwds.pleiad, status: "完了", messages: [
      u("可視化の印が大きい点に見える", 3, "16:00"),
      a("印を線画にして、可視化の印はやめる案をモックにしました。", 3, "16:20"),
    ] },
    "ss-index": { title: "インデックスの方式を比べる", cwd: cwds.pleiad, status: "完了", messages: [
      u("SQLite の FTS と、メモリの転置索引のどちらがいい？", 4, "13:00"),
      a("日本語は語の区切りが無いので、FTS なら trigram が要ります。件数が少ないうちは都度の走査で足ります。", 4, "13:04"),
    ] },
    "ss-top": { title: "トップページの文言", cwd: cwds.site, status: null, messages: [
      u("トップの見出しをもう少し短く。モックの段階で決めたい", 5, "11:00"),
      a("「エージェントを束ねる」に縮めました。", 5, "11:02"),
    ] },
    "ss-dark": { title: "ダークのコントラスト", cwd: cwds.pleiad, status: "完了", messages: [
      u("ダークで弱い字が読みにくい", 6, "15:10"),
      a("--ink-weak を #8a91b8 にして、どの面の上でも 4.5:1 以上にしました。", 6, "15:30"),
    ] },
    "ss-nightly": { title: "E2E を毎晩流す", cwd: cwds.vtc, status: "完了", messages: [
      u("ＣＩ でも E2E を流したい。毎晩でいい", 40, "09:00"),
      a("夜の 3 時に GitHub Actions で流すワークフローを足しました。", 40, "09:20"),
    ] },
  };

  const records = {};
  const sessions = {};
  for (const [id, c] of Object.entries(convs)) {
    const last = Date.parse(c.messages.at(-1).at);
    const info = { sessionId: id, title: c.title, cwd: c.cwd, createdAt: Date.parse(c.messages[0].at), lastModified: last };
    records[id] = { segments: [{ backend: "claude", nativeId: `n-${id}` }], info, backend: "fake", nativeId: null, base: c.messages.length };
    fs.writeFileSync(path.join(dir, "conversations", `${id}.json`), JSON.stringify({ messages: c.messages }));
    sessions[id] = {
      backend: "fake", title: c.title, cwd: c.cwd, status: c.status, statusChangedAt: new Date(last).toISOString(),
      createdAt: info.createdAt, lastModified: last, ...(c.delegation ? { delegation: c.delegation } : {}),
    };
  }
  fs.writeFileSync(path.join(dir, "conversations.json"), JSON.stringify(records));
  fs.writeFileSync(path.join(dir, "sessions.json"), JSON.stringify(sessions));
  return { ids: Object.fromEntries(Object.keys(convs).map((id) => [id, id])), cwds, uuidOf: (id, i) => convs[id].messages[i].uuid, convs };
}

// 手で確かめるときは直接呼ぶ: node tests/lib/search-seed.mjs <データ置き場> <作業ディレクトリの親>
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dir, cwdRoot] = process.argv.slice(2);
  if (!dir || !cwdRoot) throw new Error("usage: node tests/lib/search-seed.mjs <data dir> <cwd root>");
  const r = seedSearchData(dir, cwdRoot);
  console.log(`seeded ${Object.keys(r.ids).length} conversations into ${dir}`);
}
