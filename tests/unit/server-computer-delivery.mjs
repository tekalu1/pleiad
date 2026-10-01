// コンピューターの操作（ply_computer）を、サーバーの橋（偽の driver）から本物の形のエージェントの身代わりへ通す。
// 実画面にも LLM にも触れない（AGENT_HOST_COMPUTER_DRIVER=fake、tests/lib/fake-codex.mjs・fake-agy.mjs）:
//   - Codex: thread/start の config（ply_computer・同梱を切るキー・tool_timeout_sec）と developerInstructions、mcpToolCall の正規化、履歴の読み直し
//   - Antigravity: agent.md の 2 本目の中継、接頭辞付きの名前で橋を呼び、画像のパスと印から表示を作る
//   - 委譲の子の会話にも渡す（ADR 0071）。設定でオフにした会話には何も足さない
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { agentT } from '../../core/i18n.mjs';

export const name = 'server-computer-delivery';
export const title = 'ply_computer をサーバー越しに Codex・Antigravity の身代わりへ: 注入・正規化・履歴・委譲の子・設定でオフ';

const shotCall = { name: 'screenshot', arguments: { title: '画面を確かめる' } };
const clickCall = { name: 'left_click', arguments: { coordinate: [100, 100], title: '保存を押す' } };
const SHOT_URL = /^\/computer-shot\/[0-9a-f]{32}\.jpg$/;

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-computer-delivery-')));
  const dataDir = path.join(tmp, 'data'), log = path.join(tmp, 'fake-codex.log'), agentFile = path.join(tmp, 'agent.json');
  let host, c;
  const entries = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const turnStarts = async () => (await entries()).filter(e => e.method === 'turn/start');
  const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return fn(); };
  try {
    host = await startServer({ dataDir, timeoutMs: 30_000, env: {
      AGENT_HOST_BACKENDS: 'fake,codex,antigravity', AGENT_HOST_COMPUTER_DRIVER: 'fake',
      AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-codex.mjs')}"`, FAKE_CODEX_LOG: log,
      AGENT_HOST_AGY_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-agy.mjs')}"`, FAKE_AGY_AGENT_FILE: agentFile,
    } });
    // アプリの承認は「この会話で許可」で答える（ほかの承認はそのまま許可）
    c = await open({ ...host, onEvent: async (ev, api) => {
      if (ev.type !== 'permission') return;
      await api.cmd('resolvePermission', ev.computerApp ? { id: ev.id, allow: true, scope: 'session' } : { id: ev.id, allow: true }).catch(() => {});
    } });
    const shotOk = async url => { const r = await fetch(`http://127.0.0.1:${host.port}${url}?token=${host.token}`); return r.status === 200 && r.headers.get('content-type') === 'image/jpeg'; };
    const common = agentT('ja', 'computer.instructions');

    // ---- Codex
    const codexTurn = await c.runTurn({ backend: 'codex', cwd: ROOT, prompt: 'computer:' + JSON.stringify([shotCall, clickCall]) });
    const started = (await turnStarts()).find(e => e.threadId === codexTurn.sessionId) ?? (await turnStarts()).at(-1);
    t.ok('Codex: thread/start の config に ply_computer（/mcp/computer・Bearer・approve・required: false・tool_timeout_sec 660）', /\/mcp\/computer$/.test(started?.computer?.url ?? '') && started.computer.http_headers?.includes('Authorization')
      && started.computer.default_tools_approval_mode === 'approve' && started.computer.required === false && started.computer.tool_timeout_sec === 660, JSON.stringify(started?.computer ?? null));
    t.ok('Codex: 同梱の computer use を切る 2 つのプラグインのキーだけを足す', JSON.stringify(started?.bundledComputerUse) === JSON.stringify({ 'plugins.unified-computer-use@openai-bundled.enabled': false, 'plugins.computer-use@openai-bundled.enabled': false }), JSON.stringify(started?.bundledComputerUse ?? null));
    t.ok('Codex: developerInstructions に共通の指示文と Codex での呼び方', started?.developerInstructions?.includes(common) && started.developerInstructions.includes(agentT('ja', 'computerDelivery.codex')), String(started?.developerInstructions ?? '').slice(-200));
    const cStarts = codexTurn.events.filter(e => e.type === 'tool.start' && e.sessionId === codexTurn.sessionId);
    const cResults = codexTurn.events.filter(e => e.type === 'tool.result' && e.sessionId === codexTurn.sessionId);
    t.ok('Codex: tool.start は mcp__ply_computer__<ツール> と引数', cStarts.map(e => e.name).join() === 'mcp__ply_computer__screenshot,mcp__ply_computer__left_click' && cStarts[1]?.input?.coordinate?.join() === '100,100', JSON.stringify(cStarts.map(e => [e.name, e.input])));
    t.ok('Codex: 撮影の結果は印を除いた本文・images・computer（base64 は流さない）', SHOT_URL.test(cResults[0]?.images?.[0]?.url ?? '') && cResults[0].computer?.tool === 'screenshot' && cResults[0].computer?.state === 'ok'
      && !cResults[0].text.includes('[ply_computer]') && JSON.stringify(cResults[0]).length < 2000 && await shotOk(cResults[0].images[0].url), JSON.stringify(cResults[0] ?? null).slice(0, 300));
    t.ok('Codex: クリックの結果は印にアプリ名、isError なし', cResults[1]?.computer?.app === 'メモ帳' && cResults[1]?.isError === false, JSON.stringify(cResults[1] ?? null));
    const cHistory = (await c.cmd('loadSession', { sessionId: codexTurn.sessionId })).messages.flatMap(m => m.toolCalls ?? []);
    t.ok('Codex: 会話を開き直しても同じ名前・画像・印で出る', cHistory[0]?.name === 'mcp__ply_computer__screenshot' && cHistory[0]?.result?.images?.[0]?.url === cResults[0]?.images?.[0]?.url && cHistory[1]?.result?.computer?.app === 'メモ帳',
      JSON.stringify(cHistory).slice(0, 300));

    const parts = (await c.cmd('sessionContext', { sessionId: codexTurn.sessionId }))?.plyParts ?? [];
    t.ok('指示の量: ply_computer の指示文を「コンピューターの操作の説明」として数える', parts.find(p => p.id === 'computer')?.tokens > 0, JSON.stringify(parts));

    // ---- Antigravity
    const listed = await c.runTurn({ backend: 'antigravity', cwd: ROOT, prompt: 'mcp-tools' });
    const recorded = JSON.parse(await fs.readFile(agentFile, 'utf8').catch(() => 'null'));
    const relay = (recorded?.front?.mcpServers ?? []).find(s => s.serverName === 'ply_computer');
    t.ok('agy: agent.md に ply_computer の中継（--computer）。接続先とトークンは env だけ', relay?.args?.at(-1) === '--computer' && /\/mcp\/computer$/.test(recorded?.computerUrl ?? '') && /^Bearer [a-f0-9]{64}$/.test(recorded?.computerAuthorization ?? '')
      && !JSON.stringify(recorded?.front ?? {}).includes(recorded?.computerAuthorization ?? '-'), JSON.stringify({ relay, url: recorded?.computerUrl }));
    t.ok('agy: 指示文に共通の文・画像をファイルで見る指示・agy での呼び方', String(recorded?.body ?? '').includes(common) && String(recorded?.body ?? '').includes(agentT('ja', 'computer.pathInstructions')) && String(recorded?.body ?? '').includes(agentT('ja', 'computerDelivery.antigravity')));
    const tools = JSON.parse((await c.cmd('loadSession', { sessionId: listed.sessionId })).messages.findLast(m => m.role === 'assistant')?.text || '[]');
    t.ok('agy: 橋のツールが ply_computer_ の付いた名前で見える', tools.length > 10 && tools.every(x => x.name.startsWith('ply_computer_')) && tools.some(x => x.name === 'ply_computer_screenshot'), JSON.stringify(tools.map(x => x.name)).slice(0, 200));
    const agyTurn = await c.runTurn({ sessionId: listed.sessionId, prompt: `mcp-call:ply_computer_screenshot ${JSON.stringify(shotCall.arguments)}` });
    const aStart = agyTurn.events.find(e => e.type === 'tool.start' && e.sessionId === listed.sessionId);
    const aResult = agyTurn.events.find(e => e.type === 'tool.result' && e.sessionId === listed.sessionId);
    t.ok('agy: tool.start は mcp__ply_computer__screenshot と引数', aStart?.name === 'mcp__ply_computer__screenshot' && aStart?.input?.title === '画面を確かめる', JSON.stringify(aStart ?? null));
    t.ok('agy: 結果は印から images と computer。保存先のパスを本文に残し、退避先の行は除く', SHOT_URL.test(aResult?.images?.[0]?.url ?? '') && aResult.computer?.state === 'ok' && aResult.isError === false
      && aResult.text.includes(path.join(dataDir, 'computer-use', 'shots')) && !aResult.text.includes('Resource offloaded') && await shotOk(aResult.images[0].url), JSON.stringify(aResult ?? null).slice(0, 400));
    const aHistory = (await c.cmd('loadSession', { sessionId: listed.sessionId })).messages.flatMap(m => m.toolCalls ?? []).find(x => x.name === 'mcp__ply_computer__screenshot');
    t.ok('agy: 会話を開き直しても画像と印が出る', aHistory?.result?.images?.[0]?.url === aResult?.images?.[0]?.url && aHistory?.result?.computer?.tool === 'screenshot', JSON.stringify(aHistory ?? null).slice(0, 300));

    // ---- 委譲の子の会話にも渡す（ADR 0071）
    const before = (await turnStarts()).filter(e => e.computer).length;
    const parent = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'codex', title: 'child-computer', task: 'computer:' + JSON.stringify([shotCall]) } }) });
    const child = await until(async () => (await turnStarts()).filter(e => e.computer).length > before && (await turnStarts()).filter(e => e.computer).at(-1));
    t.ok('委譲の子（Codex）にも ply_computer と同梱を切るキー・指示文を渡す', /\/mcp\/computer$/.test(child?.computer?.url ?? '') && Object.keys(child?.bundledComputerUse ?? {}).length === 2 && child?.developerInstructions?.includes(common), JSON.stringify(child ?? null).slice(0, 300));
    // 子の完了通知が親の会話で走り終わるまで待つ（次の確認の邪魔をしない）
    await until(async () => { const r = await c.cmd('running'); return r.turns.length === 0 && r.tasks.every(x => !['running', 'pending'].includes(x.status)); }, 20_000);

    // ---- 設定でオフにした会話には何も足さない
    await c.cmd('setPref', { key: 'computerUse', value: { enabled: false, allowAllApps: false, introduced: true, alwaysAllowed: [] } });
    const off = await c.runTurn({ backend: 'codex', cwd: ROOT, prompt: 'hello' });
    const offStart = (await turnStarts()).filter(e => e.threadId === off.sessionId).at(-1);
    t.ok('設定でオフ: Codex の config にも指示にも足さない（利用者の ~/.codex に任せる）', offStart && offStart.computer === null && Object.keys(offStart.bundledComputerUse ?? {}).length === 0 && !String(offStart.developerInstructions ?? '').includes(common), JSON.stringify(offStart ?? null).slice(0, 300));
  } finally {
    await c?.close?.();
    await host?.stop?.();
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
