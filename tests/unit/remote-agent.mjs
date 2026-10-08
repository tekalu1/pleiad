// 端末の AI からの委譲の口 /agent（ホストの側。core/remote/agent-port.mjs、docs/remote.md §4.5、ADR 0146）。
// 中継（relay/server.mjs）をこのプロセスで立て、fake バックエンドのサーバーを別プロセスで立て、試験用の端末（tests/lib/remote-device.mjs）から
// /agent を開く。LLM もネットワークも使わない。許可（既定オフ・デスクトップ版の端末だけ・人だけが変える）・防火壁・委譲と状態と完了・
// 承認モードの継承と引き上げの確かめ・上限・出どころ・承認の中継と人の答え（受領証・1 回だけ・ほかの端末は答えられない）・取り消しで止まる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRelay } from '../../relay/server.mjs';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { pairDevice, connectDevice } from '../lib/remote-device.mjs';
import { openAgent, requesterOf } from '../lib/remote-agent-client.mjs';
import { checkPath } from '../../core/remote/forward.mjs';
import { createAgentPort } from '../../core/remote/agent-port.mjs';
import { viewMessages, viewCursor, trimViewMessage, viewAnswer, viewInstructions, pickDescendants, VIEW_LIMITS } from '../../core/remote/agent-view.mjs';
import { maskOutput, MASK } from '../../core/ops/registry.mjs';
import { hostViewCursor, joinHostView, hostTreeRows, mergeHostTree, hostRowStale, hostRowRunning, HOST_ROW_STALE_MS } from '../../web/host-view.mjs';
import { visibleTaskInstructions } from '../../web/task-instructions.mjs';
import { createCardRoll } from '../../web/card-roll.mjs';
import { AGENT_OPS, AGENT_LIMITS, remoteOwnerId, parseRemoteOwner, normalizeRequester, relayReceipt } from '../../core/remote/agent-protocol.mjs';

export const name = 'remote-agent';
export const title = '端末の AI からの委譲の口（/agent）: 許可・防火壁・委譲と状態・承認モード・上限・承認の中継と人の答え・取り消し';

