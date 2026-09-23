import { createReadCompletions, READ_STORE } from "../../web/unread.mjs";

export const name = "unread";
export const title = "完了と確認を区別し、再読み込み・別タブ・古い履歴に耐える";

export default function(t) {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  const read = createReadCompletions(storage);
  t.ok("既存の履歴と未送信には印を付けない", !read.hasUnread({ id: "a" }));
  t.ok("完了した結果は未確認", read.hasUnread({ id: "a", completedAt: 100 }));
  read.mark("a", 100);
  t.ok("表示済みの完了は確認済み", !read.hasUnread({ id: "a", completedAt: 100 }));
  t.ok("次の完了は再び未確認", read.hasUnread({ id: "a", completedAt: 200 }));
  read.mark("a", 100);
  t.ok("遅れた履歴読み込みで新しい完了を消さない", read.hasUnread({ id: "a", completedAt: 200 }));
  const other = createReadCompletions(storage);
  t.ok("再読み込み後も確認済みを保持", !other.hasUnread({ id: "a", completedAt: 100 }));
  other.mark("b", 300);
  read.mark("a", 200);
  const restored = createReadCompletions(storage);
  t.ok("別タブの確認済みも保持", !restored.hasUnread({ id: "b", completedAt: 300 }));
  other.merge(values.get(READ_STORE));
  t.ok("storageイベントで同期できる", !other.hasUnread({ id: "a", completedAt: 200 }));
  read.mark("a", 50);
  t.ok("古い完了で確認記録が巻き戻らない", !read.hasUnread({ id: "a", completedAt: 200 }));
  const blocked = createReadCompletions({ getItem() { throw Error(); }, setItem() { throw Error(); } });
  blocked.mark("a", 100);
  t.ok("保存できなくてもメモリ内では動作", !blocked.hasUnread({ id: "a", completedAt: 100 }));
  values.set(READ_STORE, "broken");
  t.ok("壊れた保存内容で起動を妨げない", createReadCompletions(storage).hasUnread({ id: "a", completedAt: 100 }));
}
