// Inventory, not a reimplementation of either agent's effective prompt.
// No config writes, MCP launches, shell expansion, or skill execution.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parse as toml, stringify as tomlText } from 'smol-toml';
import { parse as yaml } from 'yaml';
import { KINDS, SOURCES, containsPath, globRegExp, pathKey, scanPlan } from './context-settings.mjs';
import { t } from './i18n.mjs';

const digest = s => crypto.createHash('sha256').update(s).digest('hex');
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const MAX_FILE = 256 * 1024, MAX_TOTAL = 4 * 1024 * 1024, MAX_ENTRIES = 1000;
// 値を伏せるキー。キー名は残す（何が要るかは見えたほうがよい）
const SECRET_KEYS = new Set(['env', 'headers']), MASK = '••••';
// クエリ文字列に鍵を置く登録（?key=… / ?token=…）があるので、? 以降は伏せる。接続先そのものは残す
const URL_KEYS = new Set(['url', 'baseUrl']);
// 先頭の YAML frontmatter（Skill・Claude の rules）。中身が空の `---\n---` も frontmatter とみなす
export const FRONTMATTER = /^---\r?\n(?:([^]*?)\r?\n)?---(?:\r?\n|$)/;
/** rules の `paths`。配列か文字列（`,` 区切り。`{a,b}` の中の `,` では切らない）。解釈できなければ null */
function globList(value) {
  const items = typeof value === 'string' ? value.split(/,(?![^{]*\})/) : Array.isArray(value) && value.every(v => typeof v === 'string') ? value : null;
  const globs = items?.map(g => g.trim()).filter(Boolean);
  if (!globs?.length) return null;
  try { globs.forEach(globRegExp); } catch { return null; }
  return globs;
}
const maskQuery = value => typeof value === 'string' ? value.replace(/\?[^]*$/, `?${MASK}`) : value;
/** 画面に出す接続先。ホストとパスだけ（ユーザー名・パスワード・クエリ・フラグメントは落とす） */
export function endpointOf(value) {
  if (typeof value !== 'string') return undefined;
  try { const u = new URL(value); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return undefined; }
}
/** MCP 1 件の定義から、画面に出してよい形を作る */
function safeDefinition(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && record(item)) out[key] = Object.fromEntries(Object.keys(item).map(name => [name, MASK]));
    else out[key] = URL_KEYS.has(key) ? maskQuery(item) : item;
  }
  return out;
}
/**
 * 設定ファイルの行に出す本文。**元ファイルの全文ではなく、MCP 登録だけを書き出し直したもの。**
 * `~/.claude.json` は OAuth アカウントやプロジェクト履歴も持つので、全文はクライアントへ送らない。
 */
