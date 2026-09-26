// ==================== 会話の右パネル「この会話のコンテキスト」（docs/design-system.md「コンテキスト」） ====================
// 会話の頭の札（指示 2 · Skills 14 · MCP … · Pleiad の指示 3）を押すと、ファイルプレビューと同じ右パネルに開く（web/file-preview.mjs の openPanel）。
// 一番上は作業場所の面: 「<場所> · 全体の設定どおり／<親の場所> の設定どおり／このフォルダーだけの設定 · n 項目」と「この場所だけ変える」。
//   変えている間（edit）は、この場所の設定（places。core/context-settings.mjs）で探した結果を並べ、担当と行のスイッチでこのフォルダーだけ変える
//   （「全体の設定に戻す」「終わる」）。保存は次のターンから効く。
// ふだんは sessionContext の記録（core/server.mjs）から作る。種類ごとに、渡したものを出どころ（ユーザー／この場所と親フォルダー／追加した場所）で分ける。
//   - 開始後に指示・Skills が変わった: 次の送信で自動的に読み込み直す。「新しい内容で会話を続ける」（refreshContext）は送信を待たずに今すぐ反映する操作と「差分を見る」
//   - MCP: 接続中（ツール数・呼び出し回数）／要ログイン（ブラウザでログイン・この会話では外す）／失敗（理由）
//   - エージェント任せの MCP は、そのエージェントの設定に登録されているものを読み取りのみで並べる（agentMcp）
//   - antigravity で Pleiad 担当を扱わなかった会話は、その理由
//   - Pleiad の指示（core/ply-instructions.mjs。担当によらない）: 項目ごとに入れたか・入れなかった理由と、渡した文
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { renderMarkdown } from './render.mjs';
import { estimateTokens } from './token-estimate.mjs';
import { toggleExclude } from './context.mjs';
import { toggleMcp } from './mcp-config.mjs';

const KEY = 'session-context';
const KINDS = ['instruction', 'skill', 'mcp'];
const WORD = { instruction: t('sessionContext.word.instruction'), skill: 'Skills', mcp: 'MCP' };
const COUNTED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
const AGENT_FILES = { claude: 'claude', codex: 'codex' };
const SOURCE = { claude: 'Claude', codex: 'Codex', common: t('sessionContext.source.common'), ply: 'Pleiad' };
const GROUPS = ['user', 'dir', 'extra'];
// 「この場所だけ変える」の担当の 2 択（設定の画面と同じ文）
const OWNER = {
  native: [t('context.owner.agent'), { instruction: t('context.instruction.agent'), skill: t('context.skill.agent'), mcp: t('context.mcp.agent') }],
  ply: [t('context.owner.ply'), { instruction: t('context.instruction.ply'), skill: t('context.skill.ply'), mcp: t('context.mcp.ply') }],
};
const SKILLS_SHOWN = 6;

