// コンテキストの設定（設定 › コンテキスト）。エージェント側の設定ファイルは変えない。
//
// 形式 2（context-scans.json、version: 2）は「種類ごとの設定」を既定と場所ごとの上書きで持つ:
//   { version: 2,
//     defaults: { roots: [..], kinds: { instruction: K, skill: K, mcp: K } },
//     places: { <pathKey>: { path, roots?: [..], kinds: { <kind>?: K } } } }
//   K = { owner: native|ply, user: S|null, directory: S|null, disabled?: [名前], prefer?: { 名前: 設定ファイル } }
//   S = { sources: [common|claude|codex], excludePaths: [..] }
// user は home（ユーザー共通）の探索、directory は Git ルート〜作業場所の探索。null はその範囲を探さない
// （形式 1 の「対象（kinds）」から外していた種類。移行で意味を保つためだけに残る）。
// 種類ごとに、作業場所に一番近い上書きを持つ場所が勝ち、無ければ既定。追加ルートも同じ（defaults.roots は
// どの場所でも探すユーザー共通のルート、places[].roots はその場所から下で探すルート）。
// disabled / prefer は外部 MCP だけ。disabled は名前で外すもの、prefer は同じ名前の定義が複数あるときに使う方。
//
// 形式 1（version: 1）は読み込み担当（owners / directoryOwners）と探索設定（user / directories）を別々に継承していた。
// 読み込んだときにバックアップを取り、コピーの上で形式 2 へ移し、同じ結果になることを確かめてから置き換える
// （docs/desktop-releases.md の「データ形式変更」）。確かめられなければ元のファイルはそのまま残して止まる。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { isDeepStrictEqual, promisify } from 'node:util';
import { realpath as realpathCallback } from 'node:fs';
// 表示用の実体パス。Windows では大文字小文字を実際の表記に戻す（キーは小文字に寄せて持つ）
const realpathNative = promisify(realpathCallback.native);
import { z } from 'zod';
import { t } from './i18n.mjs';

export const KINDS = ['instruction', 'skill', 'mcp'];
export const SOURCES = ['common', 'claude', 'codex'];
// 対応を終えたエージェントの探索元。前の版で保存した設定を読めるように受け付け、読んだところで落とす
const RETIRED_SOURCES = ['procway'];
const storedSource = z.enum([...SOURCES, ...RETIRED_SOURCES]);
const liveSources = sources => unique(sources.filter(s => SOURCES.includes(s)));
export const DEFAULT_SOURCES = ['common', 'claude', 'codex'];
/** 形式 1 の探索設定の既定。移行と、形式 1 のまま記録された会話の方針（contextSession.policy）を読むのに使う */
export const DEFAULT_SCAN = { sources: [...DEFAULT_SOURCES], kinds: [...KINDS], additionalRoots: [], excludePaths: [] };
export const DEFAULT_OWNERS = { instruction: 'native', skill: 'native', mcp: 'native' };
export const defaultKind = () => ({ owner: 'native', user: { sources: [...DEFAULT_SOURCES], excludePaths: [] }, directory: { sources: [...DEFAULT_SOURCES], excludePaths: [] } });

const paths = z.array(z.string().trim().min(1).max(4096)).max(64);
const scopeSchema = z.object({ sources: z.array(storedSource).max(4), excludePaths: paths }).strict();
const NAME = z.string().min(1).max(128);
const kindSchema = z.object({
  owner: z.enum(['native', 'ply']),
  user: scopeSchema.nullable(),
  directory: scopeSchema.nullable(),
  disabled: z.array(NAME).max(500).optional(),
  prefer: z.record(NAME, z.string().min(1).max(4096)).optional(),
}).strict();
const legacySpec = z.object({
  sources: z.array(storedSource).max(4),
  kinds: z.array(z.enum(KINDS)).max(3),
  additionalRoots: paths,
  excludePaths: paths,
}).strict();
const ownersSchema = z.object({ instruction: z.enum(['native', 'ply']), skill: z.enum(['native', 'ply']), mcp: z.enum(['native', 'ply']) }).strict();

