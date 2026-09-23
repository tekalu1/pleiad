// ==================== 外部 MCP のカード（設定 › コンテキスト）と、追加・編集のシート ====================
// docs/mockups/context-unified.html の②「外部 MCP」。
//   エージェントに任せる: 各エージェント（Claude・Codex）の登録を並べて見比べるだけ（読み取りのみ）。
//   Pleiad がそろえる: この場所でつなぐものを名前ごとに 1 行。スイッチ（オフ = 名前で外す）、同じ名前の定義が複数あれば
//   どれを使うか、Pleiad に登録したものはログイン・編集・名前の変更・削除・ログアウト・接続の確認、エージェントの登録は「Pleiad に取り込む」。
// 登録は Pleiad 自身の設定（core/ply-mcp.mjs）。Claude や Codex の設定ファイルは書き換えない。秘密は伏せ字（••••）でしか返ってこない。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { codeBlock, langFromPath } from './render.mjs';
import { createCombo } from './combo.mjs';
import { closeIcon } from './icons.mjs';

// リモートの窓（docs/remote.md §7.3）: OAuth の戻り先はホストの 127.0.0.1 なので、ログインはホストの PC で行う
const remoteWindow = () => Boolean(globalThis.window?.plyRemote);

/** 追加ボタンの ＋。全角の ＋ は字形がフォントで揺れるので線で描く */
function withPlus(b, text) {
  b.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  b.append(text);
  return b;
}

