// API キーの置き場（core/api-keys.mjs。ADR 0155）。LLM は呼ばない。偽の OpenRouter・偽の互換 API とだけ話す。
// 移行（同じ値は 1 件・違う値は別の件・通話と判定器は登録済みの所だけ引き継ぐ・冪等・保留）・値を出さない・
// 差し替え/割り当て/削除が古い置き場にも書かれる・確認・接続先の keyRef を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApiKeys, providerOfEndpoint, normalizeApiKey } from '../../core/api-keys.mjs';
import { keyFitsEndpoint, keyMatchesEndpoint, providerName } from '../../web/api-keys-model.mjs';
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
    t.ok('プロバイダー: プリセットと URL のホストで決める', providerOfEndpoint({ preset: 'openrouter', baseUrl: 'https://openrouter.ai/api' }) === 'openrouter'
      && providerOfEndpoint({ preset: 'openrouter', baseUrl: 'https://proxy.example/api' }) === 'custom'
      && providerOfEndpoint({ preset: 'custom', baseUrl: 'https://openrouter.ai/api/v1' }) === 'openrouter'
      && providerOfEndpoint({ preset: 'custom', baseUrl: 'https://api.cerebras.ai/v1' }) === 'custom'
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
      t.ok('通話と Jev は、登録済みだったキーを選んだ状態で引き継ぐ', list.uses.voice === id && list.uses['judge:jev'] === id && !Object.hasOwn(list.uses, 'judge:cerebras'));
      t.ok('wait_until の問いは古い置き場を持たないので、移行しても選ばれない（人が選ぶまで画面を送らない）', list.uses['computer:decider'] === null && await w.apiKeys.useKey('computer:decider') === null);
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
      const firstOpenRouter = list.keys.find(k => k.provider === 'openrouter').id;
      t.ok('Cerebras の判定器のキーは取り込まず（古い置き場に残す）、選んでいたことは最初の OpenRouter のキーで判定器へ引き継ぐ', !list.keys.some(k => k.provider === 'cerebras')
        && list.uses['judge:jev'] === firstOpenRouter && list.keys.find(k => k.id === firstOpenRouter).uses.some(u => u.kind === 'endpoint') && (await w.compat.get('delegation-routing:cerebras'))?.key === C);
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

    // ---- 移行済みの台帳で Cerebras の判定器を選んでいた人（ADR 0177）: 読むときに OpenRouter の判定器へ移し、Cerebras のキーは使わないキーとして残す
    // （Cerebras を名前付きのプロバイダーにしなくなった ADR 0183 の後は、provider 'cerebras' のキーは custom（host なし）として読む）
    {
      const d = await fresh();
      const CB_EP = 'ep-444444444444';
      await seed(d, { endpoints: [EP(CB_EP, { name: 'Cerebras', preset: 'custom', baseUrl: 'https://api.cerebras.ai/v1', keyRef: 'key-0000000000c1' })] });
      const OR = 'key-0000000000a1', CB = 'key-0000000000c1';
      const ledger = JSON.stringify({ version: 1, migration: { done: true, at: '2026-10-01T00:00:00.000Z' }, keys: [{ id: CB, provider: 'cerebras', label: 'Cerebras' }, { id: OR, provider: 'openrouter', label: 'OpenRouter' }],
        uses: { voice: OR, 'judge:jev': null, 'judge:cerebras': CB }, guide: null });
      await fs.writeFile(path.join(d, 'api-keys.json'), ledger);
      const w = wire(d);
      await w.secrets.set('key:' + OR, { key: A });
      await w.secrets.set('key:' + CB, { key: C });
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok('Cerebras の判定器の割り当ては OpenRouter の判定器へ移り、判定器は OpenRouter のキーで送る', list.uses['judge:jev'] === OR && !Object.hasOwn(list.uses, 'judge:cerebras') && await w.apiKeys.useKey('judge:jev') === A);
      t.ok('Cerebras のキーは消さず、判定器・通話には使わないキーとして残る（接続先が選んでいれば接続先に使われ、値も残る）', list.keys.find(k => k.id === CB)?.uses.every(u => u.kind === 'endpoint') && (await w.secrets.get('key:' + CB))?.key === C);
      const cbKey = list.keys.find(k => k.id === CB);
      t.ok('provider が cerebras のキーは custom（host なし）に直り、id・名前は変わらない', cbKey?.provider === 'custom' && cbKey.host === null && cbKey.label === 'Cerebras' && list.keys.length === 2);
      t.ok('cerebras.ai の互換の接続先はそのキーに当てはまり（custom・host なし）、もう名前付きのプロバイダーではない',
        await w.apiKeys.fits(CB, { preset: 'custom', baseUrl: 'https://api.cerebras.ai/v1' }) === true && await w.apiKeys.fits(CB, { preset: 'custom', baseUrl: 'http://localhost:4000' }) === true
        && await w.apiKeys.fits(CB, { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api' }) === false && providerName('cerebras') === '');
      t.ok('そのキーを選んでいた接続先は、同じ id のまま同じ値で送れる', (await w.eps.rows())[0].keyRef === CB && (await w.eps.resolve(CB_EP, 'claude')).key === C);
      t.ok('起動だけでは台帳を書き直さない（同じデータを使う前の版の割り当てを消さない）', await fs.readFile(path.join(d, 'api-keys.json'), 'utf8') === ledger);
      await w.apiKeys.setUse('voice', null);
      const saved = JSON.parse(await fs.readFile(path.join(d, 'api-keys.json'), 'utf8'));
      t.ok('次に保存したときに、移した割り当てを書き、廃止した使い道を落とす', saved.uses['judge:jev'] === OR && !Object.hasOwn(saved.uses, 'judge:cerebras') && saved.keys.some(k => k.id === CB));
      t.ok('次に保存したときに、cerebras のキーを custom で書く（名前・id は変えない）', saved.keys.find(k => k.id === CB)?.provider === 'custom' && saved.keys.find(k => k.id === CB)?.label === 'Cerebras');
      const d2 = await fresh();
      await seed(d2, {});
      await fs.writeFile(path.join(d2, 'api-keys.json'), JSON.stringify({ version: 1, migration: { done: true }, keys: [{ id: CB, provider: 'cerebras', label: 'Cerebras' }], uses: { 'judge:cerebras': CB } }));
      const w2 = wire(d2);
      await w2.apiKeys.init();
      t.ok('OpenRouter のキーが無ければ判定器は「使わない」のまま（Cerebras のキーは OpenRouter へ送らない）', (await w2.apiKeys.list()).uses['judge:jev'] === null && await w2.apiKeys.useKey('judge:jev') === null);
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
    // ---- 保留: 暗号器が答えない・復号に失敗する（SECRET_LOCKED 以外の失敗も、キーを失わずに保留する）
    for (const [label, cipher] of [
      ['暗号器が答えない（main がつながっていない）', { status: async () => { throw new Error('main から応答がありません'); }, encrypt: async () => { throw new Error('x'); }, decrypt: async () => { throw new Error('x'); } }],
      ['復号に失敗する（鍵束が変わった）', { status: async () => ({ encrypted: true, backend: 'fake' }), encrypt: async v => v, decrypt: async () => { throw new Error('復号に失敗しました'); } }],
    ]) {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1)] });
      const sealed = { enc: 'safeStorage', data: 'zz', at: 'x' };
      await fs.writeFile(path.join(d, 'voice-secrets.json'), JSON.stringify({ version: 1, entries: { openrouter: sealed } }));
      await fs.writeFile(path.join(d, 'compat-endpoint-secrets.json'), JSON.stringify({ version: 1, entries: { ['compat-endpoint:' + EP1]: sealed } }));
      const w = wire(d, { cipher });
      await w.apiKeys.init();
      const list = await w.apiKeys.list();
      t.ok(`${label}: 移行を保留し、キー 0 件のまま「移行済み」にしない・何も書かない`, list.migration.state === 'deferred' && !(await exists(path.join(d, 'api-keys.json'))) && !(await exists(path.join(d, 'api-key-secrets.json'))),
        JSON.stringify(list.migration));
      t.ok(`${label}: 古い置き場のキーは消えず、接続先は keyRef を持たない`, (await w.compat.keys('compat-endpoint:')).length === 1 && (await w.eps.rows())[0].keyRef === null);
      const again = wire(d, { cipher: plainCipher });
      await fs.writeFile(path.join(d, 'voice-secrets.json'), JSON.stringify({ version: 1, entries: { openrouter: { enc: 'plain', data: JSON.stringify({ key: A }), at: 'x' } } }));
      await fs.writeFile(path.join(d, 'compat-endpoint-secrets.json'), JSON.stringify({ version: 1, entries: { ['compat-endpoint:' + EP1]: { enc: 'plain', data: JSON.stringify({ key: A }), at: 'x' } } }));
      await again.apiKeys.init();
      const done = await again.apiKeys.list();
      t.ok(`${label}: 読めるようになった起動で、同じ置き場から移行できる`, done.migration.state === 'done' && done.keys.length === 1 && done.uses.voice === done.keys[0].id);
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
      const other = (await w.apiKeys.add({ provider: 'custom', label: 'Cerebras', key: C })).id;
      t.ok('プロバイダーの違うキーは割り当てられない（判定器は OpenRouter）・廃止した Cerebras の判定器は知らない使い道', (await rejects(() => w.apiKeys.setUse('judge:jev', other)))?.code === 'PROVIDER_MISMATCH'
        && (await rejects(() => w.apiKeys.setUse('judge:cerebras', id)))?.code === 'UNKNOWN_USE'
        && (await rejects(() => w.apiKeys.setUse('computer:decider', 'key-000000000000')))?.code === 'NOT_FOUND'
        && (await rejects(() => w.apiKeys.setUse('nope', id)))?.code === 'UNKNOWN_USE' && (await rejects(() => w.apiKeys.setUse('voice', 'key-000000000000')))?.code === 'NOT_FOUND');
      await w.apiKeys.remove(other);
      w.events.length = 0;
      await w.apiKeys.setUse('voice', id);
      t.ok('選んだときから使う: 通話が値を読め、古い置き場にも同じ値が書かれ、変更が配られる', await w.apiKeys.useKey('voice') === A && (await w.voice.get('openrouter'))?.key === A && w.events.some(e => e.uses?.includes('voice')));
      await w.apiKeys.setUse('judge:jev', id);
      t.ok('Jev も同じキーを選べて、古い置き場の delegation-routing:openrouter にも書かれる', await w.apiKeys.useKey('judge:jev') === A && (await w.compat.get('delegation-routing:openrouter'))?.key === A);
      const legacyBefore = [...await w.voice.keys(''), ...await w.compat.keys('')].sort().join();
      w.events.length = 0;
      await w.apiKeys.setUse('computer:decider', id);
      list = await w.apiKeys.list();
      t.ok('wait_until の問いも同じキーを選べて、使っている所に並び、変更が配られる', await w.apiKeys.useKey('computer:decider') === A && list.uses['computer:decider'] === id
        && list.keys[0].uses.some(u => u.kind === 'computer') && w.events.some(e => e.uses?.includes('computer:decider')) && !JSON.stringify(list).includes(A));
      t.ok('wait_until の問いは古い置き場に書かない（ADR 0155 の後に足した割り当て）', [...await w.voice.keys(''), ...await w.compat.keys('')].sort().join() === legacyBefore);
      // 差し替え
      await w.apiKeys.replace(id, B);
      t.ok('差し替え: 使っている所すべてが新しい値で送り、古い置き場にも新しい値が書かれる', await w.apiKeys.useKey('voice') === B && await w.apiKeys.useKey('judge:jev') === B && await w.apiKeys.useKey('computer:decider') === B
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
        && removed.affected.some(u => u.kind === 'computer') && await w.apiKeys.useKey('computer:decider') === null && (await w.apiKeys.list()).uses['computer:decider'] === null
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

    // ---- キーを別のホストへ送らない（接続先のフォームの既定・サーバーの connectionOf）
    {
      const lite = (url) => ({ preset: 'custom', baseUrl: url });
      t.ok('キーとホスト: ホストの決まったプロバイダーはホストが合うときだけ。自前のキーは元のホストだけ・まだ結び付いていないキーは選べるが既定にしない',
        keyFitsEndpoint({ provider: 'openrouter' }, { preset: 'openrouter', baseUrl: 'https://openrouter.ai/api' })
        && !keyFitsEndpoint({ provider: 'openrouter' }, { preset: 'openrouter', baseUrl: 'https://proxy.example/api' })
        && keyFitsEndpoint({ provider: 'custom', host: 'a.example' }, lite('https://a.example/v1')) && !keyFitsEndpoint({ provider: 'custom', host: 'a.example' }, lite('https://b.example/v1'))
        && keyFitsEndpoint({ provider: 'custom', host: null }, lite('https://b.example/v1')) && !keyMatchesEndpoint({ provider: 'custom', host: null }, lite('https://b.example/v1'))
        && keyMatchesEndpoint({ provider: 'custom', host: 'a.example' }, lite('https://a.example/v1')));
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1, { name: 'A のホスト', preset: 'custom', baseUrl: 'http://127.0.0.1:' + new URL(compatApi.url).port }), EP(EP2, { name: 'ほかのホスト', preset: 'custom', baseUrl: 'http://localhost:' + new URL(compatApi.url).port }), EP(EP3, { name: '同じ値', preset: 'custom', baseUrl: 'http://localhost:1' })],
        endpointKeys: { [EP1]: L, [EP2]: L, [EP3]: L } });
      const w = wire(d);
      await w.apiKeys.init();
      const keys = (await w.apiKeys.list()).keys;
      t.ok('移行: 同じ値でも別のホストの接続先は別の件（ホストを持つ。同じホストなら 1 件）。キーを別のホストへ送らない', keys.length === 2 && keys.every(k => k.provider === 'custom' && k.host) && new Set(keys.map(k => k.host)).size === 2, JSON.stringify(keys.map(k => k.host)));
      const [e1] = (await w.eps.list()).endpoints.filter(e => e.id === EP1);
      const base = { agent: 'claude', name: 'x', preset: 'custom', baseUrl: compatApi.url, authMode: 'auto', roles: { main: 'm', opus: 'm', sonnet: 'm', haiku: 'm' } };
      const own = keys.find(k => k.id === e1.keyRef);
      const ok = await w.eps.check({ ...base, keyRef: own.id });
      t.ok('自分のホストのキーなら確認できる', ok.ok === true);
      const other = keys.find(k => k.host.startsWith('localhost') && k.id !== own.id);
      const wrong = await rejects(() => w.eps.check({ ...base, keyRef: other.id }));
      t.ok('別のホスト用のキー（keyRef）は確認の前に断る。値は送らない', wrong?.message.includes('URL（ホスト）用ではありません') && !compatApi.requests.some(r => r.path.includes('never')));
      const edited = await rejects(() => w.eps.check({ agent: 'claude', baseUrl: 'http://localhost:1', authMode: 'auto', probeModel: 'm' }, { id: EP1 }));
      t.ok('保存済みの接続先の URL を別のホストへ変えたら、元のキーでは確認できない（保存済みのキーを黙って送らない）', edited?.message.includes('URL（ホスト）用ではありません'));
      // OpenRouter のプリセットのまま URL を別のホストへ
      const orKey = await w.apiKeys.add({ provider: 'openrouter', label: 'OR', key: A });
      const proxied = await rejects(() => w.eps.check({ ...base, preset: 'openrouter', keyRef: orKey.id }));
      t.ok('OpenRouter のプリセットでも、URL のホストが openrouter.ai でなければ OpenRouter のキーは選べない', proxied?.message.includes('URL（ホスト）用ではありません'));
      // まだ結び付いていないキー（「その他」で登録）は、初めて保存した接続先のホストに結び付く
      const free = await w.apiKeys.add({ provider: 'custom', label: '自由', key: L });
      t.ok('「その他」で登録したキーはホストを持たない', (await w.apiKeys.list()).keys.find(k => k.id === free.id).host === null);
      const bound = await w.eps.check({ ...base, keyRef: free.id }).catch(e => e);
      t.ok('結び付いていないキーは選べる（確認の相手はまだ A）', bound?.ok === true || compatApi.requests.length > 0);
      const savedFree = await w.eps.save({ ...base, keyRef: free.id }, bound.receipt).catch(e => e);
      t.ok('保存すると、そのホストに結び付く', !(savedFree instanceof Error) && (await w.apiKeys.list()).keys.find(k => k.id === free.id).host === '127.0.0.1', String(savedFree?.message ?? ''));
      t.ok('結び付いた後は別のホストでは選べない', (await rejects(() => w.eps.check({ ...base, baseUrl: 'http://localhost:' + new URL(compatApi.url).port, keyRef: free.id })))?.message.includes('URL（ホスト）用ではありません'));
      // 入力したキーは、同じ値でもホストが違えば別の件
      const typed = { ...base, baseUrl: 'http://localhost:' + new URL(compatApi.url).port, key: L };
      const typedChecked = await w.eps.check(typed);
      const typedSaved = await w.eps.save({ ...typed, name: 'また別' }, typedChecked.receipt);
      t.ok('入力したキーは、値が同じでもホストが違えば重ねない（同じホストなら重ねる）', typedSaved.keyRef === other.id);
    }

    // ---- 台帳に無いキーを指す接続先・古い keyRef・削除の保存が失敗したとき
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1), EP(EP2, { agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1' })], endpointKeys: { [EP1]: A, [EP2]: A } });
      const w = wire(d);
      await w.apiKeys.init();
      const id = (await w.apiKeys.list()).keys[0].id;
      // 削除の保存が失敗する（台帳の置き場所をふさぐ）→ 接続先は外れず、キーも残る
      const ledger = path.join(d, 'api-keys.json');
      await fs.rm(ledger); await fs.mkdir(ledger);
      const failed = await rejects(() => w.apiKeys.remove(id));
      await fs.rm(ledger, { recursive: true });
      t.ok('削除の保存に失敗したら、接続先は keyRef のまま（接続先だけ外れない）・キーも消えない', failed !== null && (await w.eps.list()).endpoints.every(e => e.keyRef === id && e.hasKey) && (await w.secrets.get('key:' + id))?.key === A);
      // 台帳に無いキーを指す参照（削除の途中で止まった）は、次の起動で外れて止まる
      await fs.writeFile(ledger, JSON.stringify({ version: 1, migration: { done: true, at: 'x' }, keys: [], uses: {}, guide: null }));
      const next = wire(d);
      await next.apiKeys.init();
      const rows = (await next.eps.list()).endpoints;
      t.ok('台帳に無いキーを指す keyRef は次の起動で外れ、確認に失敗した扱いで止まる', rows.every(e => !e.hasKey && e.keyRef === null && e.lastCheck.ok === false) && (await rejects(() => next.eps.resolve(EP1, 'claude'))) instanceof EndpointError);
      t.ok('外した接続先の古い置き場のキーも消える（古い版が送り続けない）', (await next.compat.keys('compat-endpoint:')).length === 0);
    }
    {
      // 途中で保留になった移行の後に古い方法でキーを外した接続先の keyRef が、次の移行で消える
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1), EP(EP2, { agent: 'codex', baseUrl: 'https://openrouter.ai/api/v1' })], endpointKeys: { [EP1]: A } });
      const rows = JSON.parse(await fs.readFile(path.join(d, 'compat-endpoints.json'), 'utf8'));
      rows.endpoints[1].keyRef = 'key-aaaaaaaaaaaa';   // 古い移行が途中まで書いた keyRef（EP2 のキーは古い方法で外してある）
      await fs.writeFile(path.join(d, 'compat-endpoints.json'), JSON.stringify(rows));
      const w = wire(d);
      await w.apiKeys.init();
      const byId = Object.fromEntries((await w.eps.list()).endpoints.map(e => [e.id, e]));
      t.ok('移行は接続先の keyRef を結果のとおりに書く（キーの無い接続先の古い keyRef は残らない）', byId[EP1].keyRef && byId[EP2].keyRef === null && !byId[EP2].hasKey);
    }

    // ---- 移行済みで、キーを使う接続先に keyRef が無ければ、空のキーで送らず止まる
    {
      const d = await fresh();
      await seed(d, { endpoints: [EP(EP1), EP(EP2, { agent: 'codex', name: 'ローカル', preset: 'ollama', baseUrl: 'http://localhost:11434/v1', auth: 'none' })] });
      const w = wire(d);
      await w.apiKeys.init();
      const stopped = await rejects(() => w.eps.resolve(EP1, 'claude'));
      t.ok('keyRef の無い（bearer の）接続先は、空のキーで走らず EndpointError で止まる', stopped instanceof EndpointError && stopped.code === 'unreadable' && stopped.message.includes('キーが選ばれていません'), String(stopped?.message));
      t.ok('キーの要らない接続先（auth: none）は今までどおり走る', (await w.eps.resolve(EP2, 'codex')).key === '');
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
