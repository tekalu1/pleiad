// ==================== 会話の右パネル「この会話のコンテキスト」（docs/mockups/context-unified.html の①） ====================
// 会話の頭の札（指示 2 · Skills 14 · MCP …）を押すと、ファイルプレビューと同じ右パネルに開く（web/file-preview.mjs の openPanel）。
// 中身は sessionContext の記録（core/server.mjs）だけから作る。種類ごとに「Pleiad が渡した／案内した」か「エージェント任せ」。
//   - 開始後に指示・Skills が変わった: 次の送信で自動的に読み込み直す。「新しい内容で会話を続ける」（refreshContext）は送信を待たずに今すぐ反映する操作と「差分を見る」
//   - MCP: 接続中（ツール数・呼び出し回数）／要ログイン（ブラウザでログイン・この会話では外す）／失敗（理由）
//   - エージェント任せの MCP は、そのエージェントの設定に登録されているものを読み取りのみで並べる（agentMcp）
//   - antigravity で Pleiad 担当を扱わなかった会話は、その理由
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';

const KEY = 'session-context';
const WORD = { instruction: t('sessionContext.word.instruction'), skill: 'Skills', mcp: 'MCP' };
const COUNTED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
const AGENT_FILES = { claude: 'claude', codex: 'codex' };
const SOURCE = { claude: 'Claude', codex: 'Codex', common: t('sessionContext.source.common'), ply: 'Pleiad' };

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

/** 札の文言。「指示 2 · Skills 14 · MCP 3（1 件つながらない）」「MCP はエージェント任せ」 */
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

