import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRegistry } from '../../core/ops/registry.mjs';
import { conversationOps } from '../../core/ops/conversations.mjs';
import { sessionOps } from '../../core/ops/sessions.mjs';
import { botOps } from '../../core/ops/bots.mjs';
import { createBotService } from '../../core/bots/service.mjs';
import { referencedSessions } from '../../core/bots/send-targets.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'sessions-send-bot';
export const title = 'bot の代理送信: 許可・拒否・OFF・人の参照・作った会話・除外の永続化・強い宛先の承認・履歴の名前とアイコン';
const ASK = { scope: 'workspace', autonomy: 'ask', label: 'ask' };
const FULL = { scope: 'full', autonomy: 'never', label: 'full' };
const HUMAN = { kind: 'human' };

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-send-bot-'));
  const rows = Object.fromEntries(['x1-sender', 'allowed', 'unknown', 'strong', 'created', 'linked', 'named', 'plain'].map((id) => [id, { id, title: `Title ${id}`, backend: 'fake' }]));
  const modes = { 'x1-sender': ASK, strong: FULL };
  const host = { store: { getAll: async () => rows, get: async (id) => rows[id] }, getBackend: () => ({ modes: () => ({ default: ASK }) }) };
  const channels = { threads: { get: async () => ({ sessions: { [bot.id]: 'x1-sender' } }) } };
  let bots = createBotService({ dataDir, host, channels });
  await bots.start();
  const bot = await bots.create({ name: 'Owl', icon: '🦉', backend: 'fake' }, HUMAN);
  const binding = { botId: bot.id, kind: 'dm' };
  const registry = createRegistry({ ops: [...conversationOps, ...botOps, ...sessionOps] });
  const sent = [], refused = [], order = [];
  let approval;
  const deps = {
    locale: 'ja', modeOf: async (id) => modes[id] ?? ASK,
    sessions: { get: async (id) => rows[id] ? { row: rows[id] } : null, fork: async () => { rows.forked = { id: 'forked', title: 'forked' }; return { sessionId: 'forked' }; } },
    botOfSession: async (id) => id === 'x1-sender' ? binding : null,
    get bots() { return bots; },
    conversations: {
      modesOf: async (id) => { order.push('mode'); return [modes[id] ?? ASK]; }, relayHops: () => 0,
      refused: async (r) => refused.push(r),
      send: async (args) => { sent.push(args); return { id: `msg-${sent.length}`, status: 'queued' }; },
      create: async () => ({ sessionId: 'created' }),
    },
    approve: async (card) => { approval = card; return { pending: true, requestId: 'approval' }; },
  };
  const actor = { by: 'agent', via: 'mcp', sessionId: 'x1-sender' };
  const send = (id, extra = {}) => registry.invoke(actor, 'sessions.send', { sessionId: id, text: 'hello' }, { ...deps, ...extra });
  const update = (patch) => bots.update({ botId: bot.id, ...patch }, HUMAN);
  try {
    await update({ sendTargets: ['allowed', 'strong'] });
    const allowed = await send('allowed');
    t.ok('設定で追加した会話へ送れる', allowed.ok && !allowed.pending, JSON.stringify(allowed));
    t.ok('既存の sentBy に bot の名前・アイコンを載せる', sent[0]?.sentBy.name === 'Owl' && sent[0].sentBy.icon === '🦉' && sent[0].sentBy.botId === bot.id && sent[0].sentBy.hops === 1);
    const denied = await send('unknown');
    t.ok('示されていない宛先を code と辞書の文で断る', denied.code === 'BOT_SEND_TARGET' && denied.error.includes('送れる会話'), JSON.stringify(denied));
    t.ok('拒否を既存の変更記録の口へ渡す', refused.at(-1)?.code === 'BOT_SEND_TARGET');
    await update({ sendToOthers: false });
    t.ok('OFF なら一覧にあっても送れない', (await send('allowed')).code === 'BOT_SEND_DISABLED');
    t.ok('共通の検査は bot の検査より先（自身への送信）', (await send('x1-sender')).code === 'SEND_SELF');
    const wrapped = { ...bots, get: async (args) => { order.push('bot'); return bots.get(args); } };
    order.length = 0;
    await send('strong', { bots: wrapped });
    t.ok('強さの比較のあとで bot の設定を調べる', order[0] === 'mode' && order[1] === 'bot', JSON.stringify(order));
    await update({ sendToOthers: true });
    const before = sent.length;
    const strong = await send('strong');
    t.ok('強い宛先は既存の承認カードへ進み、許可前には送らない', strong.pending && approval?.op === 'sessions.send' && sent.length === before, JSON.stringify(strong));
    await approval.proceed();
    t.ok('許可すれば強い宛先へ送れる', sent.length === before + 1);
    await send('strong');
    await update({ sendToOthers: false });
    const off = await approval.proceed();
    t.ok('承認待ちに OFF にしたら送信直前の検査で止まる', off.code === 'BOT_SEND_DISABLED' && sent.length === before + 1, JSON.stringify(off));
    await update({ sendToOthers: true });
    await send('strong');
    await update({ sendTargets: ['allowed'] });
    const removed = await approval.proceed();
    t.ok('承認待ちに宛先を外したら送れない', removed.code === 'BOT_SEND_TARGET', JSON.stringify(removed));

    const post = (text, extra = {}) => ({ text, author: HUMAN, mentions: [], ...extra });
    const channel = { id: 'c', members: [bot.id], kind: 'channel' };
    await bots.noteShown(post('https://localhost/?session=linked'), channel);
    t.ok('チャンネルの人のリンクで追加される', (await send('linked')).ok);
    await bots.noteShown(post('「Title named」を調べて', { threadId: 'root' }), { ...channel, members: [] });
    t.ok('スレッドの参加 bot へ人が名指しした会話を追加する', (await send('named')).ok);
    await bots.noteShown(post('unknown', { author: { kind: 'bot', botId: bot.id } }), channel);
    await bots.noteShown(post('unknown', { author: { kind: 'agent', sessionId: 'plain' } }), channel);
    await bots.noteShown(post('unknown', { taint: 'webhook' }), channel);
    t.ok('bot・AI・webhook 由来の文では許可が広がらない', (await send('unknown')).code === 'BOT_SEND_TARGET');
    await bots.noteShown(post('unknown'), { ...channel, members: [] });
    t.ok('その場にいない bot には追加しない', (await send('unknown')).code === 'BOT_SEND_TARGET');
    await bots.noteShown(post('unknown', { mentions: [bot.id] }), { ...channel, members: [] });
    t.ok('人が @ で示した bot には追加する', (await send('unknown')).ok);
    t.ok('ID の部分一致・曖昧な題・普通の文章では追加しない', referencedSessions('prefix-linked ordinary title 「duplicate」', [{ id: 'linked', title: 'ordinary title' }, { id: 'dup1', title: 'duplicate' }, { id: 'dup2', title: 'duplicate' }]).length === 0);
    await registry.invoke(actor, 'sessions.new', {}, deps);
    t.ok('bot 自身が sessions.new で作った会話へ送れる', (await send('created')).ok);
    await registry.invoke(actor, 'sessions.fork', { sessionId: 'allowed' }, deps);
    t.ok('bot 自身が sessions.fork で作った会話へも送れる', (await send('forked')).ok);
    const overview = (await bots.overview({ botId: bot.id }))[0];
    t.ok('画面へ自動・設定追加の出どころと会話の題を返す', overview.sendTargetDetails.some((d) => d.sessionId === 'created' && d.source === 'created') && overview.sendTargetDetails.some((d) => d.sessionId === 'linked' && d.source === 'shown') && overview.sendTargetDetails.some((d) => d.sessionId === 'allowed' && d.source === 'manual' && d.title === 'Title allowed'));
    const widen = await registry.invoke(actor, 'bots.update', { botId: bot.id, sendTargets: [...overview.sendTargets, 'plain'] }, deps);
    t.ok('AI が設定から宛先を広げるのは guarded のまま', widen.pending && approval.op === 'bots.update');
    await update({ sendTargets: ['allowed'] });
    bots.stop(); bots = createBotService({ dataDir, host, channels }); await bots.start();
    await bots.noteShown(post('linked named unknown created'), channel);
    t.ok('人が外した自動追加先は再起動・再提示後も復活しない', (await bots.get({ botId: bot.id })).sendTargets.join() === 'allowed');
    await update({ sendTargets: ['allowed', 'linked'] });
    t.ok('設定から明示して戻すことはできる', (await send('linked')).ok);
    t.ok('bot ではない会話の送信は制限しない', (await registry.invoke({ ...actor, sessionId: 'plain' }, 'sessions.send', { sessionId: 'unknown', text: 'hi' }, deps)).ok);
  } finally {
    bots.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
  await integration(t);
}

