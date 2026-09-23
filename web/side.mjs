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
import { runMark, satMark } from "./arc.mjs";
import { el, icon, moreButton, relTime, svgEl } from "./dom.mjs";
import { fmt, t } from "./i18n.mjs";
import { familiesOf } from "./family.mjs";

const backendLogos = {
  codex: "./brand/openai.svg",
  claude: "./brand/claude.svg",
  antigravity: "./brand/antigravity.svg",
};

function backendLogo(id, label) {
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
      filter: { backends: Array.isArray(p.filter?.backends) ? p.filter.backends.filter(x => typeof x === "string") : [], dir: p.filter?.dir ?? null, status: "status" in (p.filter ?? {}) ? p.filter.status : undefined },
      collapsed: new Set(Array.isArray(p.collapsed) ? p.collapsed : []),
      expanded: new Set(Array.isArray(p.expanded) ? p.expanded : []),
    };
  } catch {
    return { filter: { backends: [], dir: null, status: undefined }, collapsed: new Set(), expanded: new Set() };
  }
}

/**
 * @param {object} o
 * @param {(sessionId: string|null) => void} o.onOpen       行を押した（null = まだ id の無い新しいセッション）
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
                             onSetGrouped, onJoinGroup, onMoveGroup, onListContext, onSettings, cwdNow }) {
  const $ = (id) => document.getElementById(id);
  const root = $("groups");
  const prefs = loadPrefs();
  let dragId = null;                            // つかんでいる行（またはグループの根）の sessionId
  let dragKind = null;                          // "row" = 1 本 / "group" = グループごと
  const inFamily = new Set();                   // いまグループの器の中に描かれている行
  let undoTimer = null;                         // 「元に戻す」の一行を消すタイマー
  const filter = prefs.filter;                 // { dir: string|null, status: string|null|undefined }
  const collapsed = prefs.collapsed;
  const expanded = prefs.expanded;              // 開いている家族（根の sessionId）。既定は畳んだ状態
  const decided = new Set();                    // 人が開閉を決めた家族。決めるまで、今いる会話の器は開いたまま
  const made = new Set();                       // この画面で作った（まだ誰も付いていない）仮の状態
  let last = { sessions: [], statuses: [], currentId: null, runningIds: new Set(), waitingIds: new Set(), unreadIds: new Set(), draft: null, backendLabels: null, pendingRows: new Map(), pendingStatuses: new Map(), pendingNew: null };

  const save = () => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        filter: { backends: filter.backends, dir: filter.dir, ...(filter.status === undefined ? {} : { status: filter.status }) },
        collapsed: [...collapsed],
        // 消えたセッションの id は溜めない（一覧を受け取る前は間引かない）
        expanded: last.sessions.length ? [...expanded].filter((id) => last.sessions.some((s) => s.id === id)) : [...expanded],
      }));
    } catch { /* 保存できなくても動く */ }
  };

  const filtering = () => filter.dir != null || filter.status !== undefined || filter.backends.length > 0;
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
    (filter.dir == null || (s.cwd ?? "") === filter.dir) &&
    (filter.status === undefined || statusKey(s) === filter.status) &&
    (!filter.backends.length || filter.backends.includes(s.backend));

  const matchesQuery = (s, q) =>
    !q || `${s.title ?? ""} ${s.status ?? ""} ${s.cwd ?? ""}`.toLowerCase().includes(q);

  // ---- 描画 --------------------------------------------------------------

  function render() {
    const q = $("q").value.trim().toLowerCase();
    root.replaceChildren();
    if (last.pendingNew) {
      const top = el('div', 'rows pending-new-top');
      top.append(row(last.pendingNew));
      root.append(top);
    }
    const groups = groupOrder();
    const visibleGroups = filter.status === undefined ? groups : groups.filter((g) => g === filter.status);

    // グループ（根とその子孫）にまとめる。器は根の状態の見出しの下に入り、枝は器の中だけに出る。
    // 親が絞り込みで消えている枝は、入れる一番近い祖先に付く。付ける先が無ければ自分が根（= ただの行）
    const visible = last.sessions.filter((s) => matchesFilter(s) && matchesQuery(s, q));
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
      if (!rows.length && !draftHere && (filtering() || q)) continue;   // 絞っているときは空のグループを出さない

      const sec = el("section", "grp");
      const isCollapsed = collapsed.has(st ?? "");
      // 動いている行（main が作業中）と、main は返答済みで裏だけを待っている行を分ける
      // bgWaiting は、ターンが裏を待っている行と、ターンは終わったが裏の作業が残っている行（Codex の端末）
      const active = rows.some((s) => last.runningIds.has(s.id) && !last.bgWaiting.has(s.id));
      const behind = rows.reduce((n, s) => n + (last.bgWaiting.get(s.id) ?? 0), 0);
      if (isCollapsed) sec.classList.add("collapsed");

      const head = el("div", "grp-head");
      const ic = el("button", "grp-icon", iconOf(st) ?? "");
      if (!iconOf(st)) ic.append(icon(FOLDER));
      ic.type = "button";
      ic.title = t("sidebar.group.pickIcon");
      ic.onclick = (e) => { e.stopPropagation(); openIconPicker(st, ic); };
      const name = el("button", "grp-name" + (st == null ? " none" : ""), st ?? t("session.status.none"));
      name.type = "button";
      name.onclick = () => { const k = st ?? ""; collapsed.has(k) ? collapsed.delete(k) : collapsed.add(k); save(); render(); };
      head.append(ic, name);
      const pendingStatus = last.pendingStatuses.get(st);
      if (pendingStatus) {
        head.classList.add('pending-status');
        if (pendingStatus.visible) { const label = el('span', 'pending-label'); label.append(runMark(pendingStatus.text), pendingStatus.text); head.append(label); }
      }
      // 畳んだ中に走っているものがあれば見出しに弧。走っていないときは印そのものを置かない（置くと回り続ける）
      // 動いているものが 1 つでもあれば弧、裏を待っているだけなら衛星（docs/design-system.md §6）
      if (isCollapsed && active) head.append(runMark(t("sidebar.somethingRunning")));
      else if (isCollapsed && behind) head.append(satMark(behind, t("activity.behindCount", { count: behind })));
      else if (isCollapsed && rows.some(s => last.unreadIds.has(s.id))) head.append(unreadMark());
      if (st != null) {
        const add = el("button", "btn btn-icon grp-add");
        add.type = "button";
        add.title = t("sidebar.group.newSession");
        add.append(icon(PLUS));
        add.onclick = (e) => { e.stopPropagation(); onNew?.({ status: st, cwd: filter.dir ?? cwdNow?.() ?? "", backend: filter.backends.length === 1 ? filter.backends[0] : undefined }); };
        head.append(add);
      }
      if (st != null) ic.dataset.status = st;
      // 右クリックと同じメニューを開く「…」。タッチでは右クリックもドラッグも届かない（docs/remote.md §8.4）
      if (onGroupContext) head.append(moreButton("grp-more", t("session.groupMore", { status: st ?? t("session.status.none") }), (x, y) => onGroupContext(st, x, y)));
      head.oncontextmenu = (e) => { if (!onGroupContext) return; e.preventDefault(); onGroupContext(st, e.clientX, e.clientY); };
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
      if (draftHere) rowsEl.append(row({ id: null, title: "", cwd: last.draft.cwd, status: last.draft.status }));
      for (const fam of fams) rowsEl.append(fam.kin.length ? family(fam) : row(fam.root));
      if (!rows.length && !draftHere) rowsEl.append(el("div", "empty", t("sidebar.empty")));
      sec.append(rowsEl);
      root.append(sec);
    }
    if (!root.childElementCount) root.append(el("div", "empty", filtering() || q ? t("sidebar.noMatch") : t("sidebar.empty")));

    $("filterBtn").classList.toggle("on", filtering());
    renderChips();
  }

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

  /**
   * 畳んだ器の見出しに出す要約。中の様子を開かずに読めるようにする。
   * 印（走っている・裏で待っている・未確認・承認待ち）と、状態ごとの件数。枝の本数そのものは出さない
   */
  function famSummary(list) {
    const sum = el("div", "fam-sum");
    const active = list.some((s) => last.runningIds.has(s.id) && !last.bgWaiting.has(s.id));
    const behind = list.reduce((n, s) => n + (last.bgWaiting.get(s.id) ?? 0), 0);
    const waiting = list.filter((s) => last.waitingIds.has(s.id)).length;
    if (active) sum.append(runMark(t("sidebar.somethingRunning")));
    else if (behind) sum.append(satMark(behind, t("activity.behindCount", { count: behind })));
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
    const head = el("button", "fam-head");
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.setAttribute("aria-controls", `fam-${id}`);
    head.title = open ? t("sidebar.family.collapse") : here ? t("sidebar.family.hereInside") : t("sidebar.family.expand");
    const body = el("div", "fam-body");
    const name = el("div", "fam-name");
    if (fam.root.parent?.sessionId) name.append(forkMark());
    name.append(el("span", "fam-t", titleOf(fam.root)));
    body.append(name);
    if (!open) body.append(famSummary(list));   // 開けば中の行が同じことを言うので、畳んでいる間だけ
    head.append(chevron(), body);
    head.onclick = () => {
      decided.add(id);
      if (open) expanded.delete(id); else expanded.add(id);
      save();
      render();
    };
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
    // 見出しはボタンなので「…」は中に入れられない。器の右上に重ねる
    if (onFamilyContext) box.append(moreButton("fam-more", t("session.familyMore", { title: titleOf(fam.root) || t("session.untitled") }), (x, y) => onFamilyContext(fam.root, list, x, y)));
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
      for (const s of list) kids.append(row(s));
      box.append(kids);
    }
    return box;
  }

  /**
   * 一覧の行。id が null なら、まだ id の無い新しいセッション（印は付かず、掴めない）
   * @param {object} [o]
   */
  function row(s) {
    const r = el("div", "row" + (s.id === last.currentId ? " sel" : ""));
    const pendingRow = last.pendingRows.get(s.id);
    const interactive = s.id != null && pendingRow?.kind !== 'new';
    if (pendingRow) r.classList.add('pending-row', `pending-${pendingRow.kind ?? 'move'}`);
    r.tabIndex = 0;
    r.dataset.session = s.id ?? "";
    const title = el("div", "row-title");
    // fork で生まれた会話の印。グループから外しても状態を変えても消えない（§4.1）
    if (s.parent?.sessionId) title.append(forkMark());
    title.append(el("span", "row-t", titleOf(s)));
    // 右クリックと同じメニューを開く「…」。Tab は行で止まる（行では ContextMenu・Shift+F10 で同じメニュー）
    if (onContext && interactive) {
      const more = moreButton("row-more", t("session.rowMore", { title: titleOf(s) || t("session.untitled") }), (x, y) => onContext(s, x, y));
      more.tabIndex = -1;
      title.append(more);
    }
    r.append(title);
    const meta = el("div", "row-meta");
    // 走っていれば弧。裏だけを待っていれば衛星（ターンが終わっても裏の作業が残っている会話を含む）
    const behind = last.bgWaiting.get(s.id);
    if (last.runningIds.has(s.id) || behind) meta.append(behind ? satMark(behind, t("activity.behindCount", { count: behind })) : runMark(t("activity.turnRunning")));
    else if (last.unreadIds.has(s.id)) meta.append(unreadMark());
    if (last.waitingIds.has(s.id)) meta.append(el("span", "wait", t("sidebar.waiting")));
    if (pendingRow?.visible) { const label = el('span', 'pending-label'); label.append(runMark(pendingRow.text), pendingRow.text); meta.append(label); }
    else if (isStale(s)) meta.append(el("span", "stale", t("sidebar.staleDays", { count: staleDays(s.statusChangedAt) })));
    else meta.append(el("span", "row-when", s.id == null ? fmt.justNow() : relTime(s.lastModified)));
    if (last.backendLabels && s.backend) meta.append(backendLogo(s.backend, last.backendLabels[s.backend] ?? s.backend));
    const cwd = el("span", "row-cwd", shortDir(s.cwd));
    if (s.cwd) cwd.title = s.cwd;
    meta.append(cwd);
    if (s.unsent) meta.append(el("span", "row-unsent", s.hasDraft ? t("sidebar.unsentDraft") : t("sidebar.unsent")));
    r.append(meta);

    r.onclick = () => { if (s.id !== last.currentId) onOpen?.(s.id); };
    r.onkeydown = e => {
      if (e.key === "Enter" && s.id !== last.currentId) onOpen?.(s.id);
      if (interactive && (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))) {
        e.preventDefault(); const rect = r.getBoundingClientRect(); onContext?.(s, rect.right, rect.top);
      }
    };
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
    for (const s of last.sessions) if (s.cwd) dirs.set(s.cwd, (dirs.get(s.cwd) ?? 0) + 1);
    const counts = new Map();
    for (const s of last.sessions) { const k = statusKey(s); counts.set(k, (counts.get(k) ?? 0) + 1); }
    const pick = (f) => { f(); save(); render(); p.hidden = true; };
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

  $("q").oninput = render;
  $("clearFilterOutside").onclick = () => { filter.backends = []; filter.dir = null; filter.status = undefined; save(); render(); };
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
        draft: o.draft ?? null,
        backendLabels: o.backendLabels ?? null,
        pendingRows: o.pendingRows ?? new Map(),
        pendingStatuses: o.pendingStatuses ?? new Map(),
        pendingNew: o.pendingNew ?? null,
      };
      // 使われなくなった仮のグループは捨てる。使われ始めたものは statuses 側に移る
      for (const k of made) if (sessions.some((s) => statusKey(s) === k)) made.delete(k);
      render();
    },
    /** この画面で作った、まだ誰も付いていない状態を一覧に出す */
    keep(status) { if (status) made.add(status); },
    get filter() { return { ...filter }; },
    setConnLost(lost) { $("connLost").hidden = !lost; },
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