export const pathKey = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
export const containsPath = (root, file) => { const rel = path.relative(pathKey(root), pathKey(file)); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
/**
 * Claude の rules の `paths` に書く glob を正規表現にする。`**`・`*`・`?`・`{a,b}` だけを扱う（依存を増やさないための最小限）。
 * 区切りは / に寄せ、win32 では大文字小文字を区別しない（pathKey と同じ）。閉じない { は RegExp の構文エラーとして投げる
 */
export function globRegExp(glob) {
  const p = String(glob).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  let out = '', depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*' && (i === 0 || p[i - 1] === '/') && (i + 2 === p.length || p[i + 2] === '/')) {
      // 階層をまたぐ **。`a/**/b` の間は 0 階層でもよく、末尾の `a/**` は a 自身にも当たる
      if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else if (out.endsWith('/')) { out = `${out.slice(0, -1)}(?:/.*)?`; i++; }
      else { out += '.*'; i++; }
    } else if (c === '*') { out += '[^/]*'; while (p[i + 1] === '*') i++; }
    else if (c === '?') out += '[^/]';
    else if (c === '{') { depth++; out += '(?:'; }
    else if (c === '}' && depth) { depth--; out += ')'; }
    else if (c === ',' && depth) out += '|';
    else out += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, process.platform === 'win32' ? 'i' : '');
}
/** file が base からの相対で globs のどれかに当たるか。base の外は当たらない */
export function matchesGlobs(globs, base, file) {
  if (!containsPath(base, file)) return false;
  const rel = path.relative(path.resolve(base), path.resolve(file)).split(path.sep).join('/');
  return (globs ?? []).some(g => { try { return globRegExp(g).test(rel); } catch { return false; } });
}
export function resolveScanPath(p, base, home = os.homedir()) {
  return path.resolve(base, p === '~' ? home : /^~[/\\]/.test(p) ? path.join(home, p.slice(2)) : p);
}
export async function scanDirectory(p) {
  if (typeof p !== 'string' || !p.trim()) throw new Error(t('context.settings.cwdRequired'));
  const dir = await fs.realpath(resolveScanPath(p.trim(), process.cwd()));
  if (!(await fs.stat(dir)).isDirectory()) throw new Error(t('context.settings.dirRequired'));
  return dir;
}
const unique = list => [...new Set(list)];
const resolveAll = (list, base, home) => unique(list.map(p => resolveScanPath(p, base, home)));

/** 形式 1 の探索設定 1 つ（検査して、相対パスを保存元の場所から解決する） */
export function normalizeScan(value, base, home = os.homedir()) {
  const parsed = legacySpec.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.scanInvalid'));
  const v = parsed.data;
  return { sources: liveSources(v.sources), kinds: unique(v.kinds), additionalRoots: resolveAll(v.additionalRoots, base, home), excludePaths: resolveAll(v.excludePaths, base, home) };
}

/** 種類 1 つの設定を検査する。相対パスは保存先の場所（既定なら home）から解決する */
export function normalizeKind(kind, value, base, home = os.homedir()) {
  if (!KINDS.includes(kind)) throw new Error(t('context.settings.unknownKind'));
  const parsed = kindSchema.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.kindInvalid'));
  const v = parsed.data;
  if (kind !== 'mcp' && (v.disabled || v.prefer)) throw new Error(t('context.settings.disabledMcpOnly'));
  const scope = s => s && { sources: liveSources(s.sources), excludePaths: resolveAll(s.excludePaths, base, home) };
  const out = { owner: v.owner, user: scope(v.user), directory: scope(v.directory) };
  if (v.disabled?.length) out.disabled = unique(v.disabled).sort();
  if (v.prefer && Object.keys(v.prefer).length) out.prefer = Object.fromEntries(Object.entries(v.prefer).map(([n, p]) => [n, resolveScanPath(p, base, home)]));
  return out;
}
function normalizeRoots(value, base, home) {
  const parsed = paths.safeParse(value);
  if (!parsed.success) throw new Error(t('context.settings.rootsInvalid'));
  return resolveAll(parsed.data, base, home);
}

