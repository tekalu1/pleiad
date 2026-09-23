// 表示の取り違えが起きないことの検査。
//
// 「走らせたまま別のセッションを開く」と、走っている側の流れが手前の画面に混ざりうる。
// 判定はクライアント側（web/client.mjs の isMine）にあるが、あれは DOM と状態を抱えていて
// そのままは呼べない。規則だけをここに写して、同じ入力で同じ答えになることを固定する。
//
// ※ web/client.mjs の isMine を変えたら、ここも合わせて変えること。

export const name = "stream-routing";
export const title = "実行中に画面を移しても流れが混ざらない";

/** web/client.mjs の isMine と同じ規則。state を書き換えるところまで含めて写している。 */
function isMine(state, ev) {
  if (ev.type === "running") return true;
  const id = ev.sessionId;
  if (!id) return true;
  if (state.current) return id === state.current;
  if (state.awaitingSession && ev.type === "session" && ev.first) {
    state.current = id;
    state.awaitingSession = false;
    (state.runningIds ??= new Set()).add(id);   // 自分が走らせたターンは running が来る前から走っている扱い
    return true;
  }
  return false;
}

const RUNNING = "sess-A";
const OTHER = "sess-B";
// プロトコル v2 では本文も正規化イベントで来る。選り分けは sessionId だけを見る
const stream = { type: "text.delta", sessionId: RUNNING, text: "…" };

export default async function (t) {
  // 走らせたまま「新規」を押した直後
  let st = { current: null, awaitingSession: false };
  t.ok("実行中に新規へ移ると、走っている側の流れは入らない", isMine(st, stream) === false);

  // 走らせたまま別のセッションを開いた
  st = { current: OTHER, awaitingSession: false };
  t.ok("別セッションを開くと、走っている側の流れは入らない", isMine(st, stream) === false);

  // 自分で新規を始めた直後は、first の付いた session イベントで id を受け取ってよい
  st = { current: null, awaitingSession: true };
  t.ok("自分が始めた新規は id を受け取れる",
       isMine(st, { type: "session", sessionId: RUNNING, first: true }) === true && st.current === RUNNING);
  t.ok("受け取った id は走っている扱いになる", st.runningIds.has(RUNNING),
       "running が id を載せて来るまで追記中の発言を閉じないため");
  t.ok("受け取った後は続きも入る", isMine(st, stream) === true);

  // 新規待ちでも本文の流れからは id を拾わない（別タブの取り違え防止）
  st = { current: null, awaitingSession: true };
  t.ok("新規待ちでも本文の流れからは id を拾わない",
       isMine(st, stream) === false && st.current === null);

  // 別タブが再開したターンも session を出す（モデルを知らせるため）。あれには first が付かない。
  // 印を見ずに採用すると、自分が始めた新規の代わりに他人のセッションを掴む。
  st = { current: null, awaitingSession: true };
  t.ok("再開ターンの session（first 無し）は新規待ちのタブが採用しない",
       isMine(st, { type: "session", sessionId: OTHER, model: "sonnet" }) === false
       && st.current === null && st.awaitingSession === true);
  t.ok("採用しなかった後も、本物の新規は受け取れる",
       isMine(st, { type: "session", sessionId: RUNNING, first: true }) === true && st.current === RUNNING);

  // セッションに紐づかないもの（running / id なし）はいつでも通す
  st = { current: OTHER, awaitingSession: false };
  t.ok("running はどの画面でも入る", isMine(st, { type: "running", count: 1 }) === true);
  t.ok("id を持たないイベントは入る", isMine(st, { type: "turnEnd" }) === true);
}