// 「9/23 09:05」か「09:05」
function stamp(at, withDay = true) {
  if (!at) return '';
  return withDay ? fmt.dateTime(at, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : fmt.time(at);
}
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const base = p => String(p ?? '').split(/[\\/]/).pop();
/** ホーム（C:\Users\名前・/home/名前・/Users/名前）の下は ~ で短くする */
const shortPath = p => { const m = /^([A-Za-z]:)?[\\/](?:Users|home)[\\/][^\\/]+/.exec(String(p ?? '')); return m ? `~${String(p).slice(m[0].length)}` : String(p ?? ''); };
const dir = p => String(p ?? '').replace(/[\\/][^\\/]*$/, '');
/** 同じ行（id）を 1 つに。外したファイルは探索が出典ごとに別の行で返す（core/context-scan.mjs の add） */
export const uniqueRows = rows => { const seen = new Set(); return rows.filter(e => !seen.has(e.id) && seen.add(e.id)); };
/** 行の出どころ。足した場所（root）で見つかったもの／ユーザーの範囲（home）／この場所と親フォルダー（Git のルートから作業場所まで） */
const groupOf = e => e.root ? 'extra' : (e.scope ?? e.origins?.[0]?.scope) === 'user' ? 'user' : 'dir';
function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
/** 渡さなかった理由（記録に理由の文が無いとき） */
const REASON = {
  excluded: () => t('sessionContext.reason.excluded'),
  shadowed: () => t('sessionContext.reason.shadowed'),
  duplicate: () => t('sessionContext.reason.duplicate'),
  disabled: () => t('sessionContext.reason.disabled'),
  unsupported: () => t('sessionContext.reason.unsupported'),
};
/** Pleiad が担当した種類か（antigravity で扱わなかった会話は、担当が Pleiad でもエージェント任せ） */
const managed = (info, kind) => info?.report?.status !== 'native' && (info.owners ?? info.report?.owners ?? {})[kind] === 'ply';
/** Pleiad の指示の記録 1 件。前の版の記録（{ id: 'delegation', variant, text }）も読む */
const addedItem = a => ({ ...a, inserted: a.inserted ?? Boolean(a.variant), name: a.name ?? t('sessionContext.added.delegation') });

/** 札の文言。「指示 2 · Skills 14 · MCP 3（1 件つながらない）」「MCP はエージェント任せ」、Pleiad の指示を入れていれば「Pleiad の指示 3」 */
export function chipText(info) {
  const report = info?.report;
  if (!report) return '';
  const parts = [], natives = [];
  for (const kind of Object.keys(WORD)) {
    if (!managed(info, kind)) { natives.push(WORD[kind]); continue; }
    const rows = (report.entries ?? []).filter(e => e.kind === kind);
    const n = rows.filter(e => COUNTED[kind].includes(e.status)).length;
    if (kind !== 'mcp') { parts.push(`${WORD[kind]} ${n}`); continue; }
    const bad = rows.filter(e => e.status === 'needs-auth' || e.status === 'failed').length;
    parts.push(bad ? t('sessionContext.chip.mcpBad', { n, bad }) : `MCP ${n}`);
  }
  if (natives.length) parts.push(t('sessionContext.chip.native', { kinds: natives.join(t('sessionContext.chip.join')) }));
  const added = (info.added ?? []).map(addedItem).filter(a => a.inserted).length;
  if (added) parts.push(t('sessionContext.chip.added', { n: added }));
  return parts.join(' · ');
}

/** 行単位の差分。前後の一致を落とし、残りを最長共通部分列で並べる（大きいときは削除→追加の塊） */
export function lineDiff(before, after) {
  const a = String(before ?? '').split(/\r?\n/), b = String(after ?? '').split(/\r?\n/);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let post = 0;
  while (post < a.length - pre && post < b.length - pre && a[a.length - 1 - post] === b[b.length - 1 - post]) post++;
  const x = a.slice(pre, a.length - post), y = b.slice(pre, b.length - post);
  let mid = [];
  if (x.length * y.length <= 1_000_000) {
    const w = y.length + 1, len = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
      len[i * w + j] = x[i] === y[j] ? len[(i + 1) * w + j + 1] + 1 : Math.max(len[(i + 1) * w + j], len[i * w + j + 1]);
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { mid.push({ t: ' ', s: x[i] }); i++; j++; }
      else if (j < y.length && (i >= x.length || len[i * w + j + 1] > len[(i + 1) * w + j])) { mid.push({ t: '+', s: y[j] }); j++; }
      else { mid.push({ t: '-', s: x[i] }); i++; }
    }
  } else mid = [...x.map(s => ({ t: '-', s })), ...y.map(s => ({ t: '+', s }))];
  return [...a.slice(0, pre).map(s => ({ t: ' ', s })), ...mid, ...a.slice(a.length - post).map(s => ({ t: ' ', s }))];
}
/** 差分の表示。変わった行の前後 2 行だけ残し、あとは「n 行同じ」に畳む。色ではなく記号（− / +）と面の階調で見せる */
function diffView(ops) {
  const box = el('div', 'scx-lines');
  const keep = ops.map((o, i) => o.t !== ' ' || ops.slice(Math.max(0, i - 2), i + 3).some(n => n.t !== ' '));
  for (let i = 0; i < ops.length;) {
    if (!keep[i]) {
      let j = i;
      while (j < ops.length && !keep[j]) j++;
      box.append(el('div', 'skip', t('sessionContext.diff.same', { count: j - i })));
      i = j;
      continue;
    }
    const o = ops[i++];
    const row = el('div', o.t === '-' ? 'del' : o.t === '+' ? 'add' : '');
    row.append(el('span', 'g', o.t === '-' ? '−' : o.t === '+' ? '+' : ''), el('span', null, o.s || ' '));
    box.append(row);
  }
  return box;
}

/**
 * 作業場所の面の一言。here は contextSettings の今の場所（places の current）。
 * このフォルダーだけの上書きがあれば「このフォルダーだけの設定 · n 項目」、上の場所の上書きに従っていれば「<場所> の設定どおり」
 */
export function placeStatus(here) {
  if (!here) return { over: false, text: t('sessionContext.place.default'), count: 0 };
  const own = here.saved ? here.overrides : 0;
  if (own) return { over: true, text: t('sessionContext.place.override', { count: own }), count: own };
  const from = [...KINDS.map(k => here.kinds?.[k]?.from), ...KINDS.map(k => here.roots?.[k]?.from)].find(Boolean);
  return { over: false, text: from ? t('sessionContext.place.from', { path: shortPath(from) }) : t('sessionContext.place.default'), count: 0 };
}