// ------------------------------------------------------------------ 探索の計画（context-scan が読む形）
//
// plan = { user: { roots, kinds: { <kind>: S|null } }, directory: { roots, kinds }, mcp: { disabled, prefer } }

/** 形式 1 の探索設定（user / directory の 2 つ）を計画にする。形式 1 のまま記録された会話と、移行の検証に使う */
export function legacyPlan(user, directory) {
  const scope = spec => ({ roots: [...(spec.additionalRoots ?? [])],
    kinds: Object.fromEntries(KINDS.map(k => [k, spec.kinds.includes(k) ? { sources: [...spec.sources], excludePaths: [...spec.excludePaths] } : null])) });
  return { user: scope(user), directory: scope(directory), mcp: { disabled: [], prefer: {} } };
}
/** scanContext に渡された設定から計画を取り出す。形式 1 の { user, directory } も受け付ける */
export const scanPlan = settings => settings.plan ?? legacyPlan(settings.user, settings.directory);

/** 一番近い（深い）上書きを持つ場所 */
function nearest(places, key, has) {
  return Object.keys(places).filter(p => has(places[p]) && containsPath(p, key)).sort((a, b) => b.length - a.length)[0] ?? null;
}
/**
 * 場所（pathKey。null なら既定だけ）で効く設定を解く。
 * 戻り: { owners, plan, kinds: { <kind>: { value, from } }, roots: { value, from } }。from は上書きを持つ場所（既定なら null）
 */
export function resolveConfig(config, key) {
  const kinds = {};
  for (const k of KINDS) {
    const from = key ? nearest(config.places, key, p => p.kinds?.[k]) : null;
    kinds[k] = { value: structuredClone(from ? config.places[from].kinds[k] : config.defaults.kinds[k]), from };
  }
  const rootsFrom = key ? nearest(config.places, key, p => Array.isArray(p.roots)) : null;
  const roots = { value: rootsFrom ? [...config.places[rootsFrom].roots] : [], from: rootsFrom };
  const plan = {
    user: { roots: [...config.defaults.roots], kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.user])) },
    directory: { roots: [...roots.value], kinds: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.directory])) },
    mcp: { disabled: kinds.mcp.value.disabled ?? [], prefer: kinds.mcp.value.prefer ?? {} },
  };
  return { owners: Object.fromEntries(KINDS.map(k => [k, kinds[k].value.owner])), plan, kinds, roots };
}

// ------------------------------------------------------------------ 形式 1 → 2