const SECRET = crypto.randomBytes(32).toString('base64url');
const within = (p, ms, label) => {
  let timer;
  return Promise.race([Promise.resolve(p).finally(() => clearTimeout(timer)), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} が ${ms}ms で終わらない`)), ms); })]);
};
const rejects = p => p.then(() => null, e => e);

export default async function (t) {
  // ---- 純粋な部品
  t.ok('仮の親の ID は remote:<deviceId>:<会話> で、読み戻せる', (() => {
    const id = remoteOwnerId('dABC', 'sess:with:colon');
    const p = parseRemoteOwner(id);
    return id === 'remote:dABC:sess:with:colon' && p?.deviceId === 'dABC' && p?.sessionId === 'sess:with:colon' && parseRemoteOwner('local-session') === null && parseRemoteOwner('remote:x:') === null;
  })());
  t.ok('依頼元の正規化: 会話の ID が無ければ null、承認モードの不明な値は弱い側へ', (() => {
    const bad = normalizeRequester({ title: 'x' });
    const weak = normalizeRequester({ sessionId: 's', mode: { scope: 'root', autonomy: 'always', enforced: 'yes' } });
    return bad === null && weak.mode.scope === 'workspace' && weak.mode.autonomy === 'ask' && weak.mode.enforced === false;
  })());
  t.ok('受領証は承認の ID・タスク・道具・入力に結ばれる', (() => {
    const a = relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' });
    return a === relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' })
      && a !== relayReceipt({ id: '2', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 's' })
      && a !== relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 2 }, salt: 's' })
      && a !== relayReceipt({ id: '1', taskId: 't', toolName: 'x', input: { a: 1 }, salt: 'z' });
  })());
  t.ok('防火壁: /agent は接続口が自分で受ける（checkPath は通すが、forwardStream はローカルへ通さない）', checkPath('/agent')?.pathname === '/agent');

  // ---- 経過の読み出しの絞り込み（運ぶ前に絞る。docs/remote.md §4.5）
  {
    const big = 'x'.repeat(10_000);
    const trimmed = trimViewMessage({ role: 'assistant', text: 'a'.repeat(20_000), thinking: big, uuid: 'u1', toolCalls: [{ id: 'c1', name: 'Bash', input: { command: big, n: 1, nested: { img: 'data:image/png;base64,AAAA' } }, result: { text: big, isError: false, secret: 'drop-me' } }],
      attachments: [{ name: 'a.png', mime: 'image/png', data: 'data:image/png;base64,ZZZZ' }] });
    t.ok('発言の絞り込み: 本文は 16 KB・考えた内容は 4 KB・ツールの入力と出力は 1 つ 2 KB まで', trimmed.text.length <= VIEW_LIMITS.text + 1 && trimmed.thinking.length <= VIEW_LIMITS.thinking + 1
      && trimmed.toolCalls[0].input.command.length <= VIEW_LIMITS.field + 1 && trimmed.toolCalls[0].result.text.length <= VIEW_LIMITS.field + 1 && trimmed.toolCalls[0].result.truncated === true && trimmed.toolCalls[0].input.n === 1);
    t.ok('画像は枠だけ（data URI・添付の中身は運ばない）、ツールの出力の余計な項目も落とす', trimmed.toolCalls[0].input.nested.img === '' && trimmed.attachments[0].omitted === true && trimmed.attachments[0].data === undefined && trimmed.toolCalls[0].result.secret === undefined);
    const many = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, uuid: `u${i}` }));
    const first = viewMessages(many);
    t.ok('初回は末尾 40 発言（古い分は省き、from がその位置・total が総数）', first.messages.length === 40 && first.from === 60 && first.total === 100 && first.full === true && first.messages[0].text === 'm60');
    const cursor = viewCursor(first.from, first.messages);
    t.ok('続きの位置は、持っている末尾の数発言を取り直す位置（その前の 1 件の署名つき）', cursor.from === 60 + 40 - VIEW_LIMITS.resend && Number.isFinite(cursor.check));
    const grown = viewMessages([...many, { role: 'assistant', text: 'new1' }, { role: 'user', text: 'new2' }], cursor);
    t.ok('続きは cursor から先の発言だけ（全量ではない）', grown.full === false && grown.from === cursor.from && grown.messages.length === 102 - cursor.from && grown.messages.at(-1).text === 'new2', JSON.stringify([grown.full, grown.from, grown.messages.length]));
    const rewritten = viewMessages(many.map((m, i) => (i === cursor.from - 1 ? { ...m, text: 'changed' } : m)), cursor);
    t.ok('持っている先頭と署名が合わなければ、末尾から読み直す（full）', rewritten.full === true && rewritten.from === 60);
    const stale = viewMessages(many, { from: 10, check: 1 });
    t.ok('古すぎる位置（省いた範囲）も末尾から読み直す', stale.full === true && stale.from === 60);
    const heavy = viewMessages(Array.from({ length: 60 }, () => ({ role: 'assistant', text: 'y'.repeat(16_000) })));
    t.ok('発言は答えの予算に収め、収まらない分は古い方から省く', Buffer.byteLength(JSON.stringify(heavy.messages)) <= VIEW_LIMITS.bodyBytes && heavy.from > 20 && heavy.messages.length < 40 && heavy.full === true, JSON.stringify([heavy.from, heavy.messages.length]));
    t.ok('端末の AI の依頼（AGENT_OPS）に読み出しは入っていない', !AGENT_OPS.includes('view') && AGENT_OPS.length === 6);
  }

  // ---- 答えの大きさ: 日本語・ツールの多い発言、発言の外（task・追加の指示・子孫の要約）を足しても口の上限を超えない
  {
    const ja = n => 'あ'.repeat(n);
    const frameBytes = result => Buffer.byteLength(JSON.stringify({ t: 'viewed', id: 'a1', ok: true, result }));
    // 1 件に並列のツールが 20 個（入力と出力は日本語 3,000 字）。前は 1 件で 373 KB になり、末尾にある間は毎回 TOO_LARGE だった
    const toolHeavy = { role: 'assistant', text: ja(500), toolCalls: Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: 'Edit', input: { file_path: 'a', old_string: ja(3000), new_string: ja(3000) }, result: { text: ja(3000) } })) };
    const one = trimViewMessage(toolHeavy);
    t.ok('ツールの多い日本語の発言 1 件も 48 KB に収める（一段絞る。ツールの名前と順は残す）', Buffer.byteLength(JSON.stringify(one)) <= VIEW_LIMITS.messageBytes && one.toolCalls.length === 20 && one.toolCalls[0].name === 'Edit' && one.toolCalls[0].result.truncated === true, String(Buffer.byteLength(JSON.stringify(one))));
    const huge = { role: 'assistant', text: ja(20_000), toolCalls: Array.from({ length: 60 }, (_, i) => ({ id: `t${i}`, name: 'Write', input: Object.fromEntries(Array.from({ length: 30 }, (_, k) => [`k${k}`, ja(400)])), result: { text: ja(400) } })) };
    const framed = trimViewMessage(huge);
    t.ok('二段に絞っても大きすぎる発言は枠だけ（本文の頭とツールの名前。viewOmitted）', framed.viewOmitted === true && framed.toolCalls.length === VIEW_LIMITS.toolCalls && framed.toolCalls.every(c => c.input === null) && Buffer.byteLength(JSON.stringify(framed)) <= VIEW_LIMITS.messageBytes);
    const keys = trimViewMessage({ role: 'assistant', text: '', toolCalls: [{ id: 'k', name: 'X', input: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])) }] });
    t.ok('ツールの入力のキーの数も絞る（50 まで）', Object.keys(keys.toolCalls[0].input).length === VIEW_LIMITS.keys);
    t.ok('考えた内容が文字列でなくても、絞ってから運ぶ', trimViewMessage({ role: 'assistant', text: '', thinking: { a: 'z'.repeat(10_000), b: 'data:image/png;base64,AA' } }).thinking.a.length <= VIEW_LIMITS.field + 1
      && trimViewMessage({ role: 'assistant', text: '', thinking: { b: 'data:image/png;base64,AA' } }).thinking.b === '');
    const tailOnly = viewMessages([{ role: 'user', text: 'hi' }, toolHeavy]);
    t.ok('ツールの多い発言が末尾にあっても、答えに入る', tailOnly.messages.length === 2 && frameBytes(tailOnly) <= AGENT_LIMITS.messageBytes);
    const msgs = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: ja(4000), at: i }));
    const extras = {
      task: { taskId: 'ply-task-x', title: ja(200), status: 'running', error: ja(500) }, sessionId: 's',
      instructions: viewInstructions(Array.from({ length: 20 }, (_, i) => ({ id: i, text: ja(1000), state: 'delivered' }))),
      descendants: Array.from({ length: 40 }, (_, i) => ({ taskId: `d${i}`, parentTaskId: 'ply-task-x', title: ja(80), status: 'failed', error: ja(500) })), descendantsOmitted: 0, waiting: false,
    };
    const full = viewAnswer(msgs, null, extras);
    t.ok('発言の外（task・追加の指示 20 件・子孫の要約 40 件。日本語）を足した答え全体が、口の上限の内側に収まる', frameBytes(full) <= AGENT_LIMITS.messageBytes && full.messages.length > 0 && full.instructions.length === 20 && full.descendants.length === 40 && full.full === true, String(frameBytes(full)));
    t.ok('答え全体の予算は、口の上限から余白を引いた値', VIEW_LIMITS.bodyBytes < AGENT_LIMITS.messageBytes && Buffer.byteLength(JSON.stringify(full)) <= VIEW_LIMITS.bodyBytes);
    t.ok('利用者の発言の総数（userCount）は、省いた古い分も数える', full.userCount === 30 && full.messages.filter(m => m.role === 'user').length < 30);
    // 口: 読み出しの答えが大きくても、TOO_LARGE にならずに届く
    const sent = []; const h = {};
    const port = createAgentPort({ allowed: () => true, hostName: () => 'h', invoke: async () => ({}), view: async () => viewAnswer([...msgs, toolHeavy], null, extras) });
    port.attach({ kind: 'ws', destroyed: false, localDone: false, on: (n, f) => { h[n] = f; }, accept: () => Promise.resolve(), send: m => { sent.push(JSON.parse(m)); return Promise.resolve(); }, close: () => Promise.resolve(), reset() {} }, { id: 'dL', name: 'l', platform: 'desktop' });
    await sleep(10);
    h.message(Buffer.from(JSON.stringify({ t: 'view', id: 'big', taskId: 'ply-task-x' })), true, () => {});
    await sleep(50);
    const big = sent.find(m => m.t === 'viewed' && m.id === 'big');
    t.ok('口: 日本語・ツールの多い発言と大きい追加の指示・子孫を含む答えも、TOO_LARGE にならずに届く', big?.ok === true && big.result.messages.at(-1).toolCalls?.length === 20, JSON.stringify(big).slice(0, 200));
  }

  // ---- 伏せ字と続きの位置: ホストは、端末の画面へ返す前の伏せ字（maskOutput）と同じ形で照合する
  {
    const withSecret = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, toolCalls: i % 2 ? [{ id: `c${i}`, name: 'Login', input: { token: `tok-${i}`, password: 'pw' } }] : undefined }));
    const masked = trimViewMessage(withSecret[1]);
    t.ok('秘密らしい名前の欄は、運ぶ前に伏せる', masked.toolCalls[0].input.token === MASK && masked.toolCalls[0].input.password === MASK);
    // 端末の画面は、ops の invoke が返す前に maskOutput を通した答えを持つ
    let held = joinHostView({ base: 0, messages: [], sigs: [] }, maskOutput(viewMessages(withSecret)));
    let resends = 0;
    for (let n = 61; n <= 80; n++) {
      const grown = [...withSecret, ...Array.from({ length: n - 60 }, (_, i) => ({ role: 'assistant', text: `new${i}`, toolCalls: [{ id: `n${i}`, name: 'Login', input: { token: `x${i}` } }] }))];
      const reply = maskOutput(viewMessages(grown, hostViewCursor(held)));
      if (reply.full) resends++;
      held = joinHostView(held, reply);
    }
    t.ok('伏せた欄のある発言が続きの照合の位置に来ても、続きがつながる（末尾を読み直さない）', resends === 0 && held.messages.at(-1).text === 'new19', String(resends));
  }

  // ---- 子孫の要約の選び方・差し込み中の指示・孫の行の後始末
  {
    const rows = Array.from({ length: 50 }, (_, i) => ({ taskId: `d${i}`, status: i < 2 ? 'running' : 'completed', updatedAt: i < 2 ? 1 : 1000 + i }));
    const picked = pickDescendants(rows, { isLive: r => r.status === 'running' });
    t.ok('子孫の要約: 走っているもの・新しいものを優先して 40 件、省いた件数を返す（並びは元の順）', picked.rows.length === 40 && picked.omitted === 10
      && picked.rows.some(r => r.taskId === 'd0') && picked.rows.some(r => r.taskId === 'd49') && !picked.rows.some(r => r.taskId === 'd11') && picked.rows[0].taskId === 'd0');
    t.ok('子孫が 40 件以下なら、そのまま（省いた件数は 0）', pickDescendants(rows.slice(0, 5)).omitted === 0);
    const tail = [{ role: 'assistant', text: 'a' }, { role: 'user', text: 'second' }, { role: 'assistant', text: 'b' }];
    const sending = [{ id: 'i1', state: 'delivered' }, { id: 'i2', state: 'sending' }];
    t.ok('差し込み中の指示: 末尾だけの筋でも、会話全体の利用者の発言の数で判定する（筋に入った指示を二重に出さない）',
      visibleTaskInstructions(sending, tail).some(x => x.id === 'i2') && !visibleTaskInstructions(sending, tail, 3).some(x => x.id === 'i2') && visibleTaskInstructions(sending, tail, 2).some(x => x.id === 'i2'));
    const tree = [{ taskId: 'g1', rawStatus: 'running' }, { taskId: 'g2', rawStatus: 'completed' }, { taskId: 'g3', rawStatus: 'waiting' }];
    const now = 1_000_000;
    t.ok('孫の行: 読んだばかりの走っている行は古くない', !hostRowStale(tree[0], now - 1000, now) && !hostRowStale(tree[2], now - HOST_ROW_STALE_MS, now));
    t.ok('孫の行: 走っている印のまましばらく読めていない行・一度も読めていない行は古い（「動いている」に数えない）', hostRowStale(tree[0], now - HOST_ROW_STALE_MS - 1, now) && hostRowStale(tree[2], null, now));
    t.ok('孫の行: 終わった行は、読んだ時刻に関わらず古くない（状態は変わらない）', !hostRowStale(tree[1], null, now) && hostRowRunning(tree[0]) && !hostRowRunning(tree[1]));
    t.ok('孫の詳細の答えの task で、その行を置き換える', mergeHostTree(tree, [{ taskId: 'g1', rawStatus: 'completed' }]).find(r => r.taskId === 'g1').rawStatus === 'completed');
  }

  // ---- 承認・質問のカードの名簿（web/card-roll.mjs）: 同じ承認のカードを依頼元の会話と詳細の両方に持つ
  {
    const card = (name, log) => {
      const el = { isConnected: true, classList: { contains: () => false } };
      return { el, entry: { el, sending: () => false, fold: how => log.push(`${name}:${how.by}`), setOnline: on => log.push(`${name}:${on ? 'on' : 'off'}`) } };
    };
    const log = [];
    const roll = createCardRoll();
    const conv = card('conv', log), d1 = card('d1', log);
    roll.add('p1', conv.entry); roll.add('p1', d1.entry);
    // 詳細の読み直しで前のカードが外れても、依頼元の会話のカードは名簿に残る
    d1.el.isConnected = false;
    roll.prune();
    t.ok('名簿: 外れた詳細のカードだけを外し、依頼元の会話のカードは残す', roll.has('p1') && roll.of('p1').length === 1 && roll.of('p1')[0] === conv.entry);
    const d2 = card('d2', log);
    roll.add('p1', d2.entry);
    for (const e of roll.of('p1')) e.setOnline(false);
    roll.fold('p1', { by: 'host' });
    t.ok('名簿: オフラインの便り・決着は、同じ承認のカード全部に届き、畳んだら名簿から消える', log.join() === 'conv:off,d2:off,conv:host,d2:host' && !roll.has('p1'), log.join());
    const roll2 = createCardRoll();
    const only = card('x', []);
    roll2.add('p2', only.entry);
    for (let i = 0; i < 100; i++) { const c = card(`r${i}`, []); roll2.add('p2', c.entry); c.el.isConnected = false; roll2.prune(); }
    t.ok('名簿: 詳細の読み直しを繰り返しても、外れたカードを溜め込まない', roll2.of('p2').length === 1);
    only.el.isConnected = false;
    roll2.prune();
    t.ok('名簿: カードが全部外れたら、行ごと外す', !roll2.has('p2'));
  }

  // ---- 端末の画面が持つ側（web/host-view.mjs）: 続きをつなぐ・孫の並び
  {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` }));
    let held = joinHostView({ base: 0, messages: [], sigs: [] }, { ...viewMessages(msgs) });
    t.ok('最初の答えは末尾 40 件を、位置（base）つきで持つ（古い 10 件は省いた分）', held.base === 10 && held.messages.length === 40 && held.total === 50);
    const next = [...msgs, { role: 'assistant', text: 'new1' }, { role: 'user', text: 'new2' }];
    const reply = viewMessages(next, hostViewCursor(held));
    held = joinHostView(held, reply);
    t.ok('続きの答えは持っている先頭につながり、位置は変わらない（行が増えるだけ）', reply.full === false && held.base === 10 && held.messages.length === 42 && held.messages.at(-1).text === 'new2' && held.total === 52 && held.sigs.length === 42);
    const rewritten = viewMessages(next.map((m, i) => (i === 48 ? { ...m, text: 'changed' } : m)), hostViewCursor(held));
    const replaced = joinHostView(held, rewritten);
    t.ok('署名が合わない答え（full）は、持っている分を置き換える', rewritten.full === true && replaced.base === rewritten.from && replaced.messages.length === rewritten.messages.length);
    t.ok('持っているのが少ないうちは続きを頼まず、末尾から読み直す', hostViewCursor({ base: 0, messages: msgs.slice(0, 3), sigs: null }) === null);
    t.ok('位置が食い違う続きは、そのまま置き換える（つなぎ損ねない）', joinHostView(held, { messages: [{ role: 'user', text: 'x' }], from: 500, total: 501, full: false }).base === 500);
    const rows = [
      { taskId: 'g2', parentTaskId: 'r', sessionId: 's-g2', createdAt: 2 }, { taskId: 'g1', parentTaskId: 'r', sessionId: 's-g1', createdAt: 1 },
      { taskId: 'gg', parentTaskId: 'g1', sessionId: 's-gg', createdAt: 3 }, { taskId: 'lost', parentTaskId: 'unknown', sessionId: 's-l', createdAt: 0 },
    ];
    const tree = hostTreeRows('r', 's-r', rows, id => `hs:${id}`);
    t.ok('孫の並び: 兄弟は新しい順・子は親の直後・深さと親の印つき・親の分からない行は根の直下', tree.map(x => `${x.row.taskId}:${x.depth}:${x.parentKey}`).join(' ') === 'g2:1:hs:s-r g1:1:hs:s-r gg:2:hs:s-g1 lost:1:hs:s-r' && tree.find(x => x.row.taskId === 'g1').childCount === 1, tree.map(x => `${x.row.taskId}:${x.depth}`).join(' '));
    t.ok('子孫の混ぜ方: 根を読んだときは置き換え、孫の詳細を読んだときは同じ行を更新して足す', mergeHostTree([{ taskId: 'a', v: 1 }, { taskId: 'b', v: 1 }], [{ taskId: 'a', v: 2 }], { replace: true }).length === 1
      && mergeHostTree([{ taskId: 'a', v: 1 }, { taskId: 'b', v: 1 }], [{ taskId: 'a', v: 2 }, { taskId: 'c', v: 1 }]).map(r => `${r.taskId}${r.v}`).join() === 'a2,b1,c1');
  }

  // ---- 経過の読み出しの口だけの部品（サーバーなし）: 許可・未対応・件数だけの記録・口の種類
  {
    const sent = [];
    const handlers = {};
    const stream = { kind: 'ws', destroyed: false, localDone: false, on: (n, f) => { handlers[n] = f; }, accept: () => Promise.resolve(), send: m => { sent.push(JSON.parse(m)); return Promise.resolve(); }, close: () => Promise.resolve(), reset() {} };
    const audits = [];
    let permit = true;
    const calls = [];
    const port = createAgentPort({ allowed: () => permit, hostName: () => 'h', invoke: async () => ({}), audit: e => audits.push(e),
      view: async call => { calls.push(call); return { messages: [{ role: 'user', text: 'SECRET-BODY' }, { role: 'assistant', text: 'x' }], from: 0, total: 2, full: true }; } });
    port.attach(stream, { id: 'dV', name: 'v', platform: 'desktop' });
    await sleep(10);
    const ask = async (msg) => { const before = sent.length; handlers.message(Buffer.from(JSON.stringify(msg)), true, () => {}); await sleep(30); return sent.slice(before).find(m => m.t === 'viewed'); };
    t.ok('ready に view: true（読み出しを知っているホスト）が載る', sent.find(m => m.t === 'ready')?.view === true);
    const ok = await ask({ t: 'view', id: 'v1', taskId: 'ply-task-1', cursor: { from: 2, check: 7, extra: 'x' } });
    t.ok('許可のある端末の読み出しは、deps.view に端末・taskId・cursor（from・check だけ）で渡る', ok.ok === true && calls[0].device.id === 'dV' && calls[0].taskId === 'ply-task-1' && JSON.stringify(calls[0].cursor) === JSON.stringify({ from: 2, check: 7 }));
    const rec = audits.find(a => a.op === 'view');
    t.ok('記録は件数だけ（by: human・via: remote-device・件数。会話の中身は残さない）', rec?.by === 'human' && rec.via === 'remote-device' && rec.count === 2 && !JSON.stringify(rec).includes('SECRET-BODY'), JSON.stringify(rec));
    t.ok('taskId の無い・形の違う読み出しは BAD_REQUEST', (await ask({ t: 'view', id: 'v2', taskId: '' })).code === 'BAD_REQUEST' && (await ask({ t: 'view', id: 'v3' })).code === 'BAD_REQUEST');
    permit = false;
    const off = await ask({ t: 'view', id: 'v4', taskId: 'ply-task-1' });
    t.ok('「AI からの依頼を受ける」がオフなら読めない（NOT_ALLOWED。deps.view は呼ばれない）', off.ok === false && off.code === 'NOT_ALLOWED' && calls.length === 1);
    const old = createAgentPort({ allowed: () => true, hostName: () => 'h', invoke: async () => ({}) });
    const sent2 = []; const h2 = {};
    old.attach({ kind: 'ws', destroyed: false, localDone: false, on: (n, f) => { h2[n] = f; }, accept: () => Promise.resolve(), send: m => { sent2.push(JSON.parse(m)); return Promise.resolve(); }, close: () => Promise.resolve(), reset() {} }, { id: 'dO', name: 'o', platform: 'desktop' });
    await sleep(10);
    h2.message(Buffer.from(JSON.stringify({ t: 'view', id: 'v5', taskId: 'x' })), true, () => {});
    await sleep(30);
    t.ok('読み出しを持たない口は ready に view が無く、読み出しは UNSUPPORTED', sent2.find(m => m.t === 'ready')?.view === false && sent2.find(m => m.t === 'viewed')?.code === 'UNSUPPORTED');
  }

  // ---- 口だけの部品（サーバーなし）: 頻度の上限
  {
    const sent = [];
    let stream;
    const mk = () => {
      const handlers = {};
      stream = { kind: 'ws', destroyed: false, localDone: false, on: (n, f) => { handlers[n] = f; }, accept: () => Promise.resolve(), send: m => { sent.push(JSON.parse(m)); return Promise.resolve(); }, close: () => Promise.resolve(), reset() {}, handlers };
      return stream;
    };
    const port = createAgentPort({ allowed: () => true, hostName: () => 'h', invoke: async () => ({ ok: 1 }), now: () => 1_000 });
    port.attach(mk(), { id: 'dX', name: 'x', platform: 'desktop' });
    await sleep(10);
    for (let i = 0; i < AGENT_LIMITS.perMinute + 3; i++) {
      stream.handlers.message(Buffer.from(JSON.stringify({ t: 'req', id: `a${i}`, op: 'send', args: { taskId: 'x', message: 'y' }, requester: requesterOf() })), true, () => {});
    }
    await sleep(50);
    const limited = sent.filter(m => m.t === 'res' && m.code === 'RATE_LIMITED').length;
    t.ok(`頻度の上限: delegate・send は 1 分に ${AGENT_LIMITS.perMinute} 件まで（超えた分は RATE_LIMITED）`, limited === 3 && sent.filter(m => m.t === 'res' && m.ok).length === AGENT_LIMITS.perMinute, `${limited}`);
  }

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-remote-agent-')));
  const dataDir = path.join(scratch, 'data');
  const relay = createRelay({ enrollSecret: SECRET, trustProxy: false, logger: () => {} });
  const relayPort = (await relay.listen(0, '127.0.0.1')).port;
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const cmd = (command, args = {}) => within(c.cmd(command, args), 15_000, `コマンド ${command}`);
  const devices = [], agents = [];
  const pair = async (name, platform) => {
    const offer = await cmd('remotePairingStart');
    const from = c.mark();
    const p = pairDevice({ payload: offer.payload, name, platform });
    const req = await c.waitFor(e => e.type === 'remotePairing' && e.phase === 'request', { from, ms: 10_000 });
    await cmd('remotePairingApprove', { id: req.request.id });
    const creds = await within(p.result, 15_000, 'ペアリングの結果');
    const d = await connectDevice(creds);
    devices.push(d);
    return { creds, d, id: creds.deviceId };
  };
  const agent = async dev => { const a = await within(openAgent(dev.d), 15_000, '/agent を開く'); if (a.accepted) agents.push(a); return a; };
  const hostRows = () => cmd('agentTasks');
  try {
    await cmd('setRemoteSettings', { relayUrl: `http://127.0.0.1:${relayPort}`, enrollSecret: SECRET, enabled: true, hostName: 'desk-test' });
    await c.waitFor(e => e.type === 'remoteStatus' && e.status.connection.state === 'connected', { from: 0, ms: 10_000 });
    const laptop = await pair('laptop', 'desktop');
    const phone = await pair('Pixel 9', 'android');

    // ---- 既定はオフ
    const list0 = await cmd('remoteDevices');
    const lap0 = list0.find(d => d.id === laptop.id), pho0 = list0.find(d => d.id === phone.id);
    t.ok('端末の行に agent が出る: デスクトップ版は available・既定オフ、スマホは available でない', lap0.agent.available === true && lap0.agent.enabled === false && pho0.agent.available === false && pho0.agent.enabled === false, JSON.stringify([lap0.agent, pho0.agent]));
    const a0 = await agent(laptop);
    t.ok('オフの端末でも口は開くが、ready の allowed は false', a0.accepted && a0.ready.allowed === false && a0.ready.v === 1 && a0.ready.hostName === 'desk-test');
    const denied0 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:NO' });
    t.ok('許可していない端末の依頼は NOT_ALLOWED で、タスクは作られない', denied0.ok === false && denied0.code === 'NOT_ALLOWED' && (await hostRows()).length === 0, JSON.stringify(denied0));
    const http = await laptop.d.get('/agent');
    t.ok('/agent を HTTP で取りに来ても、ローカルのサーバーへは通さない（RESET 3）', http.reset === 3, String(http.reset ?? http.status));
    const wsOther = await laptop.d.ws('/agent/x');
    t.ok('/agent の下のパスも通さない（/ws 以外の WebSocket は RESET 3）', wsOther.reset === 3, JSON.stringify(wsOther.reset ?? wsOther.status));
    t.ok('スマホの端末では許可を入れられない（デスクトップ版の端末だけ）', Boolean(await rejects(cmd('setRemoteDeviceAgent', { id: phone.id, enabled: true }))));
    t.ok('知らない端末の許可は変えられない', Boolean(await rejects(cmd('setRemoteDeviceAgent', { id: 'dNOPE', enabled: true }))));
    const phoneAgent = await agent(phone);
    t.ok('スマホの端末の口の ready も allowed は false（依頼は NOT_ALLOWED）', phoneAgent.ready.allowed === false && (await phoneAgent.call('list', {})).code === 'NOT_ALLOWED');

    // ---- 許可を入れる（人だけ）
    const grant = await cmd('setRemoteDeviceAgent', { id: laptop.id, enabled: true });
    t.ok('許可を入れると端末の行の agent.enabled が true になる', grant.agent?.enabled === true);
    const allowedEv = await a0.next(e => e.t === 'allowed' && e.allowed === true, 5000, '許可の便り');
    t.ok('つながっている口へ allowed: true が届く', Boolean(allowedEv));
    const devFile = JSON.parse(await fs.readFile(path.join(dataDir, 'remote', 'devices.json'), 'utf8'));
    t.ok('devices.json の端末に agentDelegation: true が残る（秘密は増えない）', devFile.devices.find(d => d.id === laptop.id)?.agentDelegation === true && !devFile.devices.find(d => d.id === phone.id)?.agentDelegation);

    // ---- 委譲・状態・完了
    const req1 = requesterOf('conv-A', { title: 'CI を緑にする' });
    const d1 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:HELLO', title: 'ホストで挨拶', host: 'nested', remote: { evil: true } }, req1);
    t.ok('委譲が通り、taskId（ply-task-）とタスクの形が返る', d1.ok && /^ply-task-/.test(d1.result.task.taskId) && d1.result.task.requesterSessionId === 'conv-A', JSON.stringify(d1).slice(0, 200));
    const taskId = d1.result.task.taskId;
    const done1 = await a0.next(e => e.t === 'task' && e.task.taskId === taskId && e.task.status === 'completed', 15_000, '完了の便り');
    t.ok('完了すると task の便りで結果（最初のページ）が届く', done1.task.result === 'HELLO' && done1.task.resultLength === 5, JSON.stringify(done1.task).slice(0, 200));
    t.ok('承認モードは依頼元（都度確認）に合わせた', done1.task.mode === 'default');
    const rows1 = await hostRows();
    const row1 = rows1.find(r => r.taskId === taskId);
    t.ok('ホストの台帳の親は仮の ID（remote:<deviceId>:<端末の会話>）で、出どころ（requester）と remoteOrigin が残る',
      row1.parentSessionId === `remote:${laptop.id}:conv-A` && row1.requester?.deviceId === laptop.id && row1.requester?.sessionId === 'conv-A' && row1.remoteOrigin === true, JSON.stringify([row1.parentSessionId, row1.requester]));
    await sleep(300);
    const rows1b = await hostRows();
    t.ok('完了の通知は端末へ便りで届き（sent）、ホストの会話に新しいターンは始まらない', rows1b.find(r => r.taskId === taskId).notification === 'sent' && !(await cmd('listSessions')).some(s => s.title === 'CI を緑にする'));
    const sessions = await cmd('listSessions');
    const child = sessions.find(s => s.id === row1.sessionId);
    t.ok('子の会話に出どころ（delegation.remote）と、依頼元の承認モードが残る', child?.delegation?.remote?.deviceId === laptop.id && child.delegation.remote.title === 'CI を緑にする' && child.delegation.remote.mode?.autonomy === 'ask', JSON.stringify(child?.delegation));
    const st = await a0.call('status', { taskId }, req1);
    t.ok('status は同じ ID で結果と、写しの更新に使うタスクの形を返す', st.ok && st.result.result === 'HELLO' && st.result.task.status === 'completed');
    const stOther = await a0.call('status', { taskId }, requesterOf('conv-B'));
    t.ok('別の端末の会話の taskId は見えない（所有の判定は仮の親の ID で行う）', stOther.ok === false, JSON.stringify(stOther));
    const send1 = await a0.call('send', { taskId, message: 'echo:AGAIN' }, req1);
    t.ok('send で同じ子に追加の指示が届く', send1.ok, JSON.stringify(send1));
    const done2 = await a0.next(e => e.t === 'task' && e.task.taskId === taskId && e.task.status === 'completed' && e.task.result === 'AGAIN', 15_000, '追加の指示の完了');
    t.ok('追加の指示の結果も便りで届く', Boolean(done2));
    const sendSettings = await a0.call('send', { taskId, message: 'x', model: 'fast' }, req1);
    t.ok('子の設定を替える send（backend・model・effort）は、初版ではホストのタスクに使えない', sendSettings.ok === false && sendSettings.code === 'UNSUPPORTED', JSON.stringify(sendSettings));
    const list1 = await a0.call('list', {}, req1);
    t.ok('list はその依頼元の会話のタスクだけを返す', list1.ok && list1.result.tasks.length === 1 && list1.result.tasks[0].taskId === taskId);
    const sync1 = await (async () => { await a0.send({ t: 'sync', taskIds: [taskId] }); return a0.next(e => e.t === 'relays', 5000, 'sync の答え'); })();
    t.ok('sync でタスクの今の状態と、待っている中継する承認の一覧が返る', Boolean(sync1) && a0.events.filter(e => e.t === 'task' && e.task.taskId === taskId).length >= 3);

    // ---- 経過の読み出し: この端末が任せた子とその子孫だけ・続きは cursor から・孫の要約
    const v1 = await a0.view(taskId);
    t.ok('読み出し: 任せた子の発言（依頼と返答）・タスクの形・追加の指示が返る', v1.ok && v1.result.task.taskId === taskId && v1.result.sessionId === row1.sessionId && v1.result.messages.some(m => m.role === 'user')
      && v1.result.messages.some(m => m.role === 'assistant' && /AGAIN/.test(m.text)) && v1.result.full === true && v1.result.total === v1.result.from + v1.result.messages.length, JSON.stringify(v1).slice(0, 400));
    t.ok('読み出しの task は子孫の要約と同じ形（結果・作業場所は運ばない）。利用者の発言の総数と省いた子孫の件数も返す', v1.result.task.result === undefined && v1.result.task.cwd === undefined && v1.result.task.worktree === undefined
      && v1.result.task.parentTaskId === null && v1.result.task.rawStatus === 'completed' && v1.result.userCount === 2 && v1.result.descendantsOmitted === 0, JSON.stringify(v1.result.task));
    const cur1 = viewCursor(v1.result.from, v1.result.messages);
    const v1b = await a0.view(taskId, cur1);
    t.ok('cursor を付けた読み出しは続きだけ（変わっていなければ末尾の数発言）', v1b.ok && v1b.result.full === false && v1b.result.from === (cur1?.from ?? v1b.result.from) && v1b.result.messages.length <= VIEW_LIMITS.resend + 1, JSON.stringify([v1b.result?.full, v1b.result?.from, v1b.result?.messages?.length]));
    const v404 = await a0.view('ply-task-nope');
    t.ok('任せていない（知らない）タスクは読めない（NOT_FOUND）', v404.ok === false && v404.code === 'NOT_FOUND');
    const viaReq = await a0.call('view', { taskId }, req1);
    t.ok('読み出しは AI の依頼（req）では呼べない（BAD_REQUEST）', viaReq.ok === false && viaReq.code === 'BAD_REQUEST');
    const grandTask = 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', task: 'echo:GRANDCHILD', title: '孫の作業' } });
    const mid = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: grandTask, title: '子の作業' }, requesterOf('conv-G'));
    const midId = mid.result.task.taskId;
    const withGrand = await within((async () => { for (;;) { const v = await a0.view(midId); if (v.ok && v.result.descendants.length && v.result.descendants.every(d => d.rawStatus === 'completed')) return v; await sleep(150); } })(), 20_000, '孫の完了');
    const grand = withGrand.result.descendants[0];
    t.ok('子がホストで任せた孫が、子孫の要約（題・状態・親・深さの元）で返る（依頼文・結果は載せない）', grand.title === '孫の作業' && grand.parentTaskId === midId && grand.rawStatus === 'completed' && grand.result === undefined && grand.task === undefined, JSON.stringify(grand));
    const gv = await a0.view(grand.taskId);
    t.ok('孫の経過も、同じ口・同じ範囲（この端末が任せた木の中）で読める', gv.ok && gv.result.messages.some(m => m.role === 'assistant' && /GRANDCHILD/.test(m.text)), JSON.stringify(gv).slice(0, 300));
    t.ok('孫の読み出しの task は孫自身の要約（親・状態。端末の一覧の孫の行を置き換える）', gv.result.task.taskId === grand.taskId && gv.result.task.parentTaskId === midId && gv.result.task.rawStatus === 'completed' && gv.result.task.title === '孫の作業', JSON.stringify(gv.result.task));

    // ---- 読み取り・計画モードの依頼元・引き上げ
    const ro = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:NO' }, requesterOf('conv-RO', { scope: 'readonly' }));
    t.ok('読み取り・計画モードの依頼元からは委譲できない（READ_ONLY_MODE）', ro.ok === false && ro.code === 'READ_ONLY_MODE', JSON.stringify(ro));
    const before = (await hostRows()).length;
    const esc = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC' }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('引き上げが要るときは子を作らず、計画（鍵・委譲先・モード）を返す', esc.ok && esc.result.plan?.key && esc.result.plan.modeId === 'auto' && (await hostRows()).length === before, JSON.stringify(esc));
    const bad = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC', confirm: 'wrong' }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('違う鍵では確定せず、計画を返し直す', bad.ok && bad.result.plan?.key === esc.result.plan.key && (await hostRows()).length === before);
    const ok2 = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:ESC', confirm: esc.result.plan.key }, requesterOf('conv-E', { autonomy: 'never' }));
    t.ok('同じ鍵で確定すると子が作られ、モードは計画のもの', ok2.ok && ok2.result.task?.mode === 'auto', JSON.stringify(ok2).slice(0, 200));
    const noKind = await a0.call('delegate', { task: 'echo:X', backend: 'fake' }, req1);
    t.ok('kind が無いなど、手元と同じ検査はホストでも効く', noKind.ok === false);
    const garbage = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'echo:G', cwd: path.join(scratch, 'no-such-dir') }, req1);
    t.ok('作業場所はホストのパスで解釈する（無いフォルダーは断る）', garbage.ok === false, JSON.stringify(garbage).slice(0, 160));

    // ---- 口の頑丈さ
    await a0.send({ t: 'req' }); await a0.raw.send('not json', { text: true }); await a0.send({ t: 'nonsense' }); await a0.send({ t: 'req', id: 'z', op: 'shell', args: {}, requester: requesterOf() });
    await a0.send({ t: 'ping' });
    t.ok('形の違う便り・知らない種類・委譲の 6 つ以外の操作は無視して、口は生きている（ping に pong）', Boolean(await a0.next(e => e.t === 'pong', 5000, 'pong')));
    const op = await a0.call('shell', { command: 'x' });
    t.ok('委譲の 6 つ以外の操作（invoke の汎用の道）は BAD_REQUEST', op.ok === false && op.code === 'BAD_REQUEST');

    // ---- 上限: 動いているタスクは 8 件まで
    // 前の段のタスク（引き上げの確定で作った子・孫を任せた子の木）が動いている間は、その分も枠を使う。遅い環境で残っていると、8 件の途中で上限に当たったり、over が通ったりするので、0 になるのを待ってから始める
    await within((async () => { for (;;) { if ((await cmd('remoteDevices')).find(d => d.id === laptop.id).agent.active === 0) return; await sleep(50); } })(), 30_000, '前の段のタスクが終わる');
    const slowIds = [];
    for (let i = 0; i < AGENT_LIMITS.active; i++) {
      const r = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-S'));
      if (r.ok && r.result.task) slowIds.push(r.result.task.taskId);
    }
    t.ok(`動いているタスクは ${AGENT_LIMITS.active} 件まで（その分は通る）`, slowIds.length === AGENT_LIMITS.active, String(slowIds.length));
    const stats = (await cmd('remoteDevices')).find(d => d.id === laptop.id).agent;
    t.ok('端末の行に任された作業の数が出る', stats.active >= slowIds.length, JSON.stringify(stats));
    const over = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-S'));
    t.ok('上限を超えると TOO_MANY_TASKS', over.ok === false && over.code === 'TOO_MANY_TASKS', JSON.stringify(over));
    const stopped = await cmd('setRemoteDeviceAgent', { id: laptop.id, stopAll: true });
    await within((async () => { for (;;) { const rows = await hostRows(); if (rows.filter(r => r.parentSessionId?.startsWith(`remote:${laptop.id}:`)).every(r => !['queued', 'running', 'cancelling'].includes(r.status))) return; await sleep(100); } })(), 20_000, 'すべて止める');
    t.ok('「すべて止める」で任された作業がすべて止まる（許可は残る）', stopped.agent.enabled === true && (await cmd('remoteDevices')).find(d => d.id === laptop.id).agent.active === 0);
    const cancelLive = await a0.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'slow' }, requesterOf('conv-C'));
    const cancelId = cancelLive.result.task.taskId;
    await a0.next(e => e.t === 'task' && e.task.taskId === cancelId && e.task.status === 'running', 15_000, '実行中');
    const cx = await a0.call('cancel', { taskId: cancelId }, requesterOf('conv-C'));
    t.ok('cancel でホストのタスクが止まり、状態が便りで届く', cx.ok && Boolean(await a0.next(e => e.t === 'task' && e.task.taskId === cancelId && e.task.status === 'cancelled', 15_000, '取り消しの便り')));

    // ---- 承認の中継と人の答え（別の端末 desk2 で。laptop は頻度の上限に近い）
    const desk2 = await pair('desk2', 'desktop');
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: true });
    const ax = await agent(desk2);
    const otherView = await ax.view(taskId);
    t.ok('別の端末が任せた子（laptop のタスク）は、許可のある端末でも読めない（NOT_FOUND）', otherView.ok === false && otherView.code === 'NOT_FOUND', JSON.stringify(otherView));
    const otherGrand = await ax.view(grand.taskId);
    t.ok('別の端末が任せた子の孫も読めない', otherGrand.ok === false && otherGrand.code === 'NOT_FOUND');
    const reqP = requesterOf('conv-P', { title: '承認を試す会話' });
    const ask1 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const askTask = ask1.result.task.taskId;
    const relayEv = await ax.next(e => e.t === 'relay' && e.relay.taskId === askTask, 15_000, '中継する承認');
    const relay1 = relayEv.relay;
    t.ok('子の承認が依頼元へ中継される（承認の ID・受領証・道具・入力。常に許可は出さない）',
      relay1.toolName === 'fake_write' && relay1.canAlways === false && /^[0-9a-f]{64}$/.test(relay1.receipt) && relay1.requesterSessionId === 'conv-P' && relay1.input?.path === 'a.txt', JSON.stringify(relay1).slice(0, 220));
    const waitingEv = await ax.next(e => e.t === 'task' && e.task.taskId === askTask && e.task.status === 'waiting', 10_000, '承認待ちの便り');
    t.ok('承認待ちの間、タスクの状態は waiting', Boolean(waitingEv));
    const childP = waitingEv.task.sessionId;
    const hostCard = await c.waitFor(e => e.type === 'permission' && e.toolName === 'fake_write' && e.sessionId === childP, { from: 0, ms: 10_000 }).catch(() => null);
    t.ok('ホストの画面にも子の会話のカードが出る（常に許可も今どおり）', Boolean(hostCard) && hostCard.canAlways === true);
    t.ok('端末の行の「承認待ち」の数が増える', (await cmd('remoteDevices')).find(d => d.id === desk2.id).agent.waiting === 1);
    // 受領証が違う・別の ID・別の端末は答えられない
    await ax.send({ t: 'answer', id: relay1.id, receipt: 'f'.repeat(64), allow: true });
    const mismatch = await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '受領証の違う答え');
    t.ok('受領証が違う答えは捨てる（RECEIPT_MISMATCH）。承認は待ち続ける', mismatch.ok === false && mismatch.code === 'RECEIPT_MISMATCH' && (await c.cmd('running')).permissions.some(p => p.id === hostCard.id));
    await ax.send({ t: 'answer', id: 'no-such-relay', receipt: relay1.receipt, allow: true });
    t.ok('知らない承認の ID への答えは捨てる（NOT_FOUND）', (await ax.fresh(e => e.t === 'answered' && e.id === 'no-such-relay', 5000, '知らない ID')).code === 'NOT_FOUND');
    t.ok('別の端末（laptop）には中継されない', (await a0.none(e => e.t === 'relay' && e.relay.id === relay1.id)) === true);
    await a0.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: true });
    t.ok('別の端末が承認の ID と受領証を知っていても答えられない（NOT_FOUND）', (await a0.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '別の端末の答え')).code === 'NOT_FOUND');
    t.ok('それでも承認は待ち続ける', (await c.cmd('running')).permissions.some(p => p.id === hostCard.id));
    // 2 本目の口には、待っている承認が snapshot で届く
    const ax2 = await agent(desk2);
    t.ok('つなぎ直した口（2 本目）には、待っている承認が relays で届く', Boolean(await ax2.next(e => e.t === 'relays' && e.relays.some(r => r.id === relay1.id), 5000, '中継の snapshot')));
    // 正しい答え（許可）
    await ax.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: true });
    const answered = await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 10_000, '答えの受領');
    const ended = await ax.next(e => e.t === 'relayEnd' && e.id === relay1.id, 5000, '決着');
    t.ok('正しい受領証の答えは受け取られ、決着が端末の側（device）として流れる', answered.ok === true && ended.by === 'device' && ended.allow === true, JSON.stringify([answered, ended]));
    const askDone = await ax.next(e => e.t === 'task' && e.task.taskId === askTask && e.task.status === 'completed', 15_000, '承認後の完了');
    t.ok('許可はホストの子の承認として効き、子が続きを走らせる（許可された）', askDone.task.result === '許可された', askDone.task.result);
    t.ok('2 本目の口にも決着が届く', Boolean(await ax2.next(e => e.t === 'relayEnd' && e.id === relay1.id, 5000, '2 本目の決着')));
    await ax.send({ t: 'answer', id: relay1.id, receipt: relay1.receipt, allow: false });
    t.ok('同じ承認への 2 回目の答えは受けない（1 回だけ）', (await ax.fresh(e => e.t === 'answered' && e.id === relay1.id, 5000, '2 回目')).code === 'NOT_FOUND');
    const hist = (await cmd('sessionChanges', { sessionId: childP })).changes;
    t.ok('人の答えは「human・via: remote-device・端末」で子の会話の記録に残る', hist.some(h => h.by === 'human' && h.via === 'remote-device' && h.byDevice === desk2.id && h.to === 'permission.answer'), JSON.stringify(hist));
    t.ok('委譲は「agent・via: remote・端末」で子の会話の記録に残る', hist.some(h => h.by === 'agent' && h.via === 'remote' && h.byDevice === desk2.id && h.to === 'delegation.delegate'), JSON.stringify(hist));

    // ホストで先に答える
    const ask2 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const ask2Id = ask2.result.task.taskId;
    const relay2 = (await ax.next(e => e.t === 'relay' && e.relay.taskId === ask2Id, 15_000, '2 件目の中継')).relay;
    const child2 = (await hostRows()).find(r => r.taskId === ask2Id).sessionId;
    const card2 = await within((async () => { for (;;) { const p = (await c.cmd('running')).permissions.find(x => x.sessionId === child2 && !x.relay); if (p) return p; await sleep(50); } })(), 10_000, 'ホストの承認カード');
    await cmd('resolvePermission', { id: card2.id, allow: false });
    const end2 = await ax.next(e => e.t === 'relayEnd' && e.id === relay2.id, 10_000, 'ホストで答えた決着');
    t.ok('ホストの画面で先に答えると、端末へ relayEnd（by: host・allow）が流れる', end2.by === 'host' && end2.allow === false, JSON.stringify(end2));
    await ax.send({ t: 'answer', id: relay2.id, receipt: relay2.receipt, allow: true });
    t.ok('決着した後の端末の答えは受けない', (await ax.fresh(e => e.t === 'answered' && e.id === relay2.id, 5000, '決着後の答え')).ok === false);

    // 質問のカードは中継しない（ホストの子の会話のカードにだけ出る）
    const q = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'question' }, reqP);
    const qId = q.result.task.taskId;
    await ax.next(e => e.t === 'task' && e.task.taskId === qId && e.task.status === 'waiting', 15_000, '質問の待ち');
    t.ok('子の質問のカード（kind: question）は端末へ中継しない', (await ax.none(e => e.t === 'relay' && e.relay.taskId === qId)) === true);
    await ax.call('cancel', { taskId: qId }, reqP);

    // 許可を切る: 口が閉じ、新しい依頼と答えは受けない。任された作業は止めない
    const ask3 = await ax.call('delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }, reqP);
    const ask3Id = ask3.result.task.taskId;
    const relay3 = (await ax.next(e => e.t === 'relay' && e.relay.taskId === ask3Id, 15_000, '3 件目の中継')).relay;
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: false });
    const closedCode = await within(ax.closed, 8000, '許可を切ったときの口');
    t.ok('許可を切ると口が閉じる（1008）', closedCode.code === 1008, JSON.stringify(closedCode));
    const aAgain = await agent(desk2);
    t.ok('許可を切ると読み出しも止まる（NOT_ALLOWED）', (await aAgain.view(ask3Id)).code === 'NOT_ALLOWED');
    t.ok('切った後に開いた口は allowed: false で、依頼は NOT_ALLOWED', aAgain.ready.allowed === false && (await aAgain.call('list', {}, reqP)).code === 'NOT_ALLOWED');
    await aAgain.send({ t: 'answer', id: relay3.id, receipt: relay3.receipt, allow: true });
    t.ok('許可が無い端末の答えは受けない', (await aAgain.fresh(e => e.t === 'answered' && e.id === relay3.id, 5000, '許可なしの答え')).ok === false);
    t.ok('許可を切っても、任された作業は止めない（止めるのは「すべて止める」と取り消し）', ['running', 'queued'].includes((await hostRows()).find(r => r.taskId === ask3Id)?.status));

    // ---- 取り消し: 任された作業も止まり、口は閉じる
    await cmd('setRemoteDeviceAgent', { id: desk2.id, enabled: true });
    const aRev = await agent(desk2);
    await cmd('remoteRevoke', { id: desk2.id });
    await within((async () => { for (;;) { const rows = (await hostRows()).filter(r => r.parentSessionId?.startsWith(`remote:${desk2.id}:`)); if (rows.every(r => !['queued', 'running', 'cancelling'].includes(r.status))) return; await sleep(100); } })(), 20_000, '取り消しで止まる');
    t.ok('端末を取り消すと、任された作業もすべて止まる', (await hostRows()).filter(r => r.parentSessionId?.startsWith(`remote:${desk2.id}:`)).every(r => !['queued', 'running', 'cancelling'].includes(r.status)));
    t.ok('取り消すと口も閉じる', Boolean(await Promise.race([aRev.closed, sleep(5000).then(() => null)])));
  } finally {
    for (const a of agents) { try { a.close(); } catch {} }
    for (const d of devices) { try { d.close(); } catch {} }
    c.close();
    await within(server.stop(), 15_000, 'サーバーの停止').catch(e => t.note(e.message));
    await within(relay.close(), 5000, '中継の停止').catch(e => t.note(e.message));
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
