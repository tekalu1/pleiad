// API キーの置き場（core/api-keys.mjs。ADR 0154）。LLM は呼ばない。偽の OpenRouter・偽の互換 API とだけ話す。
// 移行（同じ値は 1 件・違う値は別の件・通話と判定器は登録済みの所だけ引き継ぐ・冪等・保留）・値を出さない・
// 差し替え/割り当て/削除が古い置き場にも書かれる・確認・接続先の keyRef を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiKeys, providerOfEndpoint, normalizeApiKey } from '../../core/api-keys.mjs';
import { createCompatEndpoints, EndpointError } from '../../core/compat-endpoints.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startFakeOpenRouter } from '../lib/fake-openrouter.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

export const name = 'api-keys';
export const title = 'API キー: 移行（同じ値は 1 件・違う値は別の件・登録済みの所だけ引き継ぐ・冪等・保留）・値を出さない・古い置き場にも書く・確認・接続先の keyRef';

const A = 'sk-or-v1-' + 'a'.repeat(24);
const B = 'sk-or-v1-' + 'b'.repeat(24);
const C = 'csk-' + 'c'.repeat(24);
const L = 'sk-lite-' + 'l'.repeat(24);
const EP1 = 'ep-111111111111', EP2 = 'ep-222222222222', EP3 = 'ep-333333333333';

async function rejects(fn) { try { await fn(); return null; } catch (e) { return e; } }
const exists = f => fs.stat(f).then(() => true, () => false);

/** 古い置き場を仕込んだ置き場を作る */
async function seed(dir, { endpoints = [], endpointKeys = {}, judges = {}, voice = null, cipher = plainCipher } = {}) {
  const compat = createSecretStore({ file: path.join(dir, 'compat-endpoint-secrets.json'), cipher });
  const voiceSecrets = createSecretStore({ file: path.join(dir, 'voice-secrets.json'), cipher });
  for (const [id, key] of Object.entries(endpointKeys)) await compat.set('compat-endpoint:' + id, { key });
  for (const [service, key] of Object.entries(judges)) await compat.set('delegation-routing:' + service, { key });
  if (voice) await voiceSecrets.set('openrouter', { key: voice });
  const rows = endpoints.map(e => ({ authMode: 'bearer', auth: 'bearer', roles: { main: 'm' }, options: {}, models: [], ...e }));
  await fs.writeFile(path.join(dir, 'compat-endpoints.json'), JSON.stringify({ version: 1, endpoints: rows, defaults: { claude: '', codex: '' } }));
}

/** サーバーと同じ配線 */
function wire(dir, { cipher = plainCipher, env = {}, events = [], fetchImpl } = {}) {
  const compat = createSecretStore({ file: path.join(dir, 'compat-endpoint-secrets.json'), cipher });
  const voice = createSecretStore({ file: path.join(dir, 'voice-secrets.json'), cipher });
  const secrets = createSecretStore({ file: path.join(dir, 'api-key-secrets.json'), cipher });
  let eps;
  const apiKeys = createApiKeys({ dataDir: dir, secrets, legacy: { compat, voice }, endpoints: () => eps, env, onChange: c => events.push(c), fetchImpl });
  eps = createCompatEndpoints({ dataDir: dir, secrets: compat, apiKeys });
  return { apiKeys, eps, compat, voice, secrets, events };
}

