// Pleiad 自身の Hooks の登録（正本）と、Hooks の担当（エージェントに任せる／Pleiad がそろえる）の保存（ADR 0049）。
// 各エージェントの設定ファイルは書き換えない。登録は「担当が Pleiad」の場所で、Pleiad から起動する会話にだけ渡す
// （core/hooks-plan.mjs が組み立て、各バックエンドが渡す）。
//
// 置き場: <データ置き場>/hooks.json（権限 0600）。context-scans.json（形式 3）には入れない:
//   形式 3 を読む前の版の Pleiad は知らない版のファイルを丸ごと読めないとして止まり、指示・Skills・外部 MCP の設定まで使えなくなる。
//   別のファイルなら前の版は黙って無視し、hooks はエージェント任せ（元のファイルどおり）に戻るだけで済む。
//   登録と担当を同じファイルに置くのは、切り替えの確認で「担当」と「取り込み」を 1 回の書き込みで保存するため。
//
//   { version: 1,
//     hooks: [H],
//     defaults: K,
//     places: { <pathKey>: { path, ...K } } }        // 作業場所ごとの上書き（一番近い上書きが勝つ。無ければ既定）
//   K = { owner: native|ply, disabled: [id] }        // disabled はその場所では渡さない登録（「この場所だけ変える」）
//   H = { id, name, agent（コマンドが話す入出力の形）, event, matcher, command, timeout?, async?, targets: [agent], matchers?: { <agent>: matcher },
//         enabled, importedFrom?: { agent, scope, path, plugin?, event }, createdAt, updatedAt }
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HOOK_AGENTS, HOOK_EVENTS, maskText } from './hooks-config.mjs';
import { pathKey, containsPath, scanDirectory } from './context-settings.mjs';
import { writeAtomic } from './atomic-file.mjs';
import { t } from './i18n.mjs';

export const VERSION = 1;
export const OWNERS = ['native', 'ply'];
const MAX_HOOKS = 200;
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
// i18n-dynamic: plyHooks.
const invalid = key => Object.assign(new Error(t(key)), { code: 'INVALID' });
export const defaultOwner = () => ({ owner: 'native', disabled: [] });
const ID = /^h-[0-9a-f]{12}$/;

/** 1 件の登録を検査して保存する形にする。previous は編集前の登録（id・作った時刻・取り込み元を引き継ぐ） */
export function normalizeHook(value, previous = null, now = new Date()) {
  if (!record(value)) throw invalid('plyHooks.invalid');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) throw invalid('plyHooks.name');
  const agent = value.agent;
  if (!HOOK_AGENTS.includes(agent)) throw invalid('plyHooks.agent');
  const event = value.event;
  if (typeof event !== 'string' || !HOOK_EVENTS[agent].includes(event)) throw invalid('plyHooks.event');
  const matcher = value.matcher === null || value.matcher === undefined ? '' : value.matcher;
  if (typeof matcher !== 'string' || matcher.length > 500) throw invalid('plyHooks.matcher');
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (!command || command.length > 4000 || /[\r\n\0]/.test(command)) throw invalid('plyHooks.command');
  const out = { id: previous?.id ?? `h-${crypto.randomBytes(6).toString('hex')}`, name, agent, event, matcher: matcher.trim(), command };
  if (value.timeout !== null && value.timeout !== undefined && value.timeout !== '') {
    const n = Number(value.timeout);
    if (!Number.isInteger(n) || n < 1 || n > 86400) throw invalid('plyHooks.timeout');
    out.timeout = n;
  }
  if (value.async === true) out.async = true;
  const targets = Array.isArray(value.targets) ? [...new Set(value.targets)] : [agent];
  if (!targets.length || targets.some(a => !HOOK_AGENTS.includes(a))) throw invalid('plyHooks.targets');
  out.targets = HOOK_AGENTS.filter(a => targets.includes(a));
  if (record(value.matchers)) {
    const m = {};
    for (const [a, v] of Object.entries(value.matchers)) {
      if (!HOOK_AGENTS.includes(a) || a === agent || typeof v !== 'string' || v.length > 500) throw invalid('plyHooks.matcher');
      if (v.trim() && out.targets.includes(a)) m[a] = v.trim();
    }
    if (Object.keys(m).length) out.matchers = m;
  }
  out.enabled = value.enabled !== false;
  const from = previous?.importedFrom ?? (record(value.importedFrom) ? value.importedFrom : null);
  if (from) out.importedFrom = { agent: from.agent, scope: from.scope, path: String(from.path ?? ''), event: from.event, ...(from.plugin ? { plugin: String(from.plugin) } : {}) };
  out.createdAt = previous?.createdAt ?? now.toISOString();
  out.updatedAt = now.toISOString();
  return out;
}

