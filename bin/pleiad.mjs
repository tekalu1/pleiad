#!/usr/bin/env node
// pleiad: 走っている Pleiad の操作の一覧（core/ops/）を、ターミナルから使う CLI（ADR 0083）。Node の組み込みだけで書く薄いクライアント。
//
//   pleiad status                           つながり先の版・起動時刻・走っている作業の数
//   pleiad sessions list|get|read|rename|status …   サブコマンドは操作の一覧を実行時にサーバーから取って作る（id の . が区切り）
//   pleiad settings list|get|schema …
//   pleiad ops                              使える操作の一覧
//   pleiad call <op> [--args '{…}']         何でも呼べる逃げ道
//   pleiad mcp                              同じ一覧を stdio の MCP として出す（外の AI 向け）
//
// つなぎ先: 環境変数 PLEIAD_CONTROL_URL / PLEIAD_CONTROL_TOKEN（Pleiad が会話のシェルに渡す。その会話に束縛される）→
//           <AGENT_HOST_DATA か ~/.agent-host>/control.json（会話に束縛されない）。居なければ終了コード 3。
// 終了コード: 0 成功 / 2 入力の誤り / 3 Pleiad が起動していない / 4 拒否または画面での操作が必要 / 5 その他 /
//           6 受け付けて承認待ち（会話の承認カードを出した。まだ変わっていない。結果は後で会話に届く。ADR 0088）。--json で結果を JSON にする。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { callMcpTool, mcpTools } from '../core/ops/surfaces/mcp.mjs';

export const EXIT = { ok: 0, usage: 2, notRunning: 3, refused: 4, other: 5, pending: 6 };
const REFUSED = new Set(['NEEDS_UI', 'NEEDS_APPROVAL', 'READ_ONLY_MODE', 'HOST_SCREEN_ONLY', 'DENIED', 'STALE', 'SETTING_READ_ONLY']);
const USAGE_ERRORS = new Set(['INVALID', 'NOT_FOUND', 'SESSION_NOT_FOUND', 'MESSAGE_NOT_FOUND', 'SETTING_NOT_FOUND', 'TASK_NOT_FOUND', 'WORKTREE_NOT_FOUND', 'ENDPOINT_NOT_FOUND', 'DEVICE_NOT_FOUND', 'HOOK_NOT_FOUND', 'NOT_GIT']);
export const exitCodeOf = (code) => (REFUSED.has(code) ? EXIT.refused : USAGE_ERRORS.has(code) ? EXIT.usage : EXIT.other);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOT_RUNNING_TIMEOUT_MS = 5000;

// ---- 文（CLI 自身の固定文。辞書 web/locales/<言語>/agent.json の cli.*。Node の組み込みだけで読む）

export function loadTexts(lang) {
  const read = (l) => { try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'web', 'locales', l, 'agent.json'), 'utf8')).cli ?? {}; } catch { return {}; } };
  const own = read(lang), fallback = read('en');
  // キーは t('cli.<名前>')（agent 名前空間）。辞書の cli ブロックから引く
  return (key, params = {}) => String(own[key.replace(/^cli\./, '')] ?? fallback[key.replace(/^cli\./, '')] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ''));
}

export function langOf(env = process.env, given) {
  const tag = String(given ?? env.AGENT_HOST_LOCALE ?? env.LC_ALL ?? env.LANG ?? (() => { try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; } })()).toLowerCase();
  return tag.startsWith('ja') ? 'ja' : 'en';
}

// ---- つなぎ先

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** { origin, token, bound } か、無ければ null。env が先（会話に束縛）、次に control.json（束縛なし） */
export function findConnection(env = process.env) {
  if (env.PLEIAD_CONTROL_URL && env.PLEIAD_CONTROL_TOKEN) return { origin: env.PLEIAD_CONTROL_URL.replace(/\/+$/, ''), token: env.PLEIAD_CONTROL_TOKEN, bound: true };
  const dir = env.AGENT_HOST_DATA || path.join(os.homedir(), '.agent-host');
  try {
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'control.json'), 'utf8'));
    if (typeof file.origin !== 'string' || typeof file.cliToken !== 'string' || !Number.isInteger(file.pid) || !pidAlive(file.pid)) return null;
    return { origin: file.origin.replace(/\/+$/, ''), token: file.cliToken, bound: false };
  } catch { return null; }
}

