// Chrome の操作待ちの台帳（core/chrome/handoff.mjs。ADR 0148・0168）。偽の askPermission・接続・第 6 段の control で、サーバーも Chrome も立てない。
//   - connect は 1 会話に 1 枚（ターンが走っている間だけ。ターンの外の接続では出さない）。状態の変化は update で届く。つながったら決着する
//   - ask は開いている依頼があれば新しく出さない。接続が無ければ接続の案内に読み替える。一時停止中（第 6 段の paused）なら「あなたが操作中」から
//   - wait は sliceMs で waiting（カードは残る）、signal で aborted。ターンの中で誰にも返していない答えは次の wait が返し、ターンの終わりで捨てる
//   - ターンの外で戻した・つながった → 「続けてください」が 1 回だけ。busy・断った・中断のときは送らない
import { readFileSync } from 'node:fs';
import { createChromeHandoffs, continuationMessageId, HANDOFF_REASONS } from '../../core/chrome/handoff.mjs';
import { handToUserResult } from '../../core/browser-bridge.mjs';

export const name = 'chrome-handoff';
export const title = 'Chrome の操作待ち: 1 会話 1 枚・状態の差し替え・つながったら決着・wait の区切りと中断・ターンの外で戻したら続ける（偽の askPermission / 接続 / control）';

/** askPermission の身代わり。onOpen の handle・onSettle・signal の中断を本物と同じ順で呼ぶ */
function fakeAsk() {
  const cards = [];
  const ask = opts => new Promise(resolve => {
    const card = { id: `perm-${cards.length + 1}`, opts, updates: [], answer: null };
    const settle = answer => {
      if (card.answer) return;
      card.answer = answer;
      opts.onSettle?.(answer);
      resolve(answer);
    };
    card.settle = settle;
    cards.push(card);
    opts.onOpen?.({ id: card.id, ids: [card.id], update: patch => card.updates.push(patch), settle });
    opts.signal?.addEventListener?.('abort', () => settle({ allow: false, messageKey: 'aborted' }), { once: true });
  });
  return { ask, cards };
}

/** core/chrome/connection.mjs の身代わり。demand は状態が connected になるか、signal が外れるまで待つ */
function fakeConnection(initial = 'off') {
  let status = { state: initial, dialog: false };
  const listeners = new Set();
  const demands = [];
  return {
    state: () => status,
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    demand: ({ signal } = {}) => new Promise((resolve, reject) => {
      const d = { signal, resolve, reject };
      demands.push(d);
      signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })), { once: true });
    }),
    demands,
    set(next) {
      status = { dialog: false, ...next };
      for (const fn of listeners) fn(status);
      if (status.state === 'connected') for (const d of demands) d.resolve();
    },
  };
}

