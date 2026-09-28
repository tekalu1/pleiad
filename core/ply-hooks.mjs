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
  // digest は取り込んだときの元の定義（handler と matcher）の hash。同じ定義をもう一度取り込まないための照合に使う
  if (from) out.importedFrom = { agent: from.agent, scope: from.scope, path: String(from.path ?? ''), event: from.event, ...(from.plugin ? { plugin: String(from.plugin) } : {}),
    ...(typeof from.digest === 'string' && /^[0-9a-f]{16,64}$/.test(from.digest) ? { digest: from.digest } : {}) };
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
/**
 * 担当が確かに決まるか。壊れた既定（brokenDefaults）や、効くはずの場所の壊れた上書き（brokenPlaces。読めた上書きより深いもの）があれば、
 * その場所の担当は分からない（null）。分からない担当をエージェント任せと決め打ちしない（止めるはずのネイティブが動くため）
 */
export function certainOwner(config, key) {
  const valid = key ? nearest(config.places, key) : null;
  const broken = key ? Object.keys(config.brokenPlaces ?? {}).filter(p => containsPath(p, key)).sort((a, b) => b.length - a.length)[0] ?? null : null;
  if (broken && (!valid || broken.length > valid.length)) return null;
  if (!valid && config.brokenDefaults) return null;
  return resolveOwner(config, key);
}

/** 画面・API に返す登録の形。コマンドは伏せ字（編集のシートを開くときだけ read で元の値を返す） */
export const publicHook = h => ({ ...h, command: maskText(h.command), masked: maskText(h.command) !== h.command });

/**
 * 厳密に読む（実行の正本なので、壊れた部分を黙って無かったことにしない）。
 * 戻り: { version, hooks（読めた登録）, defaults, places, problems: [{ kind, index?, id?, place? }], brokenDefaults, brokenPlaces }。
 * problems があるファイルには上書き保存しない（壊れた部分を消してしまうため。repair で退避してから直す）
 */
export function parseConfig(raw) {
  if (!record(raw) || raw.version !== VERSION || !Array.isArray(raw.hooks)) return null;
  const problems = [], hooks = [], seen = new Set();
  raw.hooks.forEach((h, index) => {
    if (index >= MAX_HOOKS) { problems.push({ kind: 'tooMany', index }); return; }
    if (!ID.test(h?.id)) { problems.push({ kind: 'hook', index }); return; }
    if (seen.has(h.id)) { problems.push({ kind: 'duplicate', index, id: h.id }); return; }
    seen.add(h.id);
    try { hooks.push({ ...normalizeHook(h, h, new Date(h.updatedAt ?? Date.now())), updatedAt: h.updatedAt ?? null }); }
    catch { problems.push({ kind: 'hook', index, id: h.id, name: typeof h.name === 'string' ? h.name.slice(0, 80) : null }); }
  });
  const ids = new Set(hooks.map(h => h.id));
  let defaults = defaultOwner(), brokenDefaults = false;
  if (raw.defaults !== undefined) {
    try { defaults = normalizeOwner(raw.defaults, ids); } catch { brokenDefaults = true; problems.push({ kind: 'defaults' }); }
  }
  const places = {}, brokenPlaces = {};
  if (raw.places !== undefined && !record(raw.places)) { brokenDefaults = true; problems.push({ kind: 'places' }); }
  for (const [key, p] of Object.entries(record(raw.places) ? raw.places : {})) {
    try { places[pathKey(key)] = { path: typeof p?.path === 'string' ? p.path : key, ...normalizeOwner(p, ids) }; }
    catch { brokenPlaces[pathKey(key)] = true; problems.push({ kind: 'place', place: typeof p?.path === 'string' ? p.path : key }); }
  }
  return { version: VERSION, hooks, defaults, places, problems, brokenDefaults, brokenPlaces };
}
const plain = config => ({ version: VERSION, hooks: config.hooks, defaults: config.defaults, places: config.places });

