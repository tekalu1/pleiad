import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { FRONTMATTER, scanContext } from './context-scan.mjs';
import { DEFAULT_OWNERS, KINDS, containsPath, legacyPlan, matchesGlobs, pathKey } from './context-settings.mjs';
import { t, agentT } from './i18n.mjs';

export const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const managed = policy => Object.values(policy?.owners ?? {}).includes('ply');
/**
 * このバックエンドが、この担当の組み合わせで Pleiad のコンテキスト（ply_context）を受け取れないなら、その理由。受け取れるなら null。
 * capabilities.plyContext が false なら常に受け取れない。backend.plyContextRefusal(owners) は組み合わせごとの制約
 * （antigravity は指示の担当がエージェントのままだと受けない。core/backends/antigravity-context.mjs）
 */
export function plyContextRefusal(backend, policy) {
  if (backend?.capabilities?.plyContext === false) return t('context.runtime.refused', { backend: backend.label ?? backend.id });
  return backend?.plyContextRefusal?.(policy?.owners ?? {}) ?? null;
}
export const acceptsPlyContext = (backend, policy) => !plyContextRefusal(backend, policy);
/**
 * Pleiad がコンテキストを開かないターンの記録。担当が Pleiad でも受け取れないバックエンド（組み合わせ）だったときは、
 * エージェント任せ（native）として扱ったことと理由を残す
 */
export function nativeContextReport(policy, cwd, backend, at = new Date()) {
  const reason = managed(policy) ? plyContextRefusal(backend, policy) : null;
  return { version: 1, cwd, owners: policy.owners, status: 'native', entries: [], at: at.toISOString(),
    ...(reason ? { guardedBackend: backend.id, reason } : {}) };
}
/**
 * 会話の方針。最初の送信で記録し、以後はターンごとに今の設定（と作業場所）で解き直す（followSettings。core/server.mjs の runTurn）。
 * 形式 2 は探索の計画（plan。core/context-settings.mjs）をそのまま持つ。形式 1（user / directory の探索設定）の記録も読める。
 * at は最初に方針を決めた時刻、removedMcp は「この会話では外す」とした外部 MCP の名前
 */
export function contextPolicy(settings, at = new Date()) {
  return { version: 2, cwd: settings.cwd, at: at.toISOString(), owners: structuredClone(settings.owners ?? DEFAULT_OWNERS), plan: structuredClone(settings.plan) };
}
const textResult = text => ({ content: [{ type: 'text', text }] });
const properties = { type: 'object', properties: { id: { type: 'string' }, full: { type: 'boolean' } }, required: ['id'], additionalProperties: false };
/**
 * 同じ会話で同じ本文を二度渡さないための控え（探索の行の id → 渡した本文のハッシュ）。
 * runtime.delivered に載せ、ターンをまたいで contextSession.delivered へ持ち越す（core/server.mjs の runTurn）。
 * 本文が変わっていなければ短い一行だけを返し、変わっていれば本文を渡し直す。full: true で必ず本文を返す
 * （圧縮などで相手の手元から消えたとき用。Codex・antigravity では圧縮を host から見られない）。
 * **控えは指示欄のプロンプトに一切影響させない。** 影響させるとファイルが同じでもターンごとに前置きが変わり、
 * バックエンド側の prompt caching が毎ターン外れる。差を出してよいのは末尾に積まれるツールの返りだけ
 */
// エージェントに渡す文（前置き・ツールの説明・返り）は会話の言語で引く（agent 名前空間。runtime.locale）。en は以前の英語の固定文と同じ
const alreadyLine = (locale, label, scope) => agentT(locale, 'context.alreadyProvided', { label, scope });

/**
 * 前のターンの方針 previous を、今の設定 settings（contextSettings.get の結果）で解き直す。設定の変更を次のターンから効かせるため。
 * 会話ごとの決めごと（最初の時刻 at・読み込み直しの時刻 refreshedAt・「この会話では外す」removedMcp・keepNative）は引き継ぐ。
 * keepNative は、コンテキストの記録が無いまま送信済みだった会話（この機能より前の会話）。担当はエージェント任せのまま変えない。
 * 戻り: { policy, changed }。changed は設定の変更で実際に渡し方が変わった種類（担当か、Pleiad が探す範囲。作業場所の変更だけなら空）
 */
