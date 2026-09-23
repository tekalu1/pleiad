import { createReadCompletions, READ_STORE } from "../../web/unread.mjs";

export const name = "unread";
export const title = "完了と確認を区別し、確認はホストへ送る・古い確認で巻き戻らない・旧版の確認済みを 1 度だけ移す";

const tick = () => new Promise(r => setTimeout(r, 0));

export default async function(t) {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v), removeItem: k => values.delete(k) };
  const sent = [];
  let online = true;
  const send = async reads => { if (!online) throw new Error("offline"); sent.push(reads); };

  const read = createReadCompletions({ storage, send });
  t.ok("既存の履歴と未送信には印を付けない", !read.hasUnread({ id: "a" }));
  t.ok("完了した結果は未確認", read.hasUnread({ id: "a", completedAt: 100 }));
  read.mark("a", 100);
  t.ok("表示済みの完了は確認済み", !read.hasUnread({ id: "a", completedAt: 100 }));
  await tick(); await tick();
  t.ok("確認はホストへ送る", JSON.stringify(sent) === JSON.stringify([[["a", 100]]]), JSON.stringify(sent));
  t.ok("次の完了は再び未確認", read.hasUnread({ id: "a", completedAt: 200 }));
  read.mark("a", 100);
  t.ok("遅れた履歴読み込みで新しい完了を消さない", read.hasUnread({ id: "a", completedAt: 200 }));
  t.ok("localStorage には書かない", !values.has(READ_STORE));

  // ---- ホストの確認（一覧の readAt・read イベント）を取り込む ----
  t.ok("read イベントを取り込むと変わったと答える", read.apply([["a", 200]]) === true);
  t.ok("別の窓・端末の確認で消える", !read.hasUnread({ id: "a", completedAt: 200 }));
  t.ok("古い確認で巻き戻らない", read.apply([["a", 50]]) === false && !read.hasUnread({ id: "a", completedAt: 200 }));
  const fresh = createReadCompletions({ storage, send });
  fresh.fromSessions([{ id: "b", completedAt: 300, readAt: 300 }, { id: "c", completedAt: 400, readAt: null }]);
  t.ok("再読み込み後は一覧の readAt から確認済みを得る", !fresh.hasUnread({ id: "b", completedAt: 300 }) && fresh.hasUnread({ id: "c", completedAt: 400 }));

  // ---- つながっていない間の確認は残し、つながったら送る ----
  online = false;
  sent.length = 0;
  read.mark("d", 500);
  await tick(); await tick();
  t.ok("切れている間もこの窓では確認済み", !read.hasUnread({ id: "d", completedAt: 500 }));
  online = true;
  await read.flush();
  t.ok("つながったら送り直す", JSON.stringify(sent) === JSON.stringify([[["d", 500]]]), JSON.stringify(sent));
  sent.length = 0;
  await read.flush();
  t.ok("受け取られた分は二度送らない", sent.length === 0, JSON.stringify(sent));

  // ---- 旧版の確認済み（localStorage）を 1 度だけ移す ----
  values.set(READ_STORE, JSON.stringify([["x", 700], ["y", 800], ["bad", "no"]]));
  online = false;
  const migrating = createReadCompletions({ storage, send });
  t.ok("旧版の確認済みはすぐ画面に効く", !migrating.hasUnread({ id: "x", completedAt: 700 }));
  await migrating.flush();
  t.ok("送れなければ旧版の分は消さない", values.has(READ_STORE));
  online = true;
  sent.length = 0;
  await migrating.flush();
  t.ok("つながったら旧版の分を送る", JSON.stringify(sent) === JSON.stringify([[["x", 700], ["y", 800]]]), JSON.stringify(sent));
  t.ok("受け取られたら旧版の分を消す", !values.has(READ_STORE));
  sent.length = 0;
  await createReadCompletions({ storage, send }).flush();
  t.ok("次に開いたときは送らない", sent.length === 0);

  const blocked = createReadCompletions({ storage: { getItem() { throw Error(); }, removeItem() { throw Error(); } }, send });
  blocked.mark("a", 100);
  t.ok("保存場所が使えなくても動作", !blocked.hasUnread({ id: "a", completedAt: 100 }));
  values.set(READ_STORE, "broken");
  t.ok("壊れた保存内容で起動を妨げない", createReadCompletions({ storage, send }).hasUnread({ id: "a", completedAt: 100 }));
  const noSend = createReadCompletions();
  noSend.mark("a", 100);
  t.ok("送り先が無くても落ちない", !noSend.hasUnread({ id: "a", completedAt: 100 }));
}
