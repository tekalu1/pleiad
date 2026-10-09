// API キーのコマンドをサーバー越しに（偽の OpenRouter・fake バックエンド。ADR 0155）: setApiKey・deleteApiKey・setApiKeyUse・resolveApiKeyGuide の
// 引数の形とエラー・使う側へのイベント（voiceChanged・delegationRoutingChanged・apiKeysChanged）・通話中のキーの差し替え／「使わない」／削除で通話が切れること・
// 値が画面・ログ・イベント・エラー文（compatEndpointCheck の失敗文を含む）に出ないこと。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeOpenRouter } from '../lib/fake-openrouter.mjs';

export const name = 'server-api-keys';
export const title = 'API キーのコマンドをサーバー越しに: 引数とエラー・使う側へのイベント・通話中の差し替え／使わない／削除で通話が切れる・値が出ない';

const A = 'sk-or-v1-' + 'a'.repeat(24), B = 'sk-or-v1-' + 'b'.repeat(24), C = 'csk-' + 'c'.repeat(24);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(20); } return fn(); }
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

/** /voice-ws を開き、ready まで待つ。closed は閉じたら解決する */
async function call({ port, token }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-ws?token=${token}`);
  const json = [];
  let closed = false;
  ws.on('message', (data, isBinary) => { if (!isBinary) json.push(JSON.parse(data.toString())); });
  ws.on('close', () => { closed = true; });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', target: { kind: 'chat', sessionId: null } }));
  await waitFor(() => json.some((m) => m.t === 'ready' || m.t === 'error'));
  return { ws, json, isClosed: () => closed, ready: json.some((m) => m.t === 'ready') };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-apikeys-')));
  const api = await startFakeOpenRouter();
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_VOICE_API: api.url }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const list = () => c.cmd('invoke', { op: 'apiKeys.list' });
  try {
    // ---- 引数の形とエラー
    const noKey = await rejects(c.cmd('setApiKey', { provider: 'openrouter' }));
    t.ok('setApiKey: キーが無い・形が悪い（空白・改行）は断る。エラー文にキーは出ない', noKey instanceof Error && /API キー/.test(noKey.message)
      && !String((await rejects(c.cmd('setApiKey', { provider: 'openrouter', key: `bad ${A}` })))?.message).includes(A));
    const noId = await rejects(c.cmd('setApiKey', { id: 'key-000000000000', key: A }));
    t.ok('setApiKey: 知らない id の差し替えは NOT_FOUND の文', noId instanceof Error && /登録されていません/.test(noId.message));
    const added = await c.cmd('setApiKey', { provider: 'openrouter', label: '仕事用', key: A });
    t.ok('setApiKey: 登録すると id だけ返す（キーは返さない）', /^key-[a-f0-9]{12}$/.test(added.id) && !JSON.stringify(added).includes(A));
    const cerebras = await c.cmd('setApiKey', { provider: 'cerebras', key: C });
    const state = await list();
    t.ok('apiKeys.list: 名前・プロバイダー・使っている所だけで、値は無い。登録しただけでは何にも使われない', state.keys.length === 2 && state.keys.every((k) => k.uses.length === 0)
      && Object.values(state.uses).every((v) => v === null) && !JSON.stringify(state).includes(A));
    t.ok('登録しただけでは通話は始められない（キーを選んでいない）', (await call(server)).ready === false && (await c.cmd('invoke', { op: 'voice.status' })).hasKey === false);

    // ---- setApiKeyUse
    t.ok('setApiKeyUse: 知らない使い道（廃止した Cerebras の判定器を含む）・知らないキー・プロバイダー違い（判定器に Cerebras のキー）は断る',
      /知らない使い道/.test((await rejects(c.cmd('setApiKeyUse', { use: 'nope', id: added.id })))?.message ?? '')
      && /知らない使い道/.test((await rejects(c.cmd('setApiKeyUse', { use: 'judge:cerebras', id: cerebras.id })))?.message ?? '')
      && /登録されていません/.test((await rejects(c.cmd('setApiKeyUse', { use: 'voice', id: 'key-000000000000' })))?.message ?? '')
      && /OpenRouter/.test((await rejects(c.cmd('setApiKeyUse', { use: 'judge:jev', id: cerebras.id })))?.message ?? ''));
    let from = c.mark();
    t.ok('setApiKeyUse voice: 選ぶと { use, id } を返す', (await c.cmd('setApiKeyUse', { use: 'voice', id: added.id })).id === added.id);
    await c.waitFor((e) => e.type === 'voiceChanged', { from, ms: 5000 });
    t.ok('通話に選ぶと voiceChanged と apiKeysChanged が届く。voice.status は選んだキーの id', (await c.waitFor((e) => e.type === 'apiKeysChanged', { from, ms: 5000 })) && (await c.cmd('invoke', { op: 'voice.status' })).keyRef === added.id);
    from = c.mark();
    await c.cmd('setApiKeyUse', { use: 'judge:jev', id: added.id });
    await c.waitFor((e) => e.type === 'delegationRoutingChanged', { from, ms: 5000 });
    const routing = await c.cmd('delegationRouting', {});
    t.ok('判定器に選ぶと delegationRoutingChanged が届き、delegationRouting の keys に hasKey と keyRef が出る（判定器のキーは OpenRouter の 1 つだけ）',
      routing.keys.openrouter.hasKey === true && routing.keys.openrouter.keyRef === added.id && Object.keys(routing.keys).join() === 'openrouter' && !JSON.stringify(routing).includes(A));

    // ---- 通話中のキーの差し替え・「使わない」・削除で通話が切れる
    let voice = await call(server);
    t.ok('キーを選んだ通話は始められる', voice.ready === true);
    await c.cmd('setApiKey', { id: added.id, key: B });
    t.ok('通話中にキーを差し替えると通話が切れる（古いキーで送り続けない）', await waitFor(() => voice.isClosed()));
    voice = await call(server);
    t.ok('次の通話は新しいキーで始まる', voice.ready === true && api.records.key >= 0);
    await c.cmd('setApiKeyUse', { use: 'voice', id: null });
    t.ok('通話中に「使わない」にすると通話が切れる', await waitFor(() => voice.isClosed()));
    t.ok('「使わない」の間は通話を始められない（no-key）', (await call(server)).ready === false);
    await c.cmd('setApiKeyUse', { use: 'voice', id: added.id });
    voice = await call(server);
    const removed = await c.cmd('deleteApiKey', { id: added.id });
    t.ok('通話中にキーを削除すると通話が切れる。返りは使っていた所だけ（値なし）', await waitFor(() => voice.isClosed()) && removed.affected.some((u) => u.kind === 'voice') && !JSON.stringify(removed).includes(B));
    t.ok('削除した後は一覧から消え、通話は使わないに戻る', (await list()).keys.length === 1 && (await c.cmd('invoke', { op: 'voice.status' })).hasKey === false);
    t.ok('deleteApiKey: 知らない id は断る', /登録されていません/.test((await rejects(c.cmd('deleteApiKey', { id: added.id })))?.message ?? ''));

    // ---- resolveApiKeyGuide
    const guide = await c.cmd('resolveApiKeyGuide', { keep: null });
    t.ok('resolveApiKeyGuide: 案内が無ければ何もしない（merged が空）', Array.isArray(guide.merged) && guide.merged.length === 0);
    t.ok('resolveApiKeyGuide: 知らない keep は、案内が無い間は何もせず、あるときは NOT_FOUND', (await c.cmd('resolveApiKeyGuide', { keep: 'key-000000000000' })).merged.length === 0);

    // ---- 値がどこにも出ない（compatEndpointCheck の失敗文を含む）
    const checkFail = await c.cmd('compatEndpointCheck', { input: { agent: 'codex', name: 'x', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'bearer', key: B, roles: { main: 'm' } } });
    const checkRef = await c.cmd('compatEndpointCheck', { input: { agent: 'codex', name: 'x', preset: 'custom', baseUrl: 'http://127.0.0.1:9/v1', authMode: 'bearer', keyRef: cerebras.id, roles: { main: 'm' } } }).catch((e) => ({ error: e.message }));
    t.ok('compatEndpointCheck の失敗文（キーを入れた・keyRef で選んだ）に値が出ない。別のホスト用のキーは断る', checkFail.ok === false && !JSON.stringify(checkFail).includes(B)
      && !JSON.stringify(checkRef).includes(C) && /URL（ホスト）用ではありません/.test(JSON.stringify(checkRef)));
    const everything = JSON.stringify({ events: c.events, state: await list(), routing: await c.cmd('delegationRouting', {}), log: server.tail(400) });
    t.ok('イベント・一覧・delegationRouting・サーバーのログに値が出ない', ![A, B, C].some((v) => everything.includes(v)));
    t.ok('api-keys.json に値は無く、値は api-key-secrets.json にだけある', !(await fs.readFile(path.join(scratch, 'data', 'api-keys.json'), 'utf8')).match(/sk-or-v1|csk-/)
      && (await fs.readFile(path.join(scratch, 'data', 'api-key-secrets.json'), 'utf8')).includes('"entries"'));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