function renderServers(file, servers) {
  if (path.extname(file) === '.toml') {
    try { return tomlText({ mcp_servers: servers }); } catch { /* TOML に収まらない値は JSON で出す */ }
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}
// scopes: 探す範囲。既定は両方。設定の画面のユーザーの段は ['user'] だけ（作業場所のファイルを混ぜない）
export async function scanContext(settings, { home = os.homedir(), codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex'), claudeHome = process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'), runtime = false, plyServers = null, scopes = ['user', 'directory'] } = {}) {
  const { cwd } = settings;
  // 種類ごと・範囲（user = home / directory = Git ルート〜作業場所）ごとの探し方。形式 1 の { user, directory } も受け付ける
  const plan = scanPlan(settings);
  const disabledNames = new Set(plan.mcp?.disabled ?? []);
  const entries = [], diagnostics = [], searched = [], configs = [], cache = new Map();
  let bytes = 0, operations = 0, limited = false;
  function issue(file, message) { if (diagnostics.length < 100) diagnostics.push({ path: file, message }); }
  function budget() {
    if (++operations > 5000 || bytes >= MAX_TOTAL || entries.length >= MAX_ENTRIES) {
      if (!limited) issue(cwd, t('context.scan.limitReached'));
      limited = true; return false;
    }
    return true;
  }
  async function read(file) {
    if (!budget()) return null;
    const key = pathKey(file);
    if (cache.has(key)) return cache.get(key);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      if (stat.size > MAX_FILE || bytes + stat.size > MAX_TOTAL) { issue(file, t('context.scan.tooLarge')); return null; }
      const handle = await fs.open(file, 'r');
      let body;
      try { const b = Buffer.alloc(MAX_FILE + 1); const r = await handle.read(b, 0, b.length, 0); body = b.subarray(0, r.bytesRead); }
      finally { await handle.close(); }
      if (body.length > MAX_FILE) { issue(file, t('context.scan.tooLarge')); return null; }
      bytes += body.length;
      const result = { text: body.toString('utf8').replace(/^\uFEFF/, ''), real: await fs.realpath(file), bytes: body.length };
      cache.set(key, result); return result;
    } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) issue(file, t('context.scan.fileUnreadable')); return null; }
  }
  async function list(dir) {
    if (!budget()) return [];
    try { return (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) issue(dir, t('context.scan.dirUnreadable')); return []; }
  }
  const ancestors = [];
  let root = cwd;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    ancestors.unshift(dir);
    try { await fs.stat(path.join(dir, '.git')); root = dir; break; } catch (e) { if (e.code !== 'ENOENT') issue(dir, t('context.scan.gitRootFailed')); }
    if (path.dirname(dir) === dir) { ancestors.splice(0, ancestors.length, cwd); break; }
  }
  const exclusions = { user: {}, directory: {} };
  for (const scope of ['user', 'directory']) {
    for (const kind of KINDS) {
      const list = exclusions[scope][kind] = [];
      for (const p of plan[scope].kinds[kind]?.excludePaths ?? []) {
        list.push(p);
        try { list.push(await fs.realpath(p)); } catch {}
      }
    }
  }
  function add(data, file, ctx, { kind, name, status = 'candidate', ...more }) {
    // 外部 MCP は名前でも外せる（同じ設定ファイルの他の登録は残す）
    const excluded = exclusions[ctx.scope][kind].some(p => containsPath(p, file) || containsPath(p, data.real)) || (kind === 'mcp' && disabledNames.has(name));
    const id = digest([kind, pathKey(data.real), ctx.appliesTo ? pathKey(ctx.appliesTo) : '', name].join('\0')).slice(0, 24);
    const same = entries.find(e => e.id === id && e.status !== 'excluded' && !excluded);
    if (same) { if (status === 'shadowed') same.status = status; if (!same.origins.some(o => o.path === file && o.source === ctx.source && o.scope === ctx.scope)) same.origins.push({ path: file, source: ctx.source, scope: ctx.scope }); return same; }
    // root: 足した場所（探す場所を足す）で見つかったとき、その場所。画面が「追加した場所」として分けて出す
    const item = { id, kind, name, path: file, realPath: data.real, scope: ctx.scope, appliesTo: ctx.appliesTo,
      origins: [{ path: file, source: ctx.source, scope: ctx.scope }], status: excluded ? 'excluded' : status,
      owner: 'native', ...(ctx.root ? { root: ctx.root } : {}), ...more };
    entries.push(item); return item;
  }
  // more は行に足す項目（rules の rule / paths / pathsBase）。@参照先にも paths を引き継ぎ、同じ条件でだけ渡す
  async function instruction(file, ctx, status = 'candidate', depth = 0, stack = new Set(), more = {}) {
    const data = await read(file);
    if (!data || !data.text.trim()) return;
    const key = pathKey(data.real);
    if (stack.has(key)) { issue(file, t('context.scan.circularReference')); return; }
    const item = add(data, file, ctx, { kind: 'instruction', name: path.basename(file), status, bytes: data.bytes, hash: digest(data.text), content: data.text, references: [], ...more });
    if (item.status === 'excluded' || item.status === 'shadowed') return;
    // Only standalone @path imports; ambiguous inline imports are reported, not guessed.
    if (ctx.source !== 'claude') return;
    const imports = data.text.replace(/```[^]*?```/g, '').split(/\r?\n/).filter(l => /^\s*@/.test(l));
    for (const line of imports) {
      const match = /^\s*@(?:"([^"]+)"|(\S+))\s*$/.exec(line);
      if (!match) { issue(file, t('context.scan.complexImport')); continue; }
      const ref = match[1] ?? match[2];
      if (/^[a-z]+:\/\//i.test(ref)) { issue(file, t('context.scan.urlImport')); continue; }
      const target = path.resolve(path.dirname(file), /^~[/\\]/.test(ref) ? path.join(home, ref.slice(2)) : ref);
      if (!item.references.includes(target)) item.references.push(target);
      if (depth >= 5) { issue(target, t('context.scan.importDepth')); continue; }
      if (!await read(target)) { issue(target, t('context.scan.importUnreadable')); continue; }
      const { rule, ...inherited } = more;
      await instruction(target, ctx, status === 'conditional' ? 'conditional' : 'candidate', depth + 1, new Set([...stack, key]), inherited);
    }
  }
  /**
   * Claude の rules（`.claude/rules` の下の `.md`。下位フォルダーも見る）。frontmatter の `paths` が無いものは同じ場所の CLAUDE.md と同じ扱い。
   * あるものは status: conditional で、開始時には渡さず instructions_for_path で当たるファイルを扱うときだけ渡す。
   * pathsBase は glob の起点（プロジェクトなら .claude のある場所、ユーザーの rules は null = 会話の作業場所）
   */
  async function rules(dir, ctx, pathsBase, depth = 0) {
    if (!depth) searched.push({ path: dir, kind: 'instruction', ...ctx });
    for (const entry of await list(dir)) {
      const file = path.join(dir, entry.name), md = /\.md$/i.test(entry.name);
      if (entry.isDirectory() || (entry.isSymbolicLink() && !md)) { if (depth < 10) await rules(file, ctx, pathsBase, depth + 1); continue; }
      if (!md) continue;
      const data = await read(file);
      if (!data) continue;
      const match = FRONTMATTER.exec(data.text);
      let meta = null;
      try { meta = match ? yaml(match[1] ?? '', { maxAliasCount: 20, logLevel: 'silent' }) : null; }
      catch { issue(file, t('context.scan.ruleFrontmatter')); continue; }
      const raw = record(meta) ? meta.paths : undefined, paths = raw == null ? null : globList(raw);
      if (raw != null && !paths) { issue(file, t('context.scan.rulePaths')); continue; }
      await instruction(file, ctx, paths ? 'conditional' : 'candidate', 0, new Set(), { rule: true, ...(paths ? { paths, pathsBase } : {}) });
    }
  }
  async function skills(dir, ctx) {
    searched.push({ path: dir, kind: 'skill', ...ctx });
    for (const entry of await list(dir)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const file = path.join(dir, entry.name, 'SKILL.md'), data = await read(file);
      if (!data) continue;
      const match = FRONTMATTER.exec(data.text);
      let meta = {};
      try { if (!match) throw new Error(); meta = yaml(match[1] ?? '', { maxAliasCount: 20, logLevel: 'silent' }); if (!record(meta)) throw new Error(); }
      catch { meta = {}; issue(file, t('context.scan.skillFrontmatter')); }
      const name = typeof meta?.name === 'string' ? meta.name : entry.name;
      // 本文は frontmatter を含めたまま返す。画面が表に起こす項目を絞らないため
      add(data, file, ctx, { kind: 'skill', name, description: typeof meta?.description === 'string' ? meta.description : '', hash: digest(data.text),
        bytes: data.bytes, content: data.text,
        ...(runtime ? { metadata: meta } : {}), extensions: Object.keys(meta ?? {}).filter(k => !['name', 'description', 'license', 'compatibility', 'metadata'].includes(k)) });
    }
  }
  async function mcp(file, ctx, select) {
    searched.push({ path: file, kind: 'mcp', ...ctx });
    const data = await read(file);
    if (!data) return;
    let config;
    try { config = path.extname(file) === '.toml' ? toml(data.text) : JSON.parse(data.text); }
    catch { issue(file, t('context.scan.mcpParse')); return; }
    if (!record(config)) { issue(file, t('context.scan.mcpInvalid')); return; }
    const servers = select(config);
    if (servers == null) return;
    if (!record(servers)) { issue(file, t('context.scan.mcpServersInvalid')); return; }
    const shown = {};
    for (const [name, value] of Object.entries(servers)) {
      if (!budget()) break;
      if (!record(value)) { issue(file, t('context.scan.mcpServerInvalid')); continue; }
      shown[name] = safeDefinition(value);
      add(data, file, ctx, { kind: 'mcp', name, status: value.enabled === false || value.disabled === true ? 'disabled' : 'candidate',
        ...(runtime ? { definition: value, hash: digest(JSON.stringify(value)) } : {}), transport: typeof value.command === 'string' ? 'stdio' : typeof (value.url ?? value.baseUrl) === 'string' ? 'http' : 'unknown',
        // 起動の形だけ。env と url は値を返さず、キーの有無だけ返す
        ...(typeof value.command === 'string' ? { command: value.command } : { endpoint: endpointOf(value.url ?? value.baseUrl) }),
        ...(Array.isArray(value.args) ? { args: value.args.filter(a => typeof a === 'string' || typeof a === 'number').map(String) } : {}),
        ...(record(value.env) ? { envKeys: Object.keys(value.env) } : {}) });
    }
    // 設定ファイル自身も画面の行になる（登録はその子）。bytes は書き出した本文の長さで、元ファイルの大きさではない
    if (!configs.some(c => pathKey(c.path) === pathKey(file))) {
      const body = renderServers(file, shown);
      configs.push({ path: file, realPath: data.real, source: ctx.source, scope: ctx.scope, bytes: Buffer.byteLength(body), content: body });
    }
  }
  // kinds はこの (base, source) で探す種類。種類ごとに探す形式が違うので、呼ぶ側が絞って渡す
  async function scanBase(base, source, scope, kinds, custom = false) {
    const spec = { kinds };
    const ctx = { source, scope, appliesTo: scope === 'user' ? null : custom ? cwd : base, ...(custom ? { root: base } : {}) };
    const user = scope === 'user';
    if (source === 'common') {
      if (spec.kinds.includes('instruction') && (!user || custom)) {
        searched.push({ path: base, kind: 'instruction', ...ctx });
        await instruction(path.join(base, 'AGENTS.md'), ctx);
      }
      if (spec.kinds.includes('skill')) await skills(path.join(base, '.agents', 'skills'), ctx);
      return;
    }
    const configDir = user && !custom ? source === 'codex' ? codexHome : claudeHome : path.join(base, `.${source}`);
    if (spec.kinds.includes('instruction')) {
      const dir = user && !custom ? configDir : base;
      searched.push({ path: dir, kind: 'instruction', ...ctx });
      if (source === 'codex') {
        const override = await read(path.join(dir, 'AGENTS.override.md'));
        await instruction(path.join(dir, 'AGENTS.override.md'), ctx);
        await instruction(path.join(dir, 'AGENTS.md'), ctx, override?.text.trim() ? 'shadowed' : 'candidate');
      } else if (source === 'claude') {
        await instruction(path.join(dir, 'CLAUDE.md'), ctx);
        if (!user || custom) { await instruction(path.join(configDir, 'CLAUDE.md'), ctx); await instruction(path.join(base, 'CLAUDE.local.md'), ctx); }
        await rules(path.join(configDir, 'rules'), ctx, user && !custom ? null : base);
      }
    }
    if (spec.kinds.includes('skill')) {
      await skills(path.join(configDir, 'skills'), ctx);
      if (source === 'codex' && !custom) await skills(path.join(user ? home : base, '.agents', 'skills'), ctx);
    }
    if (spec.kinds.includes('mcp')) {
      if (source === 'codex') await mcp(path.join(configDir, 'config.toml'), ctx, v => v.mcp_servers);
      else if (source === 'claude' && user && !custom) {
        await mcp(path.join(home, '.claude.json'), ctx, v => v.mcpServers);
      } else {
        await mcp(path.join(base, '.mcp.json'), ctx, v => v.mcpServers);
        if (source === 'claude' && !custom && base === cwd) await mcp(path.join(home, '.claude.json'), ctx,
          v => Object.entries(v.projects ?? {}).find(([p]) => pathKey(p) === pathKey(cwd))?.[1]?.mcpServers);
      }
    }
  }
  for (const scope of ['user', 'directory'].filter(s => scopes.includes(s))) {
    const spec = plan[scope];
    // 探す形式は種類ごと。並びは種類の順に初めて出てきた順（形式 1 は全種類で同じ並び）
    const sources = [...new Set(KINDS.flatMap(k => spec.kinds[k]?.sources ?? []))];
    for (const source of sources) {
      const kinds = KINDS.filter(k => spec.kinds[k]?.sources.includes(source));
      for (const base of scope === 'user' ? [home] : ancestors) await scanBase(base, source, scope, kinds);
    }
    // 足した場所（探す場所を足す）は種類ごと。その種類の、この範囲の探す形式で、プロジェクトと同じ置き方を探す
    const roots = [...new Set(KINDS.flatMap(k => spec.kinds[k] ? spec.roots[k] ?? [] : []))];
    for (const base of roots) {
      for (const source of SOURCES) {
        const kinds = KINDS.filter(k => spec.kinds[k]?.sources.includes(source) && (spec.roots[k] ?? []).includes(base));
        if (kinds.length) await scanBase(base, source, scope, kinds, true);
      }
    }
  }
  // Pleiad 自身の登録（core/ply-mcp.mjs）。ユーザー全体に効き、同名のネイティブ登録より優先する
  if (plyServers?.servers?.length && plan.user.kinds.mcp && scopes.includes('user')) {
    const file = plyServers.file, ctx = { source: 'ply', scope: 'user', appliesTo: null }, shown = {};
    searched.push({ path: file, kind: 'mcp', ...ctx });
    for (const { name, definition } of plyServers.servers) {
      if (!budget()) break;
      shown[name] = safeDefinition(definition);
      add({ real: file }, file, ctx, { kind: 'mcp', name, status: definition.enabled === false ? 'disabled' : 'candidate', auth: definition.auth,
        ...(runtime ? { definition, hash: digest(JSON.stringify(definition)) } : {}), transport: definition.transport === 'stdio' ? 'stdio' : 'http',
        ...(definition.url ? { endpoint: endpointOf(definition.url) } : {}),
        ...(definition.command ? { command: definition.command } : {}), ...(Array.isArray(definition.args) ? { args: definition.args } : {}),
        ...(definition.envKeys ? { envKeys: definition.envKeys } : {}) });
    }
    const body = JSON.stringify({ mcpServers: shown }, null, 2);
    configs.push({ path: file, realPath: file, source: 'ply', scope: 'user', bytes: Buffer.byteLength(body), content: body });
    const preferred = new Set(entries.filter(e => e.kind === 'mcp' && e.origins[0].source === 'ply' && e.status === 'candidate').map(e => e.name));
    for (const e of entries) if (e.kind === 'mcp' && e.origins[0].source !== 'ply' && e.status === 'candidate' && preferred.has(e.name)) { e.status = 'shadowed'; e.shadowedBy = 'ply'; }
  }
  // 同じ名前の外部 MCP が複数あるときは 1 つだけ使う。選んだ定義（prefer: 名前 → 設定ファイル）があればそれ、無ければ先に見つかったもの
  const byName = new Map();
  for (const e of entries) if (e.kind === 'mcp' && e.status === 'candidate') byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    const want = plan.mcp?.prefer?.[name];
    const chosen = (want && list.find(e => e.origins.some(o => pathKey(o.path) === pathKey(want)))) ?? list[0];
    for (const e of list) if (e !== chosen) { e.status = 'shadowed'; e.shadowedBy = 'choice'; }
  }
  for (const item of entries) {
    if (item.status !== 'candidate') continue;
    item.conflicts = entries.filter(e => e !== item && e.status === 'candidate' && e.kind === item.kind &&
      (item.kind === 'instruction' ? e.hash === item.hash : e.name === item.name)).map(e => e.id);
    if (item.kind === 'instruction') item.conflictReason = t('context.scan.conflictInstruction');
    else item.conflictReason = t('context.scan.conflictName');
  }
  // home と root は画面がツリーの根（「ユーザー」「この場所」）を作るために使う
  return { previewOnly: true, owner: 'native', cwd, root, home, scannedAt: new Date().toISOString(), entries, searched, configs, diagnostics, limited,
    // i18n-dynamic: context.scan.limitations.
    limitations: ['preview', 'excluded', 'unsupported', 'rules', 'directories', 'mcp', 'ply'].map(k => t(`context.scan.limitations.${k}`)) };
}