const MASK = '••••';
const AGENTS = [['claude', 'Claude'], ['codex', 'Codex']];
const agentName = id => AGENTS.find(([k]) => k === id)?.[1] ?? id;
const STATES = { 'signed-in': t('mcp.state.signedIn'), 'signed-out': t('mcp.state.signedOut'), expired: t('mcp.state.expired'), pending: t('mcp.state.pending'), locked: t('mcp.state.locked'), error: t('mcp.state.error') };
/** つなぎ方の短い名前 */
const transportText = kind => kind === 'stdio' ? t('mcp.transport.stdio') : t('mcp.transport.url');
/** エージェントの名前を並べる（Claude・Codex） */
const agentList = ids => ids.map(agentName).join(t('mcp.join'));

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
function icon(kind) {
  const box = el('span', 'cx-ic');
  box.title = transportText(kind);
  box.innerHTML = kind === 'stdio'
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 8 4 4-4 4M12 16h7"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/></svg>';
  return box;
}
const pathKey = p => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const within = (dir, file) => pathKey(file) === pathKey(dir) || pathKey(file).startsWith(pathKey(dir) + '/');
/** 1 件の定義の同一性（同じものを別のエージェントにも登録しているだけなら、選ばせない） */
const signature = e => e.transport === 'stdio' ? `stdio:${e.command ?? ''} ${(e.args ?? []).join(' ')}` : `http:${e.endpoint ?? ''}`;
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 設定ファイルの書き出し（サーバが MCP 登録だけを伏せ字で書き出したもの）から 1 件を取る */
function excerpt(config, name) {
  const text = String(config?.content ?? '');
  if (/\.toml$/i.test(config?.path ?? '')) {
    const re = new RegExp(`^\\[[^\\]]*\\.(?:"${escapeRe(name)}"|${escapeRe(name)})(\\.[^\\]]*)?\\][\\s\\S]*?(?=\\n\\[(?!mcp_servers\\.(?:"${escapeRe(name)}"|${escapeRe(name)})\\.)|$)`, 'm');
    return re.exec(text)?.[0]?.trimEnd() ?? text;
  }
  try { const v = JSON.parse(text).mcpServers?.[name]; return v ? JSON.stringify({ [name]: v }, null, 2) : text; } catch { return text; }
}
/** 「npx -y "a b"」を command と args に分ける。引用符の中の空白は区切らない */
export function splitCommand(line) {
  const parts = [];
  for (const m of String(line ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) parts.push(m[1] ?? m[2] ?? m[3]);
  return { command: parts[0] ?? '', args: parts.slice(1) };
}
export const joinCommand = (command, args = []) => [command, ...args].filter(v => v !== undefined && v !== '').map(a => /\s/.test(a) ? `"${a}"` : a).join(' ');

export function createMcpSection() {
  const messages = new Map();   // 行に出す直近の結果（接続の確認・取り込み・ログイン）

  // ---------------------------------------------------------------- 描画
  function render(card, ctx) {
    const value = ctx.info.kinds.mcp.value, ply = value.owner === 'ply';
    const agentBlock = el('div', 'cx-block'), plyBlock = el('div', 'cx-block');
    agentBlock.hidden = ply; plyBlock.hidden = !ply;
    if (!ply) renderAgents(agentBlock, ctx); else renderPly(plyBlock, ctx, value);
    card.append(agentBlock, plyBlock);
  }

  /** エージェント任せ: 各エージェントの登録を並べる（Pleiad は読むだけ） */
  function renderAgents(block, ctx) {
    block.append(el('p', 'cx-sub', t('mcp.agents.lead')));
    if (!ctx.agents) { block.append(ctx.loading()); return; }
    const lists = Object.fromEntries(AGENTS.map(([id]) => [id, ctx.agents.agents?.[id] ?? []]));
    const shown = AGENTS;
    const cols = el('div', 'cx-cols');
    for (const [id, label] of shown) {
      const col = el('div', 'cx-col');
      col.append(el('b', null, label));
      if (!lists[id].length) col.append(el('span', 'cx-sub', t('mcp.agents.none')));
      for (const s of lists[id]) {
        const line = el('div', 'nm2');
        line.append(el('span', 'cx-dot off'), el('span', 'n', s.name));
        if (shown.length > 1 && shown.filter(([o]) => o !== id).every(([o]) => !lists[o].some(x => x.name === s.name))) line.append(el('span', 'only', t('mcp.agents.only', { agent: label })));
        if (s.disabled) line.append(el('span', 'only', t('mcp.agents.disabled')));
        line.title = `${transportText(s.transport)} · ${ctx.short(s.path)}`;
        col.append(line);
      }
      cols.append(col);
    }
    block.append(cols, el('p', 'cx-sub', t('mcp.agents.foot')));
  }

  /** Pleiad がそろえる: 名前ごとの一覧・追加・読み込む設定ファイル */
  function renderPly(block, ctx, value) {
    const label = el('p', 'cx-sub', ctx.isDefault ? t('mcp.listDefault') : t('mcp.list'));
    block.append(label);
    if (!ctx.scan) { block.append(ctx.loading()); return; }
    const groups = new Map();
    for (const e of ctx.scan.entries.filter(e => e.kind === 'mcp')) groups.set(e.name, [...(groups.get(e.name) ?? []), e]);
    const registry = new Map((ctx.ply?.servers ?? []).map(s => [s.name, s]));
    const list = el('div', 'cx-list');
    let on = 0;
    for (const [name, entries] of groups) {
      const fromPly = entries.find(e => e.origins?.[0]?.source === 'ply');
      const active = entries.find(e => e.status === 'candidate') ?? null;
      const disabledByName = Boolean(value.disabled?.includes(name));
      const excluded = !active && entries.some(e => e.status === 'excluded');
      const nativeOff = !active && !excluded && entries.every(e => e.status === 'disabled');
      if (active) on++;
      const shown = active ?? fromPly ?? entries[0];
      const row = el('div', 'cx-row' + (active ? '' : ' off'));
      const open = button('', 'cx-open');
      const key = `mcp:${name}`;
      open.setAttribute('aria-expanded', String(ctx.opened.has(key)));
      const body = el('span', 't');
      body.append(el('span', 'nm', name));
      const p = el('span', 'p');
      describe(p, { entries, shown, fromPly, registry, active, nativeOff, disabledByName, value });
      body.append(p);
      open.append(icon(shown.transport === 'stdio' ? 'stdio' : 'http'), body);
      open.onclick = () => { if (ctx.opened.has(key)) ctx.opened.delete(key); else ctx.opened.add(key); ctx.rerender(); };
      row.append(open);
      const reg = fromPly ? registry.get(name) : null;
      if (active && reg?.auth === 'oauth' && ['signed-out', 'expired'].includes(reg.authStatus?.state) && !remoteWindow()) row.append(button(t('mcp.login'), 'btn btn-quiet', () => login(ctx, name)));
      const sw = button('', 'cx-sw');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(Boolean(active))); sw.setAttribute('aria-label', t('mcp.switchAria', { name }));
      sw.disabled = nativeOff;
      if (nativeOff) sw.title = t('mcp.nativeOffTitle');
      sw.onclick = () => { sw.setAttribute('aria-checked', String(!active)); ctx.saveKind(v => toggle(v, name, entries, !active, ctx)); };
      row.append(sw);
      list.append(row);
      const choice = choices(name, entries, ctx);
      if (choice) list.append(choice);
      if (ctx.opened.has(key)) list.append(peek(ctx, name, entries, fromPly, reg));
    }
    if (!groups.size) list.append(el('p', 'cx-empty', t('mcp.empty')));
    label.append(' ', el('span', 'n', t('mcp.count', { count: on })));
    block.append(list);
    const foot = el('div', 'cx-foot');
    foot.append(withPlus(button('', 'btn btn-quiet', () => openSheet(ctx)), t('mcp.add')), el('span', 'cx-sub', t('mcp.rowHint')));
    block.append(foot);
    if (ctx.ply?.storage && ctx.ply.storage.encrypted === false) block.append(el('p', 'cx-note', t('mcp.storage.plainList', { reason: ctx.ply.storage.reason ?? t('mcp.storage.noEncryption') })));
    const files = el('details', 'cx-fold');
    files.append(el('summary', null, t('mcp.files.summary')));
    const filesBlock = el('div', 'cx-block');
    filesBlock.append(el('p', 'cx-sub', t('mcp.files.desc')), ctx.sourceChips(value));
    files.append(filesBlock);
    block.append(files, advanced(ctx));
  }

  function describe(p, { entries, shown, fromPly, registry, active, nativeOff, disabledByName, value }) {
    const bits = [];
    const reg = fromPly ? registry.get(shown.name) : null;
    if (reg?.auth === 'oauth') {
      const state = reg.authStatus?.state;
      const text = STATES[state] ?? STATES.error;
      bits.push(['signed-out', 'expired'].includes(state) ? el('span', 'cx-strong', text) : text);
      if (reg.authStatus?.needsScope) bits.push(el('span', 'cx-strong', t('mcp.describe.needsScope')));
    }
    bits.push(transportText(shown.transport));
    if (reg?.auth === 'bearer') bits.push(t('mcp.auth.token'));
    if (reg?.auth === 'headers') bits.push(t('mcp.auth.headers'));
    if (reg?.pending?.length) bits.push(el('span', 'cx-strong', t('mcp.describe.pending')));
    const sources = [...new Set(entries.flatMap(e => e.origins?.map(o => o.source) ?? []))];
    if (fromPly) bits.push(sources.length > 1 ? t('mcp.describe.plyOver', { agents: agentList(sources.filter(s => s !== 'ply')) }) : t('mcp.describe.ply'));
    else if (sources.length === 1) bits.push(t('mcp.describe.only', { agent: agentName(sources[0]) }));
    else bits.push(sources.length === 2 ? t('mcp.describe.both', { a: agentName(sources[0]), b: agentName(sources[1]) }) : t('mcp.describe.many', { agents: agentList(sources) }));
    const defs = new Set(entries.filter(e => e.status === 'candidate' || e.shadowedBy === 'choice').map(signature));
    if (!fromPly && defs.size > 1) {
      // どちらを使うか: 選んだ定義（prefer）、無ければ先に見つかった方（core/context-scan.mjs）
      const picked = active && value?.prefer?.[shown.name] && within(value.prefer[shown.name], active.path);
      bits.push(active ? t('mcp.describe.defsUsing', { n: defs.size, agent: agentName(active.origins?.[0]?.source), by: picked ? t('mcp.describe.byPicked') : t('mcp.describe.byFirst') })
        : t('mcp.describe.defs', { n: defs.size }));
    }
    if (nativeOff) bits.push(t('mcp.describe.nativeOff'));
    else if (!active && !disabledByName) bits.push(t('mcp.describe.excluded'));
    if (reg?.authStatus?.message && !reg.authStatus.needsScope) bits.push(reg.authStatus.message);
    const message = messages.get(shown.name);
    if (message) bits.push(message);
    bits.forEach((b, i) => { if (i) p.append(' · '); p.append(b); });
  }

  /** スイッチ。オフは名前で外す（disabled）。オンは名前の除外と、設定ファイルごとの除外（移行した設定にある）も外す */
  function toggle(value, name, entries, turnOn, ctx) {
    const disabled = new Set(value.disabled ?? []);
    if (!turnOn) { disabled.add(name); value.disabled = [...disabled]; return; }
    disabled.delete(name);
    for (const e of entries.filter(e => e.status === 'excluded')) {
      const scope = e.scope === 'user' ? 'user' : 'directory';
      const list = value[scope]?.excludePaths ?? [];
      const hits = list.filter(p => within(p, e.path));
      if (!hits.length) continue;
      value[scope].excludePaths = list.filter(p => !hits.includes(p));
      // 同じ設定ファイルの他の登録は、外したままにする（名前で外す）
      for (const other of ctx.scan.entries) if (other.kind === 'mcp' && other.name !== name && other.status === 'excluded' && hits.some(p => within(p, other.path))) disabled.add(other.name);
    }
    value.disabled = [...disabled];
  }

  /** 同じ名前で中身の違う定義が複数あるとき、どれを使うか */
  function choices(name, entries, ctx) {
    if (entries.some(e => e.origins?.[0]?.source === 'ply')) return null;
    const usable = entries.filter(e => e.status === 'candidate' || e.shadowedBy === 'choice');
    if (new Set(usable.map(signature)).size < 2) return null;
    const box = el('div', 'cx-choice'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', t('mcp.choice.aria', { name }));
    box.append(el('span', null, t('mcp.choice.lead')));
    // 中身が同じものは 1 行にまとめる（同じ定義を複数のエージェントに登録しているだけなので、選ばせる意味がない）
    const groups = new Map();
    for (const e of usable) groups.set(signature(e), [...(groups.get(signature(e)) ?? []), e]);
    for (const list of groups.values()) {
      const e = list[0], label = el('label'), input = el('input');
      input.type = 'radio'; input.name = `mcp-choice-${name}`; input.checked = list.some(x => x.status === 'candidate');
      input.onchange = () => ctx.saveKind(v => { v.prefer = { ...(v.prefer ?? {}), [name]: e.path }; });
      const sources = [...new Set(list.flatMap(x => x.origins?.map(o => o.source) ?? []))];
      const how = e.transport === 'stdio' ? t('mcp.choice.local', { command: joinCommand(e.command, e.args) }) : e.endpoint ?? '';
      label.append(input, document.createTextNode(t('mcp.choice.settings', { agents: agentList(sources) })), el('span', 'cx-mono', how.length > 72 ? `${how.slice(0, 72)}…` : how));
      label.title = list.map(x => ctx.short(x.path)).join(', ');
      box.append(label);
    }
    return box;
  }

  // ---------------------------------------------------------------- 行の中身
  function peek(ctx, name, entries, fromPly, reg) {
    const box = el('div', 'cx-peek');
    if (fromPly && reg) {
      const facts = el('div', 'fm facts');
      const put = (k, v) => { if (v) facts.append(el('span', 'k', k), el('span', 'v', v)); };
      put(t('mcp.fact.transport'), reg.transport === 'stdio' ? t('mcp.transport.stdio') : reg.transport === 'sse' ? t('mcp.transport.sse') : t('mcp.transport.url'));
      put(t('mcp.fact.endpoint'), reg.url ?? null);
      put(t('mcp.fact.auth'), { none: t('mcp.auth.none'), bearer: t('mcp.auth.token'), headers: t('mcp.auth.headersWith', { names: (reg.headerNames ?? []).join(', ') }), oauth: t('mcp.auth.oauth') }[reg.auth] ?? reg.auth);
      if (reg.envKeys?.length) put(t('mcp.fact.env'), reg.envKeys.map(k => `${k}=${MASK}`).join('  '));
      if (reg.authStatus?.expiresAt) put(t('mcp.fact.expires'), fmt.dateTime(reg.authStatus.expiresAt));
      box.append(facts);
      const acts = el('div', 'acts');
      acts.append(button(t('mcp.edit'), 'btn', () => ctx.work(async () => openSheet(ctx, await ctx.cmd('readPlyMcp', { name })))));
      acts.append(button(t('mcp.rename'), 'btn', () => renameLine(box, ctx, name)));
      if (reg.auth === 'oauth') {
        if (remoteWindow()) box.append(el('p', 'remote-login-note', t('remote.loginOnHost')));
        else acts.append(button(reg.authStatus?.state === 'signed-in' ? t('mcp.loginAgain') : t('mcp.login'), 'btn', () => login(ctx, name)));
        if (reg.authStatus?.state === 'signed-in') acts.append(button(t('mcp.logout'), 'btn', () => ctx.work(async () => {
          const r = await ctx.cmd('mcpAuthLogout', { name });
          messages.set(name, r.revoked ? t('mcp.loggedOutRevoked') : t('mcp.loggedOut'));
          await ctx.reload();
        })));
      }
      acts.append(button(t('mcp.check'), 'btn', () => check(ctx, name)));
      const del = button(t('mcp.delete'), 'btn');
      let armed = null;
      del.onclick = () => {
        if (!armed) { del.textContent = t('mcp.deleteConfirm'); armed = setTimeout(() => { armed = null; del.textContent = t('mcp.delete'); }, 3000); return; }
        clearTimeout(armed);
        ctx.work(async () => { await ctx.cmd('deletePlyMcp', { name }); messages.delete(name); ctx.opened.delete(`mcp:${name}`); await ctx.reload(); ctx.toast(); });
      };
      acts.append(del);
      box.append(acts);
      return box;
    }
    // エージェントの登録: 伏せ字の定義を見せ、Pleiad に取り込める
    for (const e of entries) {
      const config = ctx.scan.configs?.find(c => pathKey(c.path) === pathKey(e.path));
      const line = el('div', 'row-line');
      line.append(el('span', 'cx-path', t('mcp.peek.config', { agent: agentName(e.origins?.[0]?.source), path: ctx.short(e.path) })));
      box.append(line);
      if (config) { const code = el('div'); code.innerHTML = codeBlock(excerpt(config, name), langFromPath(config.path)); box.append(code); }
    }
    box.append(el('p', 'msg', t('mcp.peek.masked')));
    const importable = entries.find(e => ['claude', 'codex'].includes(e.origins?.[0]?.source) && (e.status === 'candidate' || e.shadowedBy === 'choice'))
      ?? entries.find(e => ['claude', 'codex'].includes(e.origins?.[0]?.source));
    if (importable) {
      const acts = el('div', 'acts');
      acts.append(button(t('mcp.import.button'), 'btn btn-quiet', () => ctx.work(async () => {
        const source = importable.origins[0].source;
        const scope = source === 'claude' && importable.scope === 'directory' && /\.claude\.json$/i.test(importable.path) ? 'local' : importable.scope === 'user' ? 'user' : 'directory';
        const r = await ctx.cmd('importPlyMcp', { items: [{ format: source, scope, cwd: ctx.scanCwd, name }] });
        const row = r.results?.[0];
        if (!row?.ok) throw new Error(row?.error ?? t('mcp.import.failed'));
        messages.set(name, row.needsLogin ? t('mcp.import.doneLogin') : row.pending?.length ? t('mcp.import.donePending') : t('mcp.import.done'));
        await ctx.reload(); ctx.toast();
      })));
      box.append(acts, el('p', 'msg', t('mcp.import.note')));
    }
    return box;
  }
  function renameLine(box, ctx, name) {
    if (box.querySelector('.cx-inline')) return;
    const line = el('div', 'cx-inline');
    const input = el('input'); input.value = name; input.setAttribute('aria-label', t('mcp.newName')); input.autocomplete = 'off'; input.spellcheck = false;
    const go = () => ctx.work(async () => {
      const to = input.value.trim();
      if (!to || to === name) { line.remove(); return; }
      await ctx.cmd('renamePlyMcp', { name, to });
      ctx.opened.delete(`mcp:${name}`); ctx.opened.add(`mcp:${to}`);
      messages.delete(name);
      // 名前で外した設定・同じ名前の定義の選択はサーバーが新しい名前へ移す。画面の設定も読み直す（古い値で上書きしないため）
      await ctx.refreshSettings();
      await ctx.reload(); ctx.toast();
    });
    input.onkeydown = e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } if (e.key === 'Escape') line.remove(); };
    line.append(input, button(t('mcp.change'), 'btn btn-quiet', go), button(t('mcp.cancel'), 'btn', () => line.remove()));
    box.append(line);
    input.focus(); input.select();
  }
  function login(ctx, name) {
    if (remoteWindow()) { messages.set(name, t('remote.loginOnHost')); ctx.rerender(); return Promise.resolve(); }
    return ctx.work(async () => {
      const started = await ctx.cmd('mcpAuthStart', { name });
      const note = el('span');
      note.append(t('mcp.loginFlow.continue'));
      if (/^https?:\/\//i.test(started.url ?? '')) {
        const link = el('a', 'cx-link', t('mcp.loginFlow.link'));
        link.href = started.url; link.target = '_blank'; link.rel = 'noreferrer';
        note.append(link);
      }
      messages.set(name, note);
      await ctx.reload();
    });
  }
  function check(ctx, name) {
    return ctx.work(async () => {
      messages.set(name, t('mcp.checkResult.checking')); ctx.rerender();
      const r = await ctx.cmd('mcpReconnect', { name, cwd: ctx.scanCwd });
      messages.set(name, r.status === 'connected' ? t('mcp.checkResult.connected', { count: r.tools })
        : r.status === 'needs-auth' ? (r.reason ? t('mcp.checkResult.needsLoginWith', { reason: r.reason }) : t('mcp.checkResult.needsLogin'))
          : r.reason ? t('mcp.checkResult.failedWith', { reason: r.reason }) : t('mcp.checkResult.failed'));
      await ctx.reload();
    });
  }
  /** ログインが済んだ・失敗した（mcpAuth イベント）。行の知らせを差し替える */
  function authEvent(ev) {
    if (ev.phase === 'done') messages.set(ev.name, t('mcp.loginFlow.done'));
    else if (ev.phase === 'error') messages.set(ev.name, ev.message ? t('mcp.loginFlow.failedWith', { error: ev.message }) : t('mcp.loginFlow.failed'));
  }

  /** 詳細の奥: Client ID Metadata Document の URL（既定は空。サービス側がアプリ登録を受け付けないときに使う） */
  function advanced(ctx) {
    const box = el('details', 'cx-fold');
    box.append(el('summary', null, t('mcp.advanced.summary')));
    const block = el('div', 'cx-block');
    block.append(el('p', 'cx-sub', t('mcp.advanced.desc')));
    const line = el('div', 'cx-inline');
    const input = el('input'); input.value = ctx.ply?.settings?.clientMetadataUrl ?? ''; input.placeholder = 'https://…/client.json'; input.setAttribute('aria-label', t('mcp.advanced.aria')); input.autocomplete = 'off'; input.spellcheck = false;
    line.append(input, button(t('mcp.save'), 'btn btn-quiet', () => ctx.work(async () => {
      await ctx.cmd('setPlyMcpSettings', { clientMetadataUrl: input.value.trim() || null });
      ctx.toast();
    })));
    block.append(line);
    box.append(block);
    return box;
  }

  // ---------------------------------------------------------------- 追加・編集のシート
  function openSheet(ctx, existing = null) {
    document.querySelector('dialog.mcp-sheet')?.remove();
    const dialog = el('dialog', 'mcp-sheet');
    dialog.setAttribute('aria-label', existing ? t('mcp.sheet.editTitle', { name: existing.name }) : t('mcp.add'));
    const form = el('form');
    dialog.append(form);
    const v = existing?.value ?? {};
    const state = {
      kind: existing ? (v.transport === 'stdio' ? 'cmd' : 'url') : 'url',
      auth: existing ? ({ bearer: 'token', headers: 'headers', oauth: 'oauth', none: 'none' }[v.auth] ?? 'none') : 'oauth',
      scope: ctx.isDefault ? 'all' : 'here',
    };
    const natives = (ctx.scan?.entries ?? []).filter(e => e.kind === 'mcp' && e.origins?.[0]?.source !== 'ply');
    // 見出しに居場所を置く（名前の欄に置くと候補がすぐ開き、下の欄を覆う）
    const heading = el('h3', null, existing ? t('mcp.sheet.editTitle', { name: existing.name }) : t('mcp.add'));
    heading.tabIndex = -1;
    form.append(heading);
    // 名前（候補: エージェントの登録で、まだ Pleiad に無いもの。選ぶとつなぎ方などを写す）
    const nameField = el('label', 'mcp-field');
    nameField.append(t('mcp.sheet.name'));
    const registered = new Set((ctx.ply?.servers ?? []).map(s => s.name));
    const nameOptions = [...new Map(natives.filter(e => !registered.has(e.name)).map(e => [e.name, { value: e.name, hint: t('mcp.sheet.registeredIn', { agent: agentName(e.origins?.[0]?.source) }) }])).values()];
    const name = createCombo({ ariaLabel: t('mcp.sheet.name'), placeholder: 'github', cls: 'mono', head: t('mcp.sheet.copyFrom'), options: () => nameOptions, value: existing?.name ?? '',
      onCommit: n => { const src = natives.find(e => e.name === n); if (src) fill(src); } });
    if (existing) name.root.querySelector('input').readOnly = true;
    nameField.append(name.root);
    // つなぎ方
    const kindField = el('div', 'mcp-field');
    kindField.append(t('mcp.fact.transport'));
    const kindSeg = el('div', 'cx-seg'); kindSeg.setAttribute('role', 'radiogroup'); kindSeg.setAttribute('aria-label', t('mcp.fact.transport'));
    const kindButtons = [['url', t('mcp.transport.url'), t('mcp.sheet.urlDesc')], ['cmd', t('mcp.transport.stdio'), t('mcp.sheet.cmdDesc')]].map(([id, title, desc]) => {
      const b = button('', 'cx-opt'); b.setAttribute('role', 'radio'); b.dataset.k = id;
      b.append(el('b', null, title), el('span', null, desc));
      b.onclick = () => { state.kind = id; paint(); };
      kindSeg.append(b);
      return b;
    });
    kindField.append(kindSeg);
    // コマンド（候補: エージェントの登録にあるコマンド）
    const cmdField = el('label', 'mcp-field');
    cmdField.append(t('mcp.sheet.command'));
    const commands = [...new Set(natives.filter(e => e.command).map(e => joinCommand(e.command, e.args)))].map(c => ({ value: c }));
    const command = createCombo({ ariaLabel: t('mcp.sheet.command'), placeholder: 'npx -y @modelcontextprotocol/server-github', cls: 'mono', head: t('mcp.sheet.commandHead'), options: () => commands, value: v.command ? joinCommand(v.command, v.args) : '' });
    cmdField.append(command.root);
    // 環境変数（値は伏せ字。空のまま = 前の値を残す）
    const envField = el('div', 'mcp-field');
    envField.append(t('mcp.fact.env'));
    const envKeys = [...new Set(natives.flatMap(e => e.envKeys ?? []))].map(k => ({ value: k }));
    const env = pairs(envField, { keyLabel: t('mcp.sheet.name'), valueLabel: t('mcp.sheet.value'), keyOptions: () => envKeys, initial: Object.entries(v.env ?? {}), addLabel: t('mcp.sheet.addEnv') });
    // URL（候補: エージェントの登録にある接続先）
    const urlField = el('label', 'mcp-field');
    urlField.append('URL');
    const urls = [...new Set(natives.filter(e => e.endpoint).map(e => `https://${e.endpoint}`))].map(u => ({ value: u }));
    const url = createCombo({ ariaLabel: 'URL', placeholder: 'https://api.example.com/mcp', cls: 'mono', head: t('mcp.sheet.urlHead'), options: () => urls, value: v.url ?? '' });
    urlField.append(url.root);
    // 認証
    const authField = el('div', 'mcp-field');
    authField.append(t('mcp.fact.auth'));
    const authChips = el('div', 'cx-chips'); authChips.setAttribute('role', 'group'); authChips.setAttribute('aria-label', t('mcp.sheet.authAria'));
    const authButtons = [['oauth', t('mcp.auth.oauth')], ['token', t('mcp.auth.token')], ['headers', t('mcp.auth.headers')], ['none', t('mcp.auth.none')]].map(([id, label]) => {
      const b = button(label, 'cx-chip'); b.dataset.a = id;
      b.onclick = () => { state.auth = id; paint(); };
      authChips.append(b);
      return b;
    });
    const oauthNote = el('p', 'mcp-note', t('mcp.sheet.oauthNote'));
    const appReg = el('details', 'cx-fold');
    appReg.append(el('summary', null, t('mcp.sheet.appReg')));
    const clientId = el('input'); clientId.placeholder = t('mcp.sheet.clientId'); clientId.setAttribute('aria-label', t('mcp.sheet.clientId')); clientId.value = v.oauth?.clientId ?? ''; clientId.autocomplete = 'off';
    const clientSecret = el('input'); clientSecret.type = 'password'; clientSecret.placeholder = v.oauth?.clientSecret ? t('mcp.sheet.keep') : t('mcp.sheet.clientSecretOptional'); clientSecret.setAttribute('aria-label', t('mcp.sheet.clientSecret')); clientSecret.autocomplete = 'off';
    appReg.append(clientId, clientSecret);
    appReg.open = Boolean(v.oauth?.clientId);
    const token = el('input'); token.type = 'password'; token.setAttribute('aria-label', t('mcp.auth.token')); token.autocomplete = 'off';
    token.placeholder = v.bearerToken === MASK ? t('mcp.sheet.keep') : t('mcp.sheet.pasteToken');
    const tokenWrap = el('div', 'mcp-field'); tokenWrap.append(token);
    const headerWrap = el('div', 'mcp-field');
    const headers = pairs(headerWrap, { keyLabel: t('mcp.sheet.headerName'), valueLabel: t('mcp.sheet.value'), keyOptions: () => [{ value: 'X-API-Key' }, { value: 'Authorization' }], initial: Object.entries(v.headers ?? {}), addLabel: t('mcp.sheet.addHeader') });
    const noneNote = el('p', 'mcp-note', t('mcp.sheet.noneNote'));
    authField.append(authChips, oauthNote, appReg, tokenWrap, headerWrap, noneNote);
    // 使う範囲（場所を選んで追加するときだけ）
    const scopeField = el('div', 'mcp-field');
    scopeField.append(t('mcp.sheet.scope'));
    const scopeChips = el('div', 'cx-chips'); scopeChips.setAttribute('role', 'group'); scopeChips.setAttribute('aria-label', t('mcp.sheet.scope'));
    const scopeButtons = [['here', t('mcp.sheet.here')], ['all', t('mcp.sheet.all')]].map(([id, label]) => {
      const b = button(label, 'cx-chip'); b.dataset.s = id;
      b.onclick = () => { state.scope = id; paint(); };
      scopeChips.append(b);
      return b;
    });
    scopeField.append(scopeChips);
    if (!ctx.isDefault) { const where = el('p', 'mcp-note cx-mono', ctx.short(ctx.level)); where.title = ctx.level; scopeField.append(where); }
    scopeField.hidden = Boolean(existing) || ctx.isDefault;
    // 保存先と暗号化の説明
    const storage = ctx.ply?.storage;
    const where = el('p', 'mcp-note', storage && storage.encrypted === false
      ? t('mcp.storage.sheetPlain', { reason: storage.reason ?? t('mcp.storage.noEncryption') })
      : t('mcp.storage.sheetEncrypted'));
    // JSON で直接（上級者向け。開いているときはこちらを保存する）
    const json = el('details', 'cx-fold');
    json.append(el('summary', null, t('mcp.sheet.json')));
    const jsonField = el('label', 'mcp-field');
    const text = el('textarea'); text.rows = 8; text.spellcheck = false; text.setAttribute('aria-label', t('mcp.sheet.jsonAria'));
    jsonField.append(t('mcp.sheet.jsonNote'), text);
    json.append(jsonField);
    const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
    json.ontoggle = () => { if (json.open) { try { text.value = JSON.stringify(build(), null, 2); } catch (e) { text.value = ''; error.textContent = e.message; } } };
    const acts = el('div', 'mcp-acts');
    const go = button('', 'btn btn-primary');
    go.type = 'submit';
    acts.append(button(t('mcp.cancel'), 'btn', () => dialog.close()), go);
    form.append(nameField, kindField, cmdField, envField, urlField, authField, scopeField, where, json, error, acts);

    function fill(src) {
      if (src.transport === 'stdio') { state.kind = 'cmd'; if (!command.value && src.command) command.set(joinCommand(src.command, src.args)); }
      else { state.kind = 'url'; if (!url.value && src.endpoint) url.set(`https://${src.endpoint}`); }
      paint();
    }
    function paint() {
      for (const b of kindButtons) b.setAttribute('aria-checked', String(b.dataset.k === state.kind));
      for (const b of authButtons) b.setAttribute('aria-pressed', String(b.dataset.a === state.auth));
      for (const b of scopeButtons) b.setAttribute('aria-pressed', String(b.dataset.s === state.scope));
      const isUrl = state.kind === 'url';
      cmdField.hidden = isUrl; envField.hidden = isUrl; urlField.hidden = !isUrl; authField.hidden = !isUrl;
      oauthNote.hidden = state.auth !== 'oauth'; appReg.hidden = state.auth !== 'oauth';
      tokenWrap.hidden = state.auth !== 'token'; headerWrap.hidden = state.auth !== 'headers'; noneNote.hidden = state.auth !== 'none';
      go.textContent = existing ? t('mcp.save') : isUrl && state.auth === 'oauth' ? t('mcp.sheet.addLogin') : t('mcp.sheet.addTry');
    }
    /** 画面の値から保存する定義を作る（伏せ字の値はそのまま渡し、サーバが前の値を残す） */
    function build() {
      if (state.kind === 'cmd') {
        const { command: c, args } = splitCommand(command.value);
        if (!c) throw new Error(t('mcp.error.command'));
        const out = { transport: 'stdio', command: c, args, auth: 'none' };
        const e = env.value();
        if (Object.keys(e).length) out.env = e;
        return out;
      }
      const u = url.value.trim();
      if (!u) throw new Error(t('mcp.error.url'));
      const out = { transport: v.transport === 'sse' || /\/sse\/?$/.test(u) ? 'sse' : 'http', url: u };
      if (state.auth === 'oauth') {
        out.auth = 'oauth';
        const o = {};
        if (clientId.value.trim()) o.clientId = clientId.value.trim();
        if (clientSecret.value) o.clientSecret = clientSecret.value; else if (v.oauth?.clientSecret && clientId.value.trim()) o.clientSecret = MASK;
        for (const k of ['scope', 'callbackPort', 'resource']) if (v.oauth?.[k] !== undefined) o[k] = v.oauth[k];
        out.oauth = o;
      } else if (state.auth === 'token') {
        out.auth = 'bearer';
        out.bearerToken = token.value || (v.bearerToken === MASK ? MASK : '');
        if (!out.bearerToken) throw new Error(t('mcp.error.token'));
      } else if (state.auth === 'headers') {
        out.auth = 'headers';
        out.headers = headers.value();
        if (!Object.keys(out.headers).length) throw new Error(t('mcp.error.headers'));
      } else out.auth = 'none';
      return out;
    }
    form.onsubmit = async e => {
      e.preventDefault();
      error.textContent = '';
      const n = name.value.trim();
      let value;
      try {
        if (!n) throw new Error(t('mcp.error.name'));
        value = json.open ? JSON.parse(text.value) : build();
      } catch (err) { error.textContent = err instanceof SyntaxError ? t('mcp.error.json') : err.message; return; }
      go.disabled = true;
      try {
        const saved = await ctx.cmd('savePlyMcp', { name: n, value, mode: existing ? 'edit' : 'add', revision: ctx.ply?.revision });
        if (!existing && state.scope === 'here' && !ctx.isDefault) await onlyHere(ctx, n);
        dialog.close();
        ctx.opened.add(`mcp:${n}`);
        if (saved.oauthReset) messages.set(n, t('mcp.oauthReset'));
        if (!existing && value.auth === 'oauth') await login(ctx, n);
        else if (!existing) await check(ctx, n);
        else await ctx.reload();
        ctx.toast();
      } catch (err) { error.textContent = err.message; }
      finally { go.disabled = false; }
    };
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    paint();
    dialog.showModal();
    heading.focus();
  }
  /** 「この場所だけ」: 既定では名前で外し、この場所では外さない（この場所の上書きを作る） */
  async function onlyHere(ctx, name) {
    const view = await ctx.cmd('contextSettings', { cwd: ctx.cwd });
    const defaults = structuredClone(view.defaults.kinds.mcp.value);
    defaults.disabled = [...new Set([...(defaults.disabled ?? []), name])];
    const after = await ctx.cmd('setContextSettings', { cwd: ctx.cwd, place: null, kind: 'mcp', value: defaults });
    const here = after.places.find(p => pathKey(p.path) === pathKey(ctx.level));
    const value = structuredClone(here?.kinds.mcp.value ?? defaults);
    value.disabled = (value.disabled ?? []).filter(x => x !== name);
    await ctx.cmd('setContextSettings', { cwd: ctx.cwd, place: ctx.level, kind: 'mcp', value });
  }
  /** 名前と値の組（環境変数・ヘッダー）。値は伏せ字で返ってくるので、空のまま = 前の値を残す */
  function pairs(field, { keyLabel, valueLabel, keyOptions, initial, addLabel }) {
    const box = el('div', 'mcp-pairs');
    const rows = [];
    const more = withPlus(button('', 'btn', () => add()), addLabel);
    function add(k = '', val = '') {
      const row = el('div', 'mcp-pair');
      const key = createCombo({ ariaLabel: keyLabel, placeholder: keyLabel, cls: 'mono', options: keyOptions, value: k });
      const input = el('input'); input.type = 'password'; input.autocomplete = 'off'; input.setAttribute('aria-label', valueLabel);
      const masked = val === MASK, missing = val === null;
      input.placeholder = masked ? t('mcp.sheet.keep') : missing ? t('mcp.sheet.missing') : valueLabel;
      if (!masked && !missing) input.value = val ?? '';
      const remove = button('', 'btn btn-icon'); remove.innerHTML = closeIcon; remove.title = t('mcp.sheet.remove'); remove.setAttribute('aria-label', t('mcp.sheet.removeAria', { label: keyLabel }));
      const item = { key, input, masked, missing };
      remove.onclick = () => { row.remove(); rows.splice(rows.indexOf(item), 1); };
      row.append(key.root, input, remove);
      box.insertBefore(row, more);
      rows.push(item);
    }
    box.append(more);
    for (const [k, val] of initial) add(k, val);
    field.append(box);
    return { value: () => Object.fromEntries(rows.filter(r => r.key.value.trim()).map(r => [r.key.value.trim(), r.input.value || (r.masked ? MASK : r.missing ? null : '')])) };
  }

  return { render, openSheet, authEvent };
}
