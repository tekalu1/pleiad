import { isComposingKey } from "./keyboard.mjs";
// 脇のパネル（セッション一覧）。docs/design-system.md §4.1〜4.3。
//
// 別画面にすると「今どれが自分の番か」を見るのに会話から離れることになる（設計メモ §2.1）。
// 常に横にあって、そこから開ける形にする。
//
// 見出し = 状態（SDK の tag、自由文字列）の値ごと。状態は事前定義しない（設計メモ §6）ので、
// 状態という実体は無く、付いているセッションの集合でしかない。tag が使われた時点で存在する。
// 順序は listStatuses の順（既出順）。ここでは並べ直さない。アイコンは sidecar の飾り。既定はフォルダ。
//
// グループ = fork でつながった会話のまとまり（§4.1）。親子でつながり・状態が同じ・人が外していない、
// の 3 つで決まる（web/family.mjs）。見出しはフォルダの役目だけを持ち、選べない。根の会話は
// グループの中の先頭の行として選ぶ（行はどれも自分の題を出す）。つかんで別の状態へ落とせば、
// 行は 1 本だけ、見出しならグループごと移る。
//
// 絞り込み（作業ディレクトリ × 状態、AND）と畳んだ状態・開いたグループは端末ごとの好みなので
// localStorage に持つ。
//
// 一覧はひとつのツリー（role=tree、フォーカスは #groups 1 つ）。状態の見出し・グループの器・行が treeitem で、
// 指している項目は aria-activedescendant で伝える。Tab 1 回で入って 1 回で抜ける（行が何百あっても）。
// 矢印は指す項目を動かすだけで会話は開かない。Enter / Space で開く（docs/design-system.md §4.1「キーボード」）。
import { runMark, satMark } from "./arc.mjs";
import { el, icon, moreButton, relTime, svgEl } from "./dom.mjs";
import { fmt, t } from "./i18n.mjs";
import { familiesOf } from "./family.mjs";
import { warnMark, clockMark, interruptLabel, showsReasonInMeta, limitTime } from "./interrupt.mjs";
import { aiMarkTitle } from "./change-log.mjs";
import { branchIcon } from "./icons.mjs";
import { parseTerms, matchLocal, findRanges, localOrder, periodSince, pushRecentSearch, searchShortcutLabel, searchShortcutAria } from "./session-find.mjs";

const backendLogos = {
  codex: "./brand/openai.svg",
  claude: "./brand/claude.svg",
  antigravity: "./brand/antigravity.svg",
};

/** エージェントのロゴ（14px）。一覧の行とバックグラウンドのダイアログで使う */
export function backendLogo(id, label) {
  const mark = el("span", "row-be");
  mark.title = label;
  const src = Object.hasOwn(backendLogos, id) ? backendLogos[id] : null;
  if (src) {
    mark.classList.add(`row-be-${id}`);
    if (id === "codex" || id === "antigravity") {
      const svg = svgEl("svg", { viewBox: "0 0 24 24", role: "img", "aria-label": label });
      svg.append(svgEl("use", { href: `${src}#mark` }));
      mark.append(svg);
      return mark;
    }
    const img = el("img");
    img.src = src;
    img.alt = label;
    img.draggable = false;
    mark.append(img);
  } else {
    mark.textContent = "◇";
    mark.setAttribute("role", "img");
    mark.setAttribute("aria-label", label);
  }
  return mark;
}

function unreadMark() {
  const mark = svgEl("svg", { viewBox: "0 0 14 14", class: "unread-mark", role: "img", "aria-label": t("sidebar.unread") });
  const title = svgEl("title");
  title.textContent = t("sidebar.unread");
  mark.append(title, svgEl("circle", { cx: 7, cy: 7, r: 4.5, fill: "currentColor" }));
  return mark;
}

function compactionMark(s) {
  const mark = el('span', 'row-compaction');
  const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  if (s.compactionAt) {
    const time = new Date(s.compactionAt).toLocaleTimeString(document.documentElement.lang, { hour: '2-digit', minute: '2-digit' });
    svg.append(svgEl('circle', { cx: 12, cy: 12, r: 8 }), svgEl('path', { d: 'M12 7v5l3 2' }));
    mark.append(svg, document.createTextNode(time));
    mark.setAttribute('aria-label', t('compaction.scheduled', { time }));
  } else {
    svg.append(svgEl('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3 }),
      svgEl('path', { d: 'M8 12h8M10 8l2 2 2-2M10 16l2-2 2 2' }));
    mark.append(svg, document.createTextNode(t('compaction.sidebarDone')));
  }
  return mark;
}

/** 保存待ちの語（移動中・削除中・作成中）。回る弧は「動いている会話」の印なので置かず、語の上を光が通る（design-system.md §4.6） */
function pendingLabel(text) {
  const label = el("span", "pending-label");
  label.append(el("span", "pending-glint", text));
  return label;
}

// 絵文字の一覧（1363 件）は重いので、起動後の空き時間に先読みし、押した瞬間は面と弧を先に出す
let emojiMod = null;
const loadEmoji = () => (emojiMod ??= import("./emoji.mjs"));
/** 絵文字のカテゴリの名前。辞書に無い id は emoji.mjs の名前のまま */
// i18n-dynamic: sidebar.emoji.category.
const CATEGORY_IDS = ["smileys", "nature", "food", "activity", "travel", "objects", "symbols", "flags"];
const categoryLabel = (c) => (CATEGORY_IDS.includes(c.id) ? t(`sidebar.emoji.category.${c.id}`) : c.label);
(globalThis.requestIdleCallback ?? ((f) => setTimeout(f, 1500)))(() => { loadEmoji().catch(() => {}); });
const sections = new Map();   // カテゴリ id -> 一度作った格子。2 回目以降は作り直さない

const STORE_KEY = "agent-host-side";
const RECENT_KEY = "agent-host-emoji-recent";
const RECENT_MAX = 16;
const STALE_DAYS = 7;        // 状態がこれ以上動いていないものは ◌ と日数を出す（設計メモ §6）
const UNDO_MS = 12000;       // 「元に戻す」の一行が出ている時間。押さなければ静かに消える
const RECENT_SEARCH_KEY = "agent-host-side-recent";   // 最近の検索（結果を開いた語だけ。端末ごと）
const RECENT_SEARCH_MAX = 5;
const SEARCH_WAIT_MS = 120;  // 打ってから本文まで探す問い合わせを送るまでの待ち。題・状態・場所の一致はその間に手元で出す
const PARTIAL_POLL_MS = 1500;   // サーバーが写しを読み込み中（partial）の間、結果を取り直す間隔
const PARTIAL_POLL_MAX = 40;
const SORT_POLL_MS = 2000;   // 一覧が動いたときの取り直しの下限（走っている会話が一覧を更新し続けても問い合わせを連打しない）
const PERIODS = [0, 1, 7, 30];   // 期間の絞り込み（日数。0 = すべて、1 = 今日）

const PLUS = "M12 5v14M5 12h14";
// 既定のアイコン。アイコン未設定のグループはフォルダ（他のアイコンと同じ線幅 1.6・丸端）
const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";

const staleDays = (iso) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0);

/** 作業ディレクトリの末尾。一覧で場所を見分けるのに足りる最小 */
const shortDir = (d) => String(d ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "";

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}");
    return {
      filter: { backends: Array.isArray(p.filter?.backends) ? p.filter.backends.filter(x => typeof x === "string") : [], dir: p.filter?.dir ?? null, status: "status" in (p.filter ?? {}) ? p.filter.status : undefined,
        period: PERIODS.includes(p.filter?.period) ? p.filter.period : 0 },
      collapsed: new Set(Array.isArray(p.collapsed) ? p.collapsed : []),
      expanded: new Set(Array.isArray(p.expanded) ? p.expanded : []),
      sort: p.sort === "recent" ? "recent" : "relevance",
    };
  } catch {
    return { filter: { backends: [], dir: null, status: undefined, period: 0 }, collapsed: new Set(), expanded: new Set(), sort: "relevance" };
  }
}

function loadRecentSearches() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY) ?? "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()).slice(0, RECENT_SEARCH_MAX) : [];
  } catch { return []; }
}

/**
 * @param {object} o
 * @param {(sessionId: string|null, jump?: { uuid: string, role: string, query: string, speaker: string }|null) => void} o.onOpen
 *   行を押した（null = まだ id の無い新しいセッション）。検索の抜粋を押したときは jump（その発言の uuid・探した語）も渡す
 * @param {(input: object) => Promise<object>} [o.onSearch]  本文まで探す（sessions.search の入力を渡し、結果を返す）
 * @param {({status, cwd}) => void} o.onNew                 ＋（引き継ぐ状態と作業ディレクトリ付き）
 * @param {(sessionId: string|null, status: string) => void} o.onSetStatus  選ばれた行の combo で状態を変えた
 * @param {(status: string, icon: string) => void} o.onSetIcon         アイコンを選んだ（空 = なし）
 * @param {(session: object, x: number, y: number) => void} [o.onContext]  行の右クリック
 * @param {(status: string|null, x: number, y: number) => void} [o.onGroupContext]  状態の見出しの右クリック
 * @param {(root: object, members: object[], x: number, y: number) => void} [o.onFamilyContext]  グループの見出しの右クリック
 * @param {(session: object, ungrouped: boolean) => void} [o.onSetGrouped]  グループから外す / 戻す
 * @param {(session: object, root: object) => void} [o.onJoinGroup]  そのグループへ入れる（状態も根に揃える）
 * @param {(root: object, status: string) => void} [o.onMoveGroup]  グループごと別の状態へ移す
 * @param {(x: number, y: number) => void} [o.onListContext]  一覧の空白の右クリック
 * @param {() => string} o.cwdNow  入力欄の今の作業ディレクトリ（絞っていないときの引き継ぎ元）
 */
