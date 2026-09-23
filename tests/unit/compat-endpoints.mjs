// 互換の接続先（core/compat-endpoints.mjs）。LLM は呼ばない。偽の互換 API（tests/lib/fake-compat-api.mjs）とだけ話す。
// 保存（確認が通った値だけ）・キーが漏れない・確認の成功と失敗（キー違い・Chat Completions だけ・リダイレクト・公開の http）・
// 使えない接続先で止める・env と Codex の上書きの組み立てを確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCompatEndpoints, claudeCompatEnv, claudeCompatVars, codexCompatThread, codexProviderId, writeClaudeFlagSettings,
  sweepClaudeFlagSettings, normalizeUrl, EndpointError, CheckError, NO_KEY } from '../../core/compat-endpoints.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

export const name = 'compat-endpoints';
export const title = '互換の接続先: 確認してから保存・キーを出さない・確認の失敗の出し分け・使えない接続先で止める・env と Codex の上書き';

const KEY = 'sk-compat-' + 'k'.repeat(24);
const OTHER = 'sk-compat-' + 'o'.repeat(24);

async function rejects(fn) { try { await fn(); return null; } catch (e) { return e; } }

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compat-'));
  const api = await startFakeCompatApi({ keys: [KEY], auth: 'bearer' });
  try {
    const secrets = createSecretStore({ file: path.join(dir, 'compat-endpoint-secrets.json'), cipher: plainCipher });
    const eps = createCompatEndpoints({ dataDir: dir, secrets });

    // ---- URL の検査
    t.ok('Claude の URL の末尾の /v1 は断る', (await rejects(() => normalizeUrl('claude', 'https://x.example/v1')))?.message.includes('/v1'));
    t.ok('URL の userinfo は断る', (await rejects(() => normalizeUrl('codex', 'https://u:p@x.example/v1')))?.message.includes('パスワード'));
    t.ok('URL のクエリは断る', (await rejects(() => normalizeUrl('codex', 'https://x.example/v1?a=1'))) instanceof CheckError);
    t.ok('<リソース名> が残っていれば断る', (await rejects(() => normalizeUrl('codex', 'https://<リソース名>.openai.azure.com/openai/v1')))?.message.includes('置き換え'));
    t.ok('末尾の / は落とす', normalizeUrl('codex', 'http://localhost:11434/v1/') === 'http://localhost:11434/v1');

    // ---- Claude: 確認 → 保存
    const input = { agent: 'claude', name: '偽の互換', preset: 'custom', baseUrl: api.url, authMode: 'auto', key: KEY,
      roles: { main: 'fake-large', opus: 'fake-large', sonnet: 'fake-large', haiku: 'vendor/fake-small' } };
    const noReceipt = await rejects(() => eps.save(input, 'nope'));
    t.ok('確認していない値は保存できない', noReceipt?.message.includes('接続を確認'));
    const checked = await eps.check(input);
    const probe = api.requests.find(r => r.path === '/v1/messages');
    t.ok('確認は POST /v1/messages を max_tokens 1 で 1 回送る', probe && probe.body?.max_tokens === 1 && probe.headers['anthropic-version'] === '2023-06-01');
    t.ok('自動の認証は Bearer から試す', checked.auth === 'bearer' && probe.headers.authorization === `Bearer ${KEY}`);
    t.ok('モデルの一覧を GET /v1/models で取る', checked.models.includes('vendor/fake-small') && api.requests.some(r => r.method === 'GET' && r.path.startsWith('/v1/models')));
    t.ok('確認の結果にキーは出ない', !JSON.stringify(checked).includes(KEY));
    const changed = await rejects(() => eps.save({ ...input, baseUrl: api.url + '/other' }, checked.receipt));
    t.ok('URL を変えたら受領証は使えない', changed?.message.includes('接続を確認'));
    const missingRole = await rejects(() => eps.save({ ...input, roles: { ...input.roles, haiku: '' } }, checked.receipt));
    t.ok('空の役割があると保存できない', missingRole?.message.includes('Haiku 相当'));
    const { id } = await eps.save(input, checked.receipt);
    t.ok('保存すると ep- の id が付く', /^ep-[a-f0-9]{12}$/.test(id));
    const again = await rejects(() => eps.save(input, checked.receipt));
    t.ok('受領証は 1 回しか使えない', again instanceof CheckError);

    const listed = await eps.list('claude');
    const row = listed.endpoints[0];
    t.ok('一覧はキーを返さず hasKey だけ', row.hasKey === true && !JSON.stringify(listed).includes(KEY));
    t.ok('一覧に確認の結果とモデルが残る', row.lastCheck?.ok === true && row.models.includes('fake-large') && row.auth === 'bearer');
    const onDisk = await fs.readFile(path.join(dir, 'compat-endpoints.json'), 'utf8');
    t.ok('一覧のファイルにキーを書かない', !onDisk.includes(KEY));
    t.ok('キーは秘密の置き場に入る', (await secrets.get('compat-endpoint:' + id))?.key === KEY);

    // ---- 編集: キー欄が空なら保存済みのキーで確かめる
    const edited = await eps.check({ ...input, key: '', name: '名前だけ変える' }, { id });
    await eps.save({ ...input, key: '', name: '名前だけ変える' }, edited.receipt, { id });
    t.ok('編集でキー欄が空なら保存済みのキーを使う', (await eps.get(id)).name === '名前だけ変える' && (await secrets.get('compat-endpoint:' + id))?.key === KEY);

    // ---- 失敗の出し分け
    const badKey = await rejects(() => eps.check({ ...input, key: OTHER }));
    t.ok('キー違いは Bearer と x-api-key の両方で試して断る', badKey?.code === 'auth' && badKey.lines.join('').includes('Bearer と x-api-key の両方'));
    t.ok('キー違いのエラー文にキーを出さない', !JSON.stringify({ m: badKey.message, l: badKey.lines }).includes(OTHER));
    api.set({ auth: 'x-api-key' });
    const xkey = await eps.check(input);
    t.ok('自動の認証は x-api-key に切り替えて通す', xkey.auth === 'x-api-key');
    api.set({ auth: 'bearer', messages: false });
    const notFound = await rejects(() => eps.check(input));
    t.ok('/v1/messages が無ければ URL を確かめるよう言う', notFound?.code === 'not-found' && notFound.message.includes('/v1/messages'));
    api.set({ messages: true, knownModels: ['only-this'] });
    const unknownModel = await eps.check(input);
    t.ok('知らないモデルのエラーでも URL とキーが通れば成功にする', unknownModel.ok && unknownModel.lines.some(l => l.includes('URL とキーは通っています')));
    api.set({ knownModels: [], models: null });
    const noModels = await eps.check(input);
    t.ok('モデルの一覧が取れなくても失敗にしない', noModels.ok && noModels.models.length === 0 && noModels.lines.some(l => l.includes('取れませんでした')));
    api.set({ models: ['fake-large', 'vendor/fake-small'], redirect: true });
    const redirected = await rejects(() => eps.check(input));
    t.ok('リダイレクトは追わない（キーを別の宛先へ送らない）', redirected?.code === 'redirect');
    t.ok('リダイレクト先に要求を送っていない', !api.requests.some(r => r.path.includes('elsewhere')));
    api.set({ redirect: false });
    const publicHttp = await rejects(() => createCompatEndpoints({ dataDir: dir, secrets, lookup: async () => [{ address: '93.184.216.34', family: 4 }] })
      .check({ ...input, baseUrl: 'http://api.example.com' }));
    t.ok('公開のアドレスへの http は断る', publicHttp?.message.includes('https'));
    const privateHttp = await rejects(() => createCompatEndpoints({ dataDir: dir, secrets, lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: async () => new Response('{}', { status: 200 }) })
      .check({ ...input, baseUrl: 'http://litellm.internal:4000' }));
    t.ok('社内のアドレスへの http は通す', privateHttp === null, privateHttp?.message);

    // ---- Codex: Responses と Chat Completions だけの先
    const codexInput = { agent: 'codex', name: 'Responses の偽物', preset: 'custom', baseUrl: api.url + '/v1', authMode: 'bearer', key: KEY, roles: { main: 'fake-large' } };
    api.requests.length = 0;
    const cx = await eps.check(codexInput);
    const rq = api.requests.find(r => r.path === '/v1/responses');
    t.ok('Codex の確認は POST /responses を送る', cx.ok && rq && rq.body?.stream === false && rq.headers.authorization === `Bearer ${KEY}`);
    t.ok('Codex のモデルは GET /models で取る', cx.models.includes('fake-large') && api.requests.some(r => r.path === '/v1/models'));
    const { id: codexId } = await eps.save(codexInput, cx.receipt);
    api.set({ responses: false });
    const chatOnly = await rejects(() => eps.check(codexInput));
    t.ok('Chat Completions だけの先は理由を付けて断る', chatOnly?.code === 'chat-only' && chatOnly.message.includes('Chat Completions') && chatOnly.lines.join('').includes('/chat/completions は応答します'));
    t.ok('Chat Completions の見分けは本文の無い要求（生成しない）', api.requests.filter(r => r.path === '/v1/chat/completions').every(r => !r.body?.messages));
    api.set({ chat: false });
    const neither = await rejects(() => eps.check(codexInput));
    t.ok('どちらも無ければ URL を確かめるよう言う', neither?.code === 'not-found');
    api.set({ responses: true, chat: true });
    const codexBad = await rejects(() => eps.check({ ...codexInput, key: OTHER }));
    t.ok('Codex のキー違い', codexBad?.code === 'auth' && !codexBad.lines.join('').includes(OTHER));

    // ---- 既定・解決・削除
    t.ok('既定は初めは公式', (await eps.defaultFor('claude')) === '');
    const wrongAgent = await rejects(() => eps.setDefault('codex', id));
    t.ok('別のエージェントの接続先は既定にできない', wrongAgent !== null);
    await eps.setDefault('claude', id);
    t.ok('「既定にする」で既定になる', (await eps.defaultFor('claude')) === id && (await eps.list('claude')).endpoints[0].isDefault);
    t.ok("resolve('') は公式（null）", (await eps.resolve('', 'claude')) === null);
    const resolved = await eps.resolve(id, 'claude');
    t.ok('resolve はキーと役割を返す（server の中だけで使う）', resolved.key === KEY && resolved.roles.haiku === 'vendor/fake-small' && resolved.baseUrl === api.url);
    const agentMismatch = await rejects(() => eps.resolve(codexId, 'claude'));
    t.ok('エージェント違いは止める', agentMismatch instanceof EndpointError && agentMismatch.code === 'agent');
    // 確認に失敗した接続先
    api.set({ keys: [OTHER] });
    const re = await eps.recheck(codexId);
    t.ok('一覧からの確認の失敗を記録する', re.ok === false && (await eps.get(codexId)).lastCheck.ok === false && (await eps.get(codexId)).ready === false);
    const failed = await rejects(() => eps.resolve(codexId, 'codex'));
    t.ok('確認に失敗している接続先は止める（黙って公式に戻さない）', failed instanceof EndpointError && failed.code === 'failed');
    api.set({ keys: [KEY] });
    t.ok('確認し直して通れば使える', (await eps.recheck(codexId)).ok && (await eps.resolve(codexId, 'codex')).key === KEY);
    await eps.remove(id);
    t.ok('削除すると既定も公式に戻る', (await eps.defaultFor('claude')) === '');
    t.ok('削除するとキーも消える', (await secrets.get('compat-endpoint:' + id)) === undefined);
    const deleted = await rejects(() => eps.resolve(id, 'claude'));
    t.ok('削除済みの接続先は止める', deleted instanceof EndpointError && deleted.code === 'deleted');

    // ---- Claude への注入
    const ep = { id: 'ep-aaaaaaaaaaaa', name: 'X', baseUrl: 'https://gw.example', auth: 'bearer', key: KEY,
      roles: { main: 'm/main', opus: 'm/opus', sonnet: 'm/sonnet', haiku: 'm/haiku' }, options: {} };
    const parent = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-parent', ANTHROPIC_BASE_URL: 'https://parent', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-parent', CLAUDE_CODE_USE_BEDROCK: '1' };
    const parentCopy = JSON.stringify(parent);
    const env = claudeCompatEnv(parent, ep, { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' });
    t.ok('親の ANTHROPIC_* を上書きする', env.ANTHROPIC_BASE_URL === 'https://gw.example' && env.ANTHROPIC_API_KEY === '' && env.ANTHROPIC_AUTH_TOKEN === KEY);
    t.ok('OAuth トークンを互換の先へ渡さない', env.CLAUDE_CODE_OAUTH_TOKEN === '' && !Object.values(env).includes('sk-ant-oat01-parent'));
    t.ok('CLAUDE_CODE_USE_* を消す', env.CLAUDE_CODE_USE_BEDROCK === '');
    t.ok('役割のモデルを入れる', env.ANTHROPIC_MODEL === 'm/main' && env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'm/haiku' && env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'm/opus');
    t.ok('安定化の変数を入れる', env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === '1' && env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1');
    t.ok('思考を送らない既定では thinking と effort を止める', env.CLAUDE_CODE_DISABLE_THINKING === '1' && env.CLAUDE_CODE_EFFORT_LEVEL === 'unset');
    t.ok('extra と他の変数は残す', env.PATH === '/bin' && env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === '0');
    t.ok('base は書き換えない', JSON.stringify(parent) === parentCopy);
    const thinking = claudeCompatVars({ ...ep, options: { sendThinking: true, contextTokens: 131072 } });
    t.ok('「思考を送る」がオンなら止めない', thinking.CLAUDE_CODE_DISABLE_THINKING === '' && thinking.CLAUDE_CODE_EFFORT_LEVEL === '');
    t.ok('コンテキスト長を申告する', thinking.CLAUDE_CODE_MAX_CONTEXT_TOKENS === '131072');
    const xk = claudeCompatVars({ ...ep, auth: 'x-api-key' });
    t.ok('x-api-key の接続先は ANTHROPIC_API_KEY に入れる', xk.ANTHROPIC_API_KEY === KEY && xk.ANTHROPIC_AUTH_TOKEN === '');
    const nokey = claudeCompatVars({ ...ep, auth: 'none', key: '' });
    t.ok('キーの無い接続先にもダミーの Bearer を入れる（ログイン中の OAuth を送らせない）', nokey.ANTHROPIC_AUTH_TOKEN === NO_KEY);
    const flag = await writeClaudeFlagSettings(dir, ep);
    const flagBody = JSON.parse(await fs.readFile(flag.file, 'utf8'));
    t.ok('フラグ設定のファイルに同じ env を書く', flagBody.env.ANTHROPIC_BASE_URL === 'https://gw.example' && flagBody.env.ANTHROPIC_AUTH_TOKEN === KEY);
    if (process.platform !== 'win32') t.ok('フラグ設定のファイルは 0600', ((await fs.stat(flag.file)).mode & 0o777) === 0o600);
    await flag.dispose();
    t.ok('dispose でフラグ設定のファイルを消す', await fs.access(flag.file).then(() => false, () => true));
    const stale = await writeClaudeFlagSettings(dir, ep);
    t.ok('残ったフラグ設定のファイルを起動時に片付ける', (await sweepClaudeFlagSettings(dir)) === 1 && await fs.access(stale.file).then(() => false, () => true));

    // ---- Codex への注入
    const cep = { id: 'ep-bbbbbbbbbbbb', name: 'Y', baseUrl: 'https://gw.example/v1', auth: 'bearer', key: KEY, roles: { main: 'x' }, options: { contextTokens: 32768 } };
    const thread = codexCompatThread(cep);
    const def = thread.config[`model_providers.${thread.modelProvider}`];
    t.ok('Codex は modelProvider と model_providers.<id> を渡す', /^ply_ep_b+_[0-9a-f]{8}$/.test(thread.modelProvider) && def.base_url === cep.baseUrl && def.wire_api === 'responses');
    t.ok('Codex の鍵は experimental_bearer_token（argv に出ない）', def.experimental_bearer_token === KEY && !def.env_key);
    t.ok('Codex のコンテキスト長', thread.config.model_context_window === 32768);
    const az = codexCompatThread({ ...cep, auth: 'api-key' }).config;
    t.ok('api-key の接続先は http_headers', Object.values(az).find(v => v?.http_headers)?.http_headers['api-key'] === KEY);
    t.ok('接続情報が変われば provider の id も変わる', codexProviderId(cep) !== codexProviderId({ ...cep, key: OTHER }) && codexProviderId(cep) === codexProviderId({ ...cep }));
    t.ok('provider の id にキーそのものは入らない', !codexProviderId(cep).includes('compat'));
  } finally {
    await api.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
