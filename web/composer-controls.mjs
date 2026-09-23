// 入力欄の下の設定（docs/design-system.md「入力欄の設定」、モック docs/mockups/composer-controls.html）。
//
// 「どこで」（作業ディレクトリ）「誰が・どれだけ考えて」（エージェント・モデル・エフォート・アカウント）
// 「どこまで任せるか」（承認モード）の 3 つのチップにまとめる。チップは押すと上へ浮く面（ポップオーバー）を開く。
//
//   - チップの字は全部同じ色・太さ。「既定から外れている」を色で示さない（既定が見えないと意味が伝わらないため）。
//     代わりにチップは**実際に使う値**を出す（例: Opus 5.5 · high）。一覧では「既定」は札として添えるだけ。
//     差を付けるのは承認モードが YOLO（範囲 full・自律 never）のときだけ: ⚠ と強い字
//   - 値はここでは持たない。get() が毎回 client.mjs の状態から読み、変更は on.*() で client.mjs に返す
//   - キーボード: チップは button（Enter / Space で開く）。Esc で閉じてチップへ戻る。一覧の中は ↑↓ で移る。
//     面の外を押すと閉じる。面は画面の幅に収める（360px の画面でもはみ出さない）
import { el, svgEl, relTime } from "./dom.mjs";
import { isComposingKey } from "./keyboard.mjs";
import { resolvedModel, effortStops, modelChipLabel, modelRowIds, holdsDefault, endpointChipLabel } from "./composer-labels.mjs";
import { compatModelLabel, modelCandidates, searchModels, resolveTyped, moreText, ONE_M_TITLE } from "./compat-models.mjs";
import { t } from "./i18n.mjs";
import { splitChipLabel } from "./composer-layout.mjs";

/** 一覧の「既定」の札 */
const DEFAULT_TAG = () => t("chat.model.default");

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_ADD = "M12 11v5M9.5 13.5h5";
const SHIELD = "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z";
// YOLO のときに盾と入れ替える ⚠ の線画（字には ⚠ を書かない。記号は 1 つ）
const WARN = ["M12 3.5l9.5 16.5h-19z", "M12 10v4.5M12 17.2v.3"];
// モデルのアイコン（チップの形を 3 つそろえるため。2026-09-23 に足した）
const MODEL = ["M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z", "M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"];
const CARET = "M7 10l5 5 5-5";

function glyph(...paths) {
  const svg = svgEl("svg", { class: "i", viewBox: "0 0 24 24", "aria-hidden": "true" });
  for (const d of paths) svg.append(svgEl("path", { d }));
  return svg;
}