async function integration(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-send-bot-server-'));
  const server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
  const c = await open({ port: server.port, token: server.token });
  try {
    const invoke = async (op, args) => c.cmd('invoke', { op, args });
    const target = await c.runTurn({ prompt: 'echo:target', cwd: ROOT, backend: 'fake', mode: 'default' });
    const made = await invoke('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
    const bot = made;
    const from = c.mark();
    await invoke('channels.post', { channelId: bot.dmChannelId, text: 'control-info' });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId !== target.sessionId, { from, ms: 30_000 });
    const current = await invoke('bots.get', { botId: bot.id });
    const loaded = await c.cmd('loadSession', { sessionId: current.dmSessionId });
    const token = JSON.parse(loaded.messages.at(-1).text).token;
    const blocked = await fetch(`http://127.0.0.1:${server.port}/api/ops/sessions.send`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, text: 'echo:blocked' }) });
    t.ok('実サーバー: 示す前は HTTP 403 と BOT_SEND_TARGET', blocked.status === 403 && (await blocked.json()).code === 'BOT_SEND_TARGET');
    const mark = c.mark();
    await invoke('channels.post', { channelId: bot.dmChannelId, text: `echo:${target.sessionId}` });
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === current.dmSessionId, { from: mark, ms: 30_000 });
    const sendMark = c.mark();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/ops/sessions.send`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, text: 'echo:from owl' }) });
    const sent = await res.json();
    t.ok('実サーバー: DM の人の本文の会話 ID を追加し、束縛された bot が送れる', sent.ok && !sent.pending, JSON.stringify(sent));
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === target.sessionId, { from: sendMark, ms: 30_000 });
    const live = c.events.slice(sendMark).find((e) => e.type === 'userMessage' && e.sessionId === target.sessionId);
    const history = (await c.cmd('loadSession', { sessionId: target.sessionId })).messages.find((m) => m.text === 'echo:from owl');
    t.ok('実サーバー: 流れと読み直した履歴の両方に bot の名前・アイコンが残る', live?.sentBy?.name === 'Owl' && live.sentBy.icon === '🦉' && history?.sentBy?.name === 'Owl' && history.sentBy.icon === '🦉');
    await invoke('bots.update', { botId: bot.id, sendToOthers: false });
    const off = await fetch(`http://127.0.0.1:${server.port}/api/ops/sessions.send`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: target.sessionId, text: 'echo:off' }) });
    t.ok('実サーバー: OFF は HTTP 403 と BOT_SEND_DISABLED', off.status === 403 && (await off.json()).code === 'BOT_SEND_DISABLED');
    const editedTarget = await invoke('sessions.new', { backend: 'fake', cwd: ROOT });
    await c.cmd('setTitle', { sessionId: editedTarget.sessionId, title: '編集で示す会話' });
    const post = (await invoke('channels.read', { channelId: bot.dmChannelId })).posts.find((p) => p.author.kind === 'human');
    await invoke('channels.edit', { channelId: bot.dmChannelId, postId: post.id, text: '「編集で示す会話」を確認して' });
    t.ok('実サーバー: 人が本文を編集して示した会話も保存する（OFF の間も一覧を保つ）', (await invoke('bots.get', { botId: bot.id })).sendTargets.includes(editedTarget.sessionId));
  } finally {
    c.close(); await server.stop(); await fs.rm(dataDir, { recursive: true, force: true });
  }
}