// i18n-dynamic: sessionContext.group.
// i18n-dynamic: sessionContext.added.reason.
export function setupSessionContext({ cmd, preview, session, info, refreshInfo, openSettings, labelOf, isRunning = () => false }) {
  const logins = new Map();     // MCP 名 -> ログインの進み具合（ブラウザで続けてください… / ログインしました）
  const agentCache = new Map(); // cwd -> agentMcp の結果
  let diff = null, diffOpen = false, busy = false, notice = '';
  let refreshLoadingVisible = false;
  const removedPending = new Map();
  let chip = null;
  // 作業場所の設定（contextSettings）と、「この場所だけ変える」の間の探索結果
  let place = { cwd: null, view: null, loading: false }, edit = false, editScan = null, editBusy = false, toastTimer = null, toastOn = false;

  const title = t('sessionContext.title');
  function subtitle(data) {
    const started = data.startedAt ?? data.report?.at;
    const text = started ? t('sessionContext.subtitle.startedAt', { time: stamp(started) }) : t('sessionContext.subtitle.started');
    return data.refreshedAt ? t('sessionContext.subtitle.refreshed', { text, time: stamp(data.refreshedAt) }) : text;
  }
  const backendLabel = () => labelOf(session()?.backend) || t('sessionContext.agent');
  const cwdOf = data => data?.report?.cwd ?? session()?.cwd ?? null;
  const here = () => place.view?.places?.find(p => p.current) ?? null;

  // ---------------------------------------------------------------- 描画
  let shownFor = null;
  function render() {
    // 別の会話へ移った。前の会話の差分・ログインの途中経過・変えている途中は持ち越さない
    if (session()?.id !== shownFor) { shownFor = session()?.id ?? null; diff = null; diffOpen = false; notice = ''; logins.clear(); removedPending.clear(); edit = false; editScan = null; }
    const data = info();
    const box = el('div', 'scx');
    if (!data?.report) {
      box.append(el('p', 'cx-sub', t('sessionContext.notStarted')));
      return box;
    }
    const report = data.report;
    loadPlace(cwdOf(data));
    box.append(placeFace(data));
    if (data.changed?.differs && !edit) box.append(changedNotice(data));
    if (report.guardedBackend) {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', t('sessionContext.guarded.title')), el('p', 'cx-sub', report.reason ?? t('sessionContext.guarded.reason', { backend: report.guardedBackend })));
      box.append(n);
    }
    if (report.status === 'failed') {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', t('sessionContext.failed.title')), el('p', 'cx-sub', t('sessionContext.failed.hint')));
      box.append(n);
    }
    if (edit) box.append(...KINDS.flatMap(k => [editFace(k), ...(k === 'instruction' && data.added?.length ? [addedEditFace()] : [])]));
    else {
      box.append(instructions(data));
      if (data.added?.length) box.append(addedBox(data));
      box.append(skills(data), mcp(data));
    }
    const foot = el('p', 'scx-foot');
    foot.append(t('sessionContext.foot.lead'), button(t('sessionContext.foot.link'), 'cx-link', () => openSettings()));
    box.append(foot);
    const toast = el('div', 'cx-toast scx-toast' + (toastOn ? ' on' : ''), t('context.saved')); toast.setAttribute('role', 'status');
    box.append(toast);
    return box;
  }
  function kindBox(label, who, ply) {
    const k = el('section', 'scx-kind');
    const head = el('div', 'cx-khead');
    head.append(el('h4', null, label), el('span', 'scx-who' + (ply ? ' ply' : ''), who));
    k.append(head);
    return k;
  }
  function item(mark, name, sub, { on = false } = {}) {
    const row = el('div', 'scx-item');
    const m = el('span', 'mark' + (on ? ' on' : ''), mark);
    m.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', name));
    if (sub) body.append(el('div', 'p', sub));
    row.append(m, body);
    return { row, body };
  }
  /** 行を出どころ（ユーザー／この場所と親フォルダー／追加した場所）で分けて並べる */
  function grouped(k, rows, make) {
    for (const g of GROUPS) {
      const list = rows.filter(e => groupOf(e) === g);
      if (!list.length) continue;
      k.append(el('p', 'scx-grp', t(`sessionContext.group.${g}`)));
      for (const e of list) k.append(make(e));
    }
  }

  // ---------------------------------------------------------------- 作業場所の面
  function loadPlace(cwd) {
    if (!cwd || (place.cwd === cwd && (place.view || place.loading))) return;
    place = { cwd, view: null, loading: true };
    cmd('contextSettings', { cwd }).then(v => { if (place.cwd === cwd) { place.view = v; place.loading = false; refresh(); } })
      .catch(() => { if (place.cwd === cwd) place.loading = false; });
  }
  function placeFace(data) {
    const face = el('section', 'scx-place');
    face.setAttribute('aria-label', t('sessionContext.place.aria'));
    const text = el('div', 't');
    text.append(el('span', 'cx-path', cwdOf(data) ?? ''));
    const st = placeStatus(here());
    const line = el('div', 'p' + (st.over ? ' over' : ''), st.text + (edit && !st.over ? t('sessionContext.place.willOverride') : ''));
    text.append(line);
    const acts = el('div', 'acts');
    if (edit) {
      if (st.over) acts.append(button(t('sessionContext.place.reset'), 'btn', () => placeWork(async () => {
        place.view = await cmd('setContextSettings', { cwd: place.cwd, place: place.cwd, remove: true });
        await loadEditScan();
      }, '[data-act=placeDone]')));
      const done = button(t('sessionContext.place.done'), 'btn btn-quiet', () => { edit = false; editScan = null; refresh(); focusIn('[data-act=placeStart]'); });
      done.dataset.act = 'placeDone';
      acts.append(done);
    } else {
      const start = button(t('sessionContext.place.start'), 'btn btn-quiet', () => startEdit());
      start.dataset.act = 'placeStart';
      start.disabled = !place.view;
      acts.append(start);
    }
    face.append(text, acts);
    return face;
  }
  async function startEdit() {
    edit = true; editScan = null;
    refresh();
    focusIn('[data-act=placeDone]');
    await loadEditScan();
  }
  async function loadEditScan() {
    const cwd = place.cwd;
    for (let i = 0; i < 20; i++) {
      try { editScan = await cmd('scanContext', { cwd }); break; }
      catch (e) {
        if (e.code !== 'SCAN_BUSY') { notice = t('sessionContext.place.scanFailed', { error: e.message }); editScan = { entries: [] }; break; }
        await new Promise(r => setTimeout(r, 300));
      }
    }
    if (place.cwd === cwd) refresh();
  }
  /** この場所の設定を 1 つ変えて保存し、探し直す。focus は描き直した後に戻す先 */
  async function placeWork(fn, focus) {
    if (editBusy) return;
    editBusy = true; notice = '';
    try { await fn(); showToast(); }
    catch (e) { notice = t('context.saveFailed', { error: e.message }); }
    finally { editBusy = false; refresh(); if (focus) focusIn(focus); }
  }
  /** この場所で効いている種類の設定を写して変え、この場所の上書きとして保存する（全体と同じになれば上書きは消える） */
  function savePlaceKind(kind, mutate, focus) {
    return placeWork(async () => {
      const value = structuredClone(here()?.kinds[kind].value ?? place.view.defaults.kinds[kind].value);
      mutate(value);
      place.view = await cmd('setContextSettings', { cwd: place.cwd, place: place.cwd, kind, value });
      await loadEditScan();
    }, focus);
  }
  function showToast() {
    toastOn = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastOn = false; document.querySelector('.scx-toast')?.classList.remove('on'); }, 1800);
  }
  function focusIn(selector) { requestAnimationFrame(() => document.querySelector(`.scx ${selector}`)?.focus()); }

  // ---------------------------------------------------------------- 「この場所だけ変える」の間の種類の面
  function ownerSeg(kind, owner) {
    const box = el('div', 'cx-seg'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('sessionContext.place.ownerAria', { kind: WORD[kind] }));
    for (const id of ['native', 'ply']) {
      const b = button('', 'cx-opt');
      b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(owner === id)); b.dataset.owner = `${kind}:${id}`;
      b.append(el('b', null, OWNER[id][0]), el('span', null, OWNER[id][1][kind]));
      b.onclick = () => { if (owner !== id) savePlaceKind(kind, v => { v.owner = id; }, `[data-owner="${kind}:${id}"]`); };
      box.append(b);
    }
    return box;
  }
  function editFace(kind) {
    const value = here()?.kinds[kind].value ?? place.view?.defaults.kinds[kind].value;
    const ply = value?.owner === 'ply';
    const k = kindBox(WORD[kind], ply ? t('sessionContext.place.plyWho') : t('sessionContext.native'), ply);
    if (!value) { k.append(el('p', 'cx-sub', t('sessionContext.place.loading'))); return k; }
    k.append(ownerSeg(kind, value.owner));
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.place.nativeNote', { agent: backendLabel() }))); return k; }
    if (!editScan) { const p = el('p', 'cx-sub'); p.append(runMark(t('context.searching')), document.createTextNode(' ' + t('context.searchingDots'))); k.append(p); return k; }
    const own = Boolean(here()?.saved && here().kinds[kind].override);
    const offText = own ? t('sessionContext.place.offHere') : t('sessionContext.place.offGlobal');
    const entries = uniqueRows((editScan.entries ?? []).filter(e => e.kind === kind && e.status !== 'duplicate'));
    if (!entries.length) { k.append(el('p', 'cx-sub', t('sessionContext.place.none'))); return k; }
    if (kind === 'mcp') {
      // 名前ごとに 1 行（同じ名前の定義が複数あっても、つなぐのは 1 つ）
      const byName = new Map();
      for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
      const rows = [...byName.values()].map(list => ({ ...(list.find(e => e.status === 'candidate') ?? list[0]), list }));
      grouped(k, rows, e => {
        const on = e.list.some(x => x.status === 'candidate');
        return switchRow(e, on, [shortPath(e.path), on ? '' : offText].filter(Boolean).join(' · '), true,
          () => savePlaceKind('mcp', v => toggleMcp(v, e.name, e.list, !on, editScan.entries), `[data-row="${e.id}"] .cx-sw`));
      });
      return k;
    }
    grouped(k, entries, e => {
      const on = e.status !== 'excluded';
      const where = kind === 'skill' ? dir(dir(e.path)) : dir(e.path);
      return switchRow(e, on, [shortPath(where), on ? '' : offText].filter(Boolean).join(' · '), false,
        () => savePlaceKind(kind, v => toggleExclude(v, e, !on), `[data-row="${e.id}"] .cx-sw`));
    });
    return k;
  }
  function switchRow(e, on, sub, dot, onToggle) {
    const row = el('div', 'scx-item' + (on ? '' : ' off'));
    row.dataset.row = e.id;
    const mark = dot ? el('span', 'cx-dot' + (on ? ' on' : ' off')) : el('span', 'mark' + (on ? ' on' : ''), on ? '✓' : '–');
    mark.setAttribute('aria-hidden', 'true');
    const body = el('div', 't');
    body.append(el('div', 'nm', e.name), el('div', 'p', sub));
    const sw = button('', 'cx-sw', onToggle);
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(on));
    sw.setAttribute('aria-label', t('sessionContext.place.switchAria', { path: shortPath(e.path), name: e.name }));
    sw.disabled = editBusy;
    row.append(mark, body, sw);
    return row;
  }
  function addedEditFace() {
    const k = kindBox(t('sessionContext.added.title'), t('sessionContext.added.scope'), false);
    const p = el('p', 'cx-sub');
    p.append(button(t('sessionContext.added.settings'), 'cx-link', () => openSettings()));
    k.append(p);
    return k;
  }

  // ---------------------------------------------------------------- ふだんの種類の面（記録から）
  function instructions(data) {
    const ply = managed(data, 'instruction');
    const rows = data.report.entries.filter(e => e.kind === 'instruction');
    const given = rows.filter(e => e.status === 'supplied' || e.status === 'loaded');
    const k = kindBox(WORD.instruction, ply ? t('sessionContext.instruction.who', { count: given.length }) : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.instruction.native', { agent: backendLabel() }))); return k; }
    grouped(k, given, e => item('✓', e.name, e.status === 'loaded' ? t('sessionContext.instruction.loaded', { path: shortPath(dir(e.path)) }) : shortPath(dir(e.path)), { on: true }).row);
    if (!given.length) k.append(el('p', 'cx-sub', t('sessionContext.instruction.none')));
    const left = rows.filter(e => !['supplied', 'loaded'].includes(e.status));
    if (left.length) k.append(fold(t('sessionContext.instruction.notGiven', { count: left.length }), left.map(e => item('–', e.name, `${shortPath(dir(e.path))} · ${reasonOf(e)}`).row)));
    return k;
  }
  function skills(data) {
    const ply = managed(data, 'skill');
    const rows = data.report.entries.filter(e => e.kind === 'skill');
    const offered = rows.filter(e => ['available', 'manual-only', 'loaded'].includes(e.status));
    const k = kindBox('Skills', ply ? t('sessionContext.skill.who', { count: offered.length }) : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.skill.native', { agent: backendLabel() }))); return k; }
    // 使ったものを先に。多いので最初の数件だけ並べ、残りは畳む
    const sorted = [...offered.filter(e => e.status === 'loaded'), ...offered.filter(e => e.status !== 'loaded')];
    const make = e => item('✓', e.name, [shortPath(dir(dir(e.path))), e.status === 'loaded' ? t('sessionContext.skill.usedMark') : e.status === 'manual-only' ? t('sessionContext.skill.manualOnly') : ''].filter(Boolean).join(' · '), { on: true }).row;
    grouped(k, sorted.slice(0, SKILLS_SHOWN), make);
    if (!offered.length) k.append(el('p', 'cx-sub', t('sessionContext.skill.noneOffered')));
    if (sorted.length > SKILLS_SHOWN) {
      const rest = el('div');
      grouped(rest, sorted.slice(SKILLS_SHOWN), make);
      k.append(fold(t('sessionContext.more', { count: sorted.length - SKILLS_SHOWN }), [...rest.childNodes]));
    }
    const other = rows.filter(e => !offered.includes(e));
    if (other.length) k.append(fold(t('sessionContext.skill.notOffered', { count: other.length }), other.map(e => item('–', e.name, reasonOf(e)).row)));
    return k;
  }
  function reasonOf(e) {
    // paths 付きの Claude rules。当たるファイルを扱うまでは渡さない
    if (!e.reason && e.status === 'conditional') return t('sessionContext.reason.conditional', { paths: (e.paths ?? []).join(', ') });
    if (e.reason) return e.reason;
    return REASON[e.status]?.() ?? e.status;
  }
  function fold(summary, rows) {
    const d = el('details', 'cx-fold');
    d.append(el('summary', null, summary), ...rows);
    return d;
  }
  function mcp(data) {
    const ply = managed(data, 'mcp');
    const rows = data.report.entries.filter(e => e.kind === 'mcp' && ['connected', 'pending', 'needs-auth', 'failed', 'removed'].includes(e.status));
    const k = kindBox('MCP', ply ? t('sessionContext.mcp.who', { count: rows.filter(e => e.status !== 'removed').length }) : t('sessionContext.native'), ply);
    if (!ply) { nativeMcp(k, data); return k; }
    if (!rows.length) k.append(el('p', 'cx-sub', t('sessionContext.mcp.none')));
    const primaryFree = !data.changed?.differs;
    let waiting = false;
    grouped(k, rows, raw => {
      const pending = removedPending.get(raw.name);
      const e = pending ? { ...raw, status: pending.removed ? 'removed' : (raw.status === 'removed' ? 'connected' : raw.status) } : raw;
      const row = el('div', 'scx-item');
      const dot = el('span', 'cx-dot' + (e.status === 'connected' ? ' on' : e.status === 'failed' ? '' : ' off'));
      const body = el('div', 't');
      body.append(el('div', 'nm', e.name));
      const p = el('div', 'p');
      const login = logins.get(e.name);
      const where = e.origins?.[0]?.source === 'ply' ? '' : `${shortPath(e.path)} · `;
      if (e.status === 'connected') p.textContent = where + t('sessionContext.mcp.connected', { tools: e.tools ?? 0, usage: e.calls ? t('sessionContext.mcp.calls', { count: e.calls }) : t('sessionContext.mcp.unused') });
      else if (e.status === 'pending') p.textContent = where + (e.reason ?? t('sessionContext.mcp.pending'));
      else if (e.status === 'removed') p.textContent = t('sessionContext.mcp.removed');
      else if (e.status === 'failed') p.append(el('span', 'cx-fail', t('sessionContext.mcp.failed')), ` · ${e.reason ?? t('sessionContext.mcp.unknownReason')}`);
      else {
        waiting = true;
        const oauth = e.auth === 'oauth';
        if (login) p.append(login);
        else p.append(el('span', 'cx-strong', oauth ? t('sessionContext.mcp.needsLogin') : t('sessionContext.mcp.authFailed')),
          t('sessionContext.mcp.authRest', { reason: e.reason && e.reasonCode !== 'MCP_AUTH_REQUIRED' ? t('sessionContext.mcp.reasonParen', { reason: e.reason }) : '' }));
      }
      body.append(p);
      // 同じ名前の定義が複数あったとき、どれを使ったか（core/context-runtime.mjs の markChoices）
      if (e.choice) body.append(el('div', 'p', t('sessionContext.mcp.choice', { n: e.choice.others + 1, source: SOURCE[e.choice.source] ?? e.choice.source ?? '',
        by: e.choice.by === 'prefer' ? t('sessionContext.mcp.byPrefer') : t('sessionContext.mcp.byFirst') })));
      const acts = el('div', 'acts');
      const fromPly = e.origins?.[0]?.source === 'ply';
      if (e.status === 'needs-auth' && fromPly && e.auth === 'oauth' && !login?.dataset?.done) acts.append(button(t('sessionContext.mcp.login'), primaryFree ? 'btn btn-primary' : 'btn btn-quiet', () => startLogin(e.name)));
      if (e.status === 'needs-auth' && e.auth !== 'oauth') acts.append(button(t('sessionContext.mcp.openSettings'), 'btn', () => openSettings()));
      if (['needs-auth', 'failed', 'removed'].includes(raw.status) || pending) {
        const sw = button('', 'cx-sw', () => setRemoved(e.name, e.status !== 'removed'));
        sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(e.status !== 'removed'));
        sw.setAttribute('aria-label', e.status === 'removed' ? t('sessionContext.mcp.restore') : t('sessionContext.mcp.remove'));
        sw.disabled = Boolean(pending);
        acts.append(sw);
        if (pending?.visible) { const label = el('span', 'pending-label'); label.append(runMark(t('pending.saving')), t('pending.saving')); acts.append(label); }
      }
      if (acts.childNodes.length) body.append(acts);
      row.append(dot, body);
      return row;
    });
    const unused = data.report.entries.filter(e => e.kind === 'mcp' && e.shadowedBy === 'choice');
    if (unused.length) k.append(fold(t('sessionContext.mcp.unusedDefs', { count: unused.length }), unused.map(e => item('–', e.name, `${shortPath(e.path)} · ${reasonOf(e)}`).row)));
    if (waiting) k.append(el('p', 'cx-sub', t('sessionContext.mcp.waiting')));
    if (notice) k.append(el('p', 'cx-strong', notice));
    return k;
  }
  /** Pleiad の指示（core/ply-instructions.mjs）。直前のターンの記録。項目ごとに入れたか・入れなかった理由、入れた文は畳んで出す */
  function addedBox(data) {
    const items = data.added.map(addedItem), given = items.filter(a => a.inserted);
    const k = kindBox(t('sessionContext.added.title'), given.length ? t('sessionContext.added.who', { count: given.length }) : t('sessionContext.added.none'), given.length > 0);
    for (const a of items) {
      const why = a.inserted ? t('sessionContext.added.inserted') + (a.id === 'route' ? t('sessionContext.added.linked') : '')
        : a.reason === 'target' ? (a.target === 'child' ? t('sessionContext.added.reason.forChild') : t('sessionContext.added.reason.forParent'))
        : t(`sessionContext.added.reason.${a.reason}`);
      k.append(item(a.inserted ? '✓' : '–', a.name, why, { on: a.inserted }).row);
    }
    if (given.length) {
      const text = el('div', 'scx-added');
      text.innerHTML = renderMarkdown(given.map(a => a.text).join('\n\n'));
      k.append(fold(t('sessionContext.added.show', { tokens: fmt.number(given.reduce((n, a) => n + estimateTokens(a.text), 0)) }), [text]));
    }
    const p = el('p', 'cx-sub');
    p.append(button(t('sessionContext.added.settings'), 'cx-link', () => openSettings()));
    k.append(p);
    return k;
  }
  /** エージェント任せの MCP。そのエージェントの設定に登録されているもの（読むだけ） */
  function nativeMcp(k, data) {
    const s = session(), label = backendLabel(), file = AGENT_FILES[s?.backend];
    if (!file) { k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.unreadable', { agent: label }))); return; }
    const where = data.report.cwd ?? s?.cwd;
    const cached = agentCache.get(where);
    if (!cached) {
      k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.reading', { agent: label })));
      cmd('agentMcp', { cwd: where }).then(r => { agentCache.set(where, r); refresh(); }).catch(() => { agentCache.set(where, { agents: {} }); refresh(); });
      return;
    }
    const list = cached.agents?.[file] ?? [];
    if (!list.length) { k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.none', { agent: label }))); return; }
    k.append(el('p', 'cx-sub', t('sessionContext.nativeMcp.list', { agent: label, count: list.length })));
    const rowOf = x => { const r = el('div', 'scx-item'); const body = el('div', 't'); body.append(el('div', null, x.name), el('div', 'p', x.disabled ? t('sessionContext.nativeMcp.disabled', { path: shortPath(x.path) }) : shortPath(x.path))); r.append(el('span', 'cx-dot off'), body); return r; };
    list.slice(0, 5).forEach(x => k.append(rowOf(x)));
    if (list.length > 5) k.append(fold(t('sessionContext.more', { count: list.length - 5 }), list.slice(5).map(rowOf)));
  }

  function changedNotice(data) {
    const files = data.changed.files ?? (data.changed.paths ?? []).map(path => ({ path, name: base(path) }));
    const box = el('div', 'scx-notice'); box.setAttribute('role', 'status');
    const head = el('p');
    head.append(el('span', 'cx-strong', t('sessionContext.changed.title', { count: files.length || 1 })));
    for (const f of files.slice(0, 3)) {
      const name = f.name ?? base(f.path);
      const what = f.after === null && f.before ? t('sessionContext.changed.removed', { name }) : !f.before ? t('sessionContext.changed.added', { name })
        : f.modifiedAt ? t('sessionContext.changed.updatedAt', { name, time: stamp(f.modifiedAt, !sameDay(f.modifiedAt, Date.now())) }) : t('sessionContext.changed.updated', { name });
      head.append(el('br'), el('span', 'cx-sub', what));
    }
    if (files.length > 3) head.append(el('br'), el('span', 'cx-sub', t('sessionContext.more', { count: files.length - 3 })));
    const acts = el('div', 'acts');
    const go = button(t('sessionContext.changed.continue'), 'btn btn-primary', () => refreshNow(go));
    if (busy && refreshLoadingVisible) go.replaceChildren(runMark(t('pending.reloading')), t('pending.reloading'));
    go.disabled = busy || isRunning();
    if (isRunning()) go.title = t('sessionContext.changed.afterReply');
    acts.append(go, button(diffOpen ? t('sessionContext.changed.hideDiff') : t('sessionContext.changed.showDiff'), 'btn', toggleDiff));
    box.append(head, acts, el('p', 'cx-sub', t('sessionContext.changed.note')));
    if (diffOpen) box.append(diffBody());
    return box;
  }
  function diffBody() {
    const box = el('div', 'scx-diff');
    if (!diff) { box.append(el('p', 'cx-sub', t('sessionContext.diff.loading'))); return box; }
    if (diff.error) { box.append(el('p', 'cx-strong', diff.error)); return box; }
    if (!diff.files.length) { box.append(el('p', 'cx-sub', t('sessionContext.diff.noChange'))); return box; }
    for (const f of diff.files) {
      box.append(el('h5', null, f.path));
      if (f.beforeMissing) box.append(el('p', 'cx-sub', t('sessionContext.diff.beforeMissing')));
      if (f.removed) { box.append(el('p', 'cx-sub', t('sessionContext.diff.removed'))); continue; }
      if (f.after === null) { box.append(el('p', 'cx-sub', t('sessionContext.diff.tooLarge'))); continue; }
      box.append(diffView(lineDiff(f.beforeMissing ? '' : f.before ?? '', f.after)));
    }
    return box;
  }
  async function toggleDiff() {
    diffOpen = !diffOpen;
    if (diffOpen && !diff) {
      refresh();
      const id = session()?.id;
      diff = await cmd('contextDiff', { sessionId: id }).catch(e => ({ error: t('sessionContext.diff.failed', { error: e.message }) }));
      if (session()?.id !== id) return;
    }
    refresh();
  }
  async function refreshNow(go) {
    if (busy) return;
    busy = true; go.disabled = true; notice = '';
    refreshLoadingVisible = false;
    const timer = setTimeout(() => { refreshLoadingVisible = true; refresh(); }, 150);
    const id = session()?.id;
    try {
      await cmd('refreshContext', { sessionId: id });
      diff = null; diffOpen = false;
      await refreshInfo(true);
    } catch (e) { notice = t('sessionContext.refreshFailed', { error: e.message }); }
    finally { clearTimeout(timer); busy = false; refreshLoadingVisible = false; refresh(); }
  }
  async function setRemoved(name, removed) {
    if (removedPending.has(name)) return;
    notice = '';
    const pending = { removed, visible: false };
    removedPending.set(name, pending);
    refresh();
    const timer = setTimeout(() => { pending.visible = true; refresh(); }, 150);
    try {
      await cmd('setSessionMcp', { sessionId: session()?.id, name, removed });
      await refreshInfo(true);
    } catch (e) { notice = e.message; }
    finally { clearTimeout(timer); removedPending.delete(name); }
    refresh();
  }
  async function startLogin(name) {
    try {
      const started = await cmd('mcpAuthStart', { name });
      const span = el('span');
      span.append(t('sessionContext.login.continue'));
      if (/^https?:\/\//i.test(started.url ?? '')) {
        const a = el('a', 'cx-link', t('sessionContext.login.link'));
        a.href = started.url; a.target = '_blank'; a.rel = 'noreferrer';
        span.append(a);
      }
      logins.set(name, span);
    } catch (e) { logins.set(name, document.createTextNode(t('sessionContext.login.startFailed', { error: e.message }))); }
    refresh();
  }
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (!logins.has(ev.name) && !info()?.report?.entries?.some(x => x.kind === 'mcp' && x.name === ev.name)) return;
    if (ev.phase === 'done') { const done = el('span', null, t('sessionContext.login.done')); done.dataset.done = '1'; logins.set(ev.name, done); }
    else if (ev.phase === 'error') logins.set(ev.name, document.createTextNode(ev.message ? t('sessionContext.login.failedWith', { error: ev.message }) : t('sessionContext.login.failed')));
    else return;
    refresh();
  });

  // ---------------------------------------------------------------- 開閉
  function open(element) {
    chip = element ?? chip;
    const data = info() ?? {};
    // 開くたびに作業場所の設定を読み直す（設定の画面や別の窓で変わっていることがある）
    place = { cwd: null, view: null, loading: false };
    preview.openPanel({ key: KEY, title, subtitle: data.report ? subtitle(data) : '', body: render(), label: title, element: chip,
      onClose: () => { chip?.setAttribute('aria-expanded', 'false'); edit = false; editScan = null; } });
  }
  function toggle(element) {
    if (preview.panelOpen(KEY)) preview.close();
    else open(element);
  }
  /** 記録が変わったとき（ターンの開始・読み込み直し・外す）。開いていれば描き直す */
  function refresh() {
    const data = info() ?? {};
    preview.updatePanel(KEY, { subtitle: data.report ? subtitle(data) : '', body: render() });
  }
  return { open, toggle, refresh, isOpen: () => preview.panelOpen(KEY) };
}
