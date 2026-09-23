// AI が返したタイトルの整え方。
//
// モデルは鉤括弧やクオートで包む、前置きを付ける、複数行で返す、といったことをする。
// そのまま入れると一覧が読みにくくなるので、サーバ側で整えてから返している。
//
// ※ core/server.mjs の suggestTitle を変えたら、ここも合わせて変えること。
export const name = "title-clean";
export const title = "生成されたタイトルの整え";

const NL = String.fromCharCode(10);

/** core/server.mjs の整形と同じ規則 */
const clean = (raw) =>
  String(raw ?? "").trim().split(NL)[0].replace(/^["'「『]|["'」』。]$/g, "").trim().slice(0, 60);

export default function (t) {
  t.ok("素のタイトルはそのまま", clean("認証まわりの調査") === "認証まわりの調査");

  t.ok("鉤括弧を外す", clean("「認証まわりの調査」") === "認証まわりの調査");
  t.ok("二重鉤括弧も外す", clean("『認証まわりの調査』") === "認証まわりの調査");
  t.ok("クオートを外す", clean('"認証まわりの調査"') === "認証まわりの調査");

  t.ok("末尾の句点を落とす", clean("認証まわりの調査。") === "認証まわりの調査");

  t.ok("複数行なら1行目だけ使う",
    clean("認証まわりの調査" + NL + NL + "この作業は…") === "認証まわりの調査",
    "モデルが説明を付けてくることがある");

  t.ok("前後の空白を落とす", clean("  認証まわりの調査  ") === "認証まわりの調査");

  t.ok("長すぎるものは切る", clean("あ".repeat(100)).length === 60);

  t.ok("空なら空のまま（呼び出し側が断る）", clean("   ") === "");
  t.ok("null でも落ちない", clean(null) === "");
}