/** 担当 1 つ（既定・場所の上書き）を検査する。disabled は今の登録にある id だけ残す */
export function normalizeOwner(value, ids = null) {
  if (!record(value) || !OWNERS.includes(value.owner)) throw invalid('plyHooks.owner');
  const list = value.disabled === undefined ? [] : value.disabled;
  if (!Array.isArray(list) || list.length > 500 || list.some(id => typeof id !== 'string' || !ID.test(id))) throw invalid('plyHooks.owner');
  return { owner: value.owner, disabled: [...new Set(list.filter(id => !ids || ids.has(id)))].sort() };
}

/** 一番近い（深い）上書きを持つ場所 */
function nearest(places, key) {
  return Object.keys(places).filter(p => containsPath(p, key)).sort((a, b) => b.length - a.length)[0] ?? null;
}
/** 場所 key（pathKey。null なら既定）で効く担当。from は上書きを持つ場所（既定なら null） */
export function resolveOwner(config, key) {
  const from = key ? nearest(config.places, key) : null;
  const { path: _p, ...value } = from ? config.places[from] : config.defaults;
  return { value: structuredClone(value), from };
}

/** 画面・API に返す登録の形。コマンドは伏せ字（編集のシートを開くときだけ read で元の値を返す） */
export const publicHook = h => ({ ...h, command: maskText(h.command), masked: maskText(h.command) !== h.command });