/** パスの末尾（D:\work\my-app → my-app）。ドライブの根はそのまま */
export function baseName(p) {
  const parts = String(p ?? "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] + (parts.length === 1 && /:$/.test(parts[0]) ? "\\" : "") : String(p ?? "");
}

/** 承認モードが「確認なし・制限なし」か（core/modes.mjs の軸: 範囲 full・自律 never） */
export const isDanger = (m) => m?.scope === "full" && m?.autonomy === "never";

/** 既定の承認モード。client.mjs の selectedMode と同じ規則（default が無ければ先頭） */
export const defaultModeOf = (modes) => ("default" in (modes ?? {}) ? "default" : Object.keys(modes ?? {})[0] ?? "");

// 字を決める関数は DOM を触らない別の口（web/composer-labels.mjs。テストから直接呼ぶ）
export { resolvedModel, effortStops, modelChipLabel } from "./composer-labels.mjs";

// ---------------------------------------------------------------- 浮く面

let openPanel = null;   // 同時に開くのは 1 枚だけ

/**
 * チップ（押すもの）の上に浮く面。同時に開くのは 1 枚だけで、面の外を押すと閉じる。
 * width は面の幅（px。関数なら開くたび・置き直すたびに読む）。添付のメニュー（web/attach-menu.mjs）も使う。
 * when は開いてよいか（false なら押しても開かない。添付のメニューはホストの画面では開かず、クリップがすぐファイルを選ぶ）
 */
export function panel(chip, pop, { align = "left", render, onShow, width: wantWidth = 360, when }) {
  const self = {
    chip, pop,
    get open() { return !pop.hidden; },
    show(focus = true) {
      if (openPanel && openPanel !== self) openPanel.hide(false);
      openPanel = self;
      pop.hidden = false;
      chip.setAttribute("aria-expanded", "true");
      render();
      self.place();
      onShow?.();
      if (focus) (pop.querySelector('[aria-selected="true"]') ?? pop.querySelector("input:not([type=range]):not(:disabled), button:not(:disabled), [tabindex='0']"))?.focus();
    },
    hide(returnFocus = true) {
      if (pop.hidden) return;
      pop.hidden = true;
      chip.setAttribute("aria-expanded", "false");
      if (openPanel === self) openPanel = null;
      if (returnFocus) chip.focus();
    },
    /** チップの上に浮かせる。幅は画面に収め、チップの端に揃える（右のチップは右端） */
    place() {
      if (pop.hidden) return;
      const r = chip.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const width = Math.min(typeof wantWidth === "function" ? wantWidth() : wantWidth, vw - 16);
      pop.style.width = `${width}px`;
      const want = align === "right" ? r.right - width : r.left;
      pop.style.left = `${Math.round(Math.max(8, Math.min(want, vw - 8 - width)))}px`;
      pop.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
      pop.style.maxHeight = `${Math.max(160, Math.round(r.top - 12))}px`;
    },
    render,
  };
  const may = () => !when || when();
  if (may()) { chip.setAttribute("aria-haspopup", "dialog"); chip.setAttribute("aria-expanded", "false"); }
  chip.addEventListener("click", () => (self.open ? self.hide() : may() && self.show()));
  chip.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !self.open && may()) { e.preventDefault(); self.show(); }
  });
  pop.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self.hide(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // 一覧の中を移る。入力欄からは ↓ で入力欄より後ろにある最初の一覧の先頭へ（互換の接続先のモデルの欄は
    // 接続先の一覧の下にあるので、面の最初の一覧ではなく直下のモデルの候補へ）。一覧の先頭で ↑ は直前の入力欄へ
    const from = e.target.closest?.("[role=option]");
    const list = from?.closest("[role=listbox]");
    const after = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    if (!from && e.target.matches?.("input:not([type=range])") && e.key === "ArrowDown") {
      const first = [...pop.querySelectorAll("[role=listbox]:not([hidden]) [role=option]:not(:disabled)")].find((o) => after(e.target, o));
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    if (!list) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll("[role=option]:not(:disabled)")];
    const i = rows.indexOf(from) + (e.key === "ArrowDown" ? 1 : -1);
    if (i < 0) { [...pop.querySelectorAll("input:not([type=range])")].filter((n) => after(n, list)).pop()?.focus(); return; }
    rows[Math.min(i, rows.length - 1)]?.focus();
  });
  return self;
}

// 面の外を押したら閉じる。チップ自身は click で開け閉めするので除く
document.addEventListener("pointerdown", (e) => {
  if (!openPanel) return;
  if (openPanel.pop.contains(e.target) || openPanel.chip.contains(e.target)) return;
  openPanel.hide(false);
}, true);
window.addEventListener("resize", () => openPanel?.place());

/** 一覧の行。main（名前）+ sub（補足）+ right（札・時刻）。選ばれていれば ✓ */
function row({ on, main, sub, right, tag, mono, danger, onPick, title, key, disabled, badge }) {
  const b = el("button", "copt" + (mono ? " cmono" : "") + (danger ? " danger" : ""));
  b.type = "button";
  // 選べない行（互換の接続先を選んでいる間の Claude のアカウント）。弱い字で ✓ を付けない
  if (disabled) { b.disabled = true; b.setAttribute("aria-disabled", "true"); }
  if (key) b.dataset.key = key;
  b.setAttribute("role", "option");
  b.setAttribute("aria-selected", on ? "true" : "false");
  if (title) b.title = title;
  b.append(el("span", "tick", on ? "✓" : ""));
  const mid = el("span", "cbody");
  if (badge) {
    // 字の横の小さな札（互換の接続先のモデルの「1M」）。字だけを詰め、札は残す
    const m = el("span", "main hasb");
    const b = el("span", "cbadge", badge.text);
    if (badge.title) b.title = badge.title;
    m.append(el("span", "txt", main), b);
    mid.append(m);
  } else mid.append(el("span", "main", main));
  if (sub) mid.append(el("span", "sub", sub));
  b.append(mid);
  if (tag) b.append(el("span", "tag", tag));
  if (right) b.append(el("span", "r", right));
  b.onclick = onPick;
  return b;
}

