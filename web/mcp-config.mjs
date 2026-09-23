// ==================== 外部 MCP のカード（設定 › コンテキスト）と、追加・編集のシート ====================
// docs/mockups/context-unified.html の②「外部 MCP」。
//   エージェントに任せる: 各エージェント（Claude・Codex）の登録を並べて見比べるだけ（読み取りのみ）。
//   Pleiad がそろえる: この場所でつなぐものを名前ごとに 1 行。スイッチ（オフ = 名前で外す）、同じ名前の定義が複数あれば
//   どれを使うか、Pleiad に登録したものはログイン・編集・名前の変更・削除・ログアウト・接続の確認、エージェントの登録は「Pleiad に取り込む」。
// 登録は Pleiad 自身の設定（core/ply-mcp.mjs）。Claude や Codex の設定ファイルは書き換えない。秘密は伏せ字（••••）でしか返ってこない。
import { el } from './dom.mjs';
import { fmt, t } from './i18n.mjs';
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
const STATES = { 'signed-in': 'ログイン済み', 'signed-out': 'ログインが必要', expired: 'ログインが必要（期限切れ）', pending: 'ブラウザでログイン中', locked: 'この起動では鍵を開けません', error: 'ログインの状態を確認できません' };

function button(text, className = 'btn', onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}
function icon(kind) {
  const box = el('span', 'cx-ic');
  box.title = kind === 'stdio' ? '手元で動かす' : 'URL につなぐ';
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
    block.append(el('p', 'cx-sub', '各エージェントの設定に登録されているもの（Pleiad は読むだけで変えません）'));
    if (!ctx.agents) { block.append(ctx.loading()); return; }
    const lists = Object.fromEntries(AGENTS.map(([id]) => [id, ctx.agents.agents?.[id] ?? []]));
    const shown = AGENTS;
    const cols = el('div', 'cx-cols');
    for (const [id, label] of shown) {
      const col = el('div', 'cx-col');
      col.append(el('b', null, label));
      if (!lists[id].length) col.append(el('span', 'cx-sub', '登録はありません'));
      for (const s of lists[id]) {
        const line = el('div', 'nm2');
        line.append(el('span', 'cx-dot off'), el('span', 'n', s.name));
        if (shown.length > 1 && shown.filter(([o]) => o !== id).every(([o]) => !lists[o].some(x => x.name === s.name))) line.append(el('span', 'only', `${label} だけ`));
        if (s.disabled) line.append(el('span', 'only', '無効'));
        line.title = `${s.transport === 'stdio' ? '手元で動かす' : 'URL につなぐ'} · ${ctx.short(s.path)}`;
        col.append(line);
      }
      cols.append(col);
    }
    block.append(cols, el('p', 'cx-sub', 'エージェントを切り替えると使える MCP が変わります。そろえたいときは「Pleiad がそろえる」へ'));
  }

  /** Pleiad がそろえる: 名前ごとの一覧・追加・読み込む設定ファイル */
  function renderPly(block, ctx, value) {
    const label = el('p', 'cx-sub', ctx.isDefault ? '既定でつなぐもの' : 'この場所でつなぐもの');
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
      const t = el('span', 't');
      t.append(el('span', 'nm', name));
      const p = el('span', 'p');
      describe(p, { entries, shown, fromPly, registry, active, nativeOff, disabledByName, value });
      t.append(p);
      open.append(icon(shown.transport === 'stdio' ? 'stdio' : 'http'), t);
      open.onclick = () => { if (ctx.opened.has(key)) ctx.opened.delete(key); else ctx.opened.add(key); ctx.rerender(); };
      row.append(open);
      const reg = fromPly ? registry.get(name) : null;
      if (active && reg?.auth === 'oauth' && ['signed-out', 'expired'].includes(reg.authStatus?.state) && !remoteWindow()) row.append(button('ログイン', 'btn btn-quiet', () => login(ctx, name)));
      const sw = button('', 'cx-sw');
      sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(Boolean(active))); sw.setAttribute('aria-label', `${name} をつなぐ`);
      sw.disabled = nativeOff;
      if (nativeOff) sw.title = '元の設定で無効になっています（Pleiad は変えません）';
      sw.onclick = () => { sw.setAttribute('aria-checked', String(!active)); ctx.saveKind(v => toggle(v, name, entries, !active, ctx)); };
      row.append(sw);
      list.append(row);
      const choice = choices(name, entries, ctx);
      if (choice) list.append(choice);
      if (ctx.opened.has(key)) list.append(peek(ctx, name, entries, fromPly, reg));
    }
    if (!groups.size) list.append(el('p', 'cx-empty', 'つなぐ MCP はまだありません。「＋ MCP を追加」から登録するか、読み込む設定ファイルを選んでください'));
    label.append(' ', el('span', 'n', `${on} 件`));
    block.append(list);
    const foot = el('div', 'cx-foot');
    foot.append(withPlus(button('', 'btn btn-quiet', () => openSheet(ctx)), 'MCP を追加'), el('span', 'cx-sub', '行を押すと中身の確認・編集（鍵やトークンは伏せて表示）'));
    block.append(foot);
    if (ctx.ply?.storage && ctx.ply.storage.encrypted === false) block.append(el('p', 'cx-note', `この起動では鍵の保管庫を使えないため、トークンや鍵は所有者だけが読める権限の平文で保存します（${ctx.ply.storage.reason ?? '暗号化できない起動'}）。Pleiad デスクトップで開き直すと暗号化し直します。`));
    const files = el('details', 'cx-fold');
    files.append(el('summary', null, '読み込む設定ファイル'));
    const filesBlock = el('div', 'cx-block');
    filesBlock.append(el('p', 'cx-sub', 'Claude・Codex の設定に登録された MCP も、ここで選んだものは一覧に並びます。同じ名前なら Pleiad に登録したものが優先します。'), ctx.sourceChips(value));
    files.append(filesBlock);
    block.append(files, advanced(ctx));
  }

  function describe(p, { entries, shown, fromPly, registry, active, nativeOff, disabledByName, value }) {
    const bits = [];
    const reg = fromPly ? registry.get(shown.name) : null;
    if (reg?.auth === 'oauth') {
      const state = reg.authStatus?.state;
      const text = STATES[state] ?? 'ログインの状態を確認できません';
      bits.push(['signed-out', 'expired'].includes(state) ? el('span', 'cx-strong', text) : text);
      if (reg.authStatus?.needsScope) bits.push(el('span', 'cx-strong', '追加の権限が必要'));
    }
    bits.push(shown.transport === 'stdio' ? '手元で動かす' : 'URL につなぐ');
    if (reg?.auth === 'bearer') bits.push('トークン');
    if (reg?.auth === 'headers') bits.push('ヘッダー');
    if (reg?.pending?.length) bits.push(el('span', 'cx-strong', '未入力の値あり'));
    const sources = [...new Set(entries.flatMap(e => e.origins?.map(o => o.source) ?? []))];
    if (fromPly) bits.push(sources.length > 1 ? `Pleiad に登録（${sources.filter(s => s !== 'ply').map(agentName).join('・')} の同名より優先）` : 'Pleiad に登録');
    else if (sources.length === 1) bits.push(`${agentName(sources[0])} だけに登録`);
    else bits.push(sources.length === 2 ? `${agentName(sources[0])} と ${agentName(sources[1])} の両方に登録` : `${sources.map(agentName).join('・')} に登録`);
    const defs = new Set(entries.filter(e => e.status === 'candidate' || e.shadowedBy === 'choice').map(signature));
    if (!fromPly && defs.size > 1) {
      // どちらを使うか: 選んだ定義（prefer）、無ければ先に見つかった方（core/context-scan.mjs）
      const picked = active && value?.prefer?.[shown.name] && within(value.prefer[shown.name], active.path);
      bits.push(active ? `同じ名前で定義が ${defs.size} つ · ${agentName(active.origins?.[0]?.source)} の設定の方を使用（${picked ? '選んだもの' : '先に見つかった方'}）` : `同じ名前で定義が ${defs.size} つ`);
    }
    if (nativeOff) bits.push('元の設定で無効');
    else if (!active && !disabledByName) bits.push('外しています');
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
    const box = el('div', 'cx-choice'); box.setAttribute('role', 'radiogroup'); box.setAttribute('aria-label', `${name} の定義を選ぶ`);
    box.append(el('span', null, 'どちらの定義を使いますか（選ばなければ先に見つかった方）'));
    // 中身が同じものは 1 行にまとめる（同じ定義を複数のエージェントに登録しているだけなので、選ばせる意味がない）
    const groups = new Map();
    for (const e of usable) groups.set(signature(e), [...(groups.get(signature(e)) ?? []), e]);
    for (const list of groups.values()) {
      const e = list[0], label = el('label'), input = el('input');
      input.type = 'radio'; input.name = `mcp-choice-${name}`; input.checked = list.some(x => x.status === 'candidate');
      input.onchange = () => ctx.saveKind(v => { v.prefer = { ...(v.prefer ?? {}), [name]: e.path }; });
      const sources = [...new Set(list.flatMap(x => x.origins?.map(o => o.source) ?? []))].map(agentName);
      const how = e.transport === 'stdio' ? `${joinCommand(e.command, e.args)}（手元）` : e.endpoint ?? '';
      label.append(input, document.createTextNode(`${sources.join('・')} の設定`), el('span', 'cx-mono', how.length > 72 ? `${how.slice(0, 72)}…` : how));
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
      put('つなぎ方', reg.transport === 'stdio' ? '手元で動かす' : reg.transport === 'sse' ? 'URL につなぐ（SSE）' : 'URL につなぐ');
      put('接続先', reg.url ?? null);
      put('認証', { none: 'なし', bearer: 'トークン', headers: `ヘッダー（${(reg.headerNames ?? []).join(', ')}）`, oauth: 'ブラウザでログイン' }[reg.auth] ?? reg.auth);
      if (reg.envKeys?.length) put('環境変数', reg.envKeys.map(k => `${k}=${MASK}`).join('  '));
      if (reg.authStatus?.expiresAt) put('期限', fmt.dateTime(reg.authStatus.expiresAt));
      box.append(facts);
      const acts = el('div', 'acts');
      acts.append(button('編集', 'btn', () => ctx.work(async () => openSheet(ctx, await ctx.cmd('readPlyMcp', { name })))));
      acts.append(button('名前を変える', 'btn', () => renameLine(box, ctx, name)));
      if (reg.auth === 'oauth') {
        if (remoteWindow()) box.append(el('p', 'remote-login-note', t('remote.loginOnHost')));
        else acts.append(button(reg.authStatus?.state === 'signed-in' ? 'ログインし直す' : 'ログイン', 'btn', () => login(ctx, name)));
        if (reg.authStatus?.state === 'signed-in') acts.append(button('ログアウト', 'btn', () => ctx.work(async () => {
          const r = await ctx.cmd('mcpAuthLogout', { name });
          messages.set(name, r.revoked ? 'ログアウトしました（トークンを失効）' : 'ログアウトしました');
          await ctx.reload();
        })));
      }
      acts.append(button('接続を確認', 'btn', () => check(ctx, name)));
      const del = button('削除', 'btn');
      let armed = null;
      del.onclick = () => {
        if (!armed) { del.textContent = 'もう一度押すと削除'; armed = setTimeout(() => { armed = null; del.textContent = '削除'; }, 3000); return; }
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
      line.append(el('span', 'cx-path', `${agentName(e.origins?.[0]?.source)} の設定 · ${ctx.short(e.path)}`));
      box.append(line);
      if (config) { const code = el('div'); code.innerHTML = codeBlock(excerpt(config, name), langFromPath(config.path)); box.append(code); }
    }
    box.append(el('p', 'msg', '環境変数とヘッダーの値、URL のクエリは伏せています。'));
    const importable = entries.find(e => ['claude', 'codex'].includes(e.origins?.[0]?.source) && (e.status === 'candidate' || e.shadowedBy === 'choice'))
      ?? entries.find(e => ['claude', 'codex'].includes(e.origins?.[0]?.source));
    if (importable) {
      const acts = el('div', 'acts');
      acts.append(button('Pleiad に取り込む', 'btn btn-quiet', () => ctx.work(async () => {
        const source = importable.origins[0].source;
        const scope = source === 'claude' && importable.scope === 'directory' && /\.claude\.json$/i.test(importable.path) ? 'local' : importable.scope === 'user' ? 'user' : 'directory';
        const r = await ctx.cmd('importPlyMcp', { items: [{ format: source, scope, cwd: ctx.scanCwd, name }] });
        const row = r.results?.[0];
        if (!row?.ok) throw new Error(row?.error ?? '取り込めませんでした');
        messages.set(name, row.needsLogin ? 'Pleiad に取り込みました。ログインしてください' : row.pending?.length ? 'Pleiad に取り込みました。鍵などの値は編集で入れてください' : 'Pleiad に取り込みました');
        await ctx.reload(); ctx.toast();
      })));
      box.append(acts, el('p', 'msg', '取り込むと Pleiad の登録になり、どのエージェントにも同じものをつなぎます。トークンは引き継がないので、ログインが要るものは Pleiad でログインし直します。'));
    }
    return box;
  }
  function renameLine(box, ctx, name) {
    if (box.querySelector('.cx-inline')) return;
    const line = el('div', 'cx-inline');
    const input = el('input'); input.value = name; input.setAttribute('aria-label', '新しい名前'); input.autocomplete = 'off'; input.spellcheck = false;
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
    line.append(input, button('変更', 'btn btn-quiet', go), button('やめる', 'btn', () => line.remove()));
    box.append(line);
    input.focus(); input.select();
  }
  function login(ctx, name) {
    if (remoteWindow()) { messages.set(name, t('remote.loginOnHost')); ctx.rerender(); return Promise.resolve(); }
    return ctx.work(async () => {
      const started = await ctx.cmd('mcpAuthStart', { name });
      const note = el('span');
      note.append('ブラウザで続けてください… ');
      if (/^https?:\/\//i.test(started.url ?? '')) {
        const link = el('a', 'cx-link', '開かないときはこちら');
        link.href = started.url; link.target = '_blank'; link.rel = 'noreferrer';
        note.append(link);
      }
      messages.set(name, note);
      await ctx.reload();
    });
  }
  function check(ctx, name) {
    return ctx.work(async () => {
      messages.set(name, '接続を確かめています…'); ctx.rerender();
      const r = await ctx.cmd('mcpReconnect', { name, cwd: ctx.scanCwd });
      messages.set(name, r.status === 'connected' ? `つながりました（ツール ${r.tools} 件）` : r.status === 'needs-auth' ? `ログインが必要です${r.reason ? `（${r.reason}）` : ''}` : `つながりませんでした${r.reason ? `：${r.reason}` : ''}`);
      await ctx.reload();
    });
  }
  /** ログインが済んだ・失敗した（mcpAuth イベント）。行の知らせを差し替える */
  function authEvent(ev) {
    if (ev.phase === 'done') messages.set(ev.name, 'ログインしました');
    else if (ev.phase === 'error') messages.set(ev.name, `ログインできませんでした${ev.message ? `：${ev.message}` : ''}`);
  }

  /** 詳細の奥: Client ID Metadata Document の URL（既定は空。サービス側がアプリ登録を受け付けないときに使う） */
  function advanced(ctx) {
    const box = el('details', 'cx-fold');
    box.append(el('summary', null, 'ログインの詳細設定'));
    const block = el('div', 'cx-block');
    block.append(el('p', 'cx-sub', 'クライアント ID メタデータ文書の URL（任意）。公開した文書の https の URL を入れると、対応するサービスではアプリ登録の代わりに使います。空のままで構いません。'));
    const line = el('div', 'cx-inline');
    const input = el('input'); input.value = ctx.ply?.settings?.clientMetadataUrl ?? ''; input.placeholder = 'https://…/client.json'; input.setAttribute('aria-label', 'クライアント ID メタデータ文書の URL'); input.autocomplete = 'off'; input.spellcheck = false;
    line.append(input, button('保存', 'btn btn-quiet', () => ctx.work(async () => {
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
    dialog.setAttribute('aria-label', existing ? `${existing.name} を編集` : 'MCP を追加');
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
    const heading = el('h3', null, existing ? `${existing.name} を編集` : 'MCP を追加');
    heading.tabIndex = -1;
    form.append(heading);
    // 名前（候補: エージェントの登録で、まだ Pleiad に無いもの。選ぶとつなぎ方などを写す）
    const nameField = el('label', 'mcp-field');
    nameField.append('名前');
    const registered = new Set((ctx.ply?.servers ?? []).map(s => s.name));
    const nameOptions = [...new Map(natives.filter(e => !registered.has(e.name)).map(e => [e.name, { value: e.name, hint: `${agentName(e.origins?.[0]?.source)} の登録` }])).values()];
    const name = createCombo({ ariaLabel: '名前', placeholder: 'github', cls: 'mono', head: 'エージェントの登録から写す', options: () => nameOptions, value: existing?.name ?? '',
      onCommit: n => { const src = natives.find(e => e.name === n); if (src) fill(src); } });
    if (existing) name.root.querySelector('input').readOnly = true;
    nameField.append(name.root);
    // つなぎ方
    const kindField = el('div', 'mcp-field');
    kindField.append('つなぎ方');
    const kindSeg = el('div', 'cx-seg'); kindSeg.setAttribute('role', 'radiogroup'); kindSeg.setAttribute('aria-label', 'つなぎ方');
    const kindButtons = [['url', 'URL につなぐ', 'サービスが公開している MCP'], ['cmd', '手元で動かす', 'npx などのコマンドを起動']].map(([id, title, desc]) => {
      const b = button('', 'cx-opt'); b.setAttribute('role', 'radio'); b.dataset.k = id;
      b.append(el('b', null, title), el('span', null, desc));
      b.onclick = () => { state.kind = id; paint(); };
      kindSeg.append(b);
      return b;
    });
    kindField.append(kindSeg);
    // コマンド（候補: エージェントの登録にあるコマンド）
    const cmdField = el('label', 'mcp-field');
    cmdField.append('コマンド');
    const commands = [...new Set(natives.filter(e => e.command).map(e => joinCommand(e.command, e.args)))].map(c => ({ value: c }));
    const command = createCombo({ ariaLabel: 'コマンド', placeholder: 'npx -y @modelcontextprotocol/server-github', cls: 'mono', head: 'エージェントの登録にあるコマンド', options: () => commands, value: v.command ? joinCommand(v.command, v.args) : '' });
    cmdField.append(command.root);
    // 環境変数（値は伏せ字。空のまま = 前の値を残す）
    const envField = el('div', 'mcp-field');
    envField.append('環境変数');
    const envKeys = [...new Set(natives.flatMap(e => e.envKeys ?? []))].map(k => ({ value: k }));
    const env = pairs(envField, { keyLabel: '名前', valueLabel: '値', keyOptions: () => envKeys, initial: Object.entries(v.env ?? {}), addLabel: '環境変数' });
    // URL（候補: エージェントの登録にある接続先）
    const urlField = el('label', 'mcp-field');
    urlField.append('URL');
    const urls = [...new Set(natives.filter(e => e.endpoint).map(e => `https://${e.endpoint}`))].map(u => ({ value: u }));
    const url = createCombo({ ariaLabel: 'URL', placeholder: 'https://api.example.com/mcp', cls: 'mono', head: 'エージェントの登録にある接続先', options: () => urls, value: v.url ?? '' });
    urlField.append(url.root);
    // 認証
    const authField = el('div', 'mcp-field');
    authField.append('認証');
    const authChips = el('div', 'cx-chips'); authChips.setAttribute('role', 'group'); authChips.setAttribute('aria-label', '認証の方式');
    const authButtons = [['oauth', 'ブラウザでログイン'], ['token', 'トークン'], ['headers', 'ヘッダー'], ['none', 'なし']].map(([id, label]) => {
      const b = button(label, 'cx-chip'); b.dataset.a = id;
      b.onclick = () => { state.auth = id; paint(); };
      authChips.append(b);
      return b;
    });
    const oauthNote = el('p', 'mcp-note', '追加するとブラウザが開きます。ログインが済めば、期限の更新は Pleiad が自動で行います');
    const appReg = el('details', 'cx-fold');
    appReg.append(el('summary', null, 'サービス側でアプリ登録が必要なとき'));
    const clientId = el('input'); clientId.placeholder = 'クライアント ID'; clientId.setAttribute('aria-label', 'クライアント ID'); clientId.value = v.oauth?.clientId ?? ''; clientId.autocomplete = 'off';
    const clientSecret = el('input'); clientSecret.type = 'password'; clientSecret.placeholder = v.oauth?.clientSecret ? '変えないときは空のまま' : 'クライアントシークレット（任意）'; clientSecret.setAttribute('aria-label', 'クライアントシークレット'); clientSecret.autocomplete = 'off';
    appReg.append(clientId, clientSecret);
    appReg.open = Boolean(v.oauth?.clientId);
    const token = el('input'); token.type = 'password'; token.setAttribute('aria-label', 'トークン'); token.autocomplete = 'off';
    token.placeholder = v.bearerToken === MASK ? '変えないときは空のまま' : 'トークンを貼り付け';
    const tokenWrap = el('div', 'mcp-field'); tokenWrap.append(token);
    const headerWrap = el('div', 'mcp-field');
    const headers = pairs(headerWrap, { keyLabel: 'ヘッダー名', valueLabel: '値', keyOptions: () => [{ value: 'X-API-Key' }, { value: 'Authorization' }], initial: Object.entries(v.headers ?? {}), addLabel: 'ヘッダー' });
    const noneNote = el('p', 'mcp-note', '認証の要らない MCP に使います');
    authField.append(authChips, oauthNote, appReg, tokenWrap, headerWrap, noneNote);
    // 使う範囲（場所を選んで追加するときだけ）
    const scopeField = el('div', 'mcp-field');
    scopeField.append('使う範囲');
    const scopeChips = el('div', 'cx-chips'); scopeChips.setAttribute('role', 'group'); scopeChips.setAttribute('aria-label', '使う範囲');
    const scopeButtons = [['here', 'この場所だけ'], ['all', 'すべての場所']].map(([id, label]) => {
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
    const where = el('p', 'mcp-note', 'Pleiad の設定として保存し、どのエージェントにもつなぎます。Claude や Codex の設定ファイルは書き換えません。'
      + (storage && storage.encrypted === false
        ? `この起動では鍵の保管庫を使えないため、トークンや鍵は所有者だけが読める権限の平文で保存します（${storage.reason ?? '暗号化できない起動'}）。`
        : 'トークンや鍵は OS の鍵の保管庫（Windows の資格情報、macOS のキーチェーン、Linux の Secret Service）で暗号化して保存します。'));
    // JSON で直接（上級者向け。開いているときはこちらを保存する）
    const json = el('details', 'cx-fold');
    json.append(el('summary', null, 'JSON で編集（上級者向け）'));
    const jsonField = el('label', 'mcp-field');
    const text = el('textarea'); text.rows = 8; text.spellcheck = false; text.setAttribute('aria-label', 'MCP の定義（JSON）');
    jsonField.append('秘密の値は伏せ字（••••）のままなら前の値を残します', text);
    json.append(jsonField);
    const error = el('p', 'mcp-error'); error.setAttribute('role', 'alert');
    json.ontoggle = () => { if (json.open) { try { text.value = JSON.stringify(build(), null, 2); } catch (e) { text.value = ''; error.textContent = e.message; } } };
    const acts = el('div', 'mcp-acts');
    const go = button('', 'btn btn-primary');
    go.type = 'submit';
    acts.append(button('やめる', 'btn', () => dialog.close()), go);
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
      go.textContent = existing ? '保存' : isUrl && state.auth === 'oauth' ? '追加してログイン' : '追加して試しにつなぐ';
    }
    /** 画面の値から保存する定義を作る（伏せ字の値はそのまま渡し、サーバが前の値を残す） */
    function build() {
      if (state.kind === 'cmd') {
        const { command: c, args } = splitCommand(command.value);
        if (!c) throw new Error('コマンドを入れてください');
        const out = { transport: 'stdio', command: c, args, auth: 'none' };
        const e = env.value();
        if (Object.keys(e).length) out.env = e;
        return out;
      }
      const u = url.value.trim();
      if (!u) throw new Error('URL を入れてください');
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
        if (!out.bearerToken) throw new Error('トークンを入れてください');
      } else if (state.auth === 'headers') {
        out.auth = 'headers';
        out.headers = headers.value();
        if (!Object.keys(out.headers).length) throw new Error('ヘッダーを 1 つ以上入れてください');
      } else out.auth = 'none';
      return out;
    }
    form.onsubmit = async e => {
      e.preventDefault();
      error.textContent = '';
      const n = name.value.trim();
      let value;
      try {
        if (!n) throw new Error('名前を入れてください');
        value = json.open ? JSON.parse(text.value) : build();
      } catch (err) { error.textContent = err instanceof SyntaxError ? 'JSON の形が正しくありません' : err.message; return; }
      go.disabled = true;
      try {
        const saved = await ctx.cmd('savePlyMcp', { name: n, value, mode: existing ? 'edit' : 'add', revision: ctx.ply?.revision });
        if (!existing && state.scope === 'here' && !ctx.isDefault) await onlyHere(ctx, n);
        dialog.close();
        ctx.opened.add(`mcp:${n}`);
        if (saved.oauthReset) messages.set(n, '接続先などが変わったため、ログインし直してください');
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
      input.placeholder = masked ? '変えないときは空のまま' : missing ? '未入力' : valueLabel;
      if (!masked && !missing) input.value = val ?? '';
      const remove = button('', 'btn btn-icon'); remove.innerHTML = closeIcon; remove.title = '外す'; remove.setAttribute('aria-label', `${keyLabel}を外す`);
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
