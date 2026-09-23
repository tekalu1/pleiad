// Native registrations only. Reading/saving never starts a server or a turn.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'smol-toml';
import { scanDirectory } from './context-settings.mjs';
import { t } from './i18n.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const LIMIT = 1024 * 1024;

// Keep unrelated TOML text (including comments) when the server has its own tables.
// Inline/dotted definitions fall back to serialization, explicitly disclosed in the UI.
function renderToml(text, config, name, value) {
  const expected = { ...config, mcp_servers: { ...config.mcp_servers, [name]: value } };
  const blocks = [];
  for (const match of text.matchAll(/^\s*\[[^\r\n]+\][^\r\n]*(?:\r?\n|$)/gm)) {
    try {
      parse(text.slice(0, match.index)); // Reject apparent headers inside multiline strings.
      const header = parse(match[0]);
      blocks.push({ start: match.index, target: record(header.mcp_servers) && own(header.mcp_servers, name) });
    } catch {}
  }
  let next = '', offset = 0;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].target) continue;
    next += text.slice(offset, blocks[i].start);
    offset = blocks[i + 1]?.start ?? text.length;
  }
  next += text.slice(offset);
  next = `${next.trimEnd()}\n\n${stringify({ mcp_servers: { [name]: value } })}`.trimStart();
  try { if (isDeepStrictEqual(parse(next), expected)) return { text: next, reformatsFile: false }; } catch {}
  return { text: stringify(expected), reformatsFile: true };
}

export function createMcpConfig({ home = os.homedir(), codexHome = process.env.CODEX_HOME ?? path.join(home, '.codex') } = {}) {
  let writes = Promise.resolve();
  async function target(args) {
    if (!['claude', 'codex'].includes(args?.format) || !['user', 'directory'].includes(args?.scope)) throw new Error(t('mcp.config.target'));
    const cwd = await scanDirectory(args.cwd);
    const file = args.format === 'codex'
      ? path.join(args.scope === 'user' ? codexHome : path.join(cwd, '.codex'), 'config.toml')
      : args.scope === 'user' ? path.join(home, '.claude.json') : path.join(cwd, '.mcp.json');
    return { cwd, path: file, format: args.format, scope: args.scope };
  }
  async function read(args) {
    const info = await target(args);
    let text = '', real = info.path, mode = 0o600, exists = false;
    try {
      real = await fs.realpath(info.path);
      const handle = await fs.open(real, 'r');
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > LIMIT) throw new Error();
        const buffer = Buffer.alloc(LIMIT + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > LIMIT) throw new Error();
        text = buffer.subarray(0, bytesRead).toString('utf8'); mode = stat.mode & 0o777; exists = true;
      } finally { await handle.close(); }
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(t('mcp.config.unreadable'));
      // A dangling link is not a missing registration file; never replace the link.
      const link = await fs.lstat(info.path).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (link) throw new Error(t('mcp.config.link'));
    }
    let config;
    try { config = exists ? info.format === 'codex' ? parse(text.replace(/^\uFEFF/, '')) : JSON.parse(text.replace(/^\uFEFF/, '')) : {}; }
    catch { throw new Error(t('mcp.config.syntax')); }
    const key = info.format === 'codex' ? 'mcp_servers' : 'mcpServers';
    if (!record(config) || (own(config, key) && !record(config[key]))) throw new Error(t('mcp.config.format'));
    const servers = config[key] ?? {};
    return { info, real, text, config, key, servers, mode, revision: exists ? hash(text) : 'missing' };
  }
  async function list(args) {
    await writes.catch(() => {});
    const data = await read(args);
    return { ...data.info, revision: data.revision, servers: Object.keys(data.servers).sort() };
  }
  async function get(args) {
    await writes.catch(() => {});
    const data = await read(args);
    if (typeof args.name !== 'string' || !own(data.servers, args.name) || !record(data.servers[args.name])) throw new Error(t('mcp.config.notFound'));
    return { ...data.info, revision: data.revision, name: args.name, value: data.servers[args.name],
      reformatsFile: data.info.format === 'codex' && renderToml(data.text, data.config, args.name, data.servers[args.name]).reformatsFile };
  }
  function save(args) {
    const run = writes.catch(() => {}).then(async () => {
      const { name, value, revision, mode: operation } = args ?? {};
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || ['__proto__', 'constructor', 'prototype', 'host', 'ply'].includes(name)) throw new Error(t('mcp.config.name'));
      if (!record(value) || Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error(t('mcp.config.definition'));
      const stdio = typeof value.command === 'string' && value.command.trim();
      const endpoint = value.url;
      const http = typeof endpoint === 'string' && /^https?:\/\//.test(endpoint);
      if ((!stdio && !http) || (stdio && own(value, 'url')) || (http && own(value, 'command'))) throw new Error(t('mcp.config.transport'));
      if (own(value, 'args') && (!Array.isArray(value.args) || !value.args.every(v => typeof v === 'string'))) throw new Error(t('mcp.config.args'));
      if (own(value, 'env') && (!record(value.env) || !Object.values(value.env).every(v => typeof v === 'string'))) throw new Error(t('mcp.config.env'));
      if (!['add', 'edit'].includes(operation)) throw new Error(t('mcp.config.operation'));
      const data = await read(args);
      const definition = data.info.format === 'claude' ? { type: stdio ? 'stdio' : 'http', ...value } : value;
      if (data.info.format === 'claude' && (stdio ? definition.type !== 'stdio' : !['http', 'sse'].includes(definition.type))) throw new Error(t('mcp.config.typeMismatch'));
      if (revision !== data.revision) throw new Error(t('mcp.config.changed'));
      if (own(data.servers, name) !== (operation === 'edit')) throw new Error(operation === 'add' ? t('mcp.config.exists') : t('mcp.config.notFound'));
      const rendered = data.info.format === 'codex' ? renderToml(data.text, data.config, name, definition)
        : { text: JSON.stringify({ ...data.config, [data.key]: { ...data.servers, [name]: definition } }, null, 2) + '\n', reformatsFile: false };
      if (rendered.reformatsFile && args.allowReformat !== true) throw new Error(t('mcp.config.reformat'));
      if (Buffer.byteLength(rendered.text) > LIMIT) throw new Error(t('mcp.config.tooLarge'));
      await fs.mkdir(path.dirname(data.real), { recursive: true });
      const tmp = `${data.real}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(tmp, rendered.text, { encoding: 'utf8', mode: data.mode, flag: 'wx' });
        const current = await read(args);
        if (current.revision !== revision || current.real !== data.real) throw new Error(t('mcp.config.changedReload'));
        await fs.rename(tmp, data.real);
      } finally { await fs.rm(tmp, { force: true }); }
      return { ...data.info, name, revision: hash(rendered.text), reformatsFile: rendered.reformatsFile };
    });
    writes = run;
    return run;
  }
  // Snapshot registrations without starting them or changing native files.
  // Directory entries override user entries; Codex wins within each scope.
  async function runtimeServers(cwd) {
    await writes.catch(() => {});
    const servers = {};
    for (const scope of ['user', 'directory']) {
      for (const format of ['claude', 'codex']) {
        const data = await read({ cwd, scope, format });
        for (const [name, value] of Object.entries(data.servers)) {
          if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(name) || ['__proto__', 'constructor', 'prototype', 'host', 'ply'].includes(name)) continue;
          servers[name] = { format, value };
        }
      }
    }
    return servers;
  }
  return { list, get, save, runtimeServers };
}
