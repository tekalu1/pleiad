// Session lineage and fork boundaries. Rendering and motion live in branch-view.mjs.
// Claude forks reassign UUIDs, so shared history is compared by role, content and tools.
import { t } from "./i18n.mjs";
const toolNames = (m) => (m.toolCalls ?? []).map((c) => c.name).concat(m.tools ?? []).join("\0");

/**
 * 2 つの発言が同じものか。uuid が一致すれば同じ。**一致しなくても**役割・本文・ツール名が同じなら同じ。
 * Claude の forkSession は複製した発言に新しい uuid を振る（実機で確認）ので、uuid だけを見ると
 * 親子の共通接頭辞が 0 になり、分岐点が出ない。thinking だけ・ツールだけの発言（本文が空）も
 * 両方に同じ形で並ぶので、位置を揃えて比べれば足りる
 */
function same(a, b) {
  if (!a || !b) return false;
  if (a.uuid && b.uuid && a.uuid === b.uuid) return true;
  return a.role === b.role && (a.text ?? "") === (b.text ?? "") && toolNames(a) === toolNames(b);
}

/** 共通接頭辞の長さ */
export function commonPrefix(a, b) {
  const n = Math.min(a?.length ?? 0, b?.length ?? 0);
  let i = 0;
  while (i < n && same(a[i], b[i])) i++;
  return i;
}

/**
 * junctions() の添字（数 / "head" / "tail"）を、印を付ける発言の添字にまとめる。
 * head は最初の発言、tail は最後の発言（同じ発言に複数の枝が集まれば 1 つの .jx にする）。発言が無ければ空
 */
export function nodeKeys(junctions, messageCount) {
  const out = new Map();
  for (const [k, entries] of junctions) {
    if (!messageCount && k !== -1) continue;
    const i = k === "head" ? 0 : k === "tail" ? messageCount - 1 : Math.min(Number(k), messageCount - 1);
    if (!out.has(i)) out.set(i, []);
    out.get(i).push(...entries);
  }
  return out;
}