export function followSettings(previous, settings, { keepNative = false } = {}) {
  const policy = contextPolicy(settings);
  if (keepNative || previous?.keepNative) { policy.owners = { ...DEFAULT_OWNERS }; policy.keepNative = true; }
  if (!previous) return { policy, changed: [] };
  if (previous.at) policy.at = previous.at;
  if (previous.refreshedAt) policy.refreshedAt = previous.refreshedAt;
  if (previous.removedMcp?.length) policy.removedMcp = [...previous.removedMcp];
  // 作業場所が変わったときは、場所ごとの設定の違いを設定の変更とは数えない（探し直しの結果は pin の突き合わせで知らせる）
  if (pathKey(previous.cwd ?? '') !== pathKey(policy.cwd ?? '')) return { policy, changed: [] };
  const before = runtimeSettings(previous).plan, after = runtimeSettings(policy).plan;
  const changed = KINDS.filter(k => (previous.owners?.[k] ?? 'native') !== policy.owners[k]
    || !isDeepStrictEqual(before.user.kinds[k], after.user.kinds[k]) || !isDeepStrictEqual(before.directory.kinds[k], after.directory.kinds[k])
    || (k === 'mcp' && policy.owners.mcp === 'ply' && !isDeepStrictEqual(before.mcp, after.mcp)));
  // 追加で探すフォルダーは種類を問わない。Pleiad が探している種類すべてに効く
  if (!changed.length && (!isDeepStrictEqual(before.user.roots, after.user.roots) || !isDeepStrictEqual(before.directory.roots, after.directory.roots)))
    changed.push(...KINDS.filter(k => policy.owners[k] === 'ply'));
  return { policy, changed };
}
/** 会話の方針から探索設定を作る。Pleiad が担当する種類だけを探す（担当がエージェントの種類は探さない） */
export function runtimeSettings(policy) {
  const plan = structuredClone(policy.plan ?? legacyPlan(policy.user, policy.directory));
  for (const scope of ['user', 'directory']) for (const k of KINDS) if (policy.owners?.[k] !== 'ply') plan[scope].kinds[k] = null;
  return { cwd: policy.cwd, plan };
}
/** 固定の対象は指示と Skills。MCP は接続先の設定なので本文の同一性を約束しない */
export const pinnable = entries => entries.filter(i => i.kind !== 'mcp');
// Skill は本文のハッシュを固定しない。渡しているのはカタログ（名前・説明・ID）だけで、本文は load_skill のたびに今の内容を読むため
export const contextPin = entries => hash(pinnable(entries).map(i => i.kind === 'skill' ? [i.id, i.name, i.description ?? '', i.status] : [i.id, i.hash, i.status]));

/**
 * 固定した指示・Skills の行を id で突き合わせ、変わったものを返す（消えたものは after が null）。
 * before / after はどちらも探索結果か記録の行。pin が動いた理由を名指しするのに使う
 */
export function pinnedChanges(before, after) {
  const was = new Map(pinnable(before ?? []).map(e => [e.id, e]));
  const changed = [];
  for (const item of pinnable(after ?? [])) {
    const prev = was.get(item.id);
    if (!prev || prev.hash !== item.hash) changed.push({ id: item.id, kind: item.kind, name: item.name, path: item.path, before: prev?.hash ?? null, after: item.hash });
    was.delete(item.id);
  }
  for (const item of was.values()) changed.push({ id: item.id, kind: item.kind, name: item.name, path: item.path, before: item.hash ?? null, after: null });
  return changed;
}

/**
 * 固定する指示・Skills の本文を、内容のハッシュを名前にして残す（「差分を見る」で開始時の内容と比べるため）。
 * 同じ内容は 1 つ。失敗しても会話は止めない
 */
