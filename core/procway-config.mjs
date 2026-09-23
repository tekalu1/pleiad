import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { cliCommand } from './cli-installation.mjs';
import { dataDir } from './store.mjs';
import { procwayHome } from './auth/procway-token-store.mjs';
import { protectSecret } from './auth/secret-protection.mjs';
import { validateLimits } from '../web/procway-limits.mjs';

const TYPES = new Set(['openai', 'anthropic', 'openai-compatible', 'anthropic-compatible', 'openai-codex']);
const FILE = () => path.join(dataDir, 'procway-connections.json');
let writes = Promise.resolve();
const receipts = new Map();
export async function procwaySource() {
  const cli = cliCommand('procway');
  if (!cli) throw new Error('procway-code をインストールしてください');
  const script = cli[0] === process.execPath ? cli[1] : cli[0];
  const real = await fs.realpath(script);
  const src = path.dirname(real);
  await fs.access(path.join(src, 'config/load-settings.mjs')).catch(() => { throw new Error('この procway-code の構成は未対応です。src/cli.mjs を AGENT_HOST_PROCWAY_CODE に指定してください'); });
  return src;
}
export async function nativeSettings(cwd = process.cwd()) {
  const src = await procwaySource();
  const { loadSettings } = await import(pathToFileURL(path.join(src, 'config/load-settings.mjs')).href);
  const { applySecretsFromFiles } = await import(pathToFileURL(path.join(src, 'config/load-secrets.mjs')).href);
  const environment = { ...process.env };
  await applySecretsFromFiles({ cwd, homeDir: procwayHome(), env: environment, onParseError: () => { throw new Error('procway-code の資格情報ファイルを読み込めません'); } });
  return { ...await loadSettings({ cwd, homeDir: procwayHome(), env: environment }), environment };
}
async function read() {
  try { return JSON.parse(await fs.readFile(FILE(), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, connections: {}, defaults: {} }; throw new Error('接続設定を読み込めません。既存ファイルを確認してください'); }
}
async function update(fn) {
  const work = writes.catch(() => {}).then(async () => {
    const data = await read(); const result = await fn(data);
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = FILE() + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(tmp, FILE()); }
    finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    return result;
  });
  writes = work; return work;
}
// existingSecret: 保存済みの接続先を編集している。キー欄が空なら「保存済みのキーを流用する」意味になる。
function normalize(input, { existingSecret = false } = {}) {
  const s = input ?? {};
  if (!TYPES.has(s.type)) throw new Error('接続方式を選んでください');
  const name = String(s.name ?? '').trim(), model = String(s.model ?? '').trim();
  if (!name || name.length > 80 || !model || model.length > 200 || /[\r\n\x00]/.test(model)) throw new Error('接続先の名前とモデル ID を入力してください');
  let baseUrl = s.type === 'openai' ? 'https://api.openai.com/v1' : s.type === 'anthropic' ? 'https://api.anthropic.com' : s.type === 'openai-codex' ? '' : String(s.baseUrl ?? '').trim();
  if (s.type !== 'openai-codex') {
    let u; try { u = new URL(baseUrl); } catch { throw new Error('ベース URL を入力してください'); }
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('ベース URL は認証情報・クエリを含まない HTTP(S) URL にしてください');
    baseUrl = u.href.replace(/\/$/, '');
  }
  const apiKey = String(s.apiKey ?? '').trim(), apiKeyEnv = String(s.apiKeyEnv ?? '').trim();
  if (apiKey.length > 16000 || /[\r\n]/.test(apiKey)) throw new Error('API キーの形式が不正です');
  if (apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(apiKeyEnv)) throw new Error('環境変数名が不正です');
  if (s.type !== 'openai-codex' && !apiKey && !apiKeyEnv && !existingSecret) throw new Error('API キーまたは環境変数名を入力してください');
  return { name, type: s.type, baseUrl, model, apiKey, apiKeyEnv };
}
const fingerprint = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
// id を渡すと既存の接続先の編集として確認する。キー欄が空なら保存済みのキーで確かめる。
async function managedConnection(id) {
  if (!id) return null;
  const saved = (await read()).connections;
  if (!Object.hasOwn(saved, id)) throw new Error('接続先が見つかりません。接続設定を開き直してください');
  return saved[id];
}
export async function checkConnection(input, { fetchImpl = fetch, cwd, id = null } = {}) {
  const existing = await managedConnection(id);
  const v = normalize(input, { existingSecret: !!existing?.secret });
  let models = [], note = '';
  if (v.type === 'openai-codex') {
    const { readProfile } = await import('./auth/procway-token-store.mjs');
    if (!(await readProfile('codex'))?.credentials?.access) throw new Error('先に ChatGPT でログインしてください');
    note = 'ログイン情報を確認しました。モデルの利用可否は送信時に確認します。';
  } else {
    let key = v.apiKey;
    if (!key && v.apiKeyEnv) {
      key = (await nativeSettings(cwd)).environment[v.apiKeyEnv];
      if (!key) throw new Error('指定した環境変数がホストに設定されていません');
    }
    if (!key && existing?.secret) key = await protectSecret(existing.secret, true);
    if (!key) throw new Error('API キーまたは環境変数名を入力してください');
    const anthropic = v.type.startsWith('anthropic');
    let r;
    try { r = await fetchImpl(v.baseUrl + (anthropic ? '/v1/models' : '/models'), { headers: anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000), redirect: 'error' }); }
    catch { throw new Error('接続できませんでした。ベース URL・ネットワークを確認してください（キーは転送先へリダイレクトしません）'); }
    if (!r.ok) { await r.body?.cancel(); throw new Error(r.status === 401 || r.status === 403 ? '認証できませんでした。API キー・権限を確認してください' : `モデル一覧を取得できませんでした（HTTP ${r.status}）。モデル一覧 API に対応した接続先を指定してください`); }
    let body; try { body = await r.json(); } catch { throw new Error('モデル一覧の応答形式が不正です'); }
    models = (Array.isArray(body.data) ? body.data : []).map(m => m?.id).filter(m => typeof m === 'string' && m.length <= 200).slice(0, 5000);
    // An exact model is verified without a billable generation call.
    if (!models.includes(v.model)) throw new Error('指定したモデルが一覧にありません。モデル ID と API キーの利用権限を確認してください');
    note = '接続先・認証・モデル一覧を確認しました。生成は行っていません。';
  }
  const receipt = crypto.randomUUID();
  for (const [old, item] of receipts) if (item.until < Date.now()) receipts.delete(old);
  if (receipts.size > 100) receipts.delete(receipts.keys().next().value);
  // id もハッシュに入れる。確認した接続先以外への保存にレシートを流用させない。
  receipts.set(receipt, { hash: fingerprint({ ...v, id: id ?? null }), until: Date.now() + 10 * 60_000, models });
  return { receipt, models, note };
}
export async function saveConnection(input, receipt, id = null) {
  const existing = await managedConnection(id);
  const v = normalize(input, { existingSecret: !!existing?.secret }), proof = receipts.get(receipt);
  if (!proof || proof.until < Date.now() || proof.hash !== fingerprint({ ...v, id: id ?? null })) throw new Error('設定が変更されたか確認が期限切れです。接続を確認してください');
  // 新しいキーの入力があれば置き換え、環境変数に切り替えたなら捨て、どちらも空なら保存済みを維持する。
  const secret = v.apiKey ? await protectSecret(v.apiKey) : v.apiKeyEnv ? null : existing?.secret ?? null;
  const key = id || 'ply-' + crypto.randomUUID();
  await update(data => {
    if (id && !Object.hasOwn(data.connections, id)) throw new Error('接続先が見つかりません。接続設定を開き直してください');
    data.connections[key] = { name: v.name, type: v.type, baseUrl: v.baseUrl, defaultModel: v.model, apiKeyEnv: v.apiKeyEnv, secret, models: proof.models, verifiedAt: new Date().toISOString() };
  });
  receipts.delete(receipt); return { id: key };
}
/** Pleiad が保存した接続先だけ削除できる。既定とモデル別の容量設定も一緒に片付ける。 */
export async function deleteConnection(id) {
  const target = String(id ?? '');
  await update(data => {
    if (!target || !Object.hasOwn(data.connections, target)) throw new Error('Pleiad で追加した接続先だけ削除できます');
    delete data.connections[target];
    if (data.defaultId === target) delete data.defaultId;  // procway-code 側の既定に戻る
    for (const key of Object.keys(data.defaults || {})) if (key === target || key.startsWith(target + '/')) delete data.defaults[key];
  });
}
export async function listConnections(cwd) {
  const [{ settings, sources, environment }, saved] = await Promise.all([nativeSettings(cwd), read()]);
  const all = { ...settings.providers, ...saved.connections };
  const connections = Object.entries(all).map(([id, p]) => ({ id, name: p.name || id, type: p.type, model: p.defaultModel || '', baseUrl: p.baseUrl || '', apiKeyEnv: p.apiKeyEnv || '', credential: p.secret ? 'Windows で保護済み' : p.type === 'openai-codex' ? 'ChatGPT ログイン' : environment[p.apiKeyEnv] ? '環境変数・既存資格情報に設定済み' : '資格情報が未設定', ready: !!(p.secret || environment[p.apiKeyEnv] || p.type === 'openai-codex' || p.type === 'cli-agent'), managed: Object.hasOwn(saved.connections, id), hasSecret: !!p.secret, supported: TYPES.has(p.type), models: p.models || [], source: Object.hasOwn(saved.connections, id) ? 'Pleiad の接続設定' : sources.filter(s => s.loaded && ['user', 'workspace'].includes(s.name)).map(s => s.path).join(' / ') || 'procway-code の既定' }));
  return { connections, defaultId: saved.defaultId || settings.defaultProvider, defaults: saved.defaults, canStoreKey: process.platform === 'win32' };
}
export async function setDefaultConnection(id, cwd) {
  if (!(await listConnections(cwd)).connections.some(c => c.id === id)) throw new Error('接続先が見つかりません');
  await update(d => { d.defaultId = id; });
}
export async function setModelLimits(model, limits, cwd) {
  await resolveConnection(model, cwd);
  const value = validateLimits(limits);
  await update(d => { d.defaults[model] = value; });
  return value;
}
export async function resolveConnection(selection, cwd = process.cwd(), limits) {
  const saved = await read(); const native = await nativeSettings(cwd);
  const parts = String(selection || '').split('/');
  const id = parts[0] || saved.defaultId || native.settings.defaultProvider;
  const provider = { ...(saved.connections[id] || native.settings.providers?.[id]) };
  if (!provider.type) throw new Error('接続先が見つかりません。選び直してください');
  const model = parts.slice(1).join('/') || provider.defaultModel || '';
  const key = id + '/' + model;
  const selectedLimits = validateLimits(limits === undefined ? saved.defaults[key] ?? saved.defaults[id] ?? null : limits);
  if (provider.type === 'cli-agent' && selectedLimits) throw new Error('CLI 接続の容量設定には対応していません');
  const env = {};
  if (provider.secret) { const name = 'PLY_PROCWAY_KEY'; env[name] = await protectSecret(provider.secret, true); provider.apiKeyEnv = name; }
  delete provider.secret; delete provider.models; delete provider.verifiedAt;
  provider.defaultModel = model;
  return { id, model, provider, limits: selectedLimits, env, native: native.settings };
}