function listbox(label, rows) {
  const box = el("div", "clistbox");
  box.setAttribute("role", "listbox");
  box.setAttribute("aria-label", label);
  box.append(...rows);
  return box;
}

const head = (text) => el("div", "chead", text);

// ---------------------------------------------------------------- 本体

/**
 * @param {object} o
 * @param {(command:string, args?:object) => Promise<any>} o.cmd
 * @param {() => object} o.get 今の値と候補（client.mjs の状態を読む）
 * @param {object} o.on 変更を返す口 { cwd, backend, model, effort, account, mode }。openModel はモデルの面を開いたとき
 */
export function setupComposerControls({ cmd, get, on }) {
  const $ = (id) => document.getElementById(id);
  const chips = { cwd: $("cwdChip"), model: $("modelChip"), mode: $("modeChip") };
  const pops = { cwd: $("cwdPop"), model: $("modelPop"), mode: $("modePop") };

  // チップの骨組み（アイコン + 字 + ▾）。3 つとも同じ形（docs/design-system.md「入力欄の設定」）
  const cwdName = el("span", "v");
  chips.cwd.append(glyph(FOLDER), cwdName, glyph(CARET));
  chips.cwd.lastChild.classList.add("caret");
  const modelName = el("span", "v");
  chips.model.append(glyph(...MODEL), modelName, glyph(CARET));
  chips.model.lastChild.classList.add("caret");
  const modeName = el("span", "v");
  const shield = glyph(SHIELD), warn = glyph(...WARN);
  chips.mode.append(shield, modeName, glyph(CARET));
  chips.mode.lastChild.classList.add("caret");

  // ---- 作業ディレクトリ
  let browsing = null;          // 簡易ブラウザーで開いているフォルダー（ブラウザー版だけ）
  let browseSeq = 0;
  const commitCwd = (v) => {
    const value = String(v ?? "").trim();
    if (!value) return;
    folder.hide();
    if (value !== get().cwd) on.cwd(value);
  };
  function renderFolder() {
    const d = get();
    const pop = pops.cwd;
    const input = el("input", "cpath");
    input.value = d.cwd ?? "";
    input.placeholder = t("composer.cwd.placeholder");
    input.setAttribute("aria-label", t("composer.cwd.inputLabel"));
    input.autocomplete = "off"; input.spellcheck = false;
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e) || e.key !== "Enter") return;
      e.preventDefault();     // フォームの送信にしない
      commitCwd(input.value);
    });
    const recent = (d.recent ?? []).map((r) => row({
      on: r.value === d.cwd, main: baseName(r.value), sub: r.value, right: r.time ? relTime(r.time) : "", mono: true, title: r.value,
      onPick: () => commitCwd(r.value),
    }));
    const pick = el("button", "caction");
    pick.type = "button";
    pick.append(glyph(FOLDER, FOLDER_ADD), el("span", null, t("composer.cwd.choose")));
    const err = el("p", "cerr");
    err.setAttribute("role", "alert");
    pick.onclick = async () => {
      err.textContent = "";
      // デスクトップ版は OS のダイアログ。ブラウザー版はサーバーが返す一覧を面の中で辿る
      if (window.plyDesktop?.chooseFolder) {
        const picked = await window.plyDesktop.chooseFolder().catch(() => null);
        const chosen = typeof picked === "string" ? picked : picked?.path ?? picked?.[0];
        if (chosen) commitCwd(chosen);
        return;
      }
      browse(d.cwd || "");
    };
    const box = el("div", "cbrowse");
    box.hidden = true;
    pop.replaceChildren(input, head(t("composer.cwd.recent")),
      recent.length ? listbox(t("composer.cwd.recent"), recent) : el("p", "cnote", t("composer.cwd.noRecent")),
      pick, box, err);
    if (browsing != null) browse(browsing);

    async function browse(dir, { keepError = false } = {}) {
      const seq = ++browseSeq;
      const prev = box.querySelector(".crumb") ? browsing : null;
      browsing = dir;
      box.hidden = false;
      box.setAttribute("aria-busy", "true");
      let r;
      try { r = await cmd("listDirs", { path: dir }); }
      catch (e) {
        if (seq !== browseSeq) return;
        box.removeAttribute("aria-busy");
        err.textContent = e.message;
        // 開けなかったら、開けていたところに留まる（最初から開けなければホーム）
        browsing = prev;
        if (prev == null && dir) browse("", { keepError: true });
        return;
      }
      if (seq !== browseSeq || pops.cwd.hidden) return;
      box.removeAttribute("aria-busy");
      if (!keepError) err.textContent = "";
      browsing = r.path;
      const rows = [];
      if (r.parent) rows.push(row({ main: "..", sub: t("composer.cwd.up"), mono: true, onPick: () => browse(r.parent) }));
      for (const root of r.roots ?? []) if (root !== r.path) rows.push(row({ main: root, sub: t("composer.cwd.drive"), mono: true, onPick: () => browse(root) }));
      for (const name of r.dirs) {
        const full = r.path.replace(/[\\/]+$/, "") + (r.path.includes("\\") ? "\\" : "/") + name;
        rows.push(row({ main: name, mono: true, title: full, onPick: () => browse(full) }));
      }
      const crumb = el("div", "crumb", r.path);
      crumb.title = r.path;
      const go = el("div", "go");
      const choose = el("button", "btn btn-primary", t("composer.cwd.useThis"));
      choose.type = "button";
      choose.onclick = () => commitCwd(r.path);
      go.append(choose);
      box.replaceChildren(crumb,
        rows.length ? listbox(t("composer.cwd.foldersIn", { path: r.path }), rows) : el("p", "cnote", t("composer.cwd.noFolders")),
        ...(r.truncated ? [el("p", "cnote", t("composer.cwd.truncated"))] : []),
        go);
      (box.querySelector("[role=option]") ?? choose).focus();
    }
  }
  const folder = panel(chips.cwd, pops.cwd, { align: "left", render: renderFolder });
  chips.cwd.addEventListener("click", () => { if (!folder.open) browsing = null; });

  // ---- エージェント・モデル・エフォート・アカウント
  function renderModel() {
    const d = get();
    const pop = pops.model;
    const parts = [];
    if (d.backendSwitchable) {
      parts.push(head(t("composer.agent")));
      const seg = el("div", "seg cseg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", t("composer.agent"));
      for (const b of d.backends) {
        const btn = el("button", b.id === d.backend ? "on" : "", b.label);
        btn.type = "button";
        btn.dataset.key = `backend:${b.id}`;
        btn.setAttribute("aria-pressed", String(b.id === d.backend));
        btn.onclick = () => { if (b.id !== d.backend) on.backend(b.id); };
        seg.append(btn);
      }
      parts.push(seg);
    }
    // 互換の接続先（Claude Code・Codex）。先頭は「公式」、下に登録した接続先。選んでいる間は使えないものを短い一行で出す
    const ep = d.endpoint;
    if (ep) parts.push(...endpointSection(d));
    if (ep?.row) parts.push(...compatModelSection(d));
    else parts.push(...officialModelSection(d));
    parts.push(head(t("composer.effort.title")));
    parts.push(effortBlock(d));
    if (d.accounts) {
      parts.push(head(t("composer.account.title")));
      // 互換の接続先ではアカウントを使わない（接続先のキーで送る）。節は残し、選べない見た目と理由を出す
      const off = Boolean(ep?.row);
      if (off) parts.push(el("p", "cnote", t("composer.account.compatOff")));
      parts.push(listbox(t("composer.account.title"), d.accounts.map((a) => row({
        on: !off && a.value === d.account, main: a.label, right: off ? "" : a.hint, tag: !off && a.value === "" ? DEFAULT_TAG() : "", key: `account:${a.value}`, disabled: off,
        onPick: () => { if (!off && a.value !== d.account) on.account(a.value); },
      }))));
    }
    if (ep) {
      const foot = el("div", "cfoot");
      const manage = el("button", "clink", t("composer.endpoint.manage"));
      manage.type = "button";
      manage.dataset.key = "epmanage";
      manage.onclick = () => { model.hide(false); ep.manage(); };
      foot.append(manage);
      parts.push(foot);
    }
    pop.replaceChildren(...parts);
  }

  /** 接続先の節。d.endpoint は client.mjs の endpointView() */
  function endpointSection(d) {
    const ep = d.endpoint;
    const out = [head(t("composer.endpoint.title"))];
    out.push(listbox(t("composer.endpoint.title"), ep.options.map((o) => row({
      on: o.value === ep.selected, main: (o.warn ? "⚠ " : "") + o.label, sub: o.sub, tag: o.isDefault ? DEFAULT_TAG() : "", key: `endpoint:${o.value}`, title: o.title ?? o.label,
      onPick: () => { if (o.value !== ep.selected && !o.gone) on.endpoint(o.value); },
    }))));
    if (ep.row) {
      out.push(el("p", "cnote", t("composer.endpoint.lost", { items: ep.lost })));
    }
    return out;
  }

  /**
   * 互換の接続先のモデル: 検索と ID の入力を兼ねる欄＋接続先の一覧。空はメインのモデル（「既定」の札）。
   * 字は表示名（web/compat-models.mjs。`anthropic/` の名前空間と [1m] を隠し、1M は札）、送るのは一覧どおりの ID（title）。
   * 打った字で絞る（大文字小文字を区別しない部分一致、空白区切りは AND。表示名・送る ID・display_name のどれでも）。
   * 描くのは先頭の SHOW_LIMIT 件だけ。↓ で一覧へ、Enter は打った字（一覧の ID か表示名に当たればその ID、無ければそのまま）
   */
  function compatModelSection(d) {
    const ep = d.endpoint;
    const out = [head(t("composer.model.title"))];
    const main = ep.row.roles?.main ?? "";
    const cur = d.model || main;
    // メイン → 今のモデル → 一覧の順（今のものは絞らなくても見える）
    const cands = modelCandidates(ep.row.models ?? [], ep.row.modelInfo ?? {}, [main, cur]);
    const initial = d.model ? compatModelLabel(d.model).text : "";
    const input = el("input", "cpath");
    input.value = initial;
    if (d.model) input.title = d.model;
    input.placeholder = main ? t("composer.model.searchMain", { model: compatModelLabel(main).text }) : t("composer.model.search");
    input.setAttribute("aria-label", t("composer.model.searchLabel"));
    input.dataset.key = "epmodel";
    input.autocomplete = "off"; input.spellcheck = false;
    const box = el("div");
    const roleOf = (id) => ep.roleNames.filter(([k]) => ep.row.roles?.[k] === id && k !== "main").map(([, n]) => n).join("・");
    const commit = (id) => {
      const v = String(id ?? "").trim();
      const next = v === main ? "" : v;
      if (next !== (d.model ?? "")) on.model(next);
    };
    const commitTyped = () => {
      const typed = input.value.trim();
      // 触っていない（今のモデルの表示名のまま）なら変えない。表示名が同じ候補（x と x[1m]）を取り違えないため
      if (typed === initial) return;
      commit(resolveTyped(cands, typed));
    };
    const paintList = () => {
      const q = input.value.trim().toLowerCase();
      // 今の値のままなら全部（先頭の SHOW_LIMIT 件）を出す
      const exact = !q || q === initial.toLowerCase() || cands.some((c) => c.id.toLowerCase() === q);
      const { shown, more } = searchModels(cands, exact ? "" : q);
      const rows = shown.map((c) => row({
        on: c.id === cur, main: c.text, sub: c.sub, key: `epmodel:${c.id}`, title: c.id, tag: c.id === main ? DEFAULT_TAG() : "", right: roleOf(c.id),
        badge: c.oneM ? { text: "1M", title: ONE_M_TITLE } : null,
        onPick: () => commit(c.id),
      }));
      const notes = [];
      if (more > 0) notes.push(el("p", "cnote", moreText(more)));
      box.replaceChildren(...(rows.length ? [listbox(t("composer.model.candidates"), rows)] : [el("p", "cnote", q ? t("composer.model.notListed") : t("composer.model.noList"))]), ...notes);
    };
    input.addEventListener("focus", () => input.select());
    input.addEventListener("input", paintList);
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e) || e.key !== "Enter") return;
      e.preventDefault();     // フォームの送信にしない
      commitTyped();
    });
    paintList();
    out.push(input, box);
    return out;
  }

  /** 公式のモデルの一覧（版付きの名前＋補足、既定の行に「既定」の札） */
  function officialModelSection(d) {
    const parts = [head(t("composer.model.title"))];
    const models = d.models ?? {};
    const { id: resolved, entry: current } = resolvedModel(models, d.model);
    const def = models[""]?.resolvesTo;
    // 段違いを系統にまとめた一覧（antigravity）は系統ごとに 1 行（composer-labels.mjs の modelRowIds）
    const ids = modelRowIds(models, d.model);
    // 既定が一覧のどれにも当たらない（分からない）ときは「既定に従う」の行を残す
    const rows = [];
    if (!def || !ids.some((id) => holdsDefault(models, id))) rows.push(row({
      on: !d.model, main: models[""]?.resolvedLabel ?? models[""]?.label ?? t("chat.next.useDefault"), sub: models[""]?.note, tag: DEFAULT_TAG(),
      key: "model:", onPick: () => d.model && on.model(""),
    }));
    for (const id of ids) {
      const m = models[id];
      rows.push(row({
        on: id === resolved || Boolean(m.family && m.family === current?.family),
        main: m.label ?? id, sub: m.note, tag: holdsDefault(models, id) ? DEFAULT_TAG() : "", key: `model:${id}`,
        // 既定の行を選ぶと '' を保存する（既定が変われば追従する）。選んでいる系統の行は何もしない
        onPick: () => { const v = id === def ? "" : id; if (v !== d.model && id !== resolved) on.model(v); },
      }));
    }
    parts.push(listbox(t("composer.model.title"), rows));
    return parts;
  }

  function effortBlock(d) {
    const box = el("div", "ceffort");
    const { stops, def, current, unset } = effortStops(d.efforts, d.effort);
    const top = el("div", "etop");
    const val = el("span", "val");
    const note = el("span", "note");
    const reset = el("button", "reset", t("composer.effort.reset"));
    reset.type = "button";
    top.append(val, note, reset);
    const range = el("input");
    range.type = "range";
    range.min = "0"; range.step = "1";
    range.setAttribute("aria-label", t("composer.effort.label"));
    range.dataset.key = "effort";
    const ticks = el("div", "ticks");
    const { label: modelLabel } = resolvedModel(d.models, d.model);
    // 既定に従うときに誰の設定が効くか
    // i18n-dynamic: composer.effort.follow.
    // i18n-dynamic: composer.effort.defaultFollow.
    const owner = d.endpoint?.row ? "endpoint" : d.backend === "antigravity" ? "agy" : "agent";
    const paintVal = (v) => {
      val.textContent = v || DEFAULT_TAG();
      note.textContent = !v ? t(`composer.effort.follow.${owner}`) : v === def && !d.effort ? t("composer.effort.modelDefault", { model: modelLabel }) : "";
      range.setAttribute("aria-valuetext", v ? (v === def ? t("composer.effort.levelDefault", { level: v }) : v) : t(`composer.effort.defaultFollow.${owner}`));
    };
    if (!stops.length || d.effortDisabled) {
      range.disabled = true; range.max = "0"; range.value = "0";
      val.textContent = "—";
      note.textContent = d.efforts?.[""]?.reason ?? t("composer.effort.noLevels", { model: modelLabel });
      note.title = note.textContent;
      reset.hidden = true;
      box.classList.add("off");
      box.append(top, range);
      return box;
    }
    range.max = String(stops.length - 1);
    // 既定の段が分からず既定に従っているときは、つまみを出さない（どの段も指さない。unset）。
    // 目盛りに「既定」の段は作らない（本当の段ではないため）。動かすと段が決まり、「既定に戻す」で外せる
    range.value = String(Math.max(0, stops.indexOf(current)));
    range.classList.toggle("unset", unset);
    for (const s of stops) ticks.append(el("span", s === def ? "def" : "", s));
    paintVal(current);
    reset.hidden = !d.effort;
    // 動かしている間は字だけ変え、離したとき（change）に決める。既定の段に戻したら '' を保存する
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const v = stops[+range.value];
      const next = v === def ? "" : v;
      if (next !== (d.effort ?? "")) on.effort(next);
    };
    range.addEventListener("input", () => { range.classList.remove("unset"); paintVal(stops[+range.value]); });
    range.addEventListener("change", commit);
    // つまみが出ていないときは、今の位置の目盛りを押しても change が来ない。離したときに決める
    range.addEventListener("pointerup", () => { if (unset) commit(); });
    range.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    reset.onclick = () => on.effort("");
    box.append(top, range, ticks);
    return box;
  }

  const model = panel(chips.model, pops.model, { align: "right", render: renderModel, onShow: () => on.openModel?.() });

  // ---- 承認モード
  function renderMode() {
    const d = get();
    const def = defaultModeOf(d.modes);
    const rows = Object.entries(d.modes ?? {}).map(([id, m]) => row({
      on: id === d.mode, main: (isDanger(m) ? "⚠ " : "") + (m.label ?? id), sub: m.note, tag: id === def ? DEFAULT_TAG() : "", danger: isDanger(m), key: `mode:${id}`,
      onPick: () => { mode.hide(); if (id !== d.mode) on.mode(id); },
    }));
    pops.mode.replaceChildren(head(t("chat.composer.mode")), listbox(t("chat.composer.mode"), rows));
  }
  const mode = panel(chips.mode, pops.mode, { align: "right", render: renderMode });

  /** チップの字を今の値に合わせる。開いている面も描き直す（値が変わった・候補が届いた） */
  function paint() {
    const d = get();
    // 作業ディレクトリ
    const cwd = d.cwd ?? "";
    cwdName.textContent = cwd ? baseName(cwd) : t("chat.composer.cwd");
    chips.cwd.title = cwd ? t("composer.cwd.chipTitle", { cwd }) : t("chat.composer.cwd");
    chips.cwd.setAttribute("aria-label", t("composer.cwd.chipAria", { cwd: cwd || t("composer.cwd.unset") }));
    chips.cwd.dataset.value = cwd;
    chips.cwd.disabled = Boolean(d.cwdDisabled);
    // モデル
    // 互換の接続先は「接続先 · モデル · 段」。モデルは表示名（web/compat-models.mjs）で、1M は札。送る ID を含む全体は title に出す
    const row = d.endpoint?.row;
    const epModel = row ? compatModelLabel(d.model || row.roles?.main || "") : null;
    const epLabel = row ? endpointChipLabel({ connection: row.name, model: epModel.text, fullModel: epModel.id, effort: effortStops(d.efforts, d.effort).current }) : null;
    const label = epLabel ? epLabel.text : modelChipLabel(d.models, d.model, d.efforts, d.effort);
    const full = epLabel ? epLabel.full : label;
    if (epLabel && epModel.oneM) {
      const b = el("span", "cbadge", "1M");
      b.title = ONE_M_TITLE;
      modelName.classList.remove("split");
      modelName.replaceChildren(epLabel.head, b, epLabel.tail ? ` · ${epLabel.tail}` : "");
    } else {
      // 狭いときは名前だけを … で詰め、「 · 段」は残す
      const { head, tail } = splitChipLabel(label);
      modelName.classList.add("split");
      modelName.replaceChildren(el("span", "mn", head), ...(tail ? [el("span", "ef", tail)] : []));
    }
    chips.model.title = t("composer.model.chipTitle", { label: full });
    chips.model.setAttribute("aria-label", t("composer.model.chipAria", { label: full }));
    chips.model.dataset.value = d.model ?? "";
    chips.model.dataset.backend = d.backend ?? "";
    // 承認モード
    const m = d.modes?.[d.mode];
    const danger = isDanger(m);
    // YOLO: 盾を ⚠ の線画に替え、強い字にする（字の頭に ⚠ は書かない・太字にしない）
    // 狭い行では短い名前（サーバーの short。「都度」など）に替える（fitRow）。読み上げは長い名前のまま
    const modeFull = m?.label ?? d.mode ?? "";
    const modeShort = m?.short && m.short !== modeFull ? m.short : "";
    modeName.replaceChildren(el("span", "full", modeFull), ...(modeShort ? [el("span", "short", modeShort)] : []));
    const icon = danger ? warn : shield;
    if (chips.mode.firstChild !== icon) chips.mode.firstChild.replaceWith(icon);
    chips.mode.classList.toggle("danger", danger);
    chips.mode.title = danger ? t("composer.mode.dangerTitle") : t("chat.composer.mode");
    chips.mode.setAttribute("aria-label", (danger ? t("composer.mode.chipAriaDanger", { mode: m?.label ?? d.mode ?? "" }) : t("composer.mode.chipAria", { mode: m?.label ?? d.mode ?? "" })));
    chips.mode.dataset.value = d.mode ?? "";
    // 開いている面も描き直す。触っていた部品へフォーカスを戻す（data-key で引き直す）。
    // 作業ディレクトリの面は打ち込み中・辿っている途中を消さないよう、位置だけ合わせる
    for (const p of [model, mode]) {
      if (!p.open) continue;
      const key = p.pop.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
      p.render(); p.place();
      if (key) (p.pop.querySelector(`[data-key="${CSS.escape(key)}"]:not([hidden]):not(:disabled)`) ?? p.pop.querySelector('[aria-selected="true"]'))?.focus();
    }
    folder.place();
    fitRow();
  }

  /**
   * チップの行を 1 行に収める（docs/design-system.md「入力欄と上端」）。短い値は詰めない。足りない分だけ、この順に削る:
   *   1. 承認モードを短い名前に（都度確認 → 都度）  2. モデルの「 · 段」を外す
   *   3. モデル名を … で詰める（「Smart…」くらいまで）  4. 作業ディレクトリの名前を … で詰める（9 字くらいまでは残す）
   * 縮める前の幅は、チップを縮めない状態（.measuring）で測る。行の幅・中身が変わるたびに呼ぶ（paint・窓の幅・中断の出入り）
   */
  function fitRow() {
    const row = chips.cwd.parentElement;
    if (!row || !row.isConnected || !row.offsetParent) return;
    const cwd = chips.cwd, mdl = chips.model;
    row.classList.remove("fit-short", "fit-noef");
    cwd.style.minWidth = ""; mdl.style.minWidth = "";
    row.classList.add("measuring");
    // 最後の部品（送信）の右端が行の右端に収まるか（scrollWidth は整数に丸められ、1px 足りないのを見逃す）
    const fits = () => {
      const last = [...row.children].reverse().find((n) => n.offsetParent);
      return !last || last.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.01;
    };
    if (!fits()) row.classList.add("fit-short");
    if (!fits()) row.classList.add("fit-noef");
    let size = null;
    if (!fits()) {
      const w = (n) => n.getBoundingClientRect().width;
      const v = (n) => w(n.querySelector(".v"));
      size = { cwd: [w(cwd), w(cwd) - v(cwd)], mdl: [w(mdl), w(mdl) - v(mdl)] };
    }
    row.classList.remove("measuring");
    if (!size) return;
    // 名前の最小の幅は字の幅（ch）で決める（作業ディレクトリ 9 字・モデル 6 字）。もともと短い名前はそのまま。
    // それでも入らない（とても狭い・中断が出ている）ときは、両方の最小を段々に下げる
    const min = ([whole, frame], ch) => `min(${whole}px, calc(${frame}px + ${ch}ch))`;
    for (const [a, b] of [[9, 6], [7, 4], [5, 3], [3, 2]]) {
      cwd.style.minWidth = min(size.cwd, a);
      mdl.style.minWidth = min(size.mdl, b);
      if (fits()) return;
    }
    cwd.style.minWidth = ""; mdl.style.minWidth = "";
  }
  window.addEventListener("resize", fitRow);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => fitRow()).observe(chips.cwd.parentElement);

  return { paint, fit: fitRow, close: () => openPanel?.hide(false), panels: { folder, model, mode } };
}
