// 組み込みの bot（Bot.plain。チャンネルのスレッドの「bot なし」。ADR 9101・docs/channels.md「組み込みの bot」）。
// 人格・記憶・心拍を持たず、名前で @ できない。宛先（to）・スレッドの設定（botId）の 'plain' で選び、無ければ作る。
// dispatch の経路（スレッドの会話・暗黙の宛先・返事の投稿）は普通の bot と同じ。fake バックエンドのサーバー越しに通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { normalizeBot } from '../../core/bots/store.mjs';
import { botInstructions } from '../../core/bots/sessions.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'bot-plain';
export const title = '組み込みの bot（bot なし）: plain で選んで作る・人格と記憶を渡さない・@ で呼べない・暗黙の宛先には入る・変えられない・一覧の印';

const until = async (fn, { ms = 20_000, label = '' } = {}) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(40); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)?.slice(0, 600)}`);
};

export default async function (t) {
  // ---- 形と指示（サーバー無し）
  const plain = normalizeBot({ id: 'b_plain', name: 'Agent', plain: true, persona: '使われない人格' });
  t.ok('保存の形: plain の印を残す（ふつうの bot には付かない）', plain.plain === true && !('plain' in normalizeBot({ id: 'b_x', name: 'X', plain: 'yes' })));
  for (const lang of ['ja', 'en']) {
    const text = botInstructions(plain, lang);
    t.ok(`指示（${lang}）: 人格・名前を入れず、記憶と予約の文を入れない`, !text.includes('使われない人格') && !text.includes('Agent') && !text.includes('memory.search') && !text.includes('brain.wakeAdd')
      && text.length > 100, text.slice(0, 200));
  }
  // 記憶・予約は組み込みの bot の会話から断る（ops の検査。主体の会話から bot を引く）
  {
    const deps = { locale: 'ja', botOfSession: async (id) => (id === 's_plain' ? { botId: 'b_plain', kind: 'thread' } : null), bots: { get: async ({ botId }) => (botId === 'b_plain' ? plain : null) },
      memory: { write: async () => ({ id: 'm_x' }) }, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {} };
    const r = await registry.invoke({ by: 'agent', via: 'mcp', sessionId: 's_plain' }, 'memory.write', { layer: 'b_plain', text: '覚える', sources: [] }, { ...deps, actor: { sessionId: 's_plain' } });
    t.ok('memory.write: 組み込みの bot の会話からは断る', !r.ok && r.code === 'INVALID', JSON.stringify(r));
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-plain-'));
  let server = null, c = null;
  try {
    server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(tmp, 'data'), timeoutMs: 60_000 });
    c = await open({ port: server.port, token: server.token });
    const call = (op, args) => c.cmd('invoke', { op, args });
    const fails = async (op, args) => { try { await call(op, args); return false; } catch { return true; } };
    const owl = await call('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
    const dev = await call('channels.create', { name: 'dev', members: [owl.id] });
    const read = (threadId) => call('channels.read', { channelId: dev.id, threadId });
    const plainPosts = async (root, botId) => (await read(root.id)).posts.filter((p) => p.turn?.botId === botId && p.state === 'done');
    const threadOf = async (root) => (await read(root.id)).threads[0];
    const settled = (root) => until(async () => { const th = await threadOf(root); return th?.state === 'idle' ? th : null; }, { label: 'thread idle' });

    t.ok('最初は組み込みの bot が無い', !(await call('bots.list', {})).bots.some((b) => b.plain));

    // ---- 宛先 'plain' で話しかける（無ければ作る）
    const root = await call('channels.post', { channelId: dev.id, text: '計画を見てほしい' });
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:はじめまして', to: 'plain' });
    const bots1 = (await call('bots.list', {})).bots;
    const agent = bots1.find((b) => b.plain);
    t.ok('to: plain で組み込みの bot ができる（1 体だけ・名前は Agent・DM を持たない）', agent && bots1.filter((b) => b.plain).length === 1 && agent.name === 'Agent' && !agent.dmChannelId, JSON.stringify(agent));
    await until(async () => (await plainPosts(root, agent.id)).length === 1, { label: '組み込みの bot の返事' });
    t.ok('dispatch の経路は普通の bot と同じ（スレッドの会話・返事の投稿）', (await plainPosts(root, agent.id))[0].text === 'はじめまして' && Boolean((await settled(root)).sessions[agent.id]));
    t.ok('メンバーには足さない', !(await call('channels.get', { channelId: dev.id })).members.includes(agent.id));
    t.ok('DM のチャンネルを作らない', !(await call('channels.list', {})).channels.some((ch) => ch.kind === 'dm' && ch.botId === agent.id));

    // ---- 指示・末尾の文脈
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'instructions:', to: agent.id });
    await until(async () => (await plainPosts(root, agent.id)).length === 2, { label: 'instructions' });
    const instr = (await plainPosts(root, agent.id))[1].text;
    t.ok('ターンの指示に人格を入れない（組み込みの bot の見出し）', !instr.includes('調べ物') && instr.includes('人格は持ちません'), instr.slice(0, 200));
    await settled(root);
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'notes:', to: agent.id });
    await until(async () => (await plainPosts(root, agent.id)).length === 3, { label: 'notes' });
    const notes = (await plainPosts(root, agent.id))[2].text;
    t.ok('末尾の文脈に記憶を入れない', !notes.includes('pleiad-memory'), notes.slice(0, 300));
    await settled(root);

    // ---- 暗黙の宛先には入る・名前では呼べない
    await call('channels.post', { channelId: dev.id, threadId: root.id, text: 'echo:宛先なし' });
    await until(async () => (await plainPosts(root, agent.id)).some((p) => p.text === '宛先なし'), { label: '暗黙の宛先' });
    t.ok('@ も宛先も無い人の投稿は、最後に話した組み込みの bot が受ける', true);
    await settled(root);
    const named = await call('channels.post', { channelId: dev.id, text: '@Agent echo:呼べる？' });
    t.ok('@Agent は組み込みの bot の @ にならない', !(named.mentions ?? []).includes(agent.id), JSON.stringify(named.mentions));

    // ---- スレッドの設定の 'plain'（同じ 1 体を使う）
    const root2 = await call('channels.post', { channelId: dev.id, text: '別のスレッド' });
    const s2 = await call('channels.threadSettings', { channelId: dev.id, threadId: root2.id, botId: 'plain', backend: 'fake' });
    t.ok('threadSettings の botId plain: 同じ組み込みの bot の会話をこのスレッドに作る', Boolean(s2.sessionId) && (await threadOf(root2)).sessions[agent.id] === s2.sessionId
      && (await call('bots.list', {})).bots.filter((b) => b.plain).length === 1, JSON.stringify(s2));
    t.ok('ふつうの bot の backend は変えられない', await fails('channels.threadSettings', { channelId: dev.id, threadId: root2.id, botId: owl.id, backend: 'fake' }));

    // ---- 変えられない・消せない
    t.ok('bots.update は断る', await fails('bots.update', { botId: agent.id, persona: '人格を足す' }));
    t.ok('bots.remove は断る', await fails('bots.remove', { botId: agent.id }));
    t.ok('人の bot に Agent という名前を付けられる（組み込みの bot と重ならない）', Boolean((await call('bots.create', { name: 'Agent', icon: '🤖', backend: 'fake' })).id));
    t.ok('一時チャットでは組み込みの bot を宛先にできない', await fails('channels.post', { channelId: 'home', text: 'x', to: agent.id }));
    t.ok('サーバーのログに例外が出ていない', !/Unhandled|TypeError|ReferenceError/.test(server.tail(80)), server.tail(30));
  } finally {
    c?.close();
    await server?.stop().catch(() => {});
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