/** 形式 1（読み込み・検査済み）を形式 2 にする。純粋な計算で、ファイルには触れない */
export function migrateV1(old, display = p => p) {
  const legacyKind = (owner, user, directory, k) => ({ owner,
    user: user.kinds.includes(k) ? { sources: [...user.sources], excludePaths: [...user.excludePaths] } : null,
    directory: directory.kinds.includes(k) ? { sources: [...directory.sources], excludePaths: [...directory.excludePaths] } : null });
  const config = { version: 2, defaults: { roots: [...old.user.additionalRoots],
    kinds: Object.fromEntries(KINDS.map(k => [k, legacyKind(old.owners[k], old.user, DEFAULT_SCAN, k)])) }, places: {} };
  // 形式 1 では担当と探索設定が別々の場所から継承される。どちらかを上書きしていた場所はすべて、
  // その場所で効いていた担当と探索設定を持つ場所にする（その下の場所も、一番近い上書きが同じものを指す）
  const keys = unique([...Object.keys(old.directoryOwners), ...Object.keys(old.directories)]).sort((a, b) => a.length - b.length);
  for (const key of keys) {
    const ownerFrom = nearest(old.directoryOwners, key, () => true), specFrom = nearest(old.directories, key, () => true);
    const owners = ownerFrom ? old.directoryOwners[ownerFrom] : old.owners, spec = specFrom ? old.directories[specFrom] : DEFAULT_SCAN;
    config.places[key] = { path: display(key), roots: [...spec.additionalRoots], kinds: Object.fromEntries(KINDS.map(k => [k, legacyKind(owners[k], old.user, spec, k)])) };
  }
  // 上の場所（または既定）から受け継ぐ値と同じ上書きは消す。結果は変わらず、画面の「個別に変更」が実際の違いだけになる
  for (const key of keys) {
    const place = config.places[key];
    delete config.places[key];
    const inherited = resolveConfig(config, key);
    const kinds = Object.fromEntries(KINDS.filter(k => !isDeepStrictEqual(place.kinds[k], inherited.kinds[k].value)).map(k => [k, place.kinds[k]]));
    const next = { path: place.path, kinds };
    if (!isDeepStrictEqual(place.roots, inherited.roots.value)) next.roots = place.roots;
    if (Object.keys(kinds).length || next.roots) config.places[key] = next;
  }
  return config;
}
/** 形式 1 の場所で効いていた担当と探索の計画 */
export function legacyEffective(old, key) {
  const ownerFrom = key ? nearest(old.directoryOwners, key, () => true) : null, specFrom = key ? nearest(old.directories, key, () => true) : null;
  return { owners: structuredClone(ownerFrom ? old.directoryOwners[ownerFrom] : old.owners), plan: legacyPlan(old.user, specFrom ? old.directories[specFrom] : DEFAULT_SCAN) };
}
/** 移行の検証。既定と、形式 1 で上書きを持っていたすべての場所で、担当と探索の計画が同じか */
export function sameMeaning(old, config) {
  const keys = [null, ...Object.keys(old.directoryOwners), ...Object.keys(old.directories)];
  for (const key of keys) {
    const before = legacyEffective(old, key), after = resolveConfig(config, key);
    if (!isDeepStrictEqual(before.owners, after.owners) || !isDeepStrictEqual(before.plan, after.plan)) return key ?? t('context.settings.defaultPlace');
  }
  return null;
}

// ------------------------------------------------------------------ 保存

