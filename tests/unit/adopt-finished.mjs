// 段階 2 の 2b-4: 走っているターンの付け直し（docs/zero-downtime-update/stage2-server-state.md §4.2-§4.4・§5・§6.1）。
// 生きた子は使わない。「終わっていたターン」の札と記録（fake の出来事の行と exit）から付け直す:
//   1. 記録の再生の道（core/adopt.mjs の replayRecord）: 印から ack までは replay、続きは普通に流して ack、uuid で冪等
//   2. 旧サーバー A（tests/lib/adopt-server.mjs）: handOffTurn で札を取ったターンは、中断してもバックエンドが返っても締めない（X1）
//   3. 新しいサーバー B（AGENT_HOST_ADOPT_FROM）: 札と記録から付け直したターンが turnEnd・completedAt・使用量（presentKey）を 1 回だけ残し、
//      会話の口が同じトークンで戻り、起動時の後片付け（restart の中断・送信待ちの保留）に消されない。
//      札と記録が合わない（版が違う・記録が切れている）ターンと札の無いターンは、今どおり restart の中断になる
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { readSessions, readUsage, writeUsage } from '../lib/data-store.mjs';
import { replayRecord, ADOPT_FILE } from '../../core/adopt.mjs';

export const name = 'adopt-finished';
export const title = '付け直し: 終わっていたターンの札と記録から 1 回だけ締める・旧サーバーは締めない・合わない札は中断';

const WAIT_MS = 15_000;
const line = event => JSON.stringify(event);