export function createSide({ onOpen, onNew, onSetStatus, onSetIcon, onContext, onGroupContext, onFamilyContext,
                             onSetGrouped, onJoinGroup, onMoveGroup, onListContext, onSettings, onSearch, cwdNow }) {
  const $ = (id) => document.getElementById(id);
  const root = $("groups");
  const prefs = loadPrefs();
  let dragId = null;                            // つかんでいる行（またはグループの根）の sessionId
  let dragKind = null;                          // "row" = 1 本 / "group" = グループごと
  const inFamily = new Set();                   // いまグループの器の中に描かれている行
  let undoTimer = null;                         // 「元に戻す」の一行を消すタイマー
  let activeKey = null;                         // 一覧の中で指している項目（行 "s:<id>"・状態の見出し "g:<状態>"・器 "f:<根の id>"）
  let keyboard = false;                         // キーボードで一覧に入った・触っている（輪と下の一行を出す）
  let typed = "", typedAt = 0;                  // 打った文字で行へ飛ぶ（web/tree.mjs と同じ 800ms）
  let itemSeq = 0;                              // aria-activedescendant が指す id の連番
  const filter = prefs.filter;                 // { dir: string|null, status: string|null|undefined }
  const collapsed = prefs.collapsed;
  const expanded = prefs.expanded;              // 開いている家族（根の sessionId）。既定は畳んだ状態
  const decided = new Set();                    // 人が開閉を決めた家族。決めるまで、今いる会話の器は開いたまま
  const made = new Set();                       // この画面で作った（まだ誰も付いていない）仮の状態
  let last = { sessions: [], statuses: [], currentId: null, runningIds: new Set(), waitingIds: new Set(), unreadIds: new Set(), interrupted: new Map(), draft: null, backendLabels: null, pendingRows: new Map(), pendingStatuses: new Map(), pendingNew: null };

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        filter: { backends: filter.backends, dir: filter.dir, ...(filter.status === undefined ? {} : { status: filter.status }), ...(filter.period ? { period: filter.period } : {}) },
        sort: sortMode,
        collapsed: [...collapsed],
        // 消えたセッションの id は溜めない（一覧を受け取る前は間引かない）
        expanded: last.sessions.length ? [...expanded].filter((id) => last.sessions.some((s) => s.id === id)) : [...expanded],
      }));
    } catch { /* 保存できなくても動く */ }
  };

  let sortMode = prefs.sort;                    // 結果の並び。"relevance" | "recent"（端末ごと）
  const filtering = () => filter.dir != null || filter.status !== undefined || filter.backends.length > 0 || filter.period > 0;
  const statusKey = (s) => (s.status ? String(s.status) : null);
  const iconOf = (st) => last.statuses.find((x) => x.status === st)?.icon ?? null;

  /**
   * 一覧に出すグループの順。listStatuses の順（既出順）のうち、今どれかのセッションに付いているか
   * kept（statuses.json にある = 人が作った器）のものだけ。履歴にだけ残る旧名は候補には出るがグループにはしない
   * （削除したグループが空のまま残らないように）。まだ listStatuses に無いもの（付けた直後・この画面で
   * 作った仮のもの）を足し、最後に「状態なし」
   */
  function groupOrder() {
    const inUse = new Set(last.sessions.map(statusKey).filter(Boolean));
    const known = [...new Set(last.statuses.filter((x) => inUse.has(x.status) || x.kept).map((x) => x.status))];
    const extra = new Set(inUse);
    if (last.draft?.status) extra.add(last.draft.status);
    for (const k of made) extra.add(k);
    const rest = [...extra].filter((k) => !known.includes(k));
    return [...known, ...rest, null];
  }

  const matchesFilter = (s) =>
    (filter.dir == null || (s.worktree?.origin ?? s.cwd ?? "") === filter.dir) &&
    (filter.status === undefined || statusKey(s) === filter.status) &&
    (!filter.backends.length || filter.backends.includes(s.backend)) &&
    (!filter.period || (s.lastModified ?? 0) >= periodSince(filter.period));

  // ---- 描画 --------------------------------------------------------------

  function render() {
    const q = $("q").value.trim();
    syncSearchBar(q);
    if (q) return renderResults(q);
    resetRemote();
    root.replaceChildren();
    itemSeq = 0;
    if (last.pendingNew) {
      const top = el('div', 'rows pending-new-top');
      top.setAttribute("role", "none");
      top.append(row(last.pendingNew, 1));
      root.append(top);
    }
    const groups = groupOrder();
    const visibleGroups = filter.status === undefined ? groups : groups.filter((g) => g === filter.status);

    // グループ（根とその子孫）にまとめる。器は根の状態の見出しの下に入り、枝は器の中だけに出る。
    // 親が絞り込みで消えている枝は、入れる一番近い祖先に付く。付ける先が無ければ自分が根（= ただの行）
    const visible = last.sessions.filter(matchesFilter);
    const byGroup = new Map();
    inFamily.clear();
    for (const fam of familiesOf(visible, last.sessions)) {
      const k = statusKey(fam.root);
      if (!byGroup.has(k)) byGroup.set(k, []);
      byGroup.get(k).push(fam);
      if (fam.kin.length) for (const s of members(fam)) inFamily.add(s.id);
    }

    for (const st of visibleGroups) {
      // 放置は上に浮く。それ以外は新しい順。家族は中で一番新しい行で並ぶ（枝が動けば器ごと上に来る）
      const fams = (byGroup.get(st) ?? []).sort((a, b) => (famStale(b) - famStale(a)) || (famWhen(b) - famWhen(a)));
      const rows = fams.flatMap(members);        // このグループに出る行（器の中の枝を含む）
      const draftHere = last.draft && (last.draft.status ?? null) === st;
      if (!rows.length && !draftHere && filtering()) continue;   // 絞っているときは空のグループを出さない

      const sec = el("section", "grp");
      sec.setAttribute("role", "none");
      const isCollapsed = collapsed.has(st ?? "");
      // 動いている行（main が作業中）と、main は返答済みで裏だけを待っている行を分ける
      // bgWaiting は、ターンが裏を待っている行と、ターンは終わったが裏の作業が残っている行（Codex の端末）
      const active = rows.some((s) => last.runningIds.has(s.id) && !last.bgWaiting.has(s.id));
      const behind = rows.reduce((n, s) => n + (last.bgWaiting.get(s.id) ?? 0), 0);
      if (isCollapsed) sec.classList.add("collapsed");

      const head = el("div", "grp-head");
      const setOpen = (open) => { const k = st ?? ""; if (open) collapsed.delete(k); else collapsed.add(k); save(); render(); };
      treeItem(head, `g:${st ?? ""}`, 1, {
        expanded: !isCollapsed,
        open: () => setOpen(isCollapsed),
        expand: setOpen,
        menu: onGroupContext && ((x, y) => onGroupContext(st, x, y)),
      });
      // アイコン・＋・… はマウスとタッチのためのもの。キーボードは見出しの Shift+F10 のメニューから同じことをする
      const ic = el("button", "grp-icon", iconOf(st) ?? "");
      if (!iconOf(st)) ic.append(icon(FOLDER));
      ic.type = "button";
      ic.tabIndex = -1;
      ic.title = t("sidebar.group.pickIcon");
      ic.onclick = (e) => { e.stopPropagation(); openIconPicker(st, ic); };
      const name = el("span", "grp-name" + (st == null ? " none" : ""), st ?? t("session.status.none"));
      name.onclick = () => setOpen(isCollapsed);
      head.append(ic, name);
      const pendingStatus = last.pendingStatuses.get(st);
      if (pendingStatus) {
        head.classList.add('pending-status');
        if (pendingStatus.visible) head.append(pendingLabel(pendingStatus.text));
      }
      // 畳んだ中に走っているものがあれば見出しに弧。走っていないときは印そのものを置かない（置くと回り続ける）
      // 動いているものが 1 つでもあれば弧、裏を待っているだけなら衛星（docs/design-system.md §6）
      // 印は 1 つだけ。弧 → 衛星 → 中断の三角 → 未読の順に強い
      let stoppedMark = null;
      if (isCollapsed && active) head.append(runMark(t("sidebar.somethingRunning")));
      else if (isCollapsed && behind) head.append(satMark(behind, t("activity.behindCount", { count: behind })));
      else if (isCollapsed && (stoppedMark = stoppedIn(rows))) head.append(stoppedMark);
      else if (isCollapsed && rows.some(s => last.unreadIds.has(s.id))) head.append(unreadMark());
      if (st != null) {
        const add = el("button", "btn btn-icon grp-add");
        add.type = "button";
        add.tabIndex = -1;
        add.title = t("sidebar.group.newSession");
        add.append(icon(PLUS));
        add.onclick = (e) => { e.stopPropagation(); onNew?.({ status: st, cwd: filter.dir ?? cwdNow?.() ?? "", backend: filter.backends.length === 1 ? filter.backends[0] : undefined }); };
        head.append(add);
      }
      if (st != null) ic.dataset.status = st;
      // 右クリックと同じメニューを開く「…」。タッチでは右クリックもドラッグも届かない（docs/remote.md §8.4）
      if (onGroupContext) head.append(menuButton("grp-more", t("session.groupMore", { status: st ?? t("session.status.none") }), (x, y) => onGroupContext(st, x, y)));
      head.oncontextmenu = (e) => { if (!onGroupContext) return; e.preventDefault(); onGroupContext(st, e.clientX, e.clientY); };
      head.setAttribute("aria-label", spoken([...head.children].filter((c) => c.tagName !== "BUTTON")));
      sec.append(head);
      // 行とグループの見出しを落とせる先。掴んでいる間、上に来た状態の面が一段持ち上がる。
      // 同じ状態へ落とすのは「グループから外すだけ」の意味になる（中の行のときだけ受ける）
      sec.addEventListener("dragover", (e) => {
        if (dragId == null) return;
        const s = last.sessions.find((x) => x.id === dragId);
        if (!s) return;
        if (statusKey(s) === st && !(dragKind === "row" && inFamily.has(s.id))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        sec.classList.add("over");
      });
      sec.addEventListener("dragleave", (e) => { if (!sec.contains(e.relatedTarget)) sec.classList.remove("over"); });
      sec.addEventListener("drop", (e) => {
        e.preventDefault();
        sec.classList.remove("over");
        const id = dragId ?? e.dataTransfer.getData("text/plain");
        const kind = dragKind;
        dragId = null;
        dragKind = null;
        const s = last.sessions.find((x) => x.id === id);
        if (!s) return;
        if (statusKey(s) === st) {
          // 同じ状態の空きへ: 状態はそのままグループから外れるだけ
          if (kind === "row" && inFamily.has(s.id)) onSetGrouped?.(s, true);
          return;
        }
        // 空になる状態はこの画面に残す（「まだ無い」）。落とした先が消えて見えるのを防ぐ
        const from = statusKey(s);
        if (from && !last.sessions.some((x) => x.id !== id && statusKey(x) === from)) made.add(from);
        if (kind === "group") onMoveGroup?.(s, st ?? "");
        else onSetStatus?.(id, st ?? "");
      });

      const rowsEl = el("div", "rows");
      rowsEl.setAttribute("role", "group");
      if (draftHere) rowsEl.append(row({ id: null, title: "", cwd: last.draft.cwd, status: last.draft.status }, 2));
      for (const fam of fams) rowsEl.append(fam.kin.length ? family(fam) : row(fam.root, 2));
      if (!rows.length && !draftHere) rowsEl.append(el("div", "empty", t("sidebar.empty")));
      sec.append(rowsEl);
      root.append(sec);
    }
    if (!root.childElementCount) root.append(el("div", "empty", filtering() ? t("sidebar.noMatch") : t("sidebar.empty")));

    $("filterBtn").classList.toggle("on", filtering());
    renderChips();
    paintActive();
  }

  // ---- キーボード（一覧をひとつのツリーとして扱う。web/tree.mjs と同じ規則） ----------------------

  /**
   * 項目を treeitem にする。o.open は Enter / Space、o.expand(open) は → / ←（開閉できる項目だけ）、
   * o.menu(x, y) は Shift+F10・メニューキー
   */
  function treeItem(node, key, level, o) {
    node.id = `side-item-${++itemSeq}`;
    node.dataset.key = key;
    node.setAttribute("role", "treeitem");
    node.setAttribute("aria-level", String(level));
    if (o.expanded != null) node.setAttribute("aria-expanded", String(o.expanded));
    node.treeOpen = o.open;
    node.treeExpand = o.expand;
    node.treeMenu = o.menu || null;
  }

  /** 読み上げの名前。印は aria-label か title、それ以外は字。aria-hidden の字（印と同じことを言う字）は読まない */
  const spoken = (nodes) => nodes.filter((c) => c.getAttribute?.("aria-hidden") !== "true").map((c) => c.getAttribute?.("aria-label") || c.textContent.trim() || c.title || "")
    .filter(Boolean).join(", ");

  /** 「…」。右クリックと同じメニュー。Tab には入れず、title にキーボードの入口を添える */
  function menuButton(cls, label, open) {
    const b = moreButton(cls, label, open);
    b.tabIndex = -1;
    b.title = t("sidebar.menuKey", { label });
    return b;
  }

  /** 今見えている項目（畳んだ状態の中の行は除く）。上から順 */
  const treeItems = () => [...root.querySelectorAll("[role=treeitem]")].filter((n) => !n.closest(".grp.collapsed > .rows"));

  /** 一覧に入ったときに指す項目。開いている会話の行、見えなければ先頭の行 */
  function entryItem(items = treeItems()) {
    return items.find((n) => n.classList.contains("sel")) ?? items.find((n) => n.classList.contains("row")) ?? items[0] ?? null;
  }

  /** 指している項目に印を付け、aria-activedescendant を向ける。scroll なら見えるところまで送る */
  function paintActive(scroll = false) {
    const item = activeKey == null ? null : treeItems().find((n) => n.dataset.key === activeKey) ?? null;
    for (const n of root.querySelectorAll(".is-active")) if (n !== item) n.classList.remove("is-active");
    if (item) { item.classList.add("is-active"); root.setAttribute("aria-activedescendant", item.id); }
    else root.removeAttribute("aria-activedescendant");
    if (scroll) item?.scrollIntoView({ block: "nearest" });
    syncKeyboard();
    return item;
  }

  /** 輪と脇の下の操作の一行は、キーボードで一覧にいる間だけ */
  function syncKeyboard() {
    root.classList.toggle("kbd", keyboard);
    $("keyHint").hidden = !(keyboard && document.activeElement === root);
  }

  /** 親の項目（行 → 器の見出し・状態の見出し、器の見出し → 状態の見出し） */
  function parentItem(n) {
    if (n.classList.contains("row") && n.closest(".fam")) return n.closest(".fam").querySelector(":scope > .fam-head");
    return n.closest(".grp")?.querySelector(":scope > .grp-head") ?? null;
  }

  root.setAttribute("role", "tree");
  root.tabIndex = 0;
  root.setAttribute("aria-label", t("sidebar.list"));
  root.addEventListener("focus", () => {
    if (root.matches(":focus-visible")) keyboard = true;
    const items = treeItems();
    if (!items.some((n) => n.dataset.key === activeKey)) activeKey = entryItem(items)?.dataset.key ?? null;
    paintActive(keyboard);
  });
  root.addEventListener("blur", syncKeyboard);
  root.addEventListener("pointerdown", () => { keyboard = false; syncKeyboard(); });
  // 押した・右クリックした項目を指す（描き直しても同じ項目を指し続ける）。各項目の処理より先に決める
  const pointAt = (e) => { const n = e.target.closest?.("[role=treeitem]"); if (n && root.contains(n)) { activeKey = n.dataset.key; paintActive(); } };
  root.addEventListener("click", pointAt, true);
  root.addEventListener("contextmenu", pointAt, true);
  root.addEventListener("keydown", (e) => {
    if (e.target !== root || isComposingKey(e)) return;
    const items = treeItems();
    if (!items.length) return;
    const cur = items.find((n) => n.dataset.key === activeKey) ?? null;
    const at = items.indexOf(cur);
    const go = (n) => { if (!n) return; activeKey = n.dataset.key; paintActive(true); };
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      if (!cur?.treeMenu) return;
      e.preventDefault();
      const r = cur.getBoundingClientRect();
      cur.treeMenu(r.left + 24, r.bottom);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key;
    if (key === "ArrowDown") go(cur ? items[Math.min(items.length - 1, at + 1)] : entryItem(items));
    else if (key === "ArrowUp") go(cur ? items[Math.max(0, at - 1)] : entryItem(items));
    else if (key === "Home") go(items[0]);
    else if (key === "End") go(items[items.length - 1]);
    else if (key === "ArrowRight") {
      if (!cur) go(entryItem(items));
      else if (!cur.hasAttribute("aria-expanded")) return;
      else if (cur.getAttribute("aria-expanded") === "false") cur.treeExpand(true);
      else go(Number(items[at + 1]?.getAttribute("aria-level")) > Number(cur.getAttribute("aria-level")) ? items[at + 1] : null);
    } else if (key === "ArrowLeft") {
      if (!cur) return;
      if (cur.getAttribute("aria-expanded") === "true") cur.treeExpand(false);
      else if (parentItem(cur)) go(parentItem(cur));
      else return;
    } else if (key === "Enter" || key === " ") {
      if (!cur) return;
      cur.treeOpen();
    } else if (key.length === 1 && /\S/.test(key)) {
      // 打った文字で始まる次の項目へ。続けて打つと語で絞る
      const now = Date.now();
      typed = now - typedAt < 800 ? typed + key : key;
      typedAt = now;
      const from = at + 1;
      const found = [...items.slice(from), ...items.slice(0, from)]
        .find((n) => (n.querySelector(".row-t, .grp-name, .fam-t")?.textContent ?? "").toLowerCase().startsWith(typed.toLowerCase()));
      if (!found) return;
      go(found);
    } else return;
    e.preventDefault();
    keyboard = true;
    syncKeyboard();
  });
  const isStale = (s) => Boolean(s.status) && staleDays(s.statusChangedAt) >= STALE_DAYS;

  // ---- 家族（fork した会話の器） ------------------------------------------
  // 根とその子孫をひとつの器に入れる。見出しはフォルダの役目だけで、押すと開閉する（選べない）。
  // 根の会話は器の中の先頭の行から開く。行はどれも自分の題を出す（根も題のまま）。

  const rowOrder = (a, b) => (isStale(b) - isStale(a)) || ((b.lastModified ?? 0) - (a.lastModified ?? 0));
  /** 器に並ぶ行。根が先頭、続けて枝を放置・新しい順に */
  const members = (fam) => [fam.root, ...[...fam.kin].sort(rowOrder)];
  const famWhen = (fam) => Math.max(...members(fam).map((s) => s.lastModified ?? 0));
  const famStale = (fam) => (members(fam).some(isStale) ? 1 : 0);
  const titleOf = (s) => (s.title === "(no title)" ? "" : (s.title ?? ""));

  /**
   * fork で生まれた会話の印。題の前に出す。グループから外しても、状態を変えても消えない
   * （「この会話は誰かの続き」という事実は変わらないため）。押せない、見るだけの印
   */
  function forkMark() {
    const svg = svgEl("svg", { class: "forkmark", viewBox: "0 0 16 16", role: "img", "aria-label": t("sidebar.forked") });
    const title = svgEl("title");
    title.textContent = t("sidebar.forked");
    svg.append(title,
      svgEl("path", { d: "M5 4.6v3.4a3 3 0 0 0 3 3h2.6" }),
      svgEl("circle", { cx: 5, cy: 3, r: 1.5 }),
      svgEl("circle", { cx: 12.4, cy: 11, r: 1.5 }));
    return svg;
  }

  /** 10px の chevron。閉じているとき右向き、開くと 90° 回る（回転は CSS） */
  function chevron() {
    const svg = svgEl("svg", { class: "fam-chev", viewBox: "0 0 10 10", "aria-hidden": "true" });
    svg.append(svgEl("path", { d: "M3.5 1.5 7 5l-3.5 3.5" }));
    return svg;
  }

  /** 承認待ちの印。器の見出しでは文言を出さず ◆ だけ（2 件以上なら数を添える） */
  function waitMark(n) {
    const label = n > 1 ? t("sidebar.waitingCount", { count: n }) : t("sidebar.waiting");
    const m = el("span", "wait only", n > 1 ? String(n) : "");
    m.setAttribute("role", "img");
    m.setAttribute("aria-label", label);
    m.title = label;
    return m;
  }

  /** 畳んだ中に中断した会話があれば三角（中に未読の中断が 1 つでもあれば --ink）。無ければ null */
  function stoppedIn(list) {
    const stopped = list.map((s) => last.interrupted.get(s.id)).filter(Boolean);
    if (!stopped.length) return null;
    return warnMark(t("interrupt.groupMark"), { read: !stopped.some((x) => x.unread) });
  }

  /**
   * 畳んだ器の見出しに出す要約。中の様子を開かずに読めるようにする。
   * 印（走っている・裏で待っている・未確認・承認待ち）と、状態ごとの件数。枝の本数そのものは出さない
   */
  function famSummary(list) {
    const sum = el("div", "fam-sum");
    const active = list.some((s) => last.runningIds.has(s.id) && !last.bgWaiting.has(s.id));
    const behind = list.reduce((n, s) => n + (last.bgWaiting.get(s.id) ?? 0), 0);
    const waiting = list.filter((s) => last.waitingIds.has(s.id)).length;
    let stoppedMark = null;
    if (active) sum.append(runMark(t("sidebar.somethingRunning")));
    else if (behind) sum.append(satMark(behind, t("activity.behindCount", { count: behind })));
    else if ((stoppedMark = stoppedIn(list))) sum.append(stoppedMark);
    else if (list.some((s) => last.unreadIds.has(s.id))) sum.append(unreadMark());
    if (waiting) sum.append(waitMark(waiting));
    const counts = new Map();
    for (const s of list) { const k = statusKey(s); counts.set(k, (counts.get(k) ?? 0) + 1); }
    for (const [k, n] of counts) sum.append(el("span", "fam-count", `${k ?? t("session.status.none")} ${n}`));
    return sum;
  }

  /** 家族の器。中に根と枝が平らに並ぶ（枝の枝も同じ器。入れ子の器は作らない） */
  function family(fam) {
    const list = members(fam);
    const id = fam.root.id;
    // 今いる会話が中にあれば開いたまま出す（人が閉じるまで）。それ以外の既定は畳んだ状態
    const here = list.some((s) => s.id === last.currentId);
    const open = expanded.has(id) || (!decided.has(id) && here);
    // 畳んだまま中の会話を見ていることがある。器の面を白へ持ち上げて「今いるのはこの中」を示す
    const box = el("div", "fam" + (open ? " open" : "") + (here && !open ? " here" : ""));
    box.setAttribute("role", "none");
    const head = el("div", "fam-head");
    const setOpen = (next) => {
      decided.add(id);
      if (next) expanded.add(id); else expanded.delete(id);
      save();
      render();
    };
    treeItem(head, `f:${id}`, 2, {
      expanded: open,
      open: () => setOpen(!open),
      expand: setOpen,
      menu: onFamilyContext && ((x, y) => onFamilyContext(fam.root, list, x, y)),
    });
    head.setAttribute("aria-controls", `fam-${id}`);
    head.title = open ? t("sidebar.family.collapse") : here ? t("sidebar.family.hereInside") : t("sidebar.family.expand");
    const body = el("div", "fam-body");
    const name = el("div", "fam-name");
    if (fam.root.parent?.sessionId) name.append(forkMark());
    name.append(el("span", "fam-t", titleOf(fam.root)));
    body.append(name);
    if (!open) body.append(famSummary(list));   // 開けば中の行が同じことを言うので、畳んでいる間だけ
    head.append(chevron(), body);
    head.setAttribute("aria-label", spoken([...name.children, ...(body.querySelector(".fam-sum")?.children ?? [])]) || t("session.untitled"));
    head.onclick = () => setOpen(!open);
    head.oncontextmenu = (e) => { if (!onFamilyContext) return; e.preventDefault(); onFamilyContext(fam.root, list, e.clientX, e.clientY); };
    // 見出しをつかむと、グループごと別の状態へ移せる（中の会話も一緒に動く）
    head.draggable = true;
    head.addEventListener("dragstart", (e) => {
      dragId = id;
      dragKind = "group";
      e.dataTransfer.setData("text/plain", id);
      e.dataTransfer.effectAllowed = "move";
      head.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
      dragId = null;
      dragKind = null;
      head.classList.remove("dragging");
      for (const g of root.querySelectorAll(".over")) g.classList.remove("over");
    });
    box.append(head);
    // 「…」は見出しの外に置き、器の右上に重ねる
    if (onFamilyContext) box.append(menuButton("fam-more", t("session.familyMore", { title: titleOf(fam.root) || t("session.untitled") }), (x, y) => onFamilyContext(fam.root, list, x, y)));
    // 外にある枝をここへ落とすと、このグループに入る（状態も根に揃う）
    box.addEventListener("dragover", (e) => {
      if (dragId == null || dragKind !== "row" || inFamily.has(dragId)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      for (const g of root.querySelectorAll(".over")) g.classList.remove("over");
      box.classList.add("over");
    });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("over"); });
    box.addEventListener("drop", (e) => {
      if (dragId == null || dragKind !== "row" || inFamily.has(dragId)) return;
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove("over");
      const s = last.sessions.find((x) => x.id === dragId);
      dragId = null;
      dragKind = null;
      if (s) onJoinGroup?.(s, fam.root);
    });
    if (open) {
      const kids = el("div", "fam-rows");
      kids.id = `fam-${id}`;
      kids.setAttribute("role", "group");
      for (const s of list) kids.append(row(s, 3));
      box.append(kids);
    }
    return box;
  }

  /**
   * 一覧の行。id が null なら、まだ id の無い新しいセッション（印は付かず、掴めない）
   * @param {number} level ツリーの深さ（先頭の作成中 1・状態の見出しの下 2・器の中 3）
   */
  function row(s, level) {
    const open = s.id === last.currentId;
    const r = el("div", "row" + (open ? " sel" : ""));
    const pendingRow = last.pendingRows.get(s.id);
    const interactive = s.id != null && pendingRow?.kind !== 'new';
    if (pendingRow) r.classList.add('pending-row', `pending-${pendingRow.kind ?? 'move'}`);
    // 開いている会話は白い面（.sel）と aria-selected・aria-current。指している項目（キーボード）とは別に示す
    treeItem(r, `s:${s.id ?? ""}`, level, {
      open: () => { if (!open) onOpen?.(s.id); },
      menu: onContext && interactive && ((x, y) => onContext(s, x, y)),
    });
    r.setAttribute("aria-selected", String(open));
    if (open) r.setAttribute("aria-current", "page");
    r.dataset.session = s.id ?? "";
    const title = el("div", "row-title");
    // fork で生まれた会話の印。グループから外しても状態を変えても消えない（§4.1）
    if (s.parent?.sessionId) title.append(forkMark());
    title.append(el("span", "row-t", titleOf(s)));
    // 右クリックと同じメニューを開く「…」。キーボードは一覧の Shift+F10・メニューキーで同じメニュー
    if (onContext && interactive) title.append(menuButton("row-more", t("session.rowMore", { title: titleOf(s) || t("session.untitled") }), (x, y) => onContext(s, x, y)));
    r.append(title);
    const meta = el("div", "row-meta");
    // 走っていれば弧。裏だけを待っていれば衛星（ターンが終わっても裏の作業が残っている会話を含む）
    const behind = last.bgWaiting.get(s.id);
    // 中断した会話は注意の三角（未読は --ink、開いた後は --ink-weak）。次のターンが始まるまで残る。走っていればそちらが先
    const stopped = last.interrupted.get(s.id);
    const moving = last.runningIds.has(s.id) || behind;
    if (moving) meta.append(behind ? satMark(behind, t("activity.behindCount", { count: behind })) : runMark(t("activity.turnRunning")));
    else if (stopped?.reason === 'limit' && stopped.autoResume && Number.isFinite(stopped.resetsAt))
      meta.append(clockMark(t('interrupt.limitResumeAt', { time: limitTime(stopped.resetsAt) })));
    else if (stopped) meta.append(warnMark(interruptLabel(stopped), { read: !stopped.unread }));
    else if (last.unreadIds.has(s.id)) meta.append(unreadMark());
    // 自分で押した中断でないもの（更新・終了・再起動）は理由の字も出す。読み上げは三角の名前が同じことを言うので読ませない
    if (stopped && !moving && showsReasonInMeta(stopped)) {
      const why = el("span", "row-why", interruptLabel(stopped));
      why.setAttribute("aria-hidden", "true");
      meta.append(why);
    }
    if (stopped?.reason === 'limit' && stopped.autoResume && !moving && Number.isFinite(stopped.resetsAt))
      meta.append(el('span', 'row-why', t('interrupt.limitResumeAt', { time: limitTime(stopped.resetsAt) })));
    if (last.waitingIds.has(s.id)) meta.append(el("span", "wait", t("sidebar.waiting")));
    if (pendingRow?.visible) meta.append(pendingLabel(pendingRow.text));
    else if (isStale(s)) meta.append(el("span", "stale", t("sidebar.staleDays", { count: staleDays(s.statusChangedAt) })));
    else meta.append(el("span", "row-when", s.id == null ? fmt.justNow() : relTime(s.lastModified)));
    // 状態を最後に変えたのが AI のときだけ小さな「AI」の印（理由は title。誰がいつ変えたかは行のメニューの「変更の記録」）
    if (s.status && s.statusByAi) {
      const ai = el("span", "row-ai", t("changeLog.aiMark"));
      ai.title = aiMarkTitle(s.statusByAi);
      meta.append(ai);
    }
    if (last.backendLabels && s.backend) meta.append(backendLogo(s.backend, last.backendLabels[s.backend] ?? s.backend));
    const cwd = el("span", "row-cwd");
    // 分けた作業場所の中の会話は、元の場所の名前に枝分かれの印（ADR 0089）
    if (s.worktree) { const mark = el("span", "wt-ic"); mark.innerHTML = branchIcon; mark.setAttribute("aria-hidden", "true"); cwd.append(mark); }
    cwd.append(shortDir(s.worktree?.origin ?? s.cwd));
    if (s.cwd) cwd.title = s.worktree ? `${s.worktree.origin} · ${s.cwd}` : s.cwd;
    meta.append(cwd);
    if (s.unsent) meta.append(el("span", "row-unsent", s.hasDraft ? t("sidebar.unsentDraft") : t("sidebar.unsent")));
    if (s.compactionAt || s.compacted) meta.append(compactionMark(s));
    r.append(meta);
    r.setAttribute("aria-label", [titleOf(s) || t("session.untitled"), spoken([...meta.children])].filter(Boolean).join(", "));

    r.onclick = () => { if (!open) onOpen?.(s.id); };
    r.oncontextmenu = (e) => { if (!onContext || !interactive) return; e.preventDefault(); onContext(s, e.clientX, e.clientY); };
    if (!interactive) return r;

    // つかんで別の状態へ落とすと状態が変わる（グループの中の行はそこで外れる）。
    // 同じ状態の空きへ落とせば、状態はそのままグループから外れるだけ。
    // キーボードからは右クリックのメニューで同じことができる
    r.draggable = true;
    r.addEventListener("dragstart", (e) => {
      dragId = s.id;
      dragKind = "row";
      e.dataTransfer.setData("text/plain", s.id);
      e.dataTransfer.effectAllowed = "move";
      r.classList.add("dragging");
    });
    r.addEventListener("dragend", () => {
      dragId = null;
      dragKind = null;
      r.classList.remove("dragging");
      for (const g of root.querySelectorAll(".over")) g.classList.remove("over");
    });
    return r;
  }

  function renderChips() {
    const box = $("fchips");
    box.replaceChildren();
    const chip = (k, v, clear) => {
      const c = el("span", "fchip");
      c.append(el("span", "k", k), el("span", "v", v));
      const x = el("button", "x", "×");
      x.type = "button";
      x.title = t("sidebar.filter.remove");
      x.onclick = () => { clear(); save(); render(); };
      c.append(x);
      box.append(c);
    };
    for (const id of filter.backends) chip(t("sidebar.filter.agent"), last.backendLabels?.[id] ?? id, () => { filter.backends = filter.backends.filter(x => x !== id); });
    const current = last.sessions.find(s => s.id === last.currentId);
    $("filterOutside").hidden = !current || matchesFilter(current);
    if (filter.dir != null) chip(t("sidebar.filter.place"), shortDir(filter.dir) || filter.dir, () => { filter.dir = null; });
    if (filter.status !== undefined) chip(t("sidebar.filter.status"), filter.status ?? t("session.status.none"), () => { filter.status = undefined; });
    if (filter.period) chip(t("sidebar.filter.period"), periodLabel(filter.period), () => { filter.period = 0; });
    // 語があるときだけ効く絞り込み（発言者・含める）。語を消すと札も消える
    if ($("q").value.trim()) {
      if (scope.speaker !== "any") chip(t("sidebar.filter.speaker"), scope.speaker === "user" ? t("sidebar.filter.speakerUser") : t("sidebar.filter.speakerAssistant"), () => { scope.speaker = "any"; });
      if (scope.delegated) chip(t("sidebar.filter.include"), t("sidebar.filter.includeDelegated"), () => { scope.delegated = false; });
      if (scope.tools) chip(t("sidebar.filter.include"), t("sidebar.filter.includeTools"), () => { scope.tools = false; });
    }
  }

  function periodLabel(days) {
    return days === 1 ? t("sidebar.filter.periodToday") : days === 7 ? t("sidebar.filter.period7") : days === 30 ? t("sidebar.filter.period30") : t("sidebar.filter.all");
  }

  // ---- 検索 --------------------------------------------------------------
  // 語があるときは、状態の木をやめて会話の平らな結果の一覧（role=listbox）にする。題・状態・場所の一致は手元で即座に出し、
  // 120ms 待って sessions.search（本文まで。core/session-search.mjs）の結果が届いたら置き換える。語を消せばいつもの木へ戻る
  // （開閉の状態はそのまま）。docs/design-system.md §4.1「検索」。

  const searchBox = $("q");
  const scope = { speaker: "any", delegated: false, tools: false };   // 語があるときだけ効く絞り込み。覚えない
  let recentSearches = loadRecentSearches();
  let remote = null;            // 本文まで探した最後の結果 { key, sig, at, result }（result が null なら失敗）
  let wanted = null;            // 問い合わせを予約した・送っているキー
  let remoteTimer = 0, remoteSeq = 0, partialTimer = 0, partialPolls = 0;
  let listSig = "";             // 会話の一覧が動いたことを知る目印（動いたら結果を取り直す）
  let resultNodes = [];         // 結果の行（↑↓ で選べるもの）
  let optionAt = -1;            // 指している結果の位置
  let optionId = null;          // 描き直しても同じ会話を指し続ける
  let recentAt = -1;            // 指している「最近の検索」の位置
  let searchKbd = false;        // 検索欄で ↑↓ を使った（下に操作キーの一行を出す）
  let searchOn = false;         // いま結果の一覧を出している

  searchBox.title = t("sidebar.search.title", { key: searchShortcutLabel() });
  searchBox.setAttribute("aria-keyshortcuts", searchShortcutAria());

  const searchKey = (q) => JSON.stringify([q, filter.backends, filter.dir, filter.status === undefined ? 0 : [filter.status], filter.period, scope.speaker, scope.delegated, scope.tools, sortMode]);

  const searchInput = (q) => ({
    query: q,
    filters: {
      ...(filter.backends.length ? { backends: [...filter.backends] } : {}),
      ...(filter.dir != null ? { cwd: filter.dir } : {}),
      ...(filter.status !== undefined ? { status: filter.status } : {}),
      ...(filter.period ? { since: periodSince(filter.period) } : {}),
      ...(scope.speaker !== "any" ? { speaker: scope.speaker } : {}),
      ...(scope.delegated ? { includeDelegated: true } : {}),
      ...(scope.tools ? { includeToolInputs: true } : {}),
    },
    sort: sortMode,
    hitsPerSession: 1,
  });

  /** 語を消した・結果の一覧をやめた。待っている問い合わせと結果を捨てる */
  function resetRemote() {
    remoteSeq++;
    clearTimeout(remoteTimer);
    clearTimeout(partialTimer);
    remote = null;
    wanted = null;
    partialPolls = 0;
    optionAt = -1;
    optionId = null;
    resultNodes = [];
    if (searchOn) { searchOn = false; paintMode(false); }
  }

  /** 結果が要るのに、今の条件の答えが無い（または一覧が動いた）ときだけ、少し待ってから問い合わせる */
  function wantRemote(q) {
    if (!onSearch) return;
    const key = searchKey(q);
    if (remote?.key === key && remote.sig === listSig) return;
    if (wanted === key) return;
    wanted = key;
    clearTimeout(remoteTimer);
    // 同じ条件で一覧だけが動いたときは、問い合わせの間隔に下限を置く
    const same = remote?.key === key;
    const wait = same ? Math.max(SEARCH_WAIT_MS, SORT_POLL_MS - (Date.now() - remote.at)) : SEARCH_WAIT_MS;
    remoteTimer = setTimeout(() => fetchRemote(q, key), wait);
  }

  async function fetchRemote(q, key) {
    const seq = ++remoteSeq;
    const sig = listSig;
    let result = null;
    try { result = await onSearch(searchInput(q)); } catch { result = null; }
    if (seq !== remoteSeq) return;                 // もっと新しい問い合わせが走っている
    wanted = null;
    if (searchBox.value.trim() !== q || searchKey(q) !== key) return;   // 打ち直した（次の問い合わせは予約済み）
    remote = { key, sig, at: Date.now(), result };
    clearTimeout(partialTimer);
    if (result?.partial && partialPolls < PARTIAL_POLL_MAX) {
      partialPolls++;
      partialTimer = setTimeout(() => { if (remote) remote.sig = null; render(); }, PARTIAL_POLL_MS);
    } else partialPolls = 0;
    render();
  }

  /** 結果の 1 行分のデータ。手元の照合（題・状態・場所）とサーバーの結果を同じ形にそろえる */
  function resultRows(q) {
    const byId = new Map(last.sessions.map((s) => [s.id, s]));
    const key = searchKey(q);
    if (remote?.key === key && remote.result) {
      const r = remote.result;
      return {
        server: true,
        total: r.total,
        partial: Boolean(r.partial),
        rows: r.sessions.map((x) => ({
          id: x.sessionId, session: byId.get(x.sessionId) ?? null, title: x.title === "(no title)" ? "" : x.title, status: x.status,
          cwd: x.cwd, backend: x.backend, lastModified: x.lastModified,
          parent: x.parentSessionId ? { id: x.parentSessionId, title: byId.get(x.parentSessionId)?.title ?? "" } : null,
          count: x.hitCount, hit: x.hits?.[0] ?? null,
        })),
      };
    }
    const terms = parseTerms(q);
    const local = [];
    for (const s of last.sessions) {
      if (!matchesFilter(s)) continue;
      const m = matchLocal(s, terms);
      if (m) local.push({ session: s, ...m });
    }
    const rows = localOrder(local, sortMode).map(({ session: s }) => ({
      id: s.id, session: s, title: titleOf(s), status: s.status ?? null, cwd: s.cwd ?? "", backend: s.backend, lastModified: s.lastModified,
      parent: null, count: 0, hit: null,
    }));
    // 本文まで探す口が無い・探すのに失敗したときは、手元の結果が最終
    return { server: !onSearch || remote?.key === key, total: rows.length, partial: false, rows };
  }

  /** 一致の範囲に下線と太字（会話の中の検索と同じ印） */
  function fillMarked(node, text, ranges) {
    let at = 0;
    for (const [a, b] of ranges ?? []) {
      if (a < at || b > text.length) continue;
      if (a > at) node.append(text.slice(at, a));
      node.append(el("mark", "searchhit", text.slice(a, b)));
      at = b;
    }
    if (at < text.length) node.append(text.slice(at));
    return node;
  }

  function openResult(r) {
    const q = searchBox.value.trim();
    if (q) { recentSearches = pushRecentSearch(recentSearches, q, RECENT_SEARCH_MAX); try { localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(recentSearches)); } catch { /* 保存できなくても動く */ } }
    const hit = r.hit?.uuid ? r.hit : null;
    onOpen?.(r.id, hit ? { uuid: hit.uuid, role: hit.role, query: q, speaker: scope.speaker } : null);
  }

  /** 結果の 1 行。題 + 件数の札、一致した発言の抜粋（2 行まで）、時刻・エージェント・状態・場所（委譲は「委譲 · 親の題」） */
  function resultRow(r, index, terms) {
    const open = r.id === last.currentId;
    const row = el("div", "row res" + (open ? " sel" : ""));
    row.id = `side-opt-${index}`;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "false");
    row.dataset.session = r.id ?? "";
    const head = el("div", "row-title");
    head.append(fillMarked(el("span", "row-t"), r.title, findRanges(r.title, terms)));
    if (r.count > 0) {
      const badge = el("span", "hitc", String(r.count));
      badge.title = t("sidebar.search.hits", { count: r.count });
      head.append(badge);
    }
    row.append(head);
    let spokenHit = "";
    if (r.hit) {
      // i18n-dynamic: sidebar.search.who.
      const who = t(`sidebar.search.who.${r.hit.role}`);
      // 誰の発言か + 抜粋を 1 つの流れにして 2 行で切る（-webkit-box の直下に並べると、誰の発言かが 1 行を取る）。
      // 抜粋は一致の手前 16 字から始まるので、一致が 16 字目より後ろなら前が切れている（先頭に … を付ける）
      const snip = el("div", "snip" + (r.hit.role === "tool" ? " tool" : ""));
      const flow = el("span", "snip-flow");
      flow.append(el("span", "snip-who", who));
      if ((r.hit.ranges?.[0]?.[0] ?? 0) >= 16) flow.append("…");
      fillMarked(flow, r.hit.excerpt, r.hit.ranges);
      snip.append(flow);
      row.append(snip);
      spokenHit = t("sidebar.search.rowWho", { who, text: r.hit.excerpt });
    }
    const meta = el("div", "row-meta");
    meta.append(el("span", "row-when", relTime(r.lastModified)));
    if (last.backendLabels && r.backend) meta.append(backendLogo(r.backend, last.backendLabels[r.backend] ?? r.backend));
    if (r.status) meta.append(el("span", "row-st", r.status));
    if (r.parent) meta.append(el("span", "row-from", r.parent.title ? t("sidebar.search.delegated", { parent: r.parent.title }) : t("sidebar.search.delegatedNoParent")));
    else {
      const place = el("span", "row-cwd", shortDir(r.session?.worktree?.origin ?? r.cwd));
      if (r.cwd) place.title = r.cwd;
      meta.append(place);
    }
    row.append(meta);
    row.setAttribute("aria-label", [r.title || t("session.untitled"), spokenHit, r.count > 0 ? t("sidebar.search.rowHits", { count: r.count }) : "", relTime(r.lastModified)].filter(Boolean).join(", "));
    row.onclick = () => openResult(r);
    if (onContext && r.session) row.oncontextmenu = (e) => { e.preventDefault(); onContext(r.session, e.clientX, e.clientY); };
    row._result = r;
    return row;
  }

  function renderResults(q) {
    if (!searchOn) { searchOn = true; paintMode(true); }
    wantRemote(q);
    const { server, total, partial, rows } = resultRows(q);
    const terms = parseTerms(q);
    root.replaceChildren();
    resultNodes = rows.map((r, i) => resultRow(r, i, terms));
    root.append(...resultNodes);
    const more = el("div", "empty", server && total > rows.length ? t("sidebar.search.more", { count: total - rows.length }) : "");
    more.setAttribute("role", "none");
    if (more.textContent) root.append(more);
    if (!rows.length && server) {
      const none = el("div", "empty", t("sidebar.search.none"));
      none.setAttribute("role", "none");
      root.append(none);
    }
    // 描き直しても、指していた会話を指し続ける
    optionAt = optionId == null ? -1 : resultNodes.findIndex((n) => n._result.id === optionId);
    paintOption(false);
    // 件数・弧（写しを読み込み中）・並び替え
    $("resHead").hidden = false;
    $("resCount").textContent = t("sidebar.search.count", { count: total });
    $("resArc").replaceChildren(...(partial ? [runMark(t("sidebar.search.searching"))] : []));
    const sort = $("resSort");
    sort.setAttribute("aria-pressed", String(sortMode === "recent"));
    sort.querySelector("span").textContent = sortMode === "recent" ? t("sidebar.search.sort.recent") : t("sidebar.search.sort.relevance");
    sort.title = sortMode === "recent" ? t("sidebar.search.sort.toRelevance") : t("sidebar.search.sort.toRecent");
    sort.setAttribute("aria-label", sort.title);
    // 読み上げは、本文まで探した結果が届いてから 1 度（手元の結果で 2 度言わない）
    if (server && !partial) $("resLive").textContent = rows.length ? t("sidebar.search.count", { count: total }) : t("sidebar.search.none");
    $("filterBtn").classList.toggle("on", filtering());
    renderChips();
    syncSearchHint();
  }

  /** 一覧の入れ物を、結果（listbox・平ら）といつもの木（tree）で切り替える */
  function paintMode(on) {
    root.setAttribute("role", on ? "listbox" : "tree");
    root.setAttribute("aria-label", on ? t("sidebar.search.results") : t("sidebar.list"));
    root.classList.toggle("flat", on);
    root.tabIndex = on ? -1 : 0;
    if (on) root.removeAttribute("aria-activedescendant");
    $("resHead").hidden = !on;
    if (!on) { $("resArc").replaceChildren(); $("resLive").textContent = ""; searchBox.removeAttribute("aria-activedescendant"); syncSearchHint(); }
  }

  /** 検索欄まわり（消すボタン・展開の状態）を語に合わせる */
  function syncSearchBar(q) {
    $("qClear").hidden = !searchBox.value;
    searchBox.setAttribute("aria-expanded", String(Boolean(q) || !$("recentPop").hidden));
  }

  /** ↑↓ で指している結果に印（輪）と aria-activedescendant を付ける */
  function paintOption(scroll = true) {
    resultNodes.forEach((n, i) => { n.classList.toggle("active", i === optionAt); n.setAttribute("aria-selected", String(i === optionAt)); });
    const node = resultNodes[optionAt];
    optionId = node ? node._result.id : null;
    if (node) { searchBox.setAttribute("aria-activedescendant", node.id); if (scroll) node.scrollIntoView({ block: "nearest" }); }
    else if (!$("recentPop").hidden && recentAt >= 0) searchBox.setAttribute("aria-activedescendant", `side-recent-${recentAt}`);
    else searchBox.removeAttribute("aria-activedescendant");
  }

  /** 検索欄に入っていて ↑↓ を使った間だけ、脇の下に操作キーの一行 */
  function syncSearchHint() {
    $("searchHint").hidden = !(searchKbd && document.activeElement === searchBox && (searchOn || !$("recentPop").hidden));
  }

  // 最近の検索。空の検索欄に入ったときだけ候補に出す（design-system §2.4「入力する所は選択肢も出す」）
  function syncRecent() {
    const pop = $("recentPop");
    const show = document.activeElement === searchBox && !searchBox.value && recentSearches.length > 0 && $("filterPop").hidden;
    pop.hidden = !show;
    if (!show) recentAt = -1;
    else {
      pop.replaceChildren(el("div", "head", t("sidebar.search.recent")));
      recentSearches.forEach((word, i) => {
        const b = el("button", "li" + (i === recentAt ? " kb" : ""));
        b.type = "button";
        b.id = `side-recent-${i}`;
        b.tabIndex = -1;
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(i === recentAt));
        b.append(icon("M12 7.5V12l3 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0"), el("span", "lbl", word));
        // 押すと検索欄にその語が入る（検索欄の focus を外さないよう mousedown で受ける）
        b.onmousedown = (e) => { e.preventDefault(); useRecent(word); };
        pop.append(b);
      });
    }
    syncSearchBar(searchBox.value.trim());
    paintOption(false);
    syncSearchHint();
  }

  function useRecent(word) {
    searchBox.value = word;
    recentAt = -1;
    render();
    syncRecent();
  }

  searchBox.addEventListener("focus", syncRecent);
  searchBox.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement === searchBox) return;
    $("recentPop").hidden = true;
    recentAt = -1;
    searchKbd = false;
    syncSearchBar(searchBox.value.trim());
    syncSearchHint();
  }, 150));
  searchBox.addEventListener("input", () => {
    optionAt = -1;
    optionId = null;
    recentAt = -1;
    render();
    syncRecent();
  });
  $("qClear").onclick = () => { searchBox.value = ""; optionAt = -1; optionId = null; render(); searchBox.focus(); syncRecent(); };
  $("resSort").onclick = () => { sortMode = sortMode === "recent" ? "relevance" : "recent"; save(); render(); };
  root.addEventListener("pointerdown", () => { searchKbd = false; syncSearchHint(); });
  searchBox.addEventListener("keydown", (e) => {
    if (isComposingKey(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const searching = searchBox.value.trim() !== "";
    const recentOpen = !$("recentPop").hidden;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !e.shiftKey) {
      const down = e.key === "ArrowDown";
      if (searching && resultNodes.length) {
        e.preventDefault();
        searchKbd = true;
        optionAt = down ? (optionAt + 1) % resultNodes.length : (optionAt - 1 + resultNodes.length) % resultNodes.length;
        paintOption();
        syncSearchHint();
      } else if (recentOpen) {
        e.preventDefault();
        searchKbd = true;
        if (down && recentAt === recentSearches.length - 1) {
          // 最近の検索の末尾から先は、いつもの一覧（木）へ
          $("recentPop").hidden = true;
          recentAt = -1;
          enterTree();
          return;
        }
        recentAt = down ? recentAt + 1 : Math.max(-1, recentAt - 1);
        syncRecent();
      } else if (down && !searching) {
        // 検索欄で ↓ を押すと一覧の先頭の行へ入る
        e.preventDefault();
        enterTree();
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (recentOpen && recentAt >= 0) { e.preventDefault(); useRecent(recentSearches[recentAt]); return; }
      const node = searching ? resultNodes[Math.max(0, optionAt)] : null;
      if (node) { e.preventDefault(); openResult(node._result); }
      return;
    }
    if (e.key === "Escape") {
      // 語があれば消していつもの一覧へ戻る（会話の中の検索・narrow の引き出しの Esc には伝えない）
      if (searchBox.value) { e.preventDefault(); searchBox.value = ""; optionAt = -1; optionId = null; render(); syncRecent(); }
      else if (recentOpen) { e.preventDefault(); $("recentPop").hidden = true; recentAt = -1; syncSearchBar(""); syncSearchHint(); }
      else searchBox.blur();
    }
  });

  function enterTree() {
    const first = treeItems().find((n) => n.classList.contains("row"));
    if (!first) return;
    activeKey = first.dataset.key;
    keyboard = true;
    root.focus();
    paintActive(true);
  }

  // ---- 浮く面 --------------------------------------------------------------

  const pops = ["filterPop", "iconPop"];
  const closePops = (except) => { for (const id of pops) if (id !== except) $(id).hidden = true; };
  document.addEventListener("click", (e) => { if (!e.target.closest(".pop")) closePops(); });
  document.addEventListener("keydown", (e) => { if (!isComposingKey(e) && e.key === "Escape") closePops(); });

  $("settings").onclick = (e) => {
    e.stopPropagation();
    closePops();
    onSettings();
  };

  function li(label, hint, on, onClick) {
    const b = el("button", "li" + (on ? " on" : ""));
    b.type = "button";
    b.append(el("span", "lbl", label));
    if (hint != null) b.append(el("span", "hint", hint));
    b.onclick = onClick;
    return b;
  }

  // フィルター。作業ディレクトリ × 状態、AND。候補が多いので上に絞り込みの欄、下は面の中でスクロール
  $("filterBtn").onclick = (e) => {
    e.stopPropagation();
    const p = $("filterPop");
    const wasHidden = p.hidden;
    closePops();
    if (!wasHidden) return;
    p.hidden = false;
    p.replaceChildren();
    const q = document.createElement("input");
    q.className = "field";
    q.placeholder = t("sidebar.filter.placeholder");
    q.setAttribute("aria-label", t("sidebar.filter.inputLabel"));
    const body = el("div", "pop-body");
    p.append(q, body);
    const dirs = new Map();
    for (const s of last.sessions) { const dir = s.worktree?.origin ?? s.cwd; if (dir) dirs.set(dir, (dirs.get(dir) ?? 0) + 1); }
    const counts = new Map();
    for (const s of last.sessions) { const k = statusKey(s); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const pick = (f) => { f(); save(); render(); p.hidden = true; };
    $("recentPop").hidden = true;
    const paint = () => {
      const needle = q.value.trim().toLowerCase();
      const hit = (s) => !needle || s.toLowerCase().includes(needle);
      body.replaceChildren();
      body.append(el("div", "head", t("sidebar.filter.agents")));
      const agents = new Map(Object.entries(last.backendLabels ?? {}));
      for (const s of last.sessions) if (s.backend && !agents.has(s.backend)) agents.set(s.backend, s.backend);
      if (!needle) body.append(li(t("sidebar.filter.all"), null, !filter.backends.length, () => { filter.backends = []; save(); render(); paint(); }));
      for (const [id, label] of agents) {
        if (!hit(label) && !hit(id)) continue;
        const on = filter.backends.includes(id);
        const b = li(label, String(last.sessions.filter(s => s.backend === id).length), on, () => {
          filter.backends = on ? filter.backends.filter(x => x !== id) : [...filter.backends, id]; save(); render(); paint();
          [...body.querySelectorAll('[data-backend]')].find(x => x.dataset.backend === id)?.focus();
        });
        b.dataset.backend = id; b.setAttribute("aria-pressed", String(on)); body.append(b);
      }
      body.append(el("div", "head", t("chat.composer.cwd")));
      if (!needle) body.append(li(t("sidebar.filter.all"), null, filter.dir == null, () => pick(() => { filter.dir = null; })));
      for (const [d, n] of [...dirs].sort((a, b) => b[1] - a[1])) {
        if (!hit(d)) continue;
        const b = li(shortDir(d) || d, String(n), filter.dir === d, () => pick(() => { filter.dir = d; }));
        b.title = d;
        body.append(b);
      }
      body.append(el("div", "head", t("sidebar.filter.status")));
      if (!needle) body.append(li(t("sidebar.filter.all"), null, filter.status === undefined, () => pick(() => { filter.status = undefined; })));
      for (const st of groupOrder()) {
        if (!hit(st ?? t("session.status.none"))) continue;
        body.append(li(st ?? t("session.status.none"), String(counts.get(st) ?? 0), filter.status === st, () => pick(() => { filter.status = st; })));
      }
      body.append(el("div", "head", t("sidebar.filter.period")));
      for (const days of PERIODS) {
        if (needle ? !days || !hit(periodLabel(days)) : false) continue;
        body.append(li(periodLabel(days), null, filter.period === days, () => pick(() => { filter.period = days; })));
      }
      // 語があるときだけ。語が無ければ意味が無いので出さない
      if (searchBox.value.trim()) {
        body.append(el("div", "head", t("sidebar.filter.speaker")));
        for (const [who, label] of [["any", t("sidebar.filter.all")], ["user", t("sidebar.filter.speakerUser")], ["assistant", t("sidebar.filter.speakerAssistant")]]) {
          if (needle && (who === "any" || !hit(label))) continue;
          body.append(li(label, null, scope.speaker === who, () => pick(() => { scope.speaker = who; })));
        }
        body.append(el("div", "head", t("sidebar.filter.include")));
        for (const [key, label] of [["delegated", t("sidebar.filter.includeDelegated")], ["tools", t("sidebar.filter.includeTools")]]) {
          if (!hit(label)) continue;
          const b = li(label, null, scope[key], () => { scope[key] = !scope[key]; render(); paint(); });
          b.setAttribute("aria-pressed", String(scope[key]));
          body.append(b);
        }
      }
    };
    q.oninput = paint;
    q.onkeydown = (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Escape") { e.preventDefault(); p.hidden = true; }
      if (e.key === "Enter") { e.preventDefault(); body.querySelector(".li")?.click(); }   // 先頭の候補で確定
    };
    paint();
    setTimeout(() => q.focus(), 0);
  };

  // ---- アイコン選択（絵文字ピッカー）。既定はフォルダ。人間が選ぶ経路。AI は set_status で同じ値を渡せる ----

  const loadRecent = () => {
    try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]"); return Array.isArray(a) ? a.filter((x) => typeof x === "string") : []; }
    catch { return []; }
  };
  const pushRecent = (e) => {
    const next = [e, ...loadRecent().filter((x) => x !== e)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* 保存できなくても動く */ }
  };

  async function openIconPicker(st, anchor) {
    if (st == null) return;                                 // 「状態なし」にアイコンは付けない
    const p = $("iconPop");
    closePops("iconPop");
    p.hidden = false;
    const r = anchor.getBoundingClientRect();
    const side = $("sidebar").getBoundingClientRect();
    p.style.left = `${Math.max(4, Math.min(r.left - side.left, side.width - 316))}px`;
    p.style.top = `${r.bottom - side.top + 4}px`;
    const cur = iconOf(st) ?? "";
    const choose = (e) => { p.hidden = true; pushRecent(e); onSetIcon?.(st, e); };

    // 押した瞬間に面を出す。一覧の読み込みを待つ間は弧
    p.replaceChildren(el("div", "head", t("sidebar.emoji.title", { status: st })));
    const q = document.createElement("input");
    q.className = "field";
    q.placeholder = t("sidebar.emoji.placeholder");
    q.setAttribute("aria-label", t("sidebar.emoji.search"));
    p.append(q);
    const tabs = el("div", "etabs");
    const body = el("div", "ebody");
    const wait = el("div", "empty ewait");
    wait.append(runMark(t("sidebar.emoji.loadingMark")), el("span", null, t("sidebar.emoji.loading")));
    body.append(wait);
    p.append(tabs, body);
    const reset = el("button", "li");
    reset.type = "button";
    reset.append(icon(FOLDER), el("span", "lbl", t("sidebar.emoji.reset")), el("span", "hint", t("sidebar.emoji.folder")));
    reset.onclick = () => { p.hidden = true; onSetIcon?.(st, ""); };
    p.append(reset);
    setTimeout(() => q.focus(), 0);

    const opened = (p.dataset.seq = String(Number(p.dataset.seq ?? 0) + 1));
    let mod;
    try { mod = await loadEmoji(); } catch { wait.textContent = t("sidebar.emoji.loadFailed"); return; }
    if (p.hidden || p.dataset.seq !== opened) return;      // 待っている間に閉じた・別のを開いた
    const { CATEGORIES, EMOJI_RE } = mod;

    /** 格子。触れると薄い丸、押すと確定。押した先は body で受ける（格子は使い回すので、ここでは結ばない） */
    const grid = (items) => {
      const g = el("div", "egrid");
      for (const [e, en, ja] of items) {
        const b = el("button", null, e);
        b.type = "button";
        b.dataset.e = e;
        b.title = `${ja} ${en}`.trim();
        g.append(b);
      }
      return g;
    };
    const section = (id, label, items) => {
      const s = el("div", "esec");
      s.dataset.cat = id;
      s.append(el("div", "head", label), grid(items));
      return s;
    };
    // カテゴリの格子は一度作ったら使い回す（1363 個のボタンを毎回作らない）
    const cached = (c) => {
      if (!sections.has(c.id)) sections.set(c.id, section(c.id, categoryLabel(c), c.items));
      return sections.get(c.id);
    };
    body.onclick = (e) => {
      const b = e.target.closest(".egrid button");
      if (b) choose(b.dataset.e);
    };
    const markCurrent = () => {
      for (const b of body.querySelectorAll(".egrid button.on")) b.classList.remove("on");
      if (cur) for (const b of body.querySelectorAll(`.egrid button[data-e="${CSS.escape(cur)}"]`)) b.classList.add("on");
    };

    for (const c of CATEGORIES) {
      const tab = el("button", "etab", c.icon);
      tab.type = "button";
      tab.title = categoryLabel(c);
      tab.onclick = () => { q.value = ""; renderAll(); body.querySelector(`.esec[data-cat="${c.id}"]`)?.scrollIntoView({ block: "start" }); };
      tabs.append(tab);
    }

    const renderAll = () => {
      body.replaceChildren();
      const recent = loadRecent();
      if (recent.length) {
        const all = new Map(CATEGORIES.flatMap((c) => c.items).map((it) => [it[0], it]));
        body.append(section("recent", t("sidebar.emoji.recent"), recent.map((e) => all.get(e) ?? [e, "", ""])));
      }
      for (const c of CATEGORIES) body.append(cached(c));
      markCurrent();
    };
    const renderSearch = (text) => {
      body.replaceChildren();
      const typed = text.trim();
      // 貼り付けた絵文字はそのまま候補の先頭に。一覧に無いものでも選べる
      const pasted = [...new Set([...typed.matchAll(EMOJI_RE)].map((m) => m[0]))];
      const words = typed.replace(EMOJI_RE, " ").toLowerCase().split(/\s+/).filter(Boolean);
      const hits = words.length
        ? CATEGORIES.flatMap((c) => c.items).filter(([e, en, ja]) => {
            const hay = `${en} ${ja}`.toLowerCase();
            return words.every((w) => hay.includes(w)) && !pasted.includes(e);
          })
        : [];
      const items = [...pasted.map((e) => [e, "", ""]), ...hits];
      body.append(items.length ? section("search", t("sidebar.emoji.hits", { count: items.length }), items) : el("div", "empty", t("sidebar.noMatch")));
      markCurrent();
    };
    q.oninput = () => (q.value.trim() ? renderSearch(q.value) : renderAll());
    q.onkeydown = (e) => {
      if (isComposingKey(e)) return;
      if (e.key === "Escape") { e.preventDefault(); p.hidden = true; }
      // Enter は先頭の候補で確定
      if (e.key === "Enter") { e.preventDefault(); body.querySelector(".egrid button")?.click(); }
    };
    if (q.value.trim()) renderSearch(q.value); else renderAll();   // 待っている間に打ち始めていたらその結果から
  }

  $("clearFilterOutside").onclick = () => { filter.backends = []; filter.dir = null; filter.status = undefined; filter.period = 0; save(); render(); };
  $("newSession").onclick = () => onNew?.({
    backend: filter.backends.length === 1 ? filter.backends[0] : undefined,
    status: filter.status !== undefined ? filter.status : null,
    cwd: filter.dir ?? cwdNow?.() ?? "",
  });
  // 一覧の空白の右クリック（行や見出しの上は各自のメニュー）
  root.oncontextmenu = (e) => {
    if (!onListContext || e.target.closest(".row,.grp-head,.fam-head")) return;
    e.preventDefault();
    onListContext(e.clientX, e.clientY);
  };

  return {
    /** 検索欄へ移る（Ctrl+Shift+F）。語が入っていれば全選択 */
    focusSearch() { searchBox.focus(); searchBox.select(); },
    /** この状態で新しいセッション（見出しのメニューから。見出しの ＋ と同じ） */
    newIn(status) { onNew?.({ status, cwd: filter.dir ?? cwdNow?.() ?? "", backend: filter.backends.length === 1 ? filter.backends[0] : undefined }); },
    /** グループのアイコン選択を開く（右クリックのメニューから。見出しのアイコンを押したのと同じ） */
    pickIcon(status) {
      const anchor = [...root.querySelectorAll(".grp-icon")].find((b) => b.dataset.status === status);
      if (anchor) openIconPicker(status, anchor);
    },
    /**
     * @param {Array} sessions listSessions の行
     * @param {object} o
     * @param {Array} o.statuses listStatuses の行（順序とアイコンの元）
     * @param {string|null} o.currentId
     * @param {Set<string>} o.runningIds
     * @param {Set<string>} o.waitingIds
     * @param {Map<string,number>} o.bgWaiting  main は返答済みで裏を待っているセッション -> 待っている本数
     * @param {Set<string>} o.unreadIds
     * @param {Map<string,{at:number,reason:string,unread:boolean}>} [o.interrupted]  中断した会話（web/interrupt.mjs）
     * @param {{status:string|null,cwd:string}|null} o.draft  まだ id の無い新しいセッション
     * @param {object|null} o.backendLabels  バックエンドが 2 つ以上のときだけ
     */
    render(sessions, o = {}) {
      last = {
        sessions: sessions ?? [],
        statuses: o.statuses ?? [],
        currentId: o.currentId ?? null,
        runningIds: o.runningIds ?? new Set(),
        waitingIds: o.waitingIds ?? new Set(),
        bgWaiting: o.bgWaiting ?? new Map(),
        unreadIds: o.unreadIds ?? new Set(),
        interrupted: o.interrupted ?? new Map(),
        draft: o.draft ?? null,
        backendLabels: o.backendLabels ?? null,
        pendingRows: o.pendingRows ?? new Map(),
        pendingStatuses: o.pendingStatuses ?? new Map(),
        pendingNew: o.pendingNew ?? null,
      };
      // 使われなくなった仮のグループは捨てる。使われ始めたものは statuses 側に移る
      for (const k of made) if (sessions.some((s) => statusKey(s) === k)) made.delete(k);
      // 会話が増えた・更新された（ターンの終わりなど）。語があるなら、本文まで探した結果も取り直す
      listSig = `${last.sessions.length}:${last.sessions.reduce((m, s) => Math.max(m, s.lastModified ?? 0), 0)}`;
      render();
    },
    /** この画面で作った、まだ誰も付いていない状態を一覧に出す */
    keep(status) { if (status) made.add(status); },
    get filter() { return { ...filter }; },
    /**
     * 直前の操作を取り消す一行。状態が黙って動く操作（グループの出入り・移動）でだけ出す。
     * 押すか、閉じるか、次の操作か、しばらく経つと消える
     */
    showUndo(text, fn, { retry = false } = {}) {
      const box = $("sideUndo");
      const hide = () => { clearTimeout(undoTimer); box.hidden = true; };
      clearTimeout(undoTimer);
      box.replaceChildren();
      if (!text) { box.hidden = true; return; }
      box.append(el("span", "side-undo-text", text));
      if (fn) {
        const b = el("button", "btn", retry ? t('pending.retry') : t("sidebar.undo"));
        b.type = "button";
        b.onclick = () => { hide(); fn(); };
        box.append(b);
      }
      box.classList.toggle('failed', retry);
      // 待たずに消したい人のための×。取り消しはせず、この一行を閉じるだけ
      const close = el("button", "btn btn-icon side-undo-close");
      close.type = "button";
      close.title = t("sidebar.undoClose");
      close.setAttribute("aria-label", t("sidebar.undoCloseLabel"));
      close.append(icon("M6 6l12 12M18 6L6 18"));
      close.onclick = hide;
      box.append(close);
      box.hidden = false;
      undoTimer = setTimeout(() => { box.hidden = true; }, UNDO_MS);
    },
    closePops,
  };
}