class Unreachable extends Error {}

/** サーバーへ 1 回。ネットワークの失敗・401 は Unreachable（起動していない扱い）。返りは { status, body } */
async function request(conn, method, pathAndQuery, { body, lang, via } = {}) {
  let res;
  try {
    res = await fetch(conn.origin + pathAndQuery, {
      method,
      headers: { authorization: `Bearer ${conn.token}`, 'x-pleiad-locale': lang, ...(via ? { 'x-pleiad-via': via } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // 操作は承認を待たずに返る（承認待ちは pending。ADR 0088）ので、ほかの Pleiad の MCP と同じ 60 秒で切る
      signal: AbortSignal.timeout(method === 'GET' ? NOT_RUNNING_TIMEOUT_MS : 60_000),
    });
  } catch (e) { throw new Unreachable(String(e?.message ?? e)); }
  if (res.status === 401) throw new Unreachable('401');
  let json = null;
  try { json = await res.json(); } catch { /* 下で其の他 */ }
  return { status: res.status, body: json };
}

export const fetchCatalog = async (conn, lang, surface = 'cli') => {
  const r = await request(conn, 'GET', `/api/ops${surface === 'mcp' ? '?surface=mcp' : ''}`, { lang });
  if (!r.body?.ok) throw new Error(r.body?.error ?? `HTTP ${r.status}`);
  return r.body.result;
};
export const invokeOp = (conn, id, args, lang, via) => request(conn, 'POST', `/api/ops/${encodeURIComponent(id)}`, { body: args, lang, via })
  .then((r) => (r.body && typeof r.body === 'object' ? r.body : { ok: false, code: 'OTHER', error: `HTTP ${r.status}` }));

// ---- 引数の解釈

const kebab = (s) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const positionalOf = (entry) => [].concat(entry.cli?.positional ?? []);

export class UsageError extends Error {}

function coerce(raw, schema, name) {
  // 型の無い入力（設定の value など、何でも受ける欄）は JSON として読み、読めなければ文字列のまま（true・12・{"a":1}・en）
  if (schema?.type === undefined && !schema?.enum && !schema?.anyOf && !schema?.oneOf) { try { return JSON.parse(String(raw)); } catch { return String(raw); } }
  const type = [].concat(schema?.type ?? 'string').find((t) => t !== 'null') ?? 'string';
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    if (raw === '' || !Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) throw new UsageError(`--${kebab(name)}: ${raw}`);
    return n;
  }
  if (type === 'boolean') { if (raw === true || raw === 'true') return true; if (raw === 'false') return false; throw new UsageError(`--${kebab(name)}: ${raw}`); }
  if (type === 'array') { const t = String(raw).trim(); if (t.startsWith('[')) { try { return JSON.parse(t); } catch { throw new UsageError(`--${kebab(name)}: ${raw}`); } } return t ? t.split(',') : []; }
  if (type === 'object') { try { return JSON.parse(String(raw)); } catch { throw new UsageError(`--${kebab(name)}: ${raw}`); } }
  return String(raw);
}

/** コマンドの残りの引数を、操作の入力にする。位置引数は cli.positional の順、残りは --<名前>（kebab・camel のどちらでも）、--args は JSON を土台に重ねる */
export function parseArgs(entry, rest) {
  const props = entry.input?.properties ?? {};
  const out = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === '--') { positional.push(...rest.slice(i + 1)); break; }
    if (!tok.startsWith('--')) { positional.push(tok); continue; }
    const eq = tok.indexOf('=');
    const flag = eq < 0 ? tok.slice(2) : tok.slice(2, eq);
    if (flag === 'args') {
      const raw = eq >= 0 ? tok.slice(eq + 1) : rest[++i];
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new UsageError('--args'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError('--args');
      Object.assign(out, parsed);
      continue;
    }
    const name = Object.hasOwn(props, flag) ? flag : camel(flag);
    if (!Object.hasOwn(props, name)) throw new UsageError(`--${flag}`);
    const type = [].concat(props[name].type ?? 'string')[0];
    let raw;
    if (eq >= 0) raw = tok.slice(eq + 1);
    else if (type === 'boolean') raw = rest[i + 1] === 'true' || rest[i + 1] === 'false' ? rest[++i] : true;
    else { if (i + 1 >= rest.length) throw new UsageError(`--${flag}`); raw = rest[++i]; }
    out[name] = coerce(raw, props[name], name);
  }
  const names = positionalOf(entry);
  if (positional.length > names.length) throw new UsageError(positional[names.length]);
  positional.forEach((value, i) => { out[names[i]] = coerce(value, props[names[i]], names[i]); });
  return out;
}

