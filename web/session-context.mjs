// ==================== 会話の右パネル「この会話のコンテキスト」（docs/mockups/context-unified.html の①） ====================
// 会話の頭の札（指示 2 · Skills 14 · MCP …）を押すと、ファイルプレビューと同じ右パネルに開く（web/file-preview.mjs の openPanel）。
// 中身は sessionContext の記録（core/server.mjs）だけから作る。種類ごとに「Pleiad が渡した／案内した」か「エージェント任せ」。
//   - 開始後に指示・Skills が変わった: 次の送信で自動的に読み込み直す。「新しい内容で会話を続ける」（refreshContext）は送信を待たずに今すぐ反映する操作と「差分を見る」
//   - MCP: 接続中（ツール数・呼び出し回数）／要ログイン（ブラウザでログイン・この会話では外す）／失敗（理由）
//   - エージェント任せの MCP は、そのエージェントの設定に登録されているものを読み取りのみで並べる（agentMcp）
//   - antigravity で Pleiad 担当を扱わなかった会話は、その理由
import { el } from './dom.mjs';

const KEY = 'session-context';
const WORD = { instruction: '指示', skill: 'Skills', mcp: 'MCP' };
const COUNTED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
const AGENT_FILES = { claude: 'claude', codex: 'codex' };
const SOURCE = { claude: 'Claude', codex: 'Codex', common: '共通', ply: 'Pleiad' };

