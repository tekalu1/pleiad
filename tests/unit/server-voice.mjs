// 通話モードをサーバー越しに（偽の OpenRouter・fake バックエンド）: キーは人だけが入れ、画面へもログへも返さない・/voice-ws の認可・声から返事の読み上げまでの一巡・設定と使用量。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeOpenRouter, toneFrame } from '../lib/fake-openrouter.mjs';
import { BINARY_AUDIO } from '../../core/voice/session.mjs';

export const name = 'server-voice';
export const title = '通話モードをサーバー越しに: キーは human-only・画面とログへ返さない・/voice-ws の認可（トークン・中継は断る）・声 → 確定 → 返事の読み上げ・設定の検査と上限の承認・使用量';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return fn(); }

/** /voice-ws へつなぐ。受けた JSON・バイナリを溜める */
async function voiceSocket({ port, token, headers = {} }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice-ws?token=${token}`, { headers });
  const json = [], audio = [];
  ws.on('message', (data, isBinary) => { if (isBinary) audio.push(Buffer.from(data)); else json.push(JSON.parse(data.toString())); });
  const closed = new Promise((res) => ws.on('close', (code) => res(code)));
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); ws.once('unexpected-response', (_req, r) => rej(Object.assign(new Error(`HTTP ${r.statusCode}`), { status: r.statusCode }))); });
  return { ws, json, audio, closed, send: (o) => ws.send(JSON.stringify(o)), frames(voiced, n) { for (let i = 0; i < n; i++) ws.send(toneFrame(voiced)); } };
}

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-voice-')));
  const reply = '署名の鍵は、リポジトリの Secrets にあります。\n\n```\ngh secret set SIGNING_KEY\n```\n';
  const api = await startFakeOpenRouter({ transcripts: [`steps:${JSON.stringify({ steps: [{ text: reply }] })}`] });
  const dataDir = path.join(scratch, 'data');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_VOICE_API: api.url }, dataDir, timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const log = () => server.tail(400);
  try {
    // ---- ホストが対応していることと、キー
    t.ok('ready: この PC の画面には voice: 1（通話に対応）を伝える', c.ready.voice === 1);
    const s0 = await c.cmd('invoke', { op: 'voice.status' });
    t.ok('voice.status: キーは未登録・今日の使用は 0・設定は既定（キーそのものの欄は無い）', s0.hasKey === false && s0.today.callSeconds === 0 && s0.settings.ttsVoice === 'eve' && s0.active === 0 && !JSON.stringify(s0).includes('key"'));

    const bad = await c.cmd('setVoiceKey', { key: 'bad key' }).catch((e) => e);
    t.ok('setVoiceKey: 形が正しくないキー（空白を含む）は断る', bad instanceof Error && /キー/.test(bad.message), bad.message);
    const set = await c.cmd('setVoiceKey', { key: KEY });
    t.ok('setVoiceKey: 登録できる。返りにキーは無く、登録済みと確認の結果（OpenRouter の GET /key）だけ', set.hasKey === true && set.check === 'ok' && api.records.key === 1 && !JSON.stringify(set).includes(KEY));
    const stored = await fs.readFile(path.join(dataDir, 'voice-secrets.json'), 'utf8');
    t.ok('キーは voice-secrets.json（権限を絞った別の置き場）にだけある。prefs.json・usage には無い', (stored.includes(KEY) || stored.includes('"enc"')) && !(await fs.readFile(path.join(dataDir, 'prefs.json'), 'utf8').catch(() => '')).includes(KEY));
    t.ok('voice.status: 登録済みになる。キーは返さない', (await c.cmd('invoke', { op: 'voice.status' })).hasKey === true && !JSON.stringify(await c.cmd('invoke', { op: 'voice.status' })).includes(KEY));

    // ---- 設定（settings.set の voice）
    const set1 = await c.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { ttsVoice: 'ara', maxCallMinutes: 20 } } });
    t.ok('settings.set voice: 渡した欄だけ重ねて保存する（人は承認なし）', set1.changed === true && set1.value.ttsVoice === 'ara' && set1.value.maxCallMinutes === 20 && set1.value.sttModel === 'microsoft/mai-transcribe-2');
    const invalid = await c.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { maxCallMinutes: 0 } } }).catch((e) => e);
    t.ok('settings.set voice: 範囲外・形の違う値・知らない欄は INVALID', invalid.code === 'INVALID' && (await c.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { surprise: 1 } } }).catch((e) => e)).code === 'INVALID');
    t.ok('settings.set voice: key を含めようとしても受けない（キーは human-only の別の口）', (await c.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { apiKey: KEY } } }).catch((e) => e)).code === 'INVALID');
    const reset = await c.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { ttsVoice: null, maxCallMinutes: null } } });
    t.ok('settings.set voice: null の欄は既定に戻す', reset.value.ttsVoice === 'eve' && reset.value.maxCallMinutes === 30);

    // ---- /voice-ws の認可
    const noToken = await voiceSocket({ port: server.port, token: 'wrong' }).catch((e) => e);
    t.ok('/voice-ws: トークンが違えば 401', noToken.status === 401, String(noToken.message));
    const relayed = await voiceSocket({ port: server.port, token: server.token, headers: { 'x-forwarded-for': '10.0.0.5' } }).catch((e) => e);
    t.ok('/voice-ws: 中継越し（この PC の画面ではない）は 403。キーを持つ PC だけが通話を受ける', relayed.status === 403, String(relayed.message));

    // ---- 声 → 確定 → 返事の読み上げ
    const voice = await voiceSocket({ port: server.port, token: server.token });
    voice.send({ t: 'hello', target: { kind: 'chat', sessionId: null } });
    await waitFor(() => voice.json.some((m) => m.t === 'ready'));
    const ready = voice.json.find((m) => m.t === 'ready');
    t.ok('ready: 既定のモデルと再生レート 24000 を返す（キーは返さない）', ready?.sttModel === 'microsoft/mai-transcribe-2' && ready.ttsModel === 'x-ai/grok-voice-tts-1.0' && ready.rate === 24000 && !JSON.stringify(ready).includes(KEY));
    t.ok('voice.status: 通話中は active が 1', (await c.cmd('invoke', { op: 'voice.status' })).active === 1);

    voice.frames(false, 3); voice.frames(true, 8); voice.frames(false, 8);
    await waitFor(() => voice.json.some((m) => m.t === 'final'));
    const final = voice.json.find((m) => m.t === 'final');
    t.ok('声（正弦波のフレーム）→ final。声の終わり→確定の遅れも付く', final?.text.startsWith('steps:') && Number.isFinite(final.speechEndToFinalMs));
    t.ok('偽の OpenRouter への要求: 聞き取りは WAV・言語 ja・キーはヘッダ。投機の見本を先に 1 回送り、確定はそれを再利用（1 回だけ）', api.records.stt.length === 1 && api.records.stt[0].format === 'wav' && api.records.stt[0].language === 'ja' && api.records.stt[0].auth === `Bearer ${KEY}`);

    // 画面（クライアント）の役: 確定した発言を、いまの送信の経路で会話へ送る → 返事がホストで読み上げられる
    const from = c.mark();
    await c.cmd('runTurn', { prompt: final.text, backend: 'fake', cwd: ROOT, messageId: 'voice-m1' });
    const session = (await c.waitFor((e) => e.type === 'session' && e.sessionId, { from, ms: 20000 })).sessionId;
    voice.send({ t: 'target', target: { kind: 'chat', sessionId: session } });
    await waitFor(() => voice.json.filter((m) => m.t === 'seg.end').length >= 2, 15000);
    const segs = voice.json.filter((m) => m.t === 'seg');
    t.ok('返事: 本文の文だけを読み、コードは読まずに言い添えの文（skip: code）', segs.map((s) => s.text).join('|') === '署名の鍵は、リポジトリの Secrets にあります。|コードは画面に出しました' && segs.at(-1).skip === 'code', JSON.stringify(segs.map((s) => s.text)));
    const audio = voice.audio.filter((b) => b[0] === BINARY_AUDIO);
    t.ok('音: [1][文の id][PCM] のバイナリ。どの文にも届く。受け側で奇数バイトに割れていない', audio.length >= 2 && audio.every((b) => (b.length - 5) % 2 === 0) && new Set(audio.map((b) => b.readUInt32LE(1))).size === 2);
    t.ok('偽の OpenRouter への読み上げの要求: PCM・声（eve）・モデル・文の中身にコードが無い・キーはヘッダ', api.records.tts.length === 2 && api.records.tts.every((r) => r.format === 'pcm' && r.voice === 'eve' && r.model === 'x-ai/grok-voice-tts-1.0' && r.auth === `Bearer ${KEY}`)
      && !api.records.tts.some((r) => /gh secret/.test(r.input)));
    await waitFor(() => voice.json.some((m) => m.t === 'turn.end'));
    t.ok('ターンの終わり: turn.end（読んだ文があった）', voice.json.find((m) => m.t === 'turn.end')?.spoke === true);
    const lat = voice.json.find((m) => m.t === 'lat');
    t.ok('遅延の内訳: 確定 → 最初の音までを測れる', lat && Number.isFinite(lat.finalToFirstAudioMs) && lat.finalToFirstAudioMs >= 0 && Number.isFinite(lat.speechEndToFinalMs), JSON.stringify(lat));
    t.ok('サーバーのログに遅延の行（voice.latency・voice.final）が出る。本文もキーも含まない', /voice\.latency/.test(log()) && /voice\.final/.test(log()) && !log().includes(KEY) && !log().includes('署名の鍵は'), log().slice(-300));

    voice.ws.close();
    await voice.closed;
    await sleep(300);
    const after = await c.cmd('invoke', { op: 'voice.status' });
    t.ok('終えたら active は 0。今日の使用量（聞き取りの秒数・読み上げの字数）が台帳に載る', after.active === 0 && after.today.sttSeconds >= 1 && after.today.ttsChars > 10, JSON.stringify(after.today));

    // ---- 削除
    const del = await c.cmd('deleteVoiceKey', {});
    t.ok('deleteVoiceKey: 消えると登録なしに戻る。キーは返らない', del.hasKey === false && !JSON.stringify(del).includes(KEY));
    const nokey = await voiceSocket({ port: server.port, token: server.token });
    nokey.send({ t: 'hello', target: { kind: 'chat', sessionId: null } });
    await waitFor(() => nokey.json.some((m) => m.t === 'error'));
    t.ok('キーが無ければ通話は始められない（no-key）', nokey.json.find((m) => m.t === 'error')?.code === 'no-key');
    nokey.ws.close();

    // ---- キーはログにも出ない
    t.ok('キーはサーバーのログにも出ない', !log().includes(KEY) && !log().includes('sk-or'));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