export function createBranches({ cmd, titleOf }) {
  const cache = new Map();     // sessionId -> { lastModified, messages }
  let family = null;           // { rootId, rows: Map<id, { id, title, parent, createdAt, messages, k }> }
  let revision = 0;

  async function messagesOf(row) {
    const hit = cache.get(row.id);
    if (hit && hit.lastModified === row.lastModified) return hit.messages;
    // outline は照合に要る分（uuid・役割・本文・ツール名）だけを返す。家族に大きな会話があると全文は数十MBになる
    const data = await cmd("loadSession", { sessionId: row.id, outline: true }).catch(() => null);
    if (!data) return hit?.messages ?? [];
    const messages = data?.messages ?? [];
    cache.set(row.id, { lastModified: row.lastModified, messages });
    return messages;
  }

  /**
   * 系譜を読む。同じ根を持つセッションが 2 つ以上なければ null。
   * @param {string} currentId
   * @param {Array} currentMessages 今開いているセッションの履歴（読み直さない）
   */
  async function load(currentId, currentMessages) {
    const request = ++revision;
    if (!currentId) { family = null; return null; }
    const lin = await cmd("lineage", { sessionId: currentId }).catch(() => null);
    if (request !== revision) return null;
    if (!lin) { if (!family?.rows.has(currentId)) family = null; return family; }
    if ((lin.sessions ?? []).length < 2) { family = null; return null; }
    const rows = new Map();
    for (const r of lin.sessions) rows.set(r.id, { ...r, messages: [], k: -1 });
    await Promise.all([...rows.values()].map(async (r) => {
      r.messages = r.id === currentId ? currentMessages : await messagesOf(r);
    }));
    // 分岐点。第一の手がかりは sidecar の parent.atMessage（親のどの発言で分けたか）。
    // 無ければ（AI が末尾から分けた・古い記録）親の履歴との共通接頭辞の最後の添字。親が家族に無ければ根と同じ扱い
    for (const r of rows.values()) {
      const p = r.parent?.sessionId ? rows.get(r.parent.sessionId) : null;
      if (!p) { r.k = -1; continue; }
      const at = r.parent.atMessage ? p.messages.findIndex((m) => m.uuid === r.parent.atMessage) : -1;
      const before = r.parent.beforeMessage ? p.messages.findIndex(m => m.uuid === r.parent.beforeMessage) : -1;
      r.k = before >= 0 ? before - 1 : at >= 0 ? at : commonPrefix(p.messages, r.messages) - 1;
    }
    if (request !== revision) return null;
    family = { rootId: lin.rootId, rows };
    return family;
  }

  /** id が currentId の祖先か（親を辿る。循環は rows の数で止める） */
  function isAncestor(id, currentId) {
    let cur = family?.rows.get(currentId);
    for (let i = 0; cur && i < (family?.rows.size ?? 0); i++) {
      const p = cur.parent?.sessionId;
      if (!p) return false;
      if (p === id) return true;
      cur = family.rows.get(p);
    }
    return false;
  }

  /** 系譜を忘れる（新しいセッションを始めたとき） */
  function reset() {
    revision++;
    family = null;
  }

  /** 今の履歴を差し替える（送信や turnEnd の後）。読み直しはしない */
  function update(id, messages) {
    const r = family?.rows.get(id);
    if (r) r.messages = messages;
    cache.delete(id);
  }

  const has = (id) => Boolean(family?.rows.has(id));

  /** 根から順に、親の直後に子（作られた順）を並べる */
  function ordered() {
    if (!family) return [];
    const out = [];
    const walk = (id) => {
      const r = family.rows.get(id);
      if (!r || out.includes(r)) return;
      out.push(r);
      [...family.rows.values()]
        .filter((c) => c.parent?.sessionId === id)
        .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
        .forEach((c) => walk(c.id));
    };
    walk(family.rootId);
    for (const r of family.rows.values()) if (!out.includes(r)) out.push(r);   // 親が辿れないもの
    return out;
  }

  /**
   * 枝の表示名。一覧のタイトルがあればそれ。無ければ根は「はじめの流れ」、他は並び順で「枝 N」。
   * 仮の名前は保存しない。名前はバックエンドが付けるか、人が上の欄で書く
   */
  function nameOf(id) {
    const title = titleOf?.(id) ?? family?.rows.get(id)?.title ?? null;
    if (title && title !== "(no title)") return title;
    const i = ordered().findIndex((r) => r.id === id);
    return i <= 0 ? t("timeline.branch.root") : t("timeline.branch.numbered", { n: i + 1 });
  }

  /** A known fork cut wins even if two branches happen to repeat the same text. */
  function boundary(aId, bId) {
    const chain = id => {
      const out = [];
      let row = family?.rows.get(id);
      while (row && !out.includes(row)) { out.push(row); row = family.rows.get(row.parent?.sessionId); }
      return out;
    };
    const a = chain(aId), b = chain(bId);
    const ancestor = a.find(row => b.includes(row));
    if (!ancestor) return null;
    const rows = [...a.slice(0, a.indexOf(ancestor)), ...b.slice(0, b.indexOf(ancestor))];
    return rows.length && rows.every(row => row.k >= 0 || row.k === -1 && row.parent?.beforeMessage)
      ? Math.min(...rows.map(row => row.k)) : null;
  }

  /**
   * 今いる枝から見た分岐点。添字（または "head" / "tail"）-> [{ id, name, n, back }]。
   * 他の枝それぞれと共通接頭辞を取り、分かれる直前の添字にその枝が「N 件」として並ぶ。
   * 直接の親子で atMessage が分かるならそれを使う（接頭辞の計算はその確認）。
   * 接頭辞が取れない（本文まで違う）枝も必ずどこかに出す: 祖先なら会話の頭（back: 戻る札）、そうでなければ末尾。
   * **どんな場合でも戻れる経路を残す**ため
   */
  function junctions(currentId) {
    const out = new Map();
    const cur = family?.rows.get(currentId);
    if (!cur) return out;
    const put = (key, entry) => { if (!out.has(key)) out.set(key, []); out.get(key).push(entry); };
    for (const r of family.rows.values()) {
      if (r.id === currentId) continue;
      let d;
      const cut = boundary(currentId, r.id);
      d = cut ?? commonPrefix(cur.messages, r.messages) - 1;
      if (d >= 0) d = Math.min(d, cur.messages.length - 1);
      const back = isAncestor(r.id, currentId);
      if (cut === -1) {
        put(-1, { id: r.id, name: nameOf(r.id), n: r.messages.length, back });
        continue;
      }
      if (d < 0 || d >= cur.messages.length) {
        put(back ? "head" : "tail", { id: r.id, name: nameOf(r.id), n: r.messages.length, back });
        continue;
      }
      // 今の枝が向こうの接頭辞になっている（向こうが先まで続いている）か、向こうが分かれているか。
      // どちらも「d の後で違う」ので同じ扱い。完全に同じ履歴（まだ何も足していない枝）は今の枝の末尾に付く
      put(d, { id: r.id, name: nameOf(r.id), n: Math.max(0, r.messages.length - (d + 1)), back });
    }
    return out;
  }

  return { load, reset, update, has, nameOf, junctions, boundary,
    get family() { return family; } };
}