const two = n => String(n).padStart(2, '0');
function stamp(at, withDay = true) {
  const d = new Date(at ?? 0);
  if (Number.isNaN(d.getTime()) || !at) return '';
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withDay ? `${d.getMonth() + 1}/${d.getDate()} ${time}` : time;
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
    parts.push(`MCP ${n}${bad ? `（${bad} 件つながらない）` : ''}`);
  }
  if (natives.length) parts.push(`${natives.join('・')} はエージェント任せ`);
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
      box.append(el('div', 'skip', `… ${j - i} 行同じ`));
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

  const title = 'この会話のコンテキスト';
  function subtitle(data) {
    const started = data.startedAt ?? data.report?.at;
    const text = started ? `開始時（${stamp(started)}）に決まり、途中では変わりません` : '開始時に決まり、途中では変わりません';
    return data.refreshedAt ? `${text} · ${stamp(data.refreshedAt)} に読み込み直し` : text;
  }
  const backendLabel = () => labelOf(session()?.backend) || 'エージェント';

  // ---------------------------------------------------------------- 描画
  let shownFor = null;
  function render() {
    // 別の会話へ移った。前の会話の差分・ログインの途中経過は持ち越さない
    if (session()?.id !== shownFor) { shownFor = session()?.id ?? null; diff = null; diffOpen = false; notice = ''; logins.clear(); }
    const data = info();
    const box = el('div', 'scx');
    if (!data?.report) {
      box.append(el('p', 'cx-sub', 'この会話はまだ始まっていません。最初の送信で、何を渡したかをここに記録します。'));
      return box;
    }
    const report = data.report;
    if (data.changed?.differs) box.append(changedNotice(data));
    if (report.guardedBackend) {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', 'この会話では Pleiad がそろえる設定を使っていません'), el('p', 'cx-sub', report.reason ?? `${report.guardedBackend} は Pleiad がそろえるコンテキストを受け取れないため、エージェント自身の読み込みに任せました`));
      box.append(n);
    }
    if (report.status === 'failed') {
      const n = el('div', 'scx-notice');
      n.append(el('p', 'cx-strong', '読み込みか実行が途中で失敗しました'), el('p', 'cx-sub', '下の状態と、会話のエラーを確かめてください。'));
      box.append(n);
    }
    box.append(instructions(data), skills(data), mcp(data));
    const foot = el('p', 'scx-foot');
    foot.append('次の会話から変えたいとき ', button('この場所の設定を開く →', 'cx-link', () => openSettings(report.cwd ?? session()?.cwd)));
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
    const t = el('div', 't');
    t.append(el('div', null, name));
    if (sub) t.append(el('div', 'p', sub));
    row.append(m, t);
    return { row, t };
  }
  function instructions(data) {
    const ply = managed(data, 'instruction');
    const k = kindBox('指示', ply ? 'Pleiad が渡した' : 'エージェント任せ', ply);
    if (!ply) { k.append(el('p', 'cx-sub', `${backendLabel()} が自分の決まりで読みます（Pleiad からは中身が見えません）`)); return k; }
    const rows = data.report.entries.filter(e => e.kind === 'instruction');
    const given = rows.filter(e => e.status === 'supplied' || e.status === 'loaded');
    for (const e of given) k.append(item('✓', e.name, e.status === 'loaded' ? `${shortPath(dir(e.path))} · 途中で読み込み` : shortPath(dir(e.path)), { on: true }).row);
    if (!given.length) k.append(el('p', 'cx-sub', '渡した指示ファイルはありません'));
    const left = rows.filter(e => !['supplied', 'loaded'].includes(e.status));
    if (left.length) k.append(fold(`渡していないもの ${left.length} 件`, left.map(e => item('○', e.name, `${shortPath(dir(e.path))} · ${reasonOf(e)}`).row)));
    return k;
  }
  function skills(data) {
    const ply = managed(data, 'skill');
    const rows = data.report.entries.filter(e => e.kind === 'skill');
    const offered = rows.filter(e => ['available', 'manual-only', 'loaded'].includes(e.status));
    const k = kindBox('Skills', ply ? `Pleiad が案内 ${offered.length} 件` : 'エージェント任せ', ply);
    if (!ply) { k.append(el('p', 'cx-sub', `${backendLabel()} が自分の skills フォルダーを読みます（Pleiad からは中身が見えません）`)); return k; }
    const used = offered.filter(e => e.status === 'loaded'), unused = offered.filter(e => e.status !== 'loaded');
    k.append(el('p', 'cx-sub', used.length ? '使ったもの' : 'まだ使っていません'));
    for (const e of used) k.append(item('●', e.name, shortPath(dir(dir(e.path))), { on: true }).row);
    if (unused.length) k.append(fold(`使っていない ${unused.length} 件`, unused.map(e => item('○', e.name, e.status === 'manual-only' ? '明示したときだけ' : '').row)));
    const other = rows.filter(e => !offered.includes(e));
    if (other.length) k.append(fold(`案内していないもの ${other.length} 件`, other.map(e => item('○', e.name, reasonOf(e)).row)));
    return k;
  }
  function reasonOf(e) {
    // paths 付きの Claude rules。当たるファイルを扱うまでは渡さない
    if (!e.reason && e.status === 'conditional') return `${(e.paths ?? []).join(', ')} に当たるファイルを扱うときだけ`;
    return e.reason ?? { excluded: '外しています', shadowed: '同名・override が優先', duplicate: '同じものを 1 つにまとめました', disabled: '元の設定で無効', unsupported: '対応していない設定があります' }[e.status] ?? e.status;
  }
  function fold(summary, rows) {
    const d = el('details', 'cx-fold');
    d.append(el('summary', null, summary), ...rows);
    return d;
  }
  function mcp(data) {
    const ply = managed(data, 'mcp');
    const rows = data.report.entries.filter(e => e.kind === 'mcp' && ['connected', 'pending', 'needs-auth', 'failed', 'removed'].includes(e.status));
    const k = kindBox('MCP', ply ? `Pleiad がつなぐ ${rows.filter(e => e.status !== 'removed').length} 件` : 'エージェント任せ', ply);
    if (!ply) { nativeMcp(k, data); return k; }
    if (!rows.length) k.append(el('p', 'cx-sub', 'つなぐ MCP はありません'));
    const primaryFree = !data.changed?.differs;
    let waiting = false;
    for (const e of rows) {
      const row = el('div', 'scx-item');
      const dot = el('span', 'cx-dot' + (e.status === 'connected' ? ' on' : e.status === 'failed' ? '' : ' off'));
      const t = el('div', 't');
      t.append(el('div', null, e.name));
      const p = el('div', 'p');
      const login = logins.get(e.name);
      if (e.status === 'connected') p.textContent = `接続中 · ツール ${e.tools ?? 0} · ${e.calls ? `呼び出し ${e.calls} 回` : '未使用'}`;
      else if (e.status === 'pending') p.textContent = e.reason ?? '次の返答でつなぎます';
      else if (e.status === 'removed') p.textContent = 'この会話では外しています';
      else if (e.status === 'failed') p.append(el('span', 'cx-fail', '✕ つながりませんでした'), ` · ${e.reason ?? '理由は分かりません'}`);
      else {
        waiting = true;
        const oauth = e.auth === 'oauth';
        if (login) p.append(login);
        else p.append(el('span', 'cx-strong', oauth ? 'ログインが必要です' : '認証が通りませんでした'),
          `${e.reason && !/ログインが必要/.test(e.reason) ? `（${e.reason}）` : ''}。この MCP を外して会話は進めています`);
      }
      t.append(p);
      // 同じ名前の定義が複数あったとき、どれを使ったか（core/context-runtime.mjs の markChoices）
      if (e.choice) t.append(el('div', 'p', `同じ名前の定義が ${e.choice.others + 1} つ · ${SOURCE[e.choice.source] ?? e.choice.source ?? ''} の設定の方を使用（${e.choice.by === 'prefer' ? '設定で選んだもの' : '先に見つかった方'}）`));
      const acts = el('div', 'acts');
      const fromPly = e.origins?.[0]?.source === 'ply';
      if (e.status === 'needs-auth' && fromPly && e.auth === 'oauth' && !/ログインしました/.test(login?.textContent ?? '')) acts.append(button('ブラウザでログイン', primaryFree ? 'btn btn-primary' : 'btn btn-quiet', () => startLogin(e.name)));
      if (e.status === 'needs-auth' && e.auth !== 'oauth') acts.append(button('設定を開く', 'btn', () => openSettings(data.report.cwd ?? session()?.cwd)));
      if (e.status === 'needs-auth' || e.status === 'failed') acts.append(button('この会話では外す', 'btn', () => setRemoved(e.name, true)));
      if (e.status === 'removed') acts.append(button('戻す', 'btn', () => setRemoved(e.name, false)));
      if (acts.childNodes.length) t.append(acts);
      row.append(dot, t);
      k.append(row);
    }
    const unused = data.report.entries.filter(e => e.kind === 'mcp' && e.shadowedBy === 'choice');
    if (unused.length) k.append(fold(`使わなかった同じ名前の定義 ${unused.length} 件`, unused.map(e => item('○', e.name, `${shortPath(e.path)} · ${reasonOf(e)}`).row)));
    if (waiting) k.append(el('p', 'cx-sub', 'ログインが済むと自動でつなぎ直し、次の返答から使えます。会話を作り直す必要はありません'));
    if (notice) k.append(el('p', 'cx-strong', notice));
    return k;
  }
  /** エージェント任せの MCP。そのエージェントの設定に登録されているもの（読むだけ） */
  function nativeMcp(k, data) {
    const s = session(), label = backendLabel(), file = AGENT_FILES[s?.backend];
    if (!file) { k.append(el('p', 'cx-sub', `エージェント任せ。${label} の MCP の登録は Pleiad から読めません`)); return; }
    const where = data.report.cwd ?? s?.cwd;
    const cached = agentCache.get(where);
    if (!cached) {
      k.append(el('p', 'cx-sub', `エージェント任せ。${label} の設定を読んでいます…`));
      cmd('agentMcp', { cwd: where }).then(r => { agentCache.set(where, r); refresh(); }).catch(() => { agentCache.set(where, { agents: {} }); refresh(); });
      return;
    }
    const list = cached.agents?.[file] ?? [];
    if (!list.length) { k.append(el('p', 'cx-sub', `エージェント任せ。${label} の設定に MCP の登録はありません`)); return; }
    k.append(el('p', 'cx-sub', `エージェント任せ。${label} の設定に登録されているのは次の ${list.length} 件です（接続の成否は ${label} 側が持つため、Pleiad からは見えません）`));
    const rowOf = x => { const r = el('div', 'scx-item'); const t = el('div', 't'); t.append(el('div', null, x.name), el('div', 'p', x.disabled ? `${shortPath(x.path)} · 無効` : shortPath(x.path))); r.append(el('span', 'cx-dot off'), t); return r; };
    list.slice(0, 5).forEach(x => k.append(rowOf(x)));
    if (list.length > 5) k.append(fold(`ほか ${list.length - 5} 件`, list.slice(5).map(rowOf)));
  }

  function changedNotice(data) {
    const files = data.changed.files ?? (data.changed.paths ?? []).map(path => ({ path, name: base(path) }));
    const box = el('div', 'scx-notice'); box.setAttribute('role', 'status');
    const head = el('p');
    head.append(el('span', 'cx-strong', `開始後に ${files.length || 1} 件変わりました`));
    for (const f of files.slice(0, 3)) {
      const what = f.after === null && f.before ? 'が消えました' : !f.before ? 'が新しく見つかりました'
        : f.modifiedAt ? `が ${stamp(f.modifiedAt, !sameDay(f.modifiedAt, Date.now()))} に更新` : 'が更新されました';
      head.append(el('br'), el('span', 'cx-sub', `${f.name ?? base(f.path)} ${what}`));
    }
    if (files.length > 3) head.append(el('br'), el('span', 'cx-sub', `ほか ${files.length - 3} 件`));
    const acts = el('div', 'acts');
    const go = button('新しい内容で会話を続ける', 'btn btn-primary', () => refreshNow(go));
    go.disabled = busy || isRunning();
    if (isRunning()) go.title = '返答が終わってから押せます';
    acts.append(go, button(diffOpen ? '差分を閉じる' : '差分を見る', 'btn', toggleDiff));
    box.append(head, acts, el('p', 'cx-sub', '次の送信で自動的に読み込み直します。送信を待たずに今すぐ反映するなら「新しい内容で会話を続ける」（どちらもやり取りは引き継ぎます）'));
    if (diffOpen) box.append(diffBody());
    return box;
  }
  function diffBody() {
    const box = el('div', 'scx-diff');
    if (!diff) { box.append(el('p', 'cx-sub', '差分を読んでいます…')); return box; }
    if (diff.error) { box.append(el('p', 'cx-strong', diff.error)); return box; }
    if (!diff.files.length) { box.append(el('p', 'cx-sub', '今は開始時と同じ内容です')); return box; }
    for (const f of diff.files) {
      box.append(el('h5', null, f.path));
      if (f.beforeMissing) box.append(el('p', 'cx-sub', '開始時の中身は残っていません（この版より前に始めた会話）。今の中身だけを出します。'));
      if (f.removed) { box.append(el('p', 'cx-sub', 'このファイルは今はありません')); continue; }
      if (f.after === null) { box.append(el('p', 'cx-sub', '大きすぎるため中身を出せません')); continue; }
      box.append(diffView(lineDiff(f.beforeMissing ? '' : f.before ?? '', f.after)));
    }
    return box;
  }
  async function toggleDiff() {
    diffOpen = !diffOpen;
    if (diffOpen && !diff) {
      refresh();
      const id = session()?.id;
      diff = await cmd('contextDiff', { sessionId: id }).catch(e => ({ error: `差分を読めませんでした：${e.message}` }));
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
    } catch (e) { notice = `読み込み直せませんでした：${e.message}`; }
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
      span.append('ブラウザで続けてください… ');
      if (/^https?:\/\//i.test(started.url ?? '')) {
        const a = el('a', 'cx-link', '開かないときはこちら');
        a.href = started.url; a.target = '_blank'; a.rel = 'noreferrer';
        span.append(a);
      }
      logins.set(name, span);
    } catch (e) { logins.set(name, document.createTextNode(`ログインを始められませんでした：${e.message}`)); }
    refresh();
  }
  window.addEventListener('ply:mcp-auth', e => {
    const ev = e.detail ?? {};
    if (!logins.has(ev.name) && !info()?.report?.entries?.some(x => x.kind === 'mcp' && x.name === ev.name)) return;
    if (ev.phase === 'done') logins.set(ev.name, document.createTextNode('ログインしました。次の返答から使えます'));
    else if (ev.phase === 'error') logins.set(ev.name, document.createTextNode(`ログインできませんでした${ev.message ? `：${ev.message}` : ''}`));
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