/** 第 6 段の control の身代わり（state・onChange だけ） */
function fakeControl() {
  const states = new Map();
  const listeners = new Set();
  return {
    state: id => states.get(id) ?? { state: 'running' },
    onChange: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    set(id, next) { states.set(id, next); for (const fn of listeners) fn(id); },
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function rig({ connection = 'off', live = true, busy = false, withControl = false } = {}) {
  const asked = fakeAsk();
  const conn = fakeConnection(connection);
  const control = withControl ? fakeControl() : null;
  const env = { live, busy, sent: [] };
  const aborts = new Map();
  const handoffs = createChromeHandoffs({
    askPermission: asked.ask, connection: conn, control,
    sessionBusy: () => env.busy, turnLive: () => env.live,
    turnSignal: id => aborts.get(id)?.signal,
    continueTurn: async (sessionId, args) => { env.sent.push({ sessionId, ...args }); },
    titleFor: ({ reason, message }) => `${reason}:${message ?? ''}`,
  });
  return { ...asked, conn, control, env, handoffs, abortTurn: id => aborts.get(id)?.abort(), startTurn: id => aborts.set(id, new AbortController()) };
}

export default async function (t) {
  // ---- 続けるための id
  {
    const a = continuationMessageId('perm-1');
    t.ok('続けるための id は UUID の形で、カードの id から決まる', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(a) && a === continuationMessageId('perm-1') && a !== continuationMessageId('perm-2'), a);
    t.ok('エージェントに出す理由は 5 つ（connect は出さない）', HANDOFF_REASONS.join() === 'login,captcha,two_factor,payment,other');
  }

  // ---- connect: 1 会話に 1 枚・ターンの外では出さない
  {
    const r = rig({ connection: 'setup' });
    const h1 = r.handoffs.connect('s1');
    const h2 = r.handoffs.connect('s1');
    t.ok('connect は 1 会話に 1 枚（2 回目は同じ依頼でカードを増やさない）', r.cards.length === 1 && h1 === h2);
    t.ok('カードは outlivesTurn で、接続の案内（reason: connect・state・turnLive）を載せる', r.cards[0].opts.outlivesTurn === true && r.cards[0].opts.kind === 'tool' && r.cards[0].opts.toolName === 'ply_browser'
      && r.cards[0].opts.browserHandoff.reason === 'connect' && r.cards[0].opts.browserHandoff.state === 'setup' && r.cards[0].opts.browserHandoff.turnLive === true, JSON.stringify(r.cards[0].opts.browserHandoff));
    t.ok('試行は自分の demand を持つ（中継の 20 秒が外れても止まらない）', r.conn.demands.length === 1);
    r.conn.set({ state: 'permission', dialog: false });
    r.conn.set({ state: 'permission', dialog: true });
    t.ok('state・dialog の変化は update で届く', r.cards[0].updates.length === 2 && r.cards[0].updates[0].state === 'permission' && r.cards[0].updates[1].dialog === true, JSON.stringify(r.cards[0].updates));
    t.ok('current は今の中身を返す', r.handoffs.current('s1')?.state === 'permission' && r.handoffs.current('s1')?.dialog === true);
    r.conn.set({ state: 'denied' });
    t.ok('denied も差し替える', r.cards[0].updates.at(-1).state === 'denied');
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'setup', live: false });
    t.ok('ターンの外の接続では案内を出さない（頼んだ人が居ない）', r.handoffs.connect('s1') === null && r.cards.length === 0);
    const c = rig({ connection: 'connected' });
    t.ok('つながっていれば案内は出さない', c.handoffs.connect('s1') === null && c.cards.length === 0);
    const u = rig({ connection: 'unsupported' });
    t.ok('この OS では使えない（unsupported）なら出さない', u.handoffs.connect('s1') === null && u.handoffs.ask('s1', { reason: 'login', message: 'x' }) === null && u.cards.length === 0);
  }

  // ---- つながったら決着
  {
    const r = rig({ connection: 'permission' });
    r.handoffs.connect('s1');
    const waiting = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.conn.set({ state: 'connected' });
    const got = await waiting;
    t.ok('つながったら決着する（待つ人には connected）', got.kind === 'connected' && r.cards[0].answer?.allow === true && r.cards[0].answer.response.kind === 'connected', JSON.stringify(got));
    t.ok('待つ人がいれば続けるメッセージは送らない', r.env.sent.length === 0);
    t.ok('台帳から消え、demand の signal も外れる', r.handoffs.current('s1') === null && r.conn.demands[0].signal.aborted === true);
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'permission' });
    r.handoffs.connect('s1');
    r.conn.set({ state: 'connected' });
    t.ok('ターンの中で待つ人がいなければ置いておく（続けるメッセージは送らない）', r.env.sent.length === 0 && r.cards[0].answer?.allow === true);
    t.ok('ask は置いてある答えがあれば新しい依頼を出さない', r.handoffs.ask('s1', { reason: 'login', message: 'x' }) === null && r.cards.length === 1);
    const got = await r.handoffs.wait('s1', { sliceMs: 1000 });
    t.ok('次の wait がすぐ置いた答えを返す', got.kind === 'connected', JSON.stringify(got));
    t.ok('返した後は none', (await r.handoffs.wait('s1', { sliceMs: 10 })).kind === 'none');
    const d = rig({ connection: 'permission' });
    d.handoffs.connect('s1');
    d.conn.set({ state: 'connected' });
    d.handoffs.turnChanged('s1', false);
    t.ok('ターンが終わると置いた答えは捨てる', (await d.handoffs.wait('s1', { sliceMs: 10 })).kind === 'none');
    r.handoffs.close(); d.handoffs.close();
  }

  // ---- ask
  {
    const r = rig({ connection: 'connected' });
    const h1 = r.handoffs.ask('s1', { reason: 'login', message: '  example.com にログインしてください  ' });
    t.ok('ask は依頼のカードを出す（reason・message・asked）', r.cards.length === 1 && r.cards[0].opts.browserHandoff.state === 'asked' && r.cards[0].opts.browserHandoff.reason === 'login'
      && r.cards[0].opts.browserHandoff.message === 'example.com にログインしてください' && r.cards[0].opts.title === 'login:example.com にログインしてください', JSON.stringify(r.cards[0].opts.browserHandoff));
    t.ok('開いている依頼があれば新しく出さない（理由が違っても）', r.handoffs.ask('s1', { reason: 'captcha', message: 'y' }) === h1 && r.cards.length === 1);
    t.ok('別の会話の依頼は別のカード', r.handoffs.ask('s2', { reason: 'other', message: 'z' }) !== h1 && r.cards.length === 2);
    const long = rig({ connection: 'connected' });
    long.handoffs.ask('s1', { reason: 'nonsense', message: 'a'.repeat(500) });
    t.ok('知らない reason は other、message は 200 字で切る', long.cards[0].opts.browserHandoff.reason === 'other' && long.cards[0].opts.browserHandoff.message.length === 200);
    r.handoffs.close(); long.handoffs.close();
  }
  {
    const r = rig({ connection: 'off' });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    t.ok('接続が無いときの ask は接続の案内に読み替える', r.cards.length === 1 && r.cards[0].opts.browserHandoff.reason === 'connect' && r.conn.demands.length === 1);
    t.ok('案内の最中の ask は新しく出さない', (r.handoffs.ask('s1', { reason: 'login', message: 'x' }), r.cards.length === 1));
    r.handoffs.close();
  }

  // ---- wait: 区切り・中断
  {
    const r = rig({ connection: 'connected' });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    const first = await r.handoffs.wait('s1', { sliceMs: 15 });
    t.ok('sliceMs で waiting を返し、カードは残る', first.kind === 'waiting' && r.handoffs.current('s1') !== null && r.cards[0].answer === null, JSON.stringify(first));
    const again = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    r.cards[0].settle({ allow: true, response: { kind: 'resumed', at: '2026-10-08T00:00:00.000Z', url: 'https://a.example/', title: 'A', continued: false } });
    const done = await again;
    t.ok('呼び直しは同じ依頼に戻り、戻ったときの url・title を返す', r.cards.length === 1 && done.kind === 'resumed' && done.url === 'https://a.example/' && done.title === 'A', JSON.stringify(done));
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'connected' });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    const ac = new AbortController();
    const waiting = r.handoffs.wait('s1', { sliceMs: 60_000, signal: ac.signal });
    ac.abort();
    t.ok('wait は signal で aborted を返す（カードは残る）', (await waiting).kind === 'aborted' && r.cards[0].answer === null);
    t.ok('すでに中断済みの signal ならすぐ aborted', (await r.handoffs.wait('s1', { sliceMs: 60_000, signal: ac.signal })).kind === 'aborted');
    r.handoffs.close();
  }

  // ---- 止める
  {
    const r = rig({ connection: 'permission' });
    r.startTurn('s1');
    r.handoffs.connect('s1');
    const waiting = r.handoffs.wait('s1', { sliceMs: 60_000 });
    r.abortTurn('s1');
    const got = await waiting;
    t.ok('ターンの中断（人の止める）で aborted になり、demand の signal も外れる', got.kind === 'aborted' && r.cards[0].answer.messageKey === 'aborted' && r.conn.demands[0].signal.aborted === true, JSON.stringify(got));
    t.ok('中断では続けるメッセージを送らない', r.env.sent.length === 0);
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'connected' });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    r.handoffs.forget('s1');
    t.ok('会話を消すと中断として片付く', r.cards[0].answer?.messageKey === 'aborted' && r.handoffs.current('s1') === null);
    const c = rig({ connection: 'connected' });
    c.handoffs.ask('s1', { reason: 'login', message: 'x' });
    c.handoffs.close();
    t.ok('close で開いている依頼は中断として片付き、以後は出さない', c.cards[0].answer?.messageKey === 'aborted' && c.handoffs.ask('s1', { reason: 'login', message: 'x' }) === null);
  }

  // ---- 断る
  {
    const r = rig({ connection: 'connected' });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    const waiting = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.cards[0].settle({ allow: false, messageKey: 'userDenied' });
    t.ok('人の「断る」は declined', (await waiting).kind === 'declined');
    const c = rig({ connection: 'permission' });
    c.handoffs.connect('s1');
    c.conn.demands[0].reject(Object.assign(new Error('declined'), { code: 'declined' }));
    await tick();
    t.ok('設定の「やめる」（demand が declined）は断った扱いで決着する', c.cards[0].answer?.allow === false && c.handoffs.current('s1') === null);
    r.handoffs.close(); c.handoffs.close();
  }

  // ---- ターンの外で戻した・つながった → 続ける
  {
    const r = rig({ connection: 'permission', live: false });
    // ターンの外で開いたカード（ターンの中で出し、待つ人が居ないままターンが終わった形）
    r.env.live = true;
    r.handoffs.connect('s1');
    r.env.live = false;
    r.handoffs.turnChanged('s1', false);
    t.ok('ターンが終わるとカードの turnLive が false になる', r.cards[0].updates.at(-1)?.turnLive === false);
    r.conn.set({ state: 'connected' });
    await tick();
    t.ok('ターンの外でつながったら「続けてください」を 1 回だけ送る', r.env.sent.length === 1 && r.env.sent[0].sessionId === 's1' && r.env.sent[0].kind === 'connected'
      && r.env.sent[0].messageId === continuationMessageId('perm-1'), JSON.stringify(r.env.sent));
    t.ok('答えの continued が立つ', r.cards[0].answer.response.continued === true);
    r.conn.set({ state: 'connected' });
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'connected', withControl: true });
    r.handoffs.ask('s1', { reason: 'login', message: 'x' });
    t.ok('control が paused になると「あなたが操作中」に替わる（by・windowTitle）', (r.control.set('s1', { state: 'paused', by: 'device', url: 'https://a.example/', title: 'A' }), r.cards[0].updates.at(-1)?.state === 'operating' && r.cards[0].updates.at(-1).by === 'device' && r.cards[0].updates.at(-1).windowTitle === 'A'), JSON.stringify(r.cards[0].updates));
    r.env.live = false;
    r.control.set('s1', { state: 'running' });
    await tick();
    t.ok('paused が解けたら決着し、ターンの外なら続けるメッセージを 1 回送る', r.cards[0].answer?.allow === true && r.cards[0].answer.response.kind === 'resumed' && r.cards[0].answer.response.url === 'https://a.example/'
      && r.env.sent.length === 1 && r.env.sent[0].kind === 'resumed', JSON.stringify({ a: r.cards[0].answer, s: r.env.sent }));
    r.control.set('s1', { state: 'running' });
    await tick();
    t.ok('同じカードでもう一度解けても 2 回目は送らない', r.env.sent.length === 1);
    r.handoffs.close();
  }
  {
    const r = rig({ connection: 'connected', withControl: true });
    r.control.set('s1', { state: 'paused', by: 'pc', url: 'https://b.example/', title: 'B' });
    r.handoffs.ask('s1', { reason: 'captcha', message: 'x' });
    t.ok('人が先に引き継いでいた（paused）ときは operating から始める', r.cards[0].updates.at(-1)?.state === 'operating' && r.cards[0].updates.at(-1).windowTitle === 'B');
    const waiting = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.control.set('s1', { state: 'running' });
    const got = await waiting;
    t.ok('ターンの中で待っていれば resumed を返し、続けるメッセージは送らない', got.kind === 'resumed' && r.env.sent.length === 0, JSON.stringify(got));
    r.handoffs.close();
  }
  {
    const busy = rig({ connection: 'connected', withControl: true, live: false, busy: true });
    busy.handoffs.ask('s1', { reason: 'login', message: 'x' });
    busy.control.set('s1', { state: 'paused', by: 'pc' });
    busy.control.set('s1', { state: 'running' });
    await tick();
    t.ok('切り替え・分岐の最中（busy）は送らない', busy.cards[0].answer?.allow === true && busy.env.sent.length === 0 && busy.cards[0].answer.response.continued === false);
    const no = rig({ connection: 'connected', live: false });
    no.handoffs.ask('s1', { reason: 'login', message: 'x' });
    no.cards[0].settle({ allow: false, messageKey: 'userDenied' });
    const ab = rig({ connection: 'connected', live: false });
    ab.handoffs.ask('s1', { reason: 'login', message: 'x' });
    ab.cards[0].settle({ allow: false, messageKey: 'aborted' });
    await tick();
    t.ok('断った・中断のときは送らない', no.env.sent.length === 0 && ab.env.sent.length === 0);
    busy.handoffs.close(); no.handoffs.close(); ab.handoffs.close();
  }

  // ---- 偽の「つながった」を返さない: つながっていないのに外から allow:true が来ても（端末の中継の「許可」）、子へ connected を返さない
  {
    const r = rig({ connection: 'setup' });
    r.handoffs.connect('s1');
    t.ok('接続の案内が開いている間、ask・connect を重ねてもカードは増えない', r.handoffs.ask('s1', { reason: 'login', message: 'x' }) === r.handoffs.connect('s1') && r.cards.length === 1);
    const waiting = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.cards[0].settle({ allow: true, always: false, scope: 'once', message: null, response: null });
    const got = await waiting;
    t.ok('つながっていない接続の案内への allow:true（端末の中継の許可）は「つながった」にならない（子に connected を返さない）', got.kind !== 'connected' && got.kind === 'aborted', JSON.stringify(got));
    t.ok('そのとき「続けてください」も送らない', r.env.sent.length === 0);
    const text = handToUserResult('ja', got).text;
    t.ok('子に返る文に「Chrome につながりました」は出ない', !/つながりました/.test(text), text);
    r.handoffs.close();
    const late = rig({ connection: 'permission' });
    late.handoffs.connect('s1');
    late.env.live = false;
    late.cards[0].settle({ allow: true, always: false, scope: 'once', message: null, response: null });
    await tick();
    t.ok('ターンが終わった後でも、偽の許可では「続けてください」を送らない', late.env.sent.length === 0 && late.handoffs.current('s1') === null);
    late.handoffs.close();
  }
  // ---- 端末の人が「Chrome を使わずに続けてもらう」を選んだ（messageKey: chromeSkipped）: 子には、断られたのではなく Chrome 抜きで進めてよいと返す
  {
    const r = rig({ connection: 'setup' });
    r.handoffs.connect('s1');
    const waiting = r.handoffs.wait('s1', { sliceMs: 1000 });
    r.cards[0].settle({ allow: false, messageKey: 'chromeSkipped' });
    const got = await waiting;
    t.ok('chromeSkipped は declined に skipped が付いて返る（続けるメッセージは送らない）', got.kind === 'declined' && got.skipped === true && r.env.sent.length === 0, JSON.stringify(got));
    const skipped = handToUserResult('ja', got);
    const declined = handToUserResult('ja', { kind: 'declined' });
    t.ok('skipped の文は「Chrome を使わずに進めて」と伝え、エラーにしない。人が断ったときの文とは別', skipped.isError === false && /Chrome を使わずに/.test(skipped.text) && declined.isError === true && skipped.text !== declined.text, skipped.text);
    t.ok('英語の文もある（辞書の欠け落ちが無い）', /without Chrome/i.test(handToUserResult('en', got).text), handToUserResult('en', got).text);
    r.handoffs.close();
    const d = rig({ connection: 'setup' });
    d.handoffs.connect('s1');
    const w2 = d.handoffs.wait('s1', { sliceMs: 1000 });
    d.cards[0].settle({ allow: false, messageKey: 'userDenied' });
    const plain = await w2;
    t.ok('ホストの画面の「断る」（userDenied）は従来どおり skipped の無い declined', plain.kind === 'declined' && plain.skipped === undefined, JSON.stringify(plain));
    d.handoffs.close();
  }

  // ---- 配線（server.mjs）
  {
    const server = readFileSync(new URL('../../core/server.mjs', import.meta.url), 'utf8');
    t.ok('server: 端末へ中継する Chrome の操作待ちの便りに chromeWait の印を載せる', /\.\.\.\(browserHandoff \? \{ chromeWait: \{ reason: browserHandoff\.reason \?\? null \} \} : \{\}\)/.test(server));
    t.ok('server: 端末の人の答え（relay の answer）も、Chrome の操作待ちへの「許可」は HANDOFF_ONLY で断る', /if \(browserHandoff && allow === true\) return 'HANDOFF_ONLY';/.test(server));
    t.ok('server: 端末の「断る」は chromeSkipped の印で子へ返る', /!allow && browserHandoff \? \{ messageKey: 'chromeSkipped' \}/.test(server));
    t.ok('server: 端末のカード（remoteCards.open）へ chromeWait を渡す', /\.\.\.\(c\.chromeWait \? \{ chromeWait: c\.chromeWait \} : \{\}\)/.test(server));
    t.ok('server: 一般の「許可」では Chrome の操作待ちを進めない（allow:true は HANDOFF_ONLY で断る）', /browserHandoff && allow === true\) return reply\(false, t\('approval\.browserHandoffAllow'\), 'HANDOFF_ONLY'\)/.test(server));
    t.ok('server: ターンの始まり・終わりで turnChanged、会話の削除で forget', /chromeHandoffs\?\.turnChanged\([^)]*true\)/.test(server) && /chromeHandoffs\?\.turnChanged\([^)]*false\)/.test(server) && /chromeHandoffs\?\.forget\(/.test(server));
  }
}