export function createPlyHooks(dataDir) {
  const file = path.join(dataDir, 'hooks.json');
  let queue = Promise.resolve();
  const empty = () => ({ version: VERSION, hooks: [], defaults: defaultOwner(), places: {} });

  async function read() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return empty(); throw new Error(t('plyHooks.unreadable')); }
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error(t('plyHooks.unreadable')); }
    if (!record(raw) || raw.version !== VERSION || !Array.isArray(raw.hooks)) throw new Error(t('plyHooks.unreadable'));
    // 登録は 1 件ずつ検査する。読めない 1 件で全部を失わないよう、壊れた登録だけ落とす（保存し直すまでファイルは変えない）
    const hooks = [];
    for (const h of raw.hooks.slice(0, MAX_HOOKS)) {
      try { if (ID.test(h?.id)) hooks.push({ ...normalizeHook(h, h, new Date(h.updatedAt ?? Date.now())), updatedAt: h.updatedAt ?? null }); } catch {}
    }
    const ids = new Set(hooks.map(h => h.id));
    let defaults;
    try { defaults = normalizeOwner(raw.defaults ?? defaultOwner(), ids); } catch { defaults = defaultOwner(); }
    const places = {};
    for (const [key, p] of Object.entries(record(raw.places) ? raw.places : {})) {
      try { places[pathKey(key)] = { path: typeof p?.path === 'string' ? p.path : key, ...normalizeOwner(p, ids) }; } catch {}
    }
    return { version: VERSION, hooks, defaults, places };
  }
  async function write(config) {
    await fs.mkdir(dataDir, { recursive: true });
    await writeAtomic(file, JSON.stringify(config, null, 2));
    await fs.chmod(file, 0o600).catch(() => {});
  }
  // 読むのも書くのも同じ列に並べる（読み・変更・書き込みの間に別の保存が挟まらないように）
  const run = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  const revision = config => crypto.createHash('sha256').update(JSON.stringify(config.hooks)).digest('hex').slice(0, 16);

  /** 上の場所（または既定）から受け継ぐ値と同じ上書きは持たない（context-settings の pruneInherited と同じ考え方） */
  function prune(config, key) {
    const place = config.places[key];
    if (!place) return;
    delete config.places[key];
    const { path: p, ...value } = place;
    if (!isDeepStrictEqual(value, resolveOwner(config, key).value)) config.places[key] = place;
  }

  /** 作業場所 cwd（無ければ既定）で効く担当と、渡す候補の登録 */
  async function resolve(cwd = null) {
    const config = await run(read);
    const key = cwd ? pathKey(cwd) : null;
    const owner = resolveOwner(config, key);
    return { ...owner.value, from: owner.from ? config.places[owner.from].path : null, hooks: config.hooks, revision: revision(config) };
  }
  /** 画面の形。既定と、今の場所（cwd）で効く担当・どこから来ているか・登録の一覧（伏せ字） */
  async function view(cwd = null) {
    const dir = cwd ? await scanDirectory(cwd).catch(() => null) : null;
    const config = await run(read);
    const here = dir ? resolveOwner(config, pathKey(dir)) : null;
    return { version: VERSION, revision: revision(config), cwd: dir, defaults: { value: structuredClone(config.defaults) },
      place: here ? { value: here.value, override: here.from === pathKey(dir), from: here.from ? config.places[here.from].path : null } : null,
      hooks: config.hooks.map(publicHook) };
  }
  /** 編集のシートを開くときだけ、元のコマンドを返す */
  async function readHook(id) {
    const config = await run(read);
    const h = config.hooks.find(x => x.id === id);
    if (!h) throw new Error(t('plyHooks.notFound'));
    return structuredClone(h);
  }
  /** 追加・編集（id があれば編集）。戻りは画面の形 */
  function save(value, { cwd = null } = {}) {
    return run(async () => {
      const config = await read();
      const i = value?.id ? config.hooks.findIndex(h => h.id === value.id) : -1;
      if (value?.id && i < 0) throw new Error(t('plyHooks.notFound'));
      if (i < 0 && config.hooks.length >= MAX_HOOKS) throw invalid('plyHooks.tooMany');
      const next = normalizeHook(value, i >= 0 ? config.hooks[i] : null);
      if (i >= 0) config.hooks[i] = next; else config.hooks.push(next);
      await write(config);
      return next.id;
    }).then(async id => ({ ...(await view(cwd)), id }));
  }
  function remove(id, { cwd = null } = {}) {
    return run(async () => {
      const config = await read();
      if (!config.hooks.some(h => h.id === id)) throw new Error(t('plyHooks.notFound'));
      config.hooks = config.hooks.filter(h => h.id !== id);
      // 場所の「この場所では渡さない」からも外す
      for (const holder of [config.defaults, ...Object.values(config.places)]) holder.disabled = holder.disabled.filter(x => x !== id);
      for (const key of Object.keys(config.places)) prune(config, key);
      await write(config);
    }).then(() => view(cwd));
  }
  function toggle(id, enabled, { cwd = null } = {}) {
    return run(async () => {
      const config = await read();
      const h = config.hooks.find(x => x.id === id);
      if (!h) throw new Error(t('plyHooks.notFound'));
      h.enabled = enabled !== false;
      h.updatedAt = new Date().toISOString();
      await write(config);
    }).then(() => view(cwd));
  }
  /**
   * 担当と取り込みを 1 回で保存する（切り替えの確認の「そろえる」「戻す」）。
   *   place: null（既定）| 作業場所のパス、value: K | null（場所で null = 全体の設定に戻す）、add: 取り込む登録（normalizeHook に通す）
   * 取り込みに失敗したら担当も変えない（全部書くか、何も書かない）
   */
  function setOwner({ place = null, value, add = [], cwd = null } = {}) {
    return run(async () => {
      const config = await read();
      if (!Array.isArray(add) || add.length > 100 || config.hooks.length + add.length > MAX_HOOKS) throw invalid('plyHooks.tooMany');
      const added = add.map(v => normalizeHook(v));
      config.hooks.push(...added);
      const ids = new Set(config.hooks.map(h => h.id));
      if (place === null) config.defaults = value === null ? defaultOwner() : normalizeOwner(value, ids);
      else {
        const dir = await scanDirectory(place);
        const key = pathKey(dir);
        if (value === null) delete config.places[key];
        else { config.places[key] = { path: dir, ...normalizeOwner(value, ids) }; prune(config, key); }
      }
      await write(config);
      return added.map(h => h.id);
    }).then(async ids => ({ ...(await view(cwd ?? place)), added: ids }));
  }
  return { file, read: () => run(read), resolve, view, readHook, save, remove, toggle, setOwner };
}