export function setupSessionContext({ cmd, preview, session, info, refreshInfo, openSettings, labelOf, isRunning = () => false }) {
  const logins = new Map();     // MCP 名 -> ログインの進み具合（ブラウザで続けてください… / ログインしました）
  const agentCache = new Map(); // cwd -> agentMcp の結果
  let diff = null, diffOpen = false, busy = false, notice = '';
  let chip = null;

  const title = t('sessionContext.title');
  function subtitle(data) {
    const started = data.startedAt ?? data.report?.at;
    const text = started ? t('sessionContext.subtitle.startedAt', { time: stamp(started) }) : t('sessionContext.subtitle.started');
    return data.refreshedAt ? t('sessionContext.subtitle.refreshed', { text, time: stamp(data.refreshedAt) }) : text;
  }
  const backendLabel = () => labelOf(session()?.backend) || t('sessionContext.agent');

  // ---------------------------------------------------------------- 描画
  let shownFor = null;
  function render() {
    // 別の会話へ移った。前の会話の差分・ログインの途中経過は持ち越さない
    if (session()?.id !== shownFor) { shownFor = session()?.id ?? null; diff = null; diffOpen = false; notice = ''; logins.clear(); }
    const data = info();
    const box = el('div', 'scx');
    if (!data?.report) {
      box.append(el('p', 'cx-sub', t('sessionContext.notStarted')));
      return box;
    }
    const report = data.report;
    if (data.changed?.differs) box.append(changedNotice(data));
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
    box.append(instructions(data), skills(data), mcp(data));
    const foot = el('p', 'scx-foot');
    foot.append(t('sessionContext.foot.lead'), button(t('sessionContext.foot.link'), 'cx-link', () => openSettings()));
    box.append(foot);
    return box;
  }
  function kindBox(label, who, ply) {
    const k = el('div', 'scx-kind');
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
    body.append(el('div', null, name));
    if (sub) body.append(el('div', 'p', sub));
    row.append(m, body);
    return { row, body };
  }
  function instructions(data) {
    const ply = managed(data, 'instruction');
    const k = kindBox(WORD.instruction, ply ? t('sessionContext.instruction.who') : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.instruction.native', { agent: backendLabel() }))); return k; }
    const rows = data.report.entries.filter(e => e.kind === 'instruction');
    const given = rows.filter(e => e.status === 'supplied' || e.status === 'loaded');
    for (const e of given) k.append(item('✓', e.name, e.status === 'loaded' ? t('sessionContext.instruction.loaded', { path: shortPath(dir(e.path)) }) : shortPath(dir(e.path)), { on: true }).row);
    if (!given.length) k.append(el('p', 'cx-sub', t('sessionContext.instruction.none')));
    const left = rows.filter(e => !['supplied', 'loaded'].includes(e.status));
    if (left.length) k.append(fold(t('sessionContext.instruction.notGiven', { count: left.length }), left.map(e => item('○', e.name, `${shortPath(dir(e.path))} · ${reasonOf(e)}`).row)));
    return k;
  }
  function skills(data) {
    const ply = managed(data, 'skill');
    const rows = data.report.entries.filter(e => e.kind === 'skill');
    const offered = rows.filter(e => ['available', 'manual-only', 'loaded'].includes(e.status));
    const k = kindBox('Skills', ply ? t('sessionContext.skill.who', { count: offered.length }) : t('sessionContext.native'), ply);
    if (!ply) { k.append(el('p', 'cx-sub', t('sessionContext.skill.native', { agent: backendLabel() }))); return k; }
    const used = offered.filter(e => e.status === 'loaded'), unused = offered.filter(e => e.status !== 'loaded');
    k.append(el('p', 'cx-sub', used.length ? t('sessionContext.skill.used') : t('sessionContext.skill.noneUsed')));
    for (const e of used) k.append(item('●', e.name, shortPath(dir(dir(e.path))), { on: true }).row);
    if (unused.length) k.append(fold(t('sessionContext.skill.unused', { count: unused.length }), unused.map(e => item('○', e.name, e.status === 'manual-only' ? t('sessionContext.skill.manualOnly') : '').row)));
    const other = rows.filter(e => !offered.includes(e));
    if (other.length) k.append(fold(t('sessionContext.skill.notOffered', { count: other.length }), other.map(e => item('○', e.name, reasonOf(e)).row)));
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
    for (const e of rows) {
      const row = el('div', 'scx-item');
      const dot = el('span', 'cx-dot' + (e.status === 'connected' ? ' on' : e.status === 'failed' ? '' : ' off'));
      const body = el('div', 't');
      body.append(el('div', null, e.name));
      const p = el('div', 'p');
      const login = logins.get(e.name);
      if (e.status === 'connected') p.textContent = t('sessionContext.mcp.connected', { tools: e.tools ?? 0, usage: e.calls ? t('sessionContext.mcp.calls', { count: e.calls }) : t('sessionContext.mcp.unused') });
      else if (e.status === 'pending') p.textContent = e.reason ?? t('sessionContext.mcp.pending');
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
      if (e.status === 'needs-auth' || e.status === 'failed') acts.append(button(t('sessionContext.mcp.remove'), 'btn', () => setRemoved(e.name, true)));
      if (e.status === 'removed') acts.append(button(t('sessionContext.mcp.restore'), 'btn', () => setRemoved(e.name, false)));
      if (acts.childNodes.length) body.append(acts);
      row.append(dot, body);
      k.append(row);
    }
    const unused = data.report.entries.filter(e => e.kind === 'mcp' && e.shadowedBy === 'choice');
    if (unused.length) k.append(fold(t('sessionContext.mcp.unusedDefs', { count: unused.length }), unused.map(e => item('○', e.name, `${shortPath(e.path)} · ${reasonOf(e)}`).row)));
    if (waiting) k.append(el('p', 'cx-sub', t('sessionContext.mcp.waiting')));
    if (notice) k.append(el('p', 'cx-strong', notice));
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
    const id = session()?.id;
    try {
      await cmd('refreshContext', { sessionId: id });
      diff = null; diffOpen = false;
      await refreshInfo(true);
    } catch (e) { notice = t('sessionContext.refreshFailed', { error: e.message }); }
    finally { busy = false; refresh(); }
  }
  async function setRemoved(name, removed) {
    notice = '';
    try {
      await cmd('setSessionMcp', { sessionId: session()?.id, name, removed });
      await refreshInfo(true);
    } catch (e) { notice = e.message; }
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
    preview.openPanel({ key: KEY, title, subtitle: data.report ? subtitle(data) : '', body: render(), label: title, element: chip,
      onClose: () => { chip?.setAttribute('aria-expanded', 'false'); } });
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