export function createContextSettings(dataDir, home = os.homedir()) {
  const file = path.join(dataDir, 'context-scans.json');
  let writes = Promise.resolve();
  const real = async p => { try { return await fs.realpath(p); } catch { return p; } };
  // 実体パスへ寄せたキーで持つ。get/set は realpath した場所で引くので、短縮名（8.3）や junction 越しの表記で
  // 残ったキーはそのままだと二度と一致せず、継承が黙って外れる
  const keyed = async (map, fn) => Object.fromEntries(await Promise.all(Object.entries(map ?? {}).map(async ([p, v]) => { const r = await real(p); return [pathKey(r), await fn(v, r)]; })));
  const empty = () => ({ version: 2, defaults: { roots: [], kinds: Object.fromEntries(KINDS.map(k => [k, defaultKind()])) }, places: {} });

  async function readV1(raw) {
    if (!raw.directories || typeof raw.directories !== 'object' || Array.isArray(raw.directories)) throw new Error('invalid');
    // 旧版の探索元 ply は共通配置のこと
    const fix = v => ({ ...v, sources: Array.isArray(v?.sources) ? unique(v.sources.map(s => s === 'ply' ? 'common' : s)) : v?.sources });
    return { owners: ownersSchema.parse(raw.owners ?? DEFAULT_OWNERS), directoryOwners: await keyed(raw.directoryOwners, v => ownersSchema.parse(v ?? DEFAULT_OWNERS)),
      user: normalizeScan(fix(raw.user), home, home), directories: await keyed(raw.directories, (v, p) => normalizeScan(fix(v), p, home)) };
  }
  async function readV2(raw) {
    if (!raw.defaults || !raw.places || typeof raw.places !== 'object' || Array.isArray(raw.places)) throw new Error('invalid');
    const defaults = { roots: normalizeRoots(raw.defaults.roots ?? [], home, home),
      kinds: Object.fromEntries(KINDS.map(k => [k, raw.defaults.kinds?.[k] ? normalizeKind(k, raw.defaults.kinds[k], home, home) : defaultKind()])) };
    const places = await keyed(raw.places, async (v, p) => {
      const out = { path: typeof v?.path === 'string' ? v.path : p, kinds: {} };
      for (const k of KINDS) if (v?.kinds?.[k]) out.kinds[k] = normalizeKind(k, v.kinds[k], p, home);
      if (Array.isArray(v?.roots)) out.roots = normalizeRoots(v.roots, p, home);
      return out;
    });
    return { version: 2, defaults, places };
  }
  async function write(config, target = file) {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, target);
    } finally { await fs.rm(tmp, { force: true }); }
  }
  /**
   * 形式 1 → 2。バックアップ（context-scans.v1-backup.json。既にあれば残す）→ 移行 → 同じ結果かを確かめる →
   * 一時ファイルに書いて読み直し、もう一度確かめる → 置き換える。どこかで失敗したら元のファイルは変えない
   */
  async function migrate(text, raw) {
    const old = await readV1(raw);
    const backup = path.join(dataDir, 'context-scans.v1-backup.json');
    await fs.writeFile(backup, text, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const display = async key => (await realpathNative(key).catch(() => key));
    const names = Object.fromEntries(await Promise.all(unique([...Object.keys(old.directoryOwners), ...Object.keys(old.directories)]).map(async k => [k, await display(k)])));
    const config = migrateV1(old, k => names[k] ?? k);
    const differs = sameMeaning(old, config);
    if (differs) throw Object.assign(new Error(t('context.settings.migrateDiffers', { place: differs })), { migration: true });
    const tmp = `${file}.migrate.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
      const check = await readV2(JSON.parse(await fs.readFile(tmp, 'utf8')));
      if (sameMeaning(old, check)) throw Object.assign(new Error(t('context.settings.migrateUnverified')), { migration: true });
      // 読んでから置き換えるまでの間に別の Pleiad が書き換えていないか（同じ内容のときだけ置き換える）
      if ((await fs.readFile(file, 'utf8')) !== text) throw Object.assign(new Error('changed'), { retry: true });
      await fs.rename(tmp, file);
      return check;
    } finally { await fs.rm(tmp, { force: true }); }
  }
  async function read() {
    let text;
    try { text = await fs.readFile(file, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return empty(); throw new Error(t('context.settings.unreadable')); }
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error(t('context.settings.unreadable')); }
    try {
      if (raw?.version === 2) return await readV2(raw);
      if (raw?.version !== 1) throw new Error('invalid');
    } catch { throw new Error(t('context.settings.unreadable')); }
    try { return await migrate(text, raw); }
    catch (e) {
      if (e.retry) return read();
      if (e.migration) throw e;
      throw new Error(t('context.settings.unreadable'), { cause: e });
    }
  }
  // 読むのも書き込みの列に並べる。形式 1 の移行（書き込み）と保存が重ならないように
  const queue = fn => { const run = writes.catch(() => {}).then(fn); writes = run; return run; };

  /**
   * 作業場所 cwd で効く設定。level: 'default' なら場所の上書きを無視して既定だけで解く（設定の「すべての場所」の一覧用）
   * 戻り: { cwd, owners, plan, kinds, roots }
   */
  async function get(cwd, { level = null } = {}) {
    const dir = await scanDirectory(cwd);
    const config = await queue(read);
    return { cwd: dir, ...resolveConfig(config, level === 'default' ? null : pathKey(dir)) };
  }
  /** 画面の形。既定・保存された場所・今の場所（cwd）それぞれで効く設定と、どこから来ているか */
  async function view(cwd = null) {
    const dir = cwd ? await scanDirectory(cwd).catch(() => null) : null;
    const config = await queue(read);
    const level = (key, place) => {
      const r = resolveConfig(config, key);
      const kinds = Object.fromEntries(KINDS.map(k => [k, { value: r.kinds[k].value, override: key ? r.kinds[k].from === key : true, from: r.kinds[k].from ? config.places[r.kinds[k].from].path : null }]));
      const roots = { value: key ? r.roots.value : [...config.defaults.roots], override: key ? r.roots.from === key : true, from: r.roots.from ? config.places[r.roots.from].path : null };
      return { id: key ?? 'default', path: place?.path ?? null, kinds, roots, overrides: key ? KINDS.filter(k => kinds[k].override).length + (roots.override ? 1 : 0) : 0 };
    };
    const keys = Object.keys(config.places);
    if (dir && !keys.includes(pathKey(dir))) keys.push(pathKey(dir));
    const places = keys.map(k => ({ ...level(k, config.places[k] ?? { path: dir }), saved: Object.hasOwn(config.places, k), current: Boolean(dir) && k === pathKey(dir) }))
      .sort((a, b) => (b.current - a.current) || a.path.localeCompare(b.path));
    return { version: 2, cwd: dir, home, defaults: level(null), places };
  }
  /**
   * 1 か所だけ変えて即時保存する。
   *   { place: null | パス, kind, value: K | null }   種類の設定（場所で null = 既定に戻す）
   *   { place, roots: [..] | null }                     追加で探すフォルダー（場所で null = 上の設定に戻す）
   *   { place, add: true } / { place, remove: true }    場所を一覧に足す / 一覧から外す（上書きも消える）
   */
  function set(args = {}) {
    let placed = null;
    return queue(async () => {
      const config = await read();
      const { place = null, kind } = args;
      let target, base = home;
      if (place === null) target = config.defaults;
      else {
        // 一覧から外すのは、フォルダーが消えた・移った場所でもできるようにする（保存した場所の名前で探す）
        if (args.remove) {
          const dir = await scanDirectory(place).catch(() => null);
          const key = [dir && pathKey(dir), pathKey(place)].find(k => k && Object.hasOwn(config.places, k));
          if (key) { delete config.places[key]; await write(config); }
          return;
        }
        const dir = await scanDirectory(place);
        base = dir; placed = dir;
        const key = pathKey(dir);
        target = config.places[key] ??= { path: dir, kinds: {} };
      }
      if (kind !== undefined) {
        if (!KINDS.includes(kind)) throw new Error(t('context.settings.unknownKind'));
        if (args.value === null) { if (place === null) target.kinds[kind] = defaultKind(); else delete target.kinds[kind]; }
        else target.kinds[kind] = normalizeKind(kind, args.value, base, home);
      }
      if (Object.hasOwn(args, 'roots')) {
        if (args.roots === null) { if (place === null) target.roots = []; else delete target.roots; }
        else target.roots = normalizeRoots(args.roots, base, home);
      }
      if (kind === undefined && !Object.hasOwn(args, 'roots') && !args.add) throw new Error(t('context.settings.nothingToChange'));
      await write(config);
    // 外した場所を「今の場所」として一覧に戻さないよう、外したときは cwd だけで画面の形を作る
    }).then(async () => ({ ...(await view(args.cwd ?? (args.remove ? null : args.place || null))), place: placed }));
  }
  /**
   * Pleiad の登録の名前を変えたとき、既定と各場所の外部 MCP の設定で、名前で指したもの（disabled・prefer）を新しい名前へ追随させる。
   *   disabled: 新しい名前も外す。古い名前は残す（同じ名前でエージェント側に登録があれば、それも前と同じく外れたまま）
   *   prefer:   古い名前で Pleiad の登録（plyFile）を選んでいたら、新しい名前へ移す。エージェント側の定義を選んでいたものは古い名前のまま
   * 戻り値は書き換えた箇所の数
   */
  function renameMcp(from, to, { plyFile = null } = {}) {
    return queue(async () => {
      const config = await read();
      let changed = 0;
      const same = (a, b) => a && b && pathKey(a) === pathKey(b);
      for (const holder of [config.defaults, ...Object.values(config.places)]) {
        const k = holder.kinds?.mcp;
        if (!k) continue;
        if (k.disabled?.includes(from) && !k.disabled.includes(to)) { k.disabled = unique([...k.disabled, to]).sort(); changed++; }
        if (k.prefer && Object.hasOwn(k.prefer, from) && (!plyFile || same(k.prefer[from], plyFile))) {
          if (!Object.hasOwn(k.prefer, to)) k.prefer[to] = k.prefer[from];
          delete k.prefer[from];
          changed++;
        }
      }
      if (changed) await write(config);
      return changed;
    });
  }
  return { get, view, set, renameMcp, file };
}
