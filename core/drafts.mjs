// 入力欄の書きかけのサーバーの写し（ADR 0157 の F35）。スレッドの入力欄の下書きを、端末をまたいで続けられるようにする。
// 端末の localStorage の写しが先（すぐ書ける）で、ここは後から追いかける。Chats の会話の下書き（session_fields の draft）はそのまま。
//   createDrafts({ dataDir, now }) → { save({ key, text, at? }), load({ key }) → { text, at } | null, close() }
//   空の本文を保存すると消す。新しい方（at）だけを残す（古い端末の写しで上書きしない）
import { openData } from './data-schema.mjs';
import { draftTable } from './db.mjs';

export const DRAFT_TEXT_MAX = 100_000;
export const DRAFT_KEY_MAX = 200;

export function createDrafts({ dataDir, now = Date.now } = {}) {
  let table = null, handle = null;
  const open = () => { if (!table) { handle = openData(dataDir); table = draftTable(handle.db); } return table; };
  return {
    save({ key, text, at = now() }) {
      const t = open();
      const known = t.get(key);
      if (known && known.at > at) return { saved: false, at: known.at };
      if (!String(text ?? '').trim()) { t.remove(key); return { saved: true, at }; }
      t.put(key, { text: String(text) }, at);
      return { saved: true, at };
    },
    load({ key }) { return open().get(key); },
    /** DB の接続を離す（データ置き場を消す前。テストの後片付け） */
    close() { handle?.release(); handle = null; table = null; },
  };
}