/** コマンドの語（先頭から）に当たる操作。いちばん長く合うもの。残りの語を rest で返す */
export function matchCommand(catalog, words) {
  let best = null;
  for (const entry of catalog) {
    const p = entry.cli?.path;
    if (!p?.length || p.length > words.length || !p.every((w, i) => w === words[i])) continue;
    if (!best || p.length > best.entry.cli.path.length) best = { entry, rest: words.slice(p.length) };
  }
  return best;
}

// ---- 表示

const cell = (v) => (v === null || v === undefined ? '-' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 人が読む形。スカラーは key: value、オブジェクトの配列は表、入れ子は JSON */
export function render(value, indent = '') {
  if (value === null || value === undefined) return `${indent}-`;
  if (typeof value !== 'object') return `${indent}${value}`;
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}(none)`;
    if (value.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
      const cols = [...new Set(value.flatMap((v) => Object.keys(v).filter((k) => v[k] === null || typeof v[k] !== 'object')))];
      const rows = value.map((v) => cols.map((c) => clip(cell(v[c]), 60)));
      const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
      const line = (cells) => indent + cells.map((x, i) => x.padEnd(widths[i])).join('  ').trimEnd();
      return [line(cols), ...rows.map(line)].join('\n');
    }
    return value.map((v) => `${indent}${cell(v)}`).join('\n');
  }
  return Object.entries(value).map(([k, v]) => {
    if (v && typeof v === 'object') return `${indent}${k}:\n${render(v, `${indent}  `)}`;
    return `${indent}${k}: ${cell(v)}`;
  }).join('\n');
}

function commandHelp(entry, t) {
  const props = entry.input?.properties ?? {};
  const required = new Set(entry.input?.required ?? []);
  const names = positionalOf(entry);
  const lines = [`pleiad ${entry.cli.path.join(' ')}${names.map((n) => ` <${n}>`).join('')}${Object.keys(props).length > names.length ? ' [options]' : ''}`, `  ${entry.summary}`, `  (${entry.id}, ${entry.risk})`];
  for (const [name, schema] of Object.entries(props)) {
    const type = schema.type === undefined && !schema.enum && !schema.anyOf && !schema.oneOf ? 'json' : [].concat(schema.type ?? 'string')[0];
    const choices = schema.enum ? ` {${schema.enum.join('|')}}` : '';
    lines.push(`  ${names.includes(name) ? `<${name}>` : `--${kebab(name)}`} ${type}${choices}${required.has(name) ? ` (${t('cli.required')})` : ''}  ${schema.description ?? ''}`.trimEnd());
  }
  return lines.join('\n');
}

function overview(catalog, t, conn) {
  const lines = [t('cli.usage'), '', t('cli.commands')];
  const rows = catalog.filter((e) => e.cli?.path?.length).sort((a, b) => a.cli.path.join(' ').localeCompare(b.cli.path.join(' ')));
  const width = Math.max(0, ...rows.map((e) => e.cli.path.join(' ').length));
  for (const e of rows) lines.push(`  ${e.cli.path.join(' ').padEnd(width)}  ${e.summary}`);
  lines.push(`  ${'ops'.padEnd(width)}  ${t('cli.opsSummary')}`, `  ${'call <op>'.padEnd(width)}  ${t('cli.callSummary')}`, `  ${'mcp'.padEnd(width)}  ${t('cli.mcpSummary')}`, '', t('cli.flags'));
  if (conn) lines.push('', t('cli.connected', { origin: conn.origin, bound: conn.bound ? t('cli.boundYes') : t('cli.boundNo') }));
  return lines.join('\n');
}

// ---- pleiad mcp（stdio の MCP）

const offlineTexts = {
  instructions: 'Pleiad is not running. Start Pleiad (the desktop app, or npm start in the repository) and these tools will update.',
  listOps: 'List the operations available in Pleiad (Pleiad is not running now).',
  listOpsId: 'An operation id.',
  listOpsPrefix: 'An id prefix.',
  callOp: 'Call a Pleiad operation (Pleiad is not running now).',
  callOpOp: 'The operation id.',
  callOpArgs: 'The operation input.',
  notFound: 'Not found: {{id}}',
};

export async function runMcp({ env = process.env, input = process.stdin, output = process.stdout, lang = langOf(env), pollMs = 3000 } = {}) {
  let conn = null, catalog = null, texts = offlineTexts, revision = null;
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  const t = loadTexts(lang);

  /** つなぎ直す。状態（つながった・切れた・一覧の版）が変わったら true */
  async function refresh() {
    const before = `${conn?.origin ?? ''} ${revision ?? ''}`;
    try {
      conn = findConnection(env);
      if (!conn) throw new Unreachable('none');
      const result = await fetchCatalog(conn, lang, 'mcp');
      catalog = result.ops; texts = result.texts; revision = result.revision;
    } catch { conn = null; catalog = null; texts = offlineTexts; revision = null; }
    return before !== `${conn?.origin ?? ''} ${revision ?? ''}`;
  }

  const tools = () => mcpTools({ catalog: catalog ?? [], texts });
  const down = () => ({ isError: true, text: JSON.stringify({ error: t('cli.notRunning'), code: 'NOT_RUNNING' }) });

  async function handle(m) {
    if (m.method === 'initialize') {
      await refresh();
      return { protocolVersion: m.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'pleiad', version: '1.0.0' }, instructions: texts.instructions };
    }
    if (m.method === 'ping') return {};
    if (m.method === 'tools/list') { await refresh(); return { tools: tools() }; }
    if (m.method === 'tools/call') {
      if (!conn || !catalog) { await refresh(); if (!conn || !catalog) { const d = down(); return { isError: true, content: [{ type: 'text', text: d.text }] }; } }
      try {
        const out = await callMcpTool({ catalog, texts, name: m.params?.name, args: m.params?.arguments ?? {}, invoke: (id, args) => invokeOp(conn, id, args, lang, 'mcp-stdio') });
        return { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) };
      } catch (e) {
        if (e instanceof Unreachable) { if (await refresh()) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); const d = down(); return { isError: true, content: [{ type: 'text', text: d.text }] }; }
        return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
      }
    }
    return undefined;
  }

  await refresh();
  // 起動していなかったものが後から起動したら（またはその逆・一覧が変わったら）、一覧を出し直すよう知らせる
  const timer = setInterval(() => { refresh().then((changed) => { if (changed) write({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }); }).catch(() => {}); }, pollMs);
  timer.unref();

  const rl = readline.createInterface({ input });
  for await (const line of rl) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') continue;
    if (m.id === undefined) continue;
    try {
      const result = await handle(m);
      if (result === undefined) write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      else write({ jsonrpc: '2.0', id: m.id, result });
    } catch (e) { write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message ?? e) } }); }
  }
  clearInterval(timer);
}

// ---- 本体

export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const flags = { json: false, help: false, lang: undefined };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--lang') flags.lang = argv[++i];
    else if (a.startsWith('--lang=')) flags.lang = a.slice(7);
    else words.push(a);
  }
  const lang = langOf(env, flags.lang);
  const t = loadTexts(lang);
  const out = (text) => stdout.write(`${text}\n`);
  const err = (text) => stderr.write(`${text}\n`);

  if (words[0] === 'mcp') { await runMcp({ env, lang }); return EXIT.ok; }

  const conn = findConnection(env);
  const notRunning = () => { err(t('cli.notRunning')); err(t('cli.howToStart')); return EXIT.notRunning; };
  if (!words.length && (flags.help || !conn)) {
    // つながらなくても使い方は出す。一覧（サブコマンド）は起動しているときだけ分かる
    out(conn ? t('cli.usage') : [t('cli.usage'), '', t('cli.commands'), `  status, sessions, settings, ops, call, mcp  (${t('cli.listedWhenRunning')})`, '', t('cli.flags')].join('\n'));
    return EXIT.ok;
  }
  if (!conn) return notRunning();

  let result;
  try { result = await fetchCatalog(conn, lang); }
  catch (e) { if (e instanceof Unreachable) return notRunning(); err(String(e?.message ?? e)); return EXIT.other; }
  const catalog = result.ops;

  if (!words.length) { out(overview(catalog, t, conn)); return EXIT.ok; }

  if (words[0] === 'ops') {
    if (flags.json) out(JSON.stringify(catalog.map(({ id, summary, risk, scope, cli }) => ({ id, summary, risk, scope, cli })), null, 2));
    else out(render(catalog.map((e) => ({ id: e.id, risk: e.risk, command: e.cli?.path?.join(' ') ?? '-', summary: e.summary }))));
    return EXIT.ok;
  }

  let id, args, entry = null;
  try {
    if (words[0] === 'call') {
      id = words[1];
      if (!id) { err(t('cli.callUsage')); return EXIT.usage; }
      entry = catalog.find((e) => e.id === id) ?? { id, input: { properties: {} }, cli: { path: [] } };
      if (flags.help && catalog.some((e) => e.id === id)) { out(JSON.stringify({ id: entry.id, summary: entry.summary, risk: entry.risk, input: entry.input }, null, 2)); return EXIT.ok; }
      // call は引数を --args の JSON か、入力の名前の --<名前> で受ける（位置引数は取らない）
      args = parseArgs({ ...entry, cli: { path: [] } }, words.slice(2));
    } else {
      const hit = matchCommand(catalog, words);
      if (!hit) {
        const under = catalog.filter((e) => e.cli?.path?.[0] === words[0]);
        if (under.length) { out(under.map((e) => commandHelp(e, t)).join('\n\n')); return flags.help ? EXIT.ok : EXIT.usage; }
        err(t('cli.unknownCommand', { command: words.join(' ') }));
        return EXIT.usage;
      }
      entry = hit.entry; id = entry.id;
      if (flags.help) { out(commandHelp(entry, t)); return EXIT.ok; }
      args = parseArgs(entry, hit.rest);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(t('cli.badArgument', { detail: e.message }));
    if (entry?.cli?.path?.length) err(commandHelp(entry, t));
    return EXIT.usage;
  }

  let r;
  try { r = await invokeOp(conn, id, args, lang); }
  catch (e) { if (e instanceof Unreachable) return notRunning(); err(String(e?.message ?? e)); return EXIT.other; }
  // 承認待ちは結果（requestId と文）を出して 6
  if (r.ok && r.pending) { out(flags.json ? JSON.stringify(r.result, null, 2) : r.result?.message ?? render(r.result)); return EXIT.pending; }
  if (r.ok) { out(flags.json ? JSON.stringify(r.result, null, 2) : render(r.result)); return EXIT.ok; }
  if (flags.json) out(JSON.stringify({ ok: false, code: r.code, error: r.error, ...(r.issues ? { issues: r.issues } : {}) }, null, 2));
  else {
    err(`${r.error ?? r.code}`);
    for (const issue of r.issues ?? []) err(`  ${issue.path || '(root)'}: ${issue.message}`);
  }
  return exitCodeOf(r.code);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`${e?.stack ?? e}\n`); process.exitCode = EXIT.other; });
}