export default async function (t) {
  // 1. 記録の再生の道（純関数に近い。保持役の子の見え方を真似た元で）
  {
    const lines = [
      [1, line({ type: 'session', sessionId: 's1' })],
      [2, line({ type: 'text.delta', text: 'a' })],
      [3, line({ type: 'text.end', uuid: 'u1' })],
      [4, line({ type: 'text.delta', text: 'b' })],
      [5, line({ type: 'text.end', uuid: 'u2' })],
      [6, line({ type: 'text.end', uuid: 'u2' })],
      [7, line({ type: 'text.end', uuid: 'u1' })],
      [8, line({ type: 'turnResult', outcome: 'ok' })],
    ];
    const acks = [];
    const source = {
      state: { marks: { turn: 2 }, acked: 3 },
      async replay(from, to) { return lines.filter(([seq]) => seq >= from && seq <= to); },
      async *attach(from) { for (const [seq, l] of lines) if (seq >= from) yield { seq, line: l }; yield { exit: { code: 0 } }; },
      ack(seq) { acks.push(seq); },
    };
    const seen = [];
    const result = await replayRecord({ source, normalize: l => [JSON.parse(l)], emit: (event, opts) => { seen.push([event.type, event.uuid ?? event.text ?? event.outcome, Boolean(opts?.replay)]); } });
    assert.deepEqual(seen, [
      ['text.delta', 'a', true], ['text.end', 'u1', true],
      ['text.delta', 'b', false], ['text.end', 'u2', false], ['turnResult', 'ok', false],
    ], '印（2）より前は流さず、ack（3）までは replay、重なった text.end（u2・u1）は 1 回');
    assert.deepEqual(acks, [4, 5, 6, 7, 8], '続きは流し終えた行ごとに ack（捨てた重なりの行も数える）');
    assert.deepEqual(result, { exit: { code: 0 }, replayed: 2, live: 5, acked: 8 });
    await assert.rejects(replayRecord({ source: { state: { marks: {} } }, normalize: () => [], emit: () => {} }), /no turn mark/);
    t.ok('再生の道: 印から ack までは replay・続きは ack・uuid で冪等・印が無ければ投げる', true);
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-adopt-finished-'));
  const dataDir = path.join(scratch, 'data');
  const scenesDir = path.join(scratch, 'scenes');
  const adoptDir = path.join(scratch, 'adopt');
  await fs.mkdir(scenesDir);
  await fs.mkdir(adoptDir);
  const sessionMeta = id => readSessions(dataDir)[id] ?? null;
  const usageOf = key => (readUsage(dataDir)?.records ?? []).filter(r => r.id === key);
  let a = null, b = null, ca = null, cb = null;
  try {
    // 2. 旧サーバー A: 走っているターンを付け直しに渡す
    a = await startServer({
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FAKE_USAGE: '1', ADOPT_SCENES_DIR: scenesDir },
      dataDir, timeoutMs: 30_000, entry: path.join(ROOT, 'tests', 'lib', 'adopt-server.mjs'),
    });
    const scene = async (sceneName, input = {}) => {
      const done = path.join(scenesDir, `${sceneName}.done`);
      // 書きかけを入口が読まないよう、書いてから名前を変える
      await fs.writeFile(path.join(scenesDir, `${sceneName}.tmp`), JSON.stringify(input));
      await fs.rename(path.join(scenesDir, `${sceneName}.tmp`), path.join(scenesDir, `${sceneName}.go`));
      const end = Date.now() + WAIT_MS;
      while (Date.now() < end) {
        const text = await fs.readFile(done, 'utf8').catch(() => null);
        if (text) { await fs.rm(done); const out = JSON.parse(text); if (!out.ok) throw new Error(out.error); return out.value; }
        await sleep(20);
      }
      throw new Error(`場面 ${sceneName} が終わらなかった\n${a.tail(10)}`);
    };
    ca = await open({ port: a.port, token: a.token });
    // X: 付け直す（送信待ちから始めたターン）/ Y: 使用量を旧サーバーが記録済み / V: 札の版が違う / T: 記録が切れている /
    // Q: 付け直す・後ろに送信待ち / Z: 札が無い（落ちただけ）・後ろに送信待ち
    const ids = {};
    for (const k of ['X', 'Y', 'V', 'T', 'Q', 'Z']) {
      const res = await ca.runTurn({ backend: 'fake', cwd: ROOT, prompt: `echo:${k}` }, { ms: WAIT_MS });
      assert.equal(res.outcome, 'ok');
      ids[k] = res.sessionId;
    }
    const before = Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, sessionMeta(id)?.completedAt]));
    await ca.cmd('sendMessage', { sessionId: ids.X, messageId: 'adopt-x-0001', prompt: 'slow' });
    for (const k of ['Y', 'V', 'T', 'Q', 'Z']) void ca.cmd('runTurn', { sessionId: ids[k], prompt: 'slow' }).catch(() => {});
    const cards = {};
    for (const k of ['X', 'Y', 'V', 'T', 'Q']) cards[k] = (await scene('handOff', { sessionId: ids[k] })).card;
    for (const k of ['Q', 'Z']) await ca.cmd('sendMessage', { sessionId: ids[k], messageId: `adopt-${k.toLowerCase()}-queued`, prompt: `echo:queued-${k}` });
    const card = cards.X;
    assert.equal(card.v, 1);
    assert.equal(card.sessionId, ids.X);
    assert.equal(card.input.messageId, 'adopt-x-0001');
    assert.equal(card.input.promptHash, crypto.createHash('sha256').update('slow').digest('hex'), '本文はハッシュだけ');
    assert.ok(card.presentKey && card.connectionTokens.agents && card.connectionTokens.control && card.connectionTokens.context, 'presentKey と口のトークン');
    // 手を離した後に中断しても（バックエンドは aborted で返る）、A は締めない
    const markA = ca.mark();
    await ca.cmd('abort', { sessionId: ids.X });
    await sleep(800);
    assert.equal(ca.since(markA).filter(e => e.sessionId === ids.X && ['turnEnd', 'turnResult'].includes(e.type)).length, 0, 'A は turnResult・turnEnd を出さない');
    ca.close(); ca = null;
    await a.stop(); a = null;
    const handed = sessionMeta(ids.X);
    assert.equal(handed.turnStartedAt, card.startedAtMs, '走っている印が残る');
    assert.equal(handed.completedAt, before.X, '完了時刻を書かない');
    assert.equal(handed.interrupted ?? null, null, '中断の印を書かない');
    assert.equal(usageOf(card.presentKey).length, 0, '使用量を記録しない');
    t.ok('旧サーバー: handOffTurn で渡したターンは、中断されても turnEnd・completedAt・中断・使用量を書かない（札は本文の代わりにハッシュ）', true);

    // Y の使用量は旧サーバーが記録済みだった（締めの途中で落ちた）ことにする
    const usage = readUsage(dataDir);
    const template = usage.records.find(r => r.sessionId === ids.Y);
    writeUsage(dataDir, { ...usage, records: [...usage.records, { ...template, id: cards.Y.presentKey }] });

    // 「終わっていたターン」の札と記録。X は ack（5）までを旧サーバーが処理していた
    const finished = (k, events, { acked = 0, truncated = false, label = cards[k] } = {}) => ({
      id: `child-${k}`, pid: 0, alive: false, exitCode: 0, signal: null, error: null, label, policy: 'none',
      first: 1, seq: events.length, acked, marks: { turn: 1 }, truncated, pendingRequests: [], stderr: '',
      lines: events.map((e, i) => [i + 1, line(e)]),
    });
    const simple = k => [
      { type: 'session', sessionId: ids[k] }, { type: 'text.delta', text: `adopted ${k}` }, { type: 'text.end', uuid: `adopt-${k}-u1` },
      { type: 'usage', inputTokens: 1000, outputTokens: 200, cachedTokens: 900, costUsd: 0 }, { type: 'turnResult', outcome: 'ok' },
    ];
    const children = [
      finished('X', [
        { type: 'session', sessionId: ids.X },
        { type: 'text.delta', text: 'replayed ' },
        { type: 'text.end', uuid: 'adopt-x-u1' },
        { type: 'present', sessionId: ids.X, kind: 'text', caption: 'replay-present', content: 'r' },
        { type: 'usage', inputTokens: 1000, outputTokens: 200, cachedTokens: 900, costUsd: 0 },
        { type: 'text.delta', text: 'live answer' },
        { type: 'text.end', uuid: 'adopt-x-u2' },
        { type: 'text.end', uuid: 'adopt-x-u2' },
        { type: 'present', sessionId: ids.X, kind: 'text', caption: 'live-present', content: 'l' },
        { type: 'contextWindow', usedTokens: 1000, windowTokens: 200_000 },
        { type: 'turnResult', outcome: 'ok' },
      ], { acked: 5 }),
      finished('Y', simple('Y')),
      finished('V', simple('V'), { label: { ...cards.V, v: 99 } }),
      finished('T', simple('T'), { truncated: true }),
      finished('Q', simple('Q')),
    ];
    await fs.writeFile(path.join(adoptDir, ADOPT_FILE), JSON.stringify({ children }));

    // 3. 新しいサーバー B: 札と記録から付け直す
    b = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ADOPT_FROM: adoptDir }, dataDir, timeoutMs: 30_000 });
    cb = await open({ port: b.port, token: b.token });
    for (const k of ['X', 'Y', 'Q']) await cb.waitFor(e => e.type === 'turnEnd' && e.sessionId === ids[k], { ms: WAIT_MS });
    const end = Date.now() + WAIT_MS;
    while (Date.now() < end && !['V', 'T', 'Z'].every(k => sessionMeta(ids[k])?.interrupted)) await sleep(50);

    const x = sessionMeta(ids.X);
    const xEnds = cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids.X);
    assert.equal(xEnds.length, 1, 'turnEnd は 1 回');
    assert.equal(xEnds[0].outcome, 'ok');
    assert.equal(x.interrupted ?? null, null, 'restart の中断にならない（起動時の後片付けに消されない）');
    assert.equal(x.turnStartedAt ?? null, null, '走っている印はターンの終わりが片付ける');
    assert.ok(x.completedAt > card.startedAtMs, '完了時刻を書く');
    const xUsage = usageOf(card.presentKey);
    assert.equal(xUsage.length, 1, '使用量は presentKey で 1 件');
    assert.equal(xUsage[0].inputTokens, 1000, '使用量は再生（ack より前）の usage から作る');
    t.ok('付け直したターン: turnEnd・completedAt・使用量（presentKey）が 1 回だけ。restart の中断にならない', true);

    const texts = cb.events.filter(e => e.type === 'text.end' && e.sessionId === ids.X).map(e => e.uuid);
    assert.deepEqual(texts, ['adopt-x-u2'], '再生（ack まで）の発言は画面へ出さず、重なった続きの発言は 1 回');
    const loaded = await cb.cmd('loadSession', { sessionId: ids.X });
    const captions = (loaded.presents ?? []).map(p => p.caption);
    assert.ok(!captions.includes('replay-present'), '再生の present は記録し直さない');
    assert.equal(captions.filter(c => c === 'live-present').length, 1, '続きの present は 1 回記録する');
    assert.equal((loaded.presents ?? []).find(p => p.caption === 'live-present')?.turnKey, card.presentKey);
    assert.ok(b.tail(200).includes(`ack ${children[0].lines.length}`), `最後の行まで ack する\n${b.tail(10)}`);
    t.ok('再生の道: ack までは画面へ出さず記録し直さない・続きは uuid で 1 回・最後の行まで ack', true);

    // 会話の口が同じトークンで戻る（URL の道とヘッダーが同じ。ポートが同じかは 2b-6）
    const rpc = (urlPath, token, method) => fetch(`http://127.0.0.1:${b.port}${urlPath}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });
    for (const [urlPath, token] of [['/mcp/agents', card.connectionTokens.agents], ['/mcp/control', card.connectionTokens.control]]) {
      const res = await rpc(urlPath, token, 'initialize');
      assert.equal(res.status, 200, `${urlPath} は札のトークンで通る`);
      assert.ok((await res.json()).result, `${urlPath} の initialize が答える`);
    }
    assert.notEqual((await rpc('/mcp/control', crypto.randomBytes(32).toString('hex'), 'initialize')).status, 200, '知らないトークンは断る');
    t.ok('会話の口（ply_agents・ply_control）が札のトークンで開き直される', true);

    assert.equal(usageOf(cards.Y.presentKey).length, 1, '旧サーバーが記録済みの使用量に重ねない');
    assert.equal(sessionMeta(ids.Y).interrupted ?? null, null);
    t.ok('使用量は presentKey で 1 回だけ（旧と新で二重に記録しない）', true);

    for (const k of ['V', 'T', 'Z']) {
      const m = sessionMeta(ids[k]);
      assert.equal(m.interrupted?.reason, 'restart', `${k} は restart の中断`);
      assert.equal(m.turnStartedAt ?? null, null);
      assert.equal(cb.events.filter(e => e.type === 'turnEnd' && e.sessionId === ids[k]).length, 0, `${k} は付け直さない`);
    }
    assert.equal(sessionMeta(ids.Z).outbox.find(m => m.id === 'adopt-z-queued')?.status, 'paused', '付け直さない会話の送信待ちは今どおり保留');
    // 起動時の後片付けが中断にしたのは V・T・Z だけ（付け直す X・Y・Q は外した。後から締めても同じ形になるので、件数で見る）
    assert.ok(b.tail(200).includes('前の起動で終わらなかったターン 3 件を中断として残した'), `後片付けは 3 件\n${b.tail(20)}`);
    assert.ok(b.tail(200).includes('unknown card version') && b.tail(200).includes('record truncated'), '付け直せない理由をログに残す');
    t.ok('札の版が違う・記録が切れている・札が無いターンは、今どおり restart の中断', true);

    // Q の後ろに並んでいた送信は保留にならず、付け直したターンが終わった後に送られる
    const qEnd = Date.now() + WAIT_MS;
    while (Date.now() < qEnd && sessionMeta(ids.Q)?.outbox?.find(m => m.id === 'adopt-q-queued')?.status !== 'sent') await sleep(50);
    assert.equal(sessionMeta(ids.Q).outbox.find(m => m.id === 'adopt-q-queued')?.status, 'sent', '付け直す会話の送信待ちは保留にしない');
    assert.equal(sessionMeta(ids.Q).interrupted ?? null, null);
    t.ok('付け直す会話の送信待ちは保留にならず、ターンの後に送られる', true);
    assert.ok(!b.tail(200).includes('[unhandledRejection]'), b.tail(20));
  } finally {
    ca?.close();
    cb?.close();
    await a?.stop();
    await b?.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
