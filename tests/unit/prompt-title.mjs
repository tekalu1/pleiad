// 本文から会話の題を作る（core/prompt-title.mjs）: 見出しの記号・強調・リンクの区切り・コードブロック・添付の印・改行を題に入れない
import { promptTitle, textForTitleModel } from "../../core/prompt-title.mjs";
import { toRow as agyRow } from "../../core/backends/antigravity-store.mjs";

export const name = "prompt-title";
export const title = "会話の題: 最初の発言の Markdown の記号・コードブロック・添付の印・改行を題に入れず、80 字にまとめる";

export default async function (t) {
  const eq = (label, input, want) => { const got = promptTitle(input); t.ok(label, got === want, JSON.stringify(got)); };

  eq("行頭の # と改行を外し、印の行から後ろは使わない", "# Title x\ntext before\n[添付] D:\\dev\\a\\da\nあとの本文", "Title x text before");
  eq("強調・コード・リンクの区切りを外す", "この画面の**行**と__列__を`code`で [直す](https://example.com/x) ![図](a.png)", "この画面の行と列をcodeで 直す 図");
  eq("引用・箇条書き・番号の記号を外す", "> - **大事** な点\n2. 次の点", "大事 な点 次の点");
  eq("コードブロックの中は使わない", "```js\nconst a = 1;\n# not a title\n```\n本文", "本文");
  eq("閉じていないコードブロックは最後まで使わない", "前置き\n```\nx", "前置き");
  eq("1 行に潰れた本文は最初の印の手前で切る", "見てください [添付] C:\\up\\a.png 続きの本文が長く続く", "見てください");
  eq("英語の印も同じ", "Look at this [Attachment] /home/u/a.png and then", "Look at this");
  eq("添付だけの発言は最初の添付のファイル名", "[添付] C:\\up\\photo.png\n\n[添付] C:\\up\\other.png", "photo.png");
  eq("先頭が添付でも、あとに本文があれば本文", "[Attachment] /home/u/pic.jpg\n本文だよ", "本文だよ");
  eq("空白と改行は 1 つにまとめる", "  a \n\n  b\t c  ", "a b c");
  eq("空なら空", "", "");
  eq("80 字まで（字数は文字単位）", "あ".repeat(100), "あ".repeat(80));
  eq("サロゲートペアを割らない", "😀".repeat(90), "😀".repeat(80));

  t.ok("LLM に渡す本文は、印の行をファイル名の括弧に替える", textForTitleModel("a\n[添付] C:\\x\\y.png\nb") === "a\n[y.png]\nb");
  t.ok("印の無い本文はそのまま", textForTitleModel("# x\ntext") === "# x\ntext");

  // バックエンドの行: 本文由来の題は形を整え、人が付けた題には通さない
  const record = (text) => ({ conversationId: "c1", cwd: "/w", createdAt: "2026-09-29T00:00:00Z", lastModified: "2026-09-29T00:00:00Z",
    messages: [{ role: "user", text }] });
  t.ok("agy: 最初の発言から作る題も整える", agyRow(record("## 手順\n**まず**やる\n[添付] /a/b.png")).title === "手順 まずやる");
}