const EP = (id, over = {}) => ({ id, agent: 'claude', name: 'OpenRouter', preset: 'openrouter', baseUrl: 'https://openrouter.ai/api', ...over });

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-apikeys-'));
  let n = 0;
  const fresh = async () => { const d = path.join(root, `d${++n}`); await fs.mkdir(d, { recursive: true }); return d; };
  const fake = await startFakeOpenRouter();
  const compatApi = await startFakeCompatApi({ keys: [A, L] });
  try {
    // ---- 入力の検査
    t.ok('プロバイダー: プリセットと URL のホストで決める', providerOfEndpoint({ preset: 'openrouter', baseUrl: 'https://x.example' }) === 'openrouter'
      && providerOfEndpoint({ preset: 'custom', baseUrl: 'https://openrouter.ai/api/v1' }) === 'openrouter'
      && providerOfEndpoint({ preset: 'custom', baseUrl: 'https://api.cerebras.ai/v1' }) === 'cerebras'
      && providerOfEndpoint({ preset: 'zai', baseUrl: 'https://api.z.ai/api/anthropic' }) === 'zai'
      && providerOfEndpoint({ preset: 'custom', baseUrl: 'http://localhost:4000' }) === 'custom');
    t.ok('キーの形: 空・空白・制御文字・長すぎるものは断る', normalizeApiKey('') === null && normalizeApiKey('a b') === null && normalizeApiKey('a\nb') === null
      && normalizeApiKey('x'.repeat(16001)) === null && normalizeApiKey(` ${A} `) === A);

    // ---- 何も無い置き場: 移行済みになる
    {
      const d = await fresh();
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('何も無い置き場: 移行済みで、キーは 0 件・割り当ては空・案内なし', list.migration.state === 'done' && list.keys.length === 0 && list.guide === null
        && Object.values(list.uses).every(v => v === null));
      t.ok('移行済みの印は台帳に残る', JSON.parse(await fs.readFile(path.join(d, 'api-keys.json'), 'utf8')).migration?.done === true);
    }

    // ---- 同じ値は 1 件にまとめる・登録済みの所だけ割り当てを引き継ぐ
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1), EP(EP2, { agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1' })], endpointKeys: { [EP1]: A, [EP2]: A }, judges: { openrouter: A }, voice: A });
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('同じ OpenRouter のキー 4 か所は 1 件になる（名前は OpenRouter・案内なし）', list.keys.length === 1 && list.keys[0].label === 'OpenRouter' && list.keys[0].provider === 'openrouter' && list.guide === null,
        JSON.stringify(list.keys.map(k => k.label)));
      const id = list.keys[0].id;
      t.ok('通話と Jev は、登録済みだったキーを選んだ状態で引き継ぐ', list.uses.voice === id && list.uses['judge:jev'] === id && list.uses['judge:cerebras'] === null);
      t.ok('使っている所に 2 つの接続先・通話・Jev が並ぶ', list.keys[0].uses.filter(u => u.kind === 'endpoint').length === 2 && list.keys[0].uses.some(u => u.kind === 'voice') && list.keys[0].uses.some(u => u.kind === 'judge' && u.judge === 'jev'));
      t.ok('接続先は keyRef で持ち、値は持たない', (await w.eps.list()).endpoints.every(e => e.hasKey && e.keyRef === id) && !(await fs.readFile(path.join(d, 'compat-endpoints.json'), 'utf8')).includes(A));
      t.ok('値は api-key-secrets.json にあり、台帳にも一覧にも出ない', (await w.secrets.get('key:' + id))?.key === A
        && !(await fs.readFile(path.join(d, 'api-keys.json'), 'utf8')).includes(A) && !JSON.stringify(list).includes(A));
      t.ok('古い置き場は消さない', (await w.compat.get('compat-endpoint:' + EP1))?.key === A && (await w.voice.get('openrouter'))?.key === A && (await w.compat.get('delegation-routing:openrouter'))?.key === A);
      t.ok('読む側: 通話・Jev・接続先は API キーから読む', await w.apiKeys.useKey('voice') === A && await w.apiKeys.useKey('judge:jev') === A && await w.apiKeys.useKey('judge:cerebras') === null
        && (await w.eps.resolve(EP1, 'claude')).key === A);
      // 冪等: もう一度（別のインスタンス）。台帳は変わらない
      const before = await fs.readFile(path.join(d, 'api-keys.json'), 'utf8');
      const again = wire(d);
      await again.apiKeys.init();
      t.ok('移行は冪等: やり直しても台帳は変わらず、キーは増えない', await fs.readFile(path.join(d, 'api-keys.json'), 'utf8') === before && (await again.apiKeys.list()).keys.length === 1);
    }

    // ---- 違う値は元の場所が分かる名前の別の件にし、案内を一度だけ出す
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)], endpointKeys: { [EP1]: A }, voice: B, judges: { cerebras: C } });
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      const labels = list.keys.map(k => k.label).sort();
      t.ok('違う値の OpenRouter は別の件で、元の場所が名前で分かる', list.keys.filter(k => k.provider === 'openrouter').length === 2
        && labels.some(l => l.includes('通話')) && labels.some(l => l.includes('Claude Code の接続先')), JSON.stringify(labels));
      t.ok('Cerebras は 1 件（判定器から）', list.keys.filter(k => k.provider === 'cerebras').length === 1 && list.uses['judge:cerebras'] !== null);
      t.ok('案内が 1 回だけ出る（OpenRouter の 2 件）', list.guide?.provider === 'openrouter' && list.guide.keyIds.length === 2);
      const call = list.uses.voice, endpoint = list.keys.find(k => k.id !== call && k.provider === 'openrouter').id;
      t.ok('通話は通話のキー、接続先は接続先のキーのまま', list.keys.find(k => k.id === call).uses.some(u => u.kind === 'voice') && list.keys.find(k => k.id === endpoint).uses.some(u => u.kind === 'endpoint'));
      // まとめる: 接続先のキーに残す
      const merged = await w.apiKeys.resolveGuide(endpoint);
      const after = await w.apiKeys.list();
      t.ok('まとめる: 残すキーだけになり、通話は残したキーへ切り替わる・案内は消える', merged.merged.length === 1 && after.keys.filter(k => k.provider === 'openrouter').length === 1
        && after.uses.voice === endpoint && after.guide === null && after.keys.find(k => k.id === endpoint).label === 'OpenRouter');
      t.ok('まとめた後の通話は残したキーの値で送る・古い置き場も同じ値にそろう', await w.apiKeys.useKey('voice') === A && (await w.voice.get('openrouter'))?.key === A);
      t.ok('案内は二度と出ない（もう一度答えても何も起きない）', (await w.apiKeys.resolveGuide(null)).merged.length === 0 && (await w.apiKeys.list()).guide === null);
      // このままにする
      const d2 = await fresh();
      await seed(d2, { endpoints: [EP(EP1)], endpointKeys: { [EP1]: A }, voice: B });
      const w2 = wire(d2);
      await w2.apiKeys.init();
      await w2.apiKeys.resolveGuide(null);
      const kept = await w2.apiKeys.list();
      t.ok('このままにする: キーは何も変わらず、案内だけ消える', kept.keys.length === 2 && kept.guide === null);
      t.ok('同じプロバイダーのキーが 2 件でも、案内の後に作り直さない（再起動しても出ない）', (await (async () => { const r = wire(d2); await r.apiKeys.init(); return r.apiKeys.list(); })()).guide === null);
    }

    // ---- 接続先にしかキーが無い人は、通話・判定器は「使わない」のまま
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)], endpointKeys: { [EP1]: A } });
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('接続先だけ: キー 1 件・通話と判定器は使わない（送信を始めない）', list.keys.length === 1 && Object.values(list.uses).every(v => v === null)
        && await w.apiKeys.useKey('voice') === null && await w.apiKeys.hasUse('voice') === false);
    }

    // ---- カスタムの接続先は名前を引き継ぐ・同じ値は 1 件
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1, { name: '社内 LiteLLM', preset: 'custom', baseUrl: 'http://localhost:4000' }), EP(EP2, { name: '別の LiteLLM', preset: 'custom', baseUrl: 'http://localhost:4000', agent: 'codex' })], endpointKeys: { [EP1]: L, [EP2]: L } });
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('カスタムの接続先のキーは 1 件で、最初の接続先の名前になり、確認はキー単体では持たない', list.keys.length === 1 && list.keys[0].label === '社内 LiteLLM' && list.keys[0].provider === 'custom' && list.keys[0].checkable === false && list.guide === null);
    }

    // ---- 保留: 暗号化された古いキーを読めない起動（SECRET_LOCKED）
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)] });
      await fs.writeFile(path.join(d, 'voice-secrets.json'), JSON.stringify({ version: 1, entries: { openrouter: { enc: 'safeStorage', data: 'zz', at: 'x' } } }));
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('SECRET_LOCKED の起動: 移行を保留し、何も書かない', list.migration.state === 'deferred' && list.migration.reason === 'locked' && !(await exists(path.join(d, 'api-keys.json'))) && !(await exists(path.join(d, 'api-key-secrets.json'))));
      t.ok('保留中: キーの一覧は空で、書く操作は断る（MIGRATION_PENDING）', list.keys.length === 0
        && (await rejects(() => w.apiKeys.add({ provider: 'openrouter', label: 'x', key: A })))?.code === 'MIGRATION_PENDING'
        && (await rejects(() => w.apiKeys.setUse('voice', null)))?.code === 'MIGRATION_PENDING');
      t.ok('保留中: 暗号化された古い通話のキーは読めない（暗号化できない起動なので null ではなく例外）', (await rejects(() => w.apiKeys.useKey('voice')))?.code === 'SECRET_LOCKED');
      // 暗号化できる起動になったらやり直せる（同じ置き場）
      const unlocked = { status: async () => ({ encrypted: true, backend: 'fake' }), encrypt: async v => `enc:${v}`, decrypt: async v => v.replace(/^enc:/, '') };
      await fs.writeFile(path.join(d, 'voice-secrets.json'), JSON.stringify({ version: 1, entries: { openrouter: { enc: 'safeStorage', data: `enc:${JSON.stringify({ key: A })}`, at: 'x' } } }));
      const w2 = wire(d, { cipher: unlocked });
      await w2.apiKeys.init();
      const done = await w2.apiKeys.list();
      t.ok('暗号化できる起動で開き直すと移行され、通話に引き継がれる', done.migration.state === 'done' && done.keys.length === 1 && done.uses.voice === done.keys[0].id && await w2.apiKeys.useKey('voice') === A);
    }
    // 保留中の読み取りは古い置き場（平文なら読める）
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)], voice: A });
      await fs.writeFile(path.join(d, 'api-keys.json'), '{ broken');
      const w = wire(d);
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('壊れた台帳: 上書きせず保留し、古い置き場を読み続ける', list.migration.reason === 'broken' && await fs.readFile(path.join(d, 'api-keys.json'), 'utf8') === '{ broken'
        && await w.apiKeys.useKey('voice') === A && await w.apiKeys.hasUse('voice') === true && await w.apiKeys.hasUse('judge:jev') === false);
      t.ok('保留中: 接続先は古い置き場のキーで確認・送信できる（keyRef は使わない）', await w.eps.list().then(l => l.endpoints.every(e => e.keyRef === null)));
    }
    // 古い置き場が壊れている: その置き場は飛ばして続ける（消さない）
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)], endpointKeys: { [EP1]: A } });
      await fs.writeFile(path.join(d, 'voice-secrets.json'), '{ not json');
      const w = wire(d);
      await w.apiKeys.init();
      t.ok('古い置き場が壊れていても、読めた分は移行する。壊れたファイルはそのまま', (await w.apiKeys.list()).keys.length === 1 && await fs.readFile(path.join(d, 'voice-secrets.json'), 'utf8') === '{ not json');
    }

    // ---- 登録・差し替え・割り当て・削除（移行後）と、古い置き場への書き込み
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)] });
      const w = wire(d, { env: { AGENT_HOST_VOICE_API: fake.url } });
      await w.apiKeys.init();
      t.ok('形の悪いキーは断る', (await rejects(() => w.apiKeys.add({ provider: 'openrouter', label: 'x', key: 'has space' })))?.code === 'INVALID_KEY');
      const { id } = await w.apiKeys.add({ provider: 'openrouter', label: '  仕事用  ', key: A });
      let list = await w.apiKeys.list();
      t.ok('登録しただけでは何にも使わない（通話・判定器・接続先は選ばれない）', list.keys.length === 1 && list.keys[0].label === '仕事用' && list.keys[0].uses.length === 0 && Object.values(list.uses).every(v => v === null)
        && await w.apiKeys.useKey('voice') === null && !(await exists(path.join(d, 'voice-secrets.json'))));
      t.ok('登録しただけでは古い置き場にも書かない（使うキーを選ぶまで古い版も送らない）', !(await w.voice.keys('openrouter')).length && !(await w.compat.keys('delegation-routing:')).length);
      t.ok('プロバイダーの違うキーは割り当てられない（通話は OpenRouter・Cerebras の判定器は Cerebras）', (await rejects(() => w.apiKeys.setUse('judge:cerebras', id)))?.code === 'PROVIDER_MISMATCH'
        && (await rejects(() => w.apiKeys.setUse('nope', id)))?.code === 'UNKNOWN_USE' && (await rejects(() => w.apiKeys.setUse('voice', 'key-000000000000')))?.code === 'NOT_FOUND');
      w.events.length = 0;
      await w.apiKeys.setUse('voice', id);
      t.ok('選んだときから使う: 通話が値を読め、古い置き場にも同じ値が書かれ、変更が配られる', await w.apiKeys.useKey('voice') === A && (await w.voice.get('openrouter'))?.key === A && w.events.some(e => e.uses?.includes('voice')));
      await w.apiKeys.setUse('judge:jev', id);
      t.ok('Jev も同じキーを選べて、古い置き場の delegation-routing:openrouter にも書かれる', await w.apiKeys.useKey('judge:jev') === A && (await w.compat.get('delegation-routing:openrouter'))?.key === A);
      // 差し替え
      await w.apiKeys.replace(id, B);
      t.ok('差し替え: 使っている所すべてが新しい値で送り、古い置き場にも新しい値が書かれる', await w.apiKeys.useKey('voice') === B && await w.apiKeys.useKey('judge:jev') === B
        && (await w.voice.get('openrouter'))?.key === B && (await w.compat.get('delegation-routing:openrouter'))?.key === B);
      // 確認（OpenRouter の GET /key）
      const ok = await w.apiKeys.check(id);
      t.ok('確かめる: OpenRouter の GET /key。結果は台帳に残り、値は出ない', ok.ok === true && fake.records.key === 1 && (await w.apiKeys.list()).keys[0].lastCheck?.ok === true && !JSON.stringify(ok).includes(B));
      const bad = await startFakeOpenRouter({ keyStatus: 401 });
      const w2 = wire(d, { env: { AGENT_HOST_VOICE_API: bad.url } });
      await w2.apiKeys.init();
      const invalid = await w2.apiKeys.check(id);
      t.ok('401 は invalid、確認の失敗として記録する', invalid.ok === false && invalid.code === 'invalid' && (await w2.apiKeys.list()).keys[0].lastCheck?.code === 'invalid');
      await bad.close();
      const down = wire(d, { env: { AGENT_HOST_VOICE_API: 'http://127.0.0.1:9' } });
      await down.apiKeys.init();
      t.ok('つながらなければ unreachable', (await down.apiKeys.check(id)).code === 'unreachable');
      const lite = await w.apiKeys.add({ provider: 'custom', label: 'LiteLLM', key: L });
      t.ok('確かめ方の無いプロバイダーは unsupported（記録しない）', (await w.apiKeys.check(lite.id)).code === 'unsupported' && (await w.apiKeys.list()).keys.find(k => k.id === lite.id).lastCheck === null);
      // 使わない
      await w.apiKeys.setUse('voice', null);
      t.ok('使わないにすると通話は送らず、古い置き場の通話のキーも消える（古い版も送らない）', await w.apiKeys.useKey('voice') === null && (await w.voice.keys('openrouter')).length === 0 && await w.apiKeys.useKey('judge:jev') === B);
      // 削除
      const removed = await w.apiKeys.remove(id);
      t.ok('削除: 使っていた所が返り、判定器は使わないに戻り、値と古い置き場の項目も消える', removed.affected.some(u => u.kind === 'judge') && await w.apiKeys.useKey('judge:jev') === null
        && (await w.secrets.keys('key:')).length === 1 && (await w.compat.keys('delegation-routing:')).length === 0);
      t.ok('消したキーは確かめられない', (await rejects(() => w.apiKeys.check(id)))?.code === 'NOT_FOUND');
    }

    // ---- 接続先: keyRef で選ぶ・差し替え・削除
    {
      const d = await fresh();
      await seed(d);
      const w = wire(d, { env: { AGENT_HOST_VOICE_API: fake.url } });
      await w.apiKeys.init();
      const { id: keyId } = await w.apiKeys.add({ provider: 'custom', label: '社内 LiteLLM', key: L });
      const input = { agent: 'claude', name: '社内', preset: 'custom', baseUrl: compatApi.url, authMode: 'auto', keyRef: keyId,
        roles: { main: 'fake-large', opus: 'fake-large', sonnet: 'fake-large', haiku: 'fake-large' } };
      const checked = await w.eps.check(input);
      t.ok('登録済みのキーを選んで確認できる（値は API キーから読み、結果に出ない）', checked.ok && compatApi.requests.some(r => r.headers.authorization === `Bearer ${L}`) && !JSON.stringify(checked).includes(L));
      const noRef = await rejects(() => w.eps.check({ ...input, keyRef: 'key-ffffffffffff' }));
      t.ok('知らないキーは断る', noRef?.message.includes('選んだキー'));
      const stale = await rejects(() => w.eps.save({ ...input, keyRef: undefined }, checked.receipt));
      t.ok('別のキーで確認した受領証は、キーを変えたら使えない', stale?.message.includes('接続を確認'));
      const saved = await w.eps.save(input, checked.receipt);
      t.ok('保存: 接続先は keyRef を持ち、値を持たない・古い置き場の項目にも同じ値が書かれる', saved.keyRef === keyId && !(await fs.readFile(path.join(d, 'compat-endpoints.json'), 'utf8')).includes(L)
        && (await w.compat.get('compat-endpoint:' + saved.id))?.key === L && (await w.eps.list()).endpoints[0].keyRef === keyId);
      t.ok('API キーの一覧に、使っている接続先が並ぶ', (await w.apiKeys.list()).keys[0].uses.some(u => u.kind === 'endpoint' && u.id === saved.id));
      t.ok('会話で使う解決は keyRef の値', (await w.eps.resolve(saved.id, 'claude')).key === L);
      // 差し替え → 接続先は新しい値で確認できる
      await w.apiKeys.replace(keyId, A);
      const re = await w.eps.recheck(saved.id);
      t.ok('差し替えた後の確かめ直しは新しい値で行う（古い値は拒まれる偽の API で確かめ）', re.ok === true && compatApi.requests.filter(r => r.path === '/v1/messages').at(-1)?.headers.authorization === `Bearer ${A}`
        && (await w.compat.get('compat-endpoint:' + saved.id))?.key === A);
      // 「別のキーを入れる」: API キーに並ぶ。同じ値なら重ねない
      const typed = { ...input, name: '別名', keyRef: undefined, key: A };
      const typedChecked = await w.eps.check(typed);
      const typedSaved = await w.eps.save(typed, typedChecked.receipt);
      t.ok('別のキーを入れて保存すると API キーに 1 件として並ぶ（同じ値は重ねず、接続先は同じ keyRef）', typedSaved.keyRef === keyId && (await w.apiKeys.list()).keys.length === 1);
      const newer = { ...input, name: 'また別', keyRef: undefined, key: L };
      const newerSaved = await w.eps.save(newer, (await w.eps.check(newer)).receipt);
      const keys2 = (await w.apiKeys.list()).keys;
      t.ok('新しい値は別の件として登録される（名前は接続先の名前）', keys2.length === 2 && keys2.find(k => k.id === newerSaved.keyRef)?.label === 'また別');
      // 削除: 接続先はキー無し・確認に失敗した扱いで止まる（黙って公式に戻さない）
      const gone = await w.apiKeys.remove(keyId);
      t.ok('キーを削除すると、使っていた接続先の一覧にキー無しと失敗が出る', gone.affected.filter(u => u.kind === 'endpoint').length === 2
        && (await w.eps.list()).endpoints.filter(e => e.id === saved.id || e.id === typedSaved.id).every(e => !e.hasKey && e.keyRef === null && e.lastCheck.ok === false && e.ready === false));
      const stopped = await rejects(() => w.eps.resolve(saved.id, 'claude'));
      t.ok('消されたキーの接続先の会話は黙って公式に戻らず、EndpointError で止まる', stopped instanceof EndpointError && stopped.code === 'failed');
      t.ok('古い置き場の接続先の項目も消える（古い版が古いキーで送り続けない）', (await w.compat.keys('compat-endpoint:')).every(k => k !== 'compat-endpoint:' + saved.id && k !== 'compat-endpoint:' + typedSaved.id));
    }

    // ---- 値が一覧・ログ・イベントに出ない
    {
      const d = await fresh();
      const logs = [], events = [];
      await seed(d, { endpoints: [EP(EP1)], endpointKeys: { [EP1]: A }, voice: B });
      const secrets = createSecretStore({ file: path.join(d, 'api-key-secrets.json'), cipher: plainCipher });
      const compat = createSecretStore({ file: path.join(d, 'compat-endpoint-secrets.json'), cipher: plainCipher });
      const voice = createSecretStore({ file: path.join(d, 'voice-secrets.json'), cipher: plainCipher });
      let eps;
      const apiKeys = createApiKeys({ dataDir: d, secrets, legacy: { compat, voice }, endpoints: () => eps, log: (line, f) => logs.push(`${line} ${JSON.stringify(f ?? {})}`), onChange: c => events.push(c) });
      eps = createCompatEndpoints({ dataDir: d, secrets: compat, apiKeys });
      await apiKeys.init();
      await apiKeys.replace((await apiKeys.list()).uses.voice, 'sk-or-v1-' + 'z'.repeat(24));
      const everything = JSON.stringify({ list: await apiKeys.list(), logs, events, err: String((await rejects(() => apiKeys.add({ provider: 'openrouter', key: 'bad key with space ' + A })))?.message) });
      t.ok('一覧・ログ・イベント・エラー文にキーの値が出ない', ![A, B, 'z'.repeat(24)].some(v => everything.includes(v)));
    }
  } finally {
    await fake.close();
    await compatApi.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
