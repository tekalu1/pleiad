// セッション検索（core/session-search.mjs）を、このホストの保存先につなぐ。
// 最初の読み込みは Pleiad が持つ会話の保存分（conversations/<id>.json）を直接読み、
// それ以外の会話はバックエンドの getMessages（ネイティブの末尾を含む）で読む。
import { createSessionSearch } from "./session-search.mjs";
import * as conversations from "./conversations.mjs";
import * as history from "./history.mjs";
import { classifySystemMessages } from "./system-messages.mjs";

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listSessions 会話の一覧（server.mjs の sessionList）
 * @param {(id: string) => Promise<object|null>} deps.resolveBackend 会話のバックエンド（resolveBackendForSession）
 */
export function createHostSessionSearch({ listSessions, resolveBackend, ...rest }) {
  return createSessionSearch({
    listSessions,
    // 保存分には、見分けを足す前のシステム側の行が生のまま残っている。getMessages と同じく読むたびに文面で見分ける
    readStored: async (id) => {
      const raw = await conversations.readStoredMessages(id);
      return raw ? classifySystemMessages(await history.prepareMessages(id, raw)) : null;
    },
    readFull: async (id) => {
      const backend = await resolveBackend(id);
      return backend?.getMessages ? history.prepareMessages(id, await backend.getMessages(id)) : [];
    },
    ...rest,
  });
}