export async function saveSnapshots(dir, entries) {
  if (!dir) return;
  try {
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(pinnable(entries).filter(e => e.hash && typeof e.content === 'string' && /^[a-f0-9]{64}$/.test(e.hash))
      .map(e => fs.writeFile(path.join(dir, `${e.hash}.txt`), e.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(() => {})));
  } catch {}
}
export async function readSnapshot(dir, digest) {
  if (!dir || !/^[a-f0-9]{64}$/.test(String(digest ?? ''))) return null;
  return fs.readFile(path.join(dir, `${digest}.txt`), 'utf8').catch(() => null);
}

const sourceLabel = source => ({ claude: 'Claude', codex: 'Codex', common: t('context.scan.fromCommon'), ply: 'Pleiad' })[source];
/**
 * 同じ名前の外部 MCP が複数あったとき（core/context-scan.mjs が 1 つを選び、残りを shadowedBy: 'choice' にする）、
 * どれを使ったかを記録に残す。使った行に choice（選び方と、使わなかった定義の数）、使わなかった行に理由。
 * 以前は実行時に「同名の MCP があります」で止めていたので、どちらが使われたかを右パネルで確かめられるようにする
 */
function markChoices(rows, plan) {
  const mcp = rows.filter(r => r.kind === 'mcp');
  for (const row of mcp.filter(r => r.shadowedBy === 'choice')) {
    const used = mcp.find(r => r.name === row.name && r.shadowedBy !== 'choice' && !['shadowed', 'excluded', 'disabled', 'duplicate'].includes(r.status));
    if (!used) continue;
    const want = plan?.mcp?.prefer?.[row.name];
    const by = want && used.origins?.some(o => pathKey(o.path) === pathKey(want)) ? 'prefer' : 'first';
    const source = used.origins?.[0]?.source;
    used.choice ??= { by, source, others: 0 };
    used.choice.others++;
    // i18n-dynamic: context.runtime.choice
    row.reason = t(by === 'prefer' ? 'context.runtime.choicePrefer' : 'context.runtime.choiceFirst', { source: sourceLabel(source) ?? source ?? t('context.runtime.otherSource') });
  }
}

export async function resolveRuntime(policy, options = {}) {
  const owners = policy.owners;
  const kinds = Object.keys(owners).filter(k => owners[k] === 'ply');
  const settings = runtimeSettings(policy);
  // locale は会話の言語（エージェントに渡す前置き・ツールの説明の言語）。探索の設定ではないので scanOptions に入れない
  const { snapshots, locale, ...scanOptions } = options;
  const scan = await scanContext(settings, { ...scanOptions, runtime: true });
  const removed = new Set(policy.removedMcp ?? []);
  if (scan.limited || scan.diagnostics.length) throw new Error(t('context.runtime.unresolved', { detail: scan.diagnostics[0]?.message ?? t('context.runtime.scanLimit') }));
  const report = { version: 1, cwd: policy.cwd, owners, at: new Date().toISOString(), entries: [], native: kinds.length < 3, status: 'resolved' };
  const instructions = [], conditional = [], skills = [], servers = [], seen = new Set(), names = new Map();
  // 渡す本文。@参照の行（参照先は探索で別の行になっている）と、rules の frontmatter（paths は範囲として別に示す）を除く
  const body = item => (item.rule ? item.content.replace(FRONTMATTER, '') : item.content).split(/\r?\n/).filter(l => !/^\s*@(?:"[^"]+"|\S+)\s*$/.test(l)).join('\n');
  for (const item of scan.entries) {
    const row = { id: item.id, kind: item.kind, name: item.name, path: item.path, appliesTo: item.appliesTo, status: item.status, hash: item.hash, origins: item.origins,
      ...(item.paths ? { paths: item.paths } : {}),
      ...(item.kind === 'mcp' && item.auth ? { auth: item.auth } : {}), ...(item.shadowedBy ? { shadowedBy: item.shadowedBy } : {}) };
    report.entries.push(row);
    // paths 付きの rules は開始時に渡さない。instructions_for_path が当たるファイルのときだけ返す（行は conditional のまま）
    if (item.status === 'conditional') {
      const key = `rule:${pathKey(item.realPath)}:${item.pathsBase ?? ''}`;
      if (seen.has(key)) row.status = 'duplicate';
      else { seen.add(key); conditional.push({ ...item, content: body(item) }); }
      continue;
    }
    if (item.status !== 'candidate') continue;
    // 「この会話では外す」とした外部 MCP。接続せず、ply_context にもツールを出さない
    if (item.kind === 'mcp' && removed.has(item.name)) { row.status = 'removed'; row.reason = t('context.removedHere'); continue; }
    const key = `${item.kind}:${pathKey(item.realPath)}:${item.appliesTo ?? ''}:${item.kind === 'mcp' ? item.name : ''}`;
    if (seen.has(key)) { row.status = 'duplicate'; continue; }
    seen.add(key);
    if (item.kind === 'instruction') {
      row.status = 'supplied';
      // Imports are already resolved, scoped and deduplicated by the scanner.
      instructions.push({ ...item, content: body(item) });
    } else {
      const nameKey = `${item.kind}:${item.name}`;
      if (names.has(nameKey)) throw new Error(t('context.runtime.duplicateName', { kind: item.kind === 'mcp' ? 'MCP' : 'Skill', name: item.name }));
      names.set(nameKey, item);
      if (item.kind === 'skill') {
        const unsupported = Object.keys(item.metadata ?? {}).filter(k => !['name','description','license','compatibility','metadata','allowed-tools','user-invocable','disable-model-invocation','argument-hint'].includes(k));
        if (unsupported.length) { row.status = 'unsupported'; row.reason = t('context.runtime.skillUnsupported', { keys: unsupported.join(', ') }); continue; }
        if (item.metadata?.['disable-model-invocation']) { row.status = 'manual-only'; row.reason = t('context.runtime.manualOnly'); }
        else row.status = 'available';
        skills.push(item);
      } else { row.status = 'pending'; servers.push(item); }
    }
  }
  markChoices(report.entries, settings.plan);
  const prompt = instructions.map(i => agentT(locale, 'context.instructionsFrom', { path: i.path, scope: i.appliesTo ?? agentT(locale, 'context.allDirectories'), content: i.content })).join('\n\n');
  if (Buffer.byteLength(prompt) > 128 * 1024) throw new Error(t('context.runtime.instructionsTooLarge'));
  const pin = contextPin(scan.entries);
  await saveSnapshots(snapshots, scan.entries);
  // scanOptions は instructions_for_path が同じ探索（home など）で解き直すために持つ
  // delivered は渡し済みの本文の控え。会話をまたぐ分は core/server.mjs が差し替える
  return { policy, owners, report, instructions, conditional, skills, servers, prompt, pin, scanOptions, locale, delivered: {} };
}

/**
 * 固定された会話の pin を、今のファイルと突き合わせる。会話の入口とコンテキスト画面の「変更あり」に使う。
 * 正否は pin の一致だけで決まる。paths はどれが変わったかの手掛かりで、
 * 会話中に instructions_for_path で読み足した子ディレクトリの指示が差分に混じることがある。
 */
export async function pinChanges(record, options = {}) {
  if (!record?.pin) return null;
  const scan = await scanContext(runtimeSettings(record.policy), { ...options, runtime: true });
  if (contextPin(scan.entries) === record.pin) return { differs: false, paths: [], files: [] };
  // files は画面の「差分を見る」用: 開始時のハッシュ（before）と今のハッシュ（after）、今の更新時刻
  const files = pinnedChanges(record.report?.entries ?? [], scan.entries);
  await Promise.all(files.map(async f => { f.modifiedAt = f.after ? (await fs.stat(f.path).catch(() => null))?.mtime?.toISOString() ?? null : null; }));
  return { differs: true, paths: files.map(f => f.path).slice(0, 20), files: files.slice(0, 20) };
}

export function contextTools(runtime, userPrompt = '') {
  const invoked = new Set(String(userPrompt).match(/\$[\p{L}\p{N}_-]+/gu)?.map(s => s.slice(1)) ?? []);
  // Composer slash mentions can occur anywhere, including multiple manual-only skills.
  for (const match of String(userPrompt).matchAll(/(?:^|[\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（(「『、。，,])\/([\p{L}\p{N}_.:-]+)(?![\p{L}\p{N}_.:\/\\-])/gu)) invoked.add(match[1]);
  const active = runtime.skills.filter(s => !s.metadata?.['disable-model-invocation'] || invoked.has(s.name));
  const locale = runtime.locale;
  const tools = [];
  if (runtime.owners.skill === 'ply') tools.push({ name: 'load_skill', description: agentT(locale, 'context.tools.load_skill'), inputSchema: properties });
  if (runtime.owners.instruction === 'ply') tools.push({ name: 'instructions_for_path', description: agentT(locale, 'context.tools.instructions_for_path'), inputSchema: properties });
  const catalog = active.map(s => agentT(locale, 'context.prompt.skillLine', { name: s.name, description: s.description, id: s.id, dir: path.dirname(s.realPath) })).join('\n');
  // paths 付きの rules は本文を渡さず、どのファイルで読み足すべきかだけを示す
  const scoped = (runtime.conditional ?? []).map(i => agentT(locale, 'context.prompt.scopedLine', { paths: i.paths.join(', '), base: i.pathsBase ?? runtime.policy.cwd }));
  const prompt = [runtime.prompt,
    runtime.owners.instruction === 'ply' ? agentT(locale, 'context.prompt.descendants') : '',
    runtime.owners.instruction === 'ply' && scoped.length ? agentT(locale, 'context.prompt.scopedRules', { rules: [...new Set(scoped)].join('\n') }) : '',
    runtime.owners.skill === 'ply' ? agentT(locale, 'context.prompt.skills', { catalog: catalog || agentT(locale, 'context.prompt.none') }) : '',
  ].filter(Boolean).join('\n\n');
  // 渡し済みの控え。prompt を組み立てた後に触る（プロンプトには影響させない）
  const delivered = runtime.delivered ??= {};
  /** 記録の行を「読み込み済み」にし、頼まれた回数を数える（短い一行で返した分も含む） */
  const mark = id => { const row = runtime.report.entries.find(e => e.id === id); if (row) { row.status = 'loaded'; row.calls = (row.calls ?? 0) + 1; } return row; };
  return { tools, prompt, async call(name, args) {
    const full = args?.full === true;
    if (name === 'load_skill') {
      const item = active.find(s => s.id === args?.id);
      if (!item) throw new Error(agentT(locale, 'context.errors.skillUnavailable'));
      if ((await fs.stat(item.realPath)).size > 256 * 1024) throw new Error(agentT(locale, 'context.errors.skillTooLarge'));
      const body = await fs.readFile(item.realPath, 'utf8');
      // 開始時と本文が違っても止めない。今の本文を渡し、記録のハッシュを渡した内容へ直す（固定しているのは名前と説明だけ）
      const digest = hash(body.replace(/^﻿/, ''));
      const row = mark(item.id);
      if (row) row.hash = digest;
      const before = delivered[item.id];
      delivered[item.id] = digest;
      const dir = path.dirname(item.realPath);
      // 同じ本文を渡し済みなら本文を繰り返さない（会話が長くなるほど同じ Skill が何度も積み上がるため）
      if (before === digest && !full) return textResult(alreadyLine(locale, agentT(locale, 'context.skillLabel', { name: item.name }), agentT(locale, 'context.skillScope', { dir })));
      return textResult(`${before && before !== digest ? agentT(locale, 'context.skillChanged') + '\n' : ''}${agentT(locale, 'context.skillBody', { dir, body })}`);
    }
    if (name === 'instructions_for_path') {
      if (typeof args?.id !== 'string' || !path.isAbsolute(args.id)) throw new Error(agentT(locale, 'context.errors.absolutePath'));
      // これから作るファイル（paths 付きの rules はその前に読み足す）も求められるよう、無い部分は在る親の実体パスにつなぐ
      let real = null;
      for (let dir = path.resolve(args.id), rest = []; !real; rest.unshift(path.basename(dir)), dir = path.dirname(dir)) {
        try { real = path.join(await fs.realpath(dir), ...rest); } catch (e) { if (e.code !== 'ENOENT' || path.dirname(dir) === dir) throw e; }
      }
      // 要求側は実体パスにしたので、作業場所も実体で比べる（8.3 短縮名・junction 越しの cwd でも中を拒まない）
      const root = await fs.realpath(runtime.policy.cwd).catch(() => runtime.policy.cwd);
      if (!containsPath(root, real)) throw new Error(agentT(locale, 'context.errors.outsideWorkspace'));
      const cwd = (await fs.stat(real).catch(() => null))?.isDirectory() ? real : path.dirname(real);
      const child = await resolveRuntime({ ...runtime.policy, cwd, owners: { ...DEFAULT_OWNERS, instruction: 'ply' } }, { ...runtime.scanOptions, locale });
      // 開始時に渡したものは実体パスでも突き合わせる。子の探索は実体パスの作業場所で解くので、会話の作業場所が
      // 8.3 短縮名・junction 越しだと適用範囲が別の表記になり、id が変わって同じファイルを渡し直してしまう
      const added = child.instructions.filter(i => !runtime.instructions.some(p => p.id === i.id || pathKey(p.realPath) === pathKey(i.realPath)));
      // paths 付きの rules は、要求されたパスそのものが glob に当たるものだけ。ユーザーの rules の glob は会話の作業場所から見る
      const rules = child.conditional.filter(i => matchesGlobs(i.paths, i.pathsBase ?? root, real));
      for (const entry of child.report.entries) if (!runtime.report.entries.some(e => e.id === entry.id)) runtime.report.entries.push({ ...entry, status: entry.status === 'supplied' ? 'loaded' : entry.status });
      const wanted = [...added.map(i => ({ item: i, scope: i.appliesTo })),
        ...rules.map(i => ({ item: i, scope: agentT(locale, 'context.rulesScope', { paths: i.paths.join(', '), base: i.pathsBase ?? root }) }))];
      // 1 件ずつ、渡し済みの本文と同じなら短い一行だけ返す（rules の多い場所で同じ本文が何度も積み上がるのを防ぐ）
      const parts = wanted.map(({ item, scope }) => {
        const digest = hash(item.content);
        const before = delivered[item.id];
        delivered[item.id] = digest;
        mark(item.id);
        if (before === digest && !full) return alreadyLine(locale, item.path, scope);
        return `${before && before !== digest ? agentT(locale, 'context.fileChanged') + '\n' : ''}${agentT(locale, 'context.fileBody', { scope, path: item.path, content: item.content })}`;
      });
      return textResult(parts.join('\n\n') || agentT(locale, 'context.errors.noMore'));
    }
    throw new Error(agentT(locale, 'context.errors.unknownTool'));
  } };
}

// Convert existing client configuration into transport parameters in memory.
// 設定の誤りは code: 'MCP_CONFIG' で投げる（context-bridge が文言ではなく code で見分けて、理由として画面に出す）
const configError = (message, more = {}) => Object.assign(new Error(message), { code: 'MCP_CONFIG', ...more });
export function mcpTransportConfig(item, cwd, env = process.env) {
  const v = item.definition, source = item.origins[0].source;
  const allowed = ['command','args','env','cwd','url','baseUrl','type','transport','headers','http_headers','env_http_headers','bearer_token_env_var','env_vars','enabled','disabled','startup_timeout_sec','tool_timeout_sec','timeoutMs','enabled_tools','disabled_tools','required','startup_timeout_ms'];
  const unknown = Object.keys(v).filter(k => !allowed.includes(k));
  if (unknown.length) throw configError(t('context.runtime.mcpUnsupported', { name: item.name, keys: unknown.join(', ') }), { unsupported: true });
  const expand = value => typeof value === 'string' ? value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, key, fallback) => {
    if (env[key] !== undefined) return env[key]; if (fallback !== undefined) return fallback; throw configError(t('context.runtime.mcpEnvMissing', { name: item.name, key }));
  }) : value;
  const headers = Object.fromEntries(Object.entries(v.headers ?? v.http_headers ?? {}).map(([k,s]) => [k, expand(s)]));
  for (const [k,e] of Object.entries(v.env_http_headers ?? {})) { if (!env[e]) throw configError(t('context.runtime.mcpEnvMissing', { name: item.name, key: e })); headers[k] = env[e]; }
  if (v.bearer_token_env_var) { if (!env[v.bearer_token_env_var]) throw configError(t('context.runtime.mcpAuthEnvMissing', { name: item.name })); headers.Authorization = `Bearer ${env[v.bearer_token_env_var]}`; }
  const command = expand(v.command), url = expand(v.url ?? v.baseUrl);
  const timeout = v.timeoutMs ?? v.startup_timeout_ms ?? (v.startup_timeout_sec ?? 20) * 1000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw configError(t('context.runtime.mcpTimeoutInvalid', { name: item.name }));
  const inherited = source === 'codex' ? { ...getDefaultEnvironment(), ...Object.fromEntries((v.env_vars ?? []).filter(k => env[k] !== undefined).map(k => [k, env[k]])) } : env;
  if (command) return { type: 'stdio', command, args: (v.args ?? []).map(expand), cwd: v.cwd ? path.resolve(cwd, expand(v.cwd)) : cwd,
    env: { ...inherited, ...Object.fromEntries(Object.entries(v.env ?? {}).map(([k,s]) => [k,expand(s)])) }, timeout: Math.min(60000, timeout) };
  if (!url || !/^https?:\/\//.test(url)) throw configError(t('context.runtime.mcpUrlInvalid', { name: item.name }));
  return { type: (v.type ?? v.transport) === 'sse' ? 'sse' : 'http', url, headers, timeout: Math.min(60000, timeout) };
}