export function createPlyHooks(dataDir) {
  const file = path.join(dataDir, 'hooks.json');
  let queue = Promise.resolve();
  // 最後に読めた内容（このプロセスで）。ファイルが丸ごと読めなくなったとき、そのとき確かにエージェント任せだった場所だけは続けられるように
  let lastGood = null;
  const empty = () => ({ version: VERSION, hooks: [], defaults: defaultOwner(), places: {}, problems: [], brokenDefaults: false, brokenPlaces: {} });
  const unreadable = () => Object.assign(new Error(t('plyHooks.unreadable')), { code: 'UNREADABLE' });

  async function read() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') { lastGood = empty(); return lastGood; } throw unreadable(); }
    let raw;
    try { raw = JSON.parse(text); } catch { throw unreadable(); }
    const config = parseConfig(raw);
    if (!config) throw unreadable();
    lastGood = config;
    return config;
  }
  async function write(config) {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    // 作るときから 0600（一時ファイルのうちも、置き換えた直後も広い権限にしない）
    await writeAtomic(file, JSON.stringify(plain(config), null, 2), { mode: 0o600 });
    try { await fs.chmod(file, 0o600); } catch (e) { if (process.platform !== 'win32') throw e; }
  }
  // 読むのも書くのも同じ列に並べる（読み・変更・書き込みの間に別の保存が挟まらないように）
  const run = fn => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  /** 登録と担当をまとめた版。確認の面で見た内容から変わっていないかを保存の直前に照合する（確認票） */
  const revision = config => crypto.createHash('sha256').update(JSON.stringify([config.hooks, config.defaults, config.places])).digest('hex').slice(0, 16);
  /** 壊れた部分があるファイルには書かない */
  const writable = config => { if (config.problems.length) throw Object.assign(new Error(t('plyHooks.brokenSave')), { code: 'BROKEN' }); };

  /** 上の場所（または既定）から受け継ぐ値と同じ上書きは持たない（context-settings の pruneInherited と同じ考え方） */
  function prune(config, key) {
    const place = config.places[key];
    if (!place) return;
    delete config.places[key];
    const { path: p, ...value } = place;
    if (!isDeepStrictEqual(value, resolveOwner(config, key).value)) config.places[key] = place;
  }

  /** 作業場所 cwd（無ければ既定）で効く担当と、渡す候補の登録（画面の表示用。読めなければ投げる） */
  async function resolve(cwd = null) {
    const config = await run(read);
    const key = cwd ? pathKey(cwd) : null;
    const owner = resolveOwner(config, key);
    return { ...owner.value, from: owner.from ? config.places[owner.from].path : null, hooks: config.hooks, revision: revision(config) };
  }
  /**
   * ターンを始める前の担当（ADR 0049）。担当が確かに分からないとき・担当が Pleiad なのに登録に壊れた部分があるときは投げる（ターンを始めない）。
   * ファイルが丸ごと読めなくなったときは、このプロセスで最後に読めた内容で確かにエージェント任せだった場所だけ続ける（stale）
   */
  async function resolveForTurn(cwd) {
    let config, stale = false;
    try { config = await run(read); }
    catch (e) { if (e.code !== 'UNREADABLE' || !lastGood) throw e; config = lastGood; stale = true; }
    const key = pathKey(cwd);
    const owner = certainOwner(config, key);
    if (!owner) throw Object.assign(new Error(t('plyHooks.ownerUnknown')), { code: 'OWNER_UNKNOWN' });
    if (owner.value.owner === 'ply' && stale) throw unreadable();
    if (owner.value.owner === 'ply' && config.problems.some(p => ['hook', 'duplicate', 'tooMany'].includes(p.kind)))
      throw Object.assign(new Error(t('plyHooks.brokenEntries')), { code: 'BROKEN' });
    return { ...owner.value, from: owner.from ? config.places[owner.from].path : null, hooks: config.hooks, revision: revision(config), ...(stale ? { stale: true } : {}) };
  }
  /**
   * 画面の形。既定と、今の場所（cwd）で効く担当・どこから来ているか・上書きを外したときの担当（inherited）・登録の一覧（伏せ字）・壊れた部分。
   * ファイルが読めなければ { unreadable: true }（画面が退避の操作を出す）
   */
  async function view(cwd = null) {
    const dir = cwd ? await scanDirectory(cwd).catch(() => null) : null;
    let config;
    try { config = await run(read); }
    catch (e) { if (e.code === 'UNREADABLE') return { version: VERSION, unreadable: true, error: e.message, cwd: dir, hooks: [], problems: [] }; throw e; }
    const key = dir ? pathKey(dir) : null;
    const here = dir ? resolveOwner(config, key) : null;
    let inherited = null;
    if (dir && config.places[key]) {
      const copy = { ...config, places: { ...config.places } };
      delete copy.places[key];
      const up = resolveOwner(copy, key);
      inherited = { value: up.value, from: up.from ? copy.places[up.from].path : null };
    }
    return { version: VERSION, revision: revision(config), cwd: dir, defaults: { value: structuredClone(config.defaults), broken: config.brokenDefaults },
      place: here ? { value: here.value, override: here.from === key, from: here.from ? config.places[here.from].path : null, certain: Boolean(certainOwner(config, key)), inherited } : null,
      hooks: config.hooks.map(publicHook), problems: config.problems };
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
      writable(config);
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
      writable(config);
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
      writable(config);
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
   *   expect: 確認の面で見た版（revision）。今の版と違えば保存しない（確認した後に登録・担当が変わった）
   * 取り込みに失敗したら担当も変えない（全部書くか、何も書かない）。同じ出どころ・同じ定義（importedFrom.digest）の登録はもう一度足さない
   */
  function setOwner({ place = null, value, add = [], cwd = null, expect = undefined } = {}) {
    return run(async () => {
      const config = await read();
      writable(config);
      if (expect !== undefined && expect !== revision(config)) throw Object.assign(new Error(t('plyHooks.changedSinceReview')), { code: 'CHANGED' });
      if (!Array.isArray(add) || add.length > 100) throw invalid('plyHooks.tooMany');
      const same = (a, b) => a.importedFrom?.digest && a.importedFrom.digest === b.importedFrom?.digest && a.importedFrom.path === b.importedFrom?.path;
      const added = [];
      for (const v of add) {
        const h = normalizeHook(v);
        if ([...config.hooks, ...added].some(x => same(x, h))) continue;
        added.push(h);
      }
      if (config.hooks.length + added.length > MAX_HOOKS) throw invalid('plyHooks.tooMany');
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
  /**
   * 壊れた hooks.json を直す（画面の「壊れた部分を外して保存し直す」）。元のファイルは hooks.broken-<時刻>.json に退避し、読めた部分だけで書き直す。
   * 丸ごと読めなければ空（エージェント任せ）から。担当を読めなかった場所・既定はエージェント任せになる（画面でそう知らせてから押させる）
   */
  function repair({ cwd = null } = {}) {
    return run(async () => {
      let text = null;
      try { text = await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (text === null) return;
      let config = null;
      try { config = parseConfig(JSON.parse(text)); } catch {}
      const backup = path.join(dataDir, `hooks.broken-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await fs.writeFile(backup, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await write(config ? { ...config, problems: [] } : empty());
    }).then(() => view(cwd));
  }
  return { file, read: () => run(read), resolve, resolveForTurn, view, readHook, save, remove, toggle, setOwner, repair };
}