/** 入力欄「/」の候補。コンテキスト画面と同じ探索結果から作る（docs/design-system.md §2.4） */
export function skillList(report) {
  const label = (entry) => {
    if (entry.scope === 'user' || entry.origins?.some(o => o.scope === 'user')) return t('context.scan.fromUser');
    if (entry.appliesTo) return t('context.scan.fromProject');
    // 配置元（.agents / .claude / .codex …）が分かるものはその名前を出す
    for (const origin of entry.origins ?? []) {
      const dir = origin.path.split(/[\\/]/).find(part => /^\.[a-z0-9_-]+$/i.test(part));
      if (dir) return dir === '.agents' ? t('context.scan.fromCommon') : dir.slice(1);
    }
    return t('context.scan.fromProject');
  };
  const byName = new Map();
  for (const e of report.entries ?? []) {
    if (e.kind !== 'skill' || e.status !== 'candidate') continue;
    // 同名は先頭が候補。隠された置き場所の文は出さない
    if (byName.has(e.name)) continue;
    byName.set(e.name, {
      name: e.name,
      description: e.description ?? String(e.content ?? '').replace(/^---[\s\S]*?---\r?\n?/, '')
        .replace(/\s+/g, ' ').trim().slice(0, 120),
      hint: [
        typeof e?.metadata?.['argument-hint'] === 'string' && e.metadata['argument-hint'] ? e.metadata['argument-hint'] : '',
        Array.isArray(e?.extensions?.arguments) && e.extensions.arguments.some(a => !a?.optional)
          ? t('context.scan.requiredArgs') : '',
      ].filter(Boolean).join(' '),
      from: label(e),
    });
  }
  return [...byName.values()];
}
