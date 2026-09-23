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
import { shortModel } from "./compat-presets.mjs";

const FOLDER = "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z";
const FOLDER_ADD = "M12 11v5M9.5 13.5h5";
const SHIELD = "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z";
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

function panel(chip, pop, { align = "left", render, onShow }) {
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
      const width = Math.min(360, vw - 16);
      pop.style.width = `${width}px`;
      const want = align === "right" ? r.right - width : r.left;
      pop.style.left = `${Math.round(Math.max(8, Math.min(want, vw - 8 - width)))}px`;
      pop.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
      pop.style.maxHeight = `${Math.max(160, Math.round(r.top - 12))}px`;
    },
    render,
  };
  chip.setAttribute("aria-haspopup", "dialog");
  chip.setAttribute("aria-expanded", "false");
  chip.addEventListener("click", () => (self.open ? self.hide() : self.show()));
  chip.addEventListener("keydown", (e) => {
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !self.open) { e.preventDefault(); self.show(); }
  });
  pop.addEventListener("keydown", (e) => {
    if (isComposingKey(e)) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); self.hide(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    // 一覧の中を移る。入力欄からは ↓ で直下の一覧の先頭へ
    const from = e.target.closest?.("[role=option]");
    const list = from?.closest("[role=listbox]");
    if (!from && e.target.matches?.("input:not([type=range])") && e.key === "ArrowDown") {
      const first = pop.querySelector("[role=listbox]:not([hidden]) [role=option]");
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    if (!list) return;
    e.preventDefault();
    const rows = [...list.querySelectorAll("[role=option]:not(:disabled)")];
    const i = rows.indexOf(from) + (e.key === "ArrowDown" ? 1 : -1);
    if (i < 0) { pop.querySelector("input:not([type=range])")?.focus(); return; }
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
function row({ on, main, sub, right, tag, mono, danger, onPick, title, key, disabled }) {
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
  mid.append(el("span", "main", main));
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

  // チップの骨組み（アイコン + 字 + ▾）
  const cwdName = el("span", "v");
  chips.cwd.append(glyph(FOLDER), cwdName, glyph(CARET));
  chips.cwd.lastChild.classList.add("caret");
  const modelName = el("span", "v");
  chips.model.append(modelName, glyph(CARET));
  chips.model.lastChild.classList.add("caret");
  const modeName = el("span", "v");
  chips.mode.append(glyph(SHIELD), modeName, glyph(CARET));
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
    input.placeholder = "作業ディレクトリのパス";
    input.setAttribute("aria-label", "作業ディレクトリのパス（Enter で決める）");
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
    pick.append(glyph(FOLDER, FOLDER_ADD), el("span", null, "フォルダーを選ぶ…"));
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
    pop.replaceChildren(input, head("最近の作業ディレクトリ"),
      recent.length ? listbox("最近の作業ディレクトリ", recent) : el("p", "cnote", "まだありません"),
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
      if (r.parent) rows.push(row({ main: "..", sub: "ひとつ上へ", mono: true, onPick: () => browse(r.parent) }));
      for (const root of r.roots ?? []) if (root !== r.path) rows.push(row({ main: root, sub: "ドライブ", mono: true, onPick: () => browse(root) }));
      for (const name of r.dirs) {
        const full = r.path.replace(/[\\/]+$/, "") + (r.path.includes("\\") ? "\\" : "/") + name;
        rows.push(row({ main: name, mono: true, title: full, onPick: () => browse(full) }));
      }
      const crumb = el("div", "crumb", r.path);
      crumb.title = r.path;
      const go = el("div", "go");
      const choose = el("button", "btn btn-primary", "このフォルダーにする");
      choose.type = "button";
      choose.onclick = () => commitCwd(r.path);
      go.append(choose);
      box.replaceChildren(crumb,
        rows.length ? listbox(`${r.path} の中のフォルダー`, rows) : el("p", "cnote", "フォルダーがありません"),
        ...(r.truncated ? [el("p", "cnote", "多すぎるため途中まで表示しています。パスを入力してください")] : []),
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
      parts.push(head("エージェント"));
      const seg = el("div", "seg cseg");
      seg.setAttribute("role", "group");
      seg.setAttribute("aria-label", "エージェント");
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
    // 互換の接続先（Claude Code・Codex）。先頭は「公式」、下に登録した接続先。選んでいる間は使えないものを一行で出す
    const ep = d.endpoint;
    if (ep) parts.push(...endpointSection(d));
    if (ep?.row) parts.push(...compatModelSection(d));
    else parts.push(...officialModelSection(d));
    parts.push(head("エフォート（考える量）"));
    parts.push(effortBlock(d));
    if (d.accounts) {
      parts.push(head("Claude のアカウント"));
      // 互換の接続先ではアカウントを使わない（接続先のキーで送る）。節は残し、選べない見た目と理由を出す
      const off = Boolean(ep?.row);
      if (off) parts.push(el("p", "cnote", "互換の接続先ではアカウントを使いません。接続先に登録したキーで送ります。"));
      parts.push(listbox("Claude のアカウント", d.accounts.map((a) => row({
        on: !off && a.value === d.account, main: a.label, right: off ? "" : a.hint, tag: !off && a.value === "" ? "既定" : "", key: `account:${a.value}`, disabled: off,
        onPick: () => { if (!off && a.value !== d.account) on.account(a.value); },
      }))));
    }
    if (ep) {
      const foot = el("div", "cfoot");
      const manage = el("button", "clink", "接続先を管理…");
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
    const out = [head("接続先")];
    out.push(listbox("接続先", ep.options.map((o) => row({
      on: o.value === ep.selected, main: (o.warn ? "⚠ " : "") + o.label, sub: o.sub, tag: o.isDefault ? "既定" : "", key: `endpoint:${o.value}`, title: o.title ?? o.label,
      onPick: () => { if (o.value !== ep.selected && !o.gone) on.endpoint(o.value); },
    }))));
    if (ep.row) {
      const lost = el("p", "cnote");
      lost.append(el("b", null, "この接続先で使えないもの: "), ep.lost);
      out.push(lost);
    }
    return out;
  }

  /** 互換の接続先のモデル: ID の入力欄（Enter で決める）＋接続先の一覧。空はメインのモデル（「既定」の札） */
  function compatModelSection(d) {
    const ep = d.endpoint;
    const out = [head("モデル")];
    const main = ep.row.roles?.main ?? "";
    const input = el("input", "cpath");
    input.value = d.model ?? "";
    input.placeholder = main ? `モデル ID（空ならメインの ${shortModel(main)}）` : "モデル ID";
    input.setAttribute("aria-label", "モデル ID（Enter で決める）");
    input.dataset.key = "epmodel";
    input.autocomplete = "off"; input.spellcheck = false;
    const box = el("div");
    const roleOf = (id) => ep.roleNames.filter(([k]) => ep.row.roles?.[k] === id && k !== "main").map(([, n]) => n).join("・");
    const commit = (value) => {
      const v = String(value ?? "").trim();
      const next = v === main ? "" : v;
      if (next !== (d.model ?? "")) on.model(next);
    };
    const paintList = () => {
      const q = input.value.trim().toLowerCase();
      const all = [...new Set([main, ...(ep.row.models ?? [])].filter(Boolean))];
      const exact = all.some((m) => m.toLowerCase() === q);
      const shown = q && !exact ? all.filter((m) => m.toLowerCase().includes(q)) : all;
      const cur = d.model || main;
      box.replaceChildren(...(shown.length ? [listbox("モデルの候補", shown.slice(0, 200).map((m) => row({
        on: m === cur, main: m, mono: true, key: `epmodel:${m}`, title: m, tag: m === main ? "既定" : "", right: roleOf(m),
        onPick: () => commit(m),
      })))] : [el("p", "cnote", q ? "一覧にありません。Enter でこの ID を使います。" : "一覧がありません。ID を入力してください。")]));
    };
    input.addEventListener("input", paintList);
    input.addEventListener("keydown", (e) => {
      if (isComposingKey(e) || e.key !== "Enter") return;
      e.preventDefault();     // フォームの送信にしない
      commit(input.value);
    });
    paintList();
    out.push(input, box, el("p", "cnote", d.backend === "claude"
      ? "一覧は接続を確認したときに取ったものです。Opus・Sonnet・Haiku 相当は接続先の設定で割り当てます。"
      : "一覧は接続を確認したときに取ったものです。"));
    return out;
  }

  /** 公式のモデルの一覧（版付きの名前＋補足、既定の行に「既定」の札） */
  function officialModelSection(d) {
    const parts = [head("モデル")];
    const models = d.models ?? {};
    const { id: resolved, entry: current } = resolvedModel(models, d.model);
    const def = models[""]?.resolvesTo;
    // 段違いを系統にまとめた一覧（antigravity）は系統ごとに 1 行（composer-labels.mjs の modelRowIds）
    const ids = modelRowIds(models, d.model);
    // 既定が一覧のどれにも当たらない（分からない）ときは「既定に従う」の行を残す
    const rows = [];
    if (!def || !ids.some((id) => holdsDefault(models, id))) rows.push(row({
      on: !d.model, main: models[""]?.resolvedLabel ?? models[""]?.label ?? "既定に従う", sub: models[""]?.note, tag: "既定",
      key: "model:", onPick: () => d.model && on.model(""),
    }));
    for (const id of ids) {
      const m = models[id];
      rows.push(row({
        on: id === resolved || Boolean(m.family && m.family === current?.family),
        main: m.label ?? id, sub: m.note, tag: holdsDefault(models, id) ? "既定" : "", key: `model:${id}`,
        // 既定の行を選ぶと '' を保存する（既定が変われば追従する）。選んでいる系統の行は何もしない
        onPick: () => { const v = id === def ? "" : id; if (v !== d.model && id !== resolved) on.model(v); },
      }));
    }
    parts.push(listbox("モデル", rows));
    return parts;
  }

  function effortBlock(d) {
    const box = el("div", "ceffort");
    const { stops, def, current, unset } = effortStops(d.efforts, d.effort);
    const top = el("div", "etop");
    const val = el("span", "val");
    const note = el("span", "note");
    const reset = el("button", "reset", "既定に戻す");
    reset.type = "button";
    top.append(val, note, reset);
    const range = el("input");
    range.type = "range";
    range.min = "0"; range.step = "1";
    range.setAttribute("aria-label", "エフォート");
    range.dataset.key = "effort";
    const ticks = el("div", "ticks");
    const { label: modelLabel } = resolvedModel(d.models, d.model);
    // 既定に従うときに誰の設定が効くか
    const owner = d.endpoint?.row ? "接続先" : d.backend === "antigravity" ? "agy " : "エージェント";
    const paintVal = (v) => {
      val.textContent = v || "既定";
      note.textContent = !v ? `（${owner}の設定に従う）` : v === def && !d.effort ? `（${modelLabel} の既定）` : "";
      range.setAttribute("aria-valuetext", v ? v + (v === def ? "（既定）" : "") : `既定（${owner}の設定に従う）`);
    };
    if (!stops.length || d.effortDisabled) {
      range.disabled = true; range.max = "0"; range.value = "0";
      val.textContent = "—";
      note.textContent = d.efforts?.[""]?.reason ?? `${modelLabel} は段を選べません`;
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
      on: id === d.mode, main: (isDanger(m) ? "⚠ " : "") + (m.label ?? id), sub: m.note, tag: id === def ? "既定" : "", danger: isDanger(m), key: `mode:${id}`,
      onPick: () => { mode.hide(); if (id !== d.mode) on.mode(id); },
    }));
    pops.mode.replaceChildren(head("承認モード"), listbox("承認モード", rows));
  }
  const mode = panel(chips.mode, pops.mode, { align: "right", render: renderMode });

  /** チップの字を今の値に合わせる。開いている面も描き直す（値が変わった・候補が届いた） */
  function paint() {
    const d = get();
    // 作業ディレクトリ
    const cwd = d.cwd ?? "";
    cwdName.textContent = cwd ? baseName(cwd) : "作業ディレクトリ";
    chips.cwd.title = cwd ? `${cwd}（変更は次のターンから適用）` : "作業ディレクトリ";
    chips.cwd.setAttribute("aria-label", `作業ディレクトリ: ${cwd || "未指定"}`);
    chips.cwd.dataset.value = cwd;
    chips.cwd.disabled = Boolean(d.cwdDisabled);
    // モデル
    // 互換の接続先は「接続先 · モデル · 段」。モデル ID の `/` より前は省き、全体は title に出す
    const row = d.endpoint?.row;
    const epLabel = row ? endpointChipLabel({ connection: row.name, model: shortModel(d.model || row.roles?.main || ""), fullModel: d.model || row.roles?.main || "", effort: effortStops(d.efforts, d.effort).current }) : null;
    const label = epLabel ? epLabel.text : modelChipLabel(d.models, d.model, d.efforts, d.effort);
    const full = epLabel ? epLabel.full : label;
    modelName.textContent = label;
    chips.model.title = `${full}（エージェント・モデル・エフォート。次のターンから適用）`;
    chips.model.setAttribute("aria-label", `モデルとエフォート: ${full}`);
    chips.model.dataset.value = d.model ?? "";
    chips.model.dataset.backend = d.backend ?? "";
    // 承認モード
    const m = d.modes?.[d.mode];
    const danger = isDanger(m);
    modeName.textContent = (danger ? "⚠ " : "") + (m?.label ?? d.mode ?? "");
    chips.mode.classList.toggle("danger", danger);
    chips.mode.title = danger ? "承認モード: 確認なし・制限なし" : "承認モード";
    chips.mode.setAttribute("aria-label", `承認モード: ${m?.label ?? d.mode ?? ""}${danger ? "（確認なし・制限なし）" : ""}`);
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
  }

  return { paint, close: () => openPanel?.hide(false), panels: { folder, model, mode } };
}
