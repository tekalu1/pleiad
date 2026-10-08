// ターンが終わっても残る承認の待ち（outlivesTurn）と、カードの中身の差し替え（permissionUpdate）。ADR 0168。fake バックエンドのサーバー越し。LLM は呼ばない。
//   - ターンが走っている間だけ、ターンを止める待ちとして数える（running の blocking・count・handover.blocking）
//   - ターンが終わっても取り下げない・実行中の数に入らない。host が戻らなくても（giveUp）断られない
//   - 人の「止める」・巻き戻し・会話の削除では aborted で片付く
//   - update が祖先の中継の複製にも届く・つなぎ直した画面に新しい中身が届く・外からの settle で permissionSettled が出る
//   - 画面の配線（card-roll の update・client の受け口と pendingPerms の書き替え）
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import * as P from '../../core/protocol.mjs';

export const name = 'server-permission-update';
export const title = 'ターンを越えて残る承認の待ち: ターンの間だけ止める・終わっても残る・止める/巻き戻し/削除で片付く・中身の差し替えが複製とつなぎ直しに届く';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const script = (spec) => 'outlives:' + JSON.stringify(spec);
const delegate = (task) => 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', task } });

export default async function (t) {
  t.ok('permissionUpdate は EVENTS に登録されている', P.EVENTS.has('permissionUpdate'));
  const server0 = read('core/server.mjs');
  t.ok('permissionUpdate は一覧を作り直さない出来事（LIST_NEUTRAL_EVENTS）', /LIST_NEUTRAL_EVENTS = new Set\(\[[^\]]*"permissionUpdate"/.test(server0));

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-permission-update-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token });
  const handoffOf = (conn, from, sessionId) => conn.waitFor((e) => e.type === 'permission' && e.toolName === 'fake_handoff' && e.sessionId === sessionId, { from, ms: 15_000 });
  const running = async () => c.cmd('running');
  const waitCards = async (sessionId) => {
    for (let i = 0; i < 200; i++) {
      const own = (await running()).permissions.filter((p) => p.sessionId === sessionId);
      if (own.length) return own;
      await sleep(50);
    }
    throw new Error('待ちが出ない');
  };
  // ターンの終わりを待たずに始める（hold の台本は中断まで走る）。会話の id は session イベントから
  const start = async (prompt, extra = {}) => {
    const from = c.mark();
    const known = new Set(c.events.map((e) => e.sessionId).filter(Boolean));
    await c.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt, ...extra });
    const session = await c.waitFor((e) => e.type === 'session' && e.sessionId && (extra.sessionId ? e.sessionId === extra.sessionId : !known.has(e.sessionId)), { from, ms: 15_000 });
    return { sessionId: session.sessionId, from };
  };
  const op = (spec) => c.runTurn({ backend: 'fake', cwd: ROOT, prompt: script(spec) });
  const ended = (sessionId, from) => c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from, ms: 15_000 });
  try {
    // ---- ターンが走っている間は普通の待ち（止めている・数に入る）。人の「止める」で aborted
    const held = await start(script({ open: { hold: true, signal: true } }));
    const [wait1] = await waitCards(held.sessionId);
    t.ok('ターンの間: 待ちは blocking（outlivesTurn の印つき）', wait1.blocking === true && wait1.outlivesTurn === true && wait1.relay === false, JSON.stringify(wait1));
    const run1 = await running();
    t.ok('ターンの間: 実行中の数と引き継ぎを待たせる数に入る（ターン 1 + 待ち 1）', run1.count === 2 && run1.handover.blocking === 2, JSON.stringify({ count: run1.count, blocking: run1.handover?.blocking }));
    const abortFrom = c.mark();
    await c.cmd('abort', { sessionId: held.sessionId });
    const settledAbort = await c.waitFor((e) => e.type === 'permissionSettled' && e.id === wait1.id, { from: abortFrom, ms: 15_000 });
    t.ok('人の「止める」では aborted で片付く', settledAbort.allow === false && settledAbort.reason === 'aborted', JSON.stringify(settledAbort));
    await ended(held.sessionId, abortFrom);

    // ---- ターンが終わっても残る（signal を渡していても、ターンの終わりでは取り下げない）
    const first = await start(script({ open: { signal: true } }));
    await ended(first.sessionId, first.from);
    const [wait2] = await waitCards(first.sessionId);
    t.ok('ターンの後: 待ちは残るが blocking ではない', wait2.blocking === false && wait2.outlivesTurn === true, JSON.stringify(wait2));
    const run2 = await running();
    t.ok('ターンの後: 実行中の数にも引き継ぎを待たせる数にも入らない', run2.count === 0 && run2.handover.blocking === 0, JSON.stringify({ count: run2.count, blocking: run2.handover?.blocking }));
    t.ok('ターンの後: 取り下げの知らせ（permissionSettled）は出ていない', !c.since(first.from).some((e) => e.type === 'permissionSettled' && e.id === wait2.id));

    // ---- update: 全部のカードの payload に重ねて permissionUpdate を出す。重ねるのは browserHandoff だけ
    const updFrom = c.mark();
    await op({ op: 'update', target: first.sessionId, patch: { state: 'asking' } });
    const ev1 = await c.waitFor((e) => e.type === 'permissionUpdate' && e.id === wait2.id, { from: updFrom, ms: 15_000 });
    t.ok('permissionUpdate は元のカードの id と browserHandoff を運ぶ', ev1.sessionId === first.sessionId && ev1.browserHandoff?.state === 'asking', JSON.stringify(ev1));
    const updFrom2 = c.mark();
    await op({ op: 'update', target: first.sessionId, patch: { step: 2 } });
    const ev2 = await c.waitFor((e) => e.type === 'permissionUpdate' && e.id === wait2.id, { from: updFrom2, ms: 15_000 });
    t.ok('続けた update は旧い中身に重なる', ev2.browserHandoff?.state === 'asking' && ev2.browserHandoff?.step === 2, JSON.stringify(ev2));

    // ---- つなぎ直した画面に、新しい中身が届く
    const c2 = await open({ port: server.port, token: server.token });
    try {
      const again = await c2.waitFor((e) => e.type === 'permission' && e.id === wait2.id, { ms: 15_000 });
      t.ok('つなぎ直した画面には、差し替え後の中身で承認が届く', again.browserHandoff?.state === 'asking' && again.browserHandoff?.step === 2, JSON.stringify(again.browserHandoff));
    } finally { c2.close(); }

    // ---- 外からの settle（resolvePermission を通さない）で permissionSettled が出て、畳まれる
    const setFrom = c.mark();
    await op({ op: 'settle', target: first.sessionId, answer: { allow: true } });
    const settled = await c.waitFor((e) => e.type === 'permissionSettled' && e.id === wait2.id, { from: setFrom, ms: 15_000 });
    t.ok('外からの settle で permissionSettled が出る（allow が運ばれる）', settled.allow === true, JSON.stringify(settled));
    t.ok('決着後は running から消える', !(await running()).permissions.some((p) => p.id === wait2.id));
    const afterFrom = c.mark();
    await op({ op: 'update', target: first.sessionId, patch: { late: 1 } });
    await sleep(150);
    t.ok('決着した後の update は何も出さない', !c.since(afterFrom).some((e) => e.type === 'permissionUpdate'));

    // ---- 委譲の子の待ち: 祖先の複製にも update が届く。複製は数えない
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: delegate(script({ open: { hold: true, signal: true, key: 'child' } })) })).sessionId;
    let childCards = [];
    for (let i = 0; i < 300 && childCards.length < 2; i++) {
      childCards = (await running()).permissions.filter((p) => p.outlivesTurn);
      if (childCards.length < 2) await sleep(50);
    }
    const own = childCards.find((p) => !p.relay), relay = childCards.find((p) => p.relay);
    t.ok('子の待ちは依頼元に別の id の複製でも出る', Boolean(own && relay) && own.id !== relay.id && relay.sessionId === parent, JSON.stringify(childCards));
    t.ok('子のターンが走る間は blocking。複製は数に入らない', own.blocking === true && (await running()).count >= 1);
    const delFrom = c.mark();
    await op({ op: 'update', target: 'child', patch: { state: 'relayed' } });
    const evOwn = await c.waitFor((e) => e.type === 'permissionUpdate' && e.id === own.id, { from: delFrom, ms: 15_000 });
    const evRelay = await c.waitFor((e) => e.type === 'permissionUpdate' && e.id === relay.id, { from: delFrom, ms: 15_000 });
    t.ok('update は祖先の複製にも、複製の id と会話で届く', evOwn.sessionId === own.sessionId && evRelay.sessionId === parent && evRelay.browserHandoff?.state === 'relayed', JSON.stringify([evOwn, evRelay]));
    const rows = (await c.cmd('agentTasks')).filter((r) => r.parentSessionId === parent);
    const toolFrom = c.mark();
    await c.runTurn({ sessionId: parent, prompt: 'ply:' + JSON.stringify({ name: 'ply_task_status', arguments: { taskId: rows[0].taskId } }) });
    const status = JSON.parse((await c.waitFor((e) => e.type === 'tool.result' && e.sessionId === parent, { from: toolFrom, ms: 15_000 })).text);
    t.ok('子のターンが走る間、依頼元からは子が waiting に見える', status.status === 'waiting', JSON.stringify(status));
    const cancelFrom = c.mark();
    await c.cmd('cancelAgentTask', { taskId: rows[0].taskId });
    const gone = await c.waitFor((e) => e.type === 'permissionSettled' && e.id === own.id, { from: cancelFrom, ms: 15_000 });
    t.ok('子の中断で、子のカードも複製も aborted で片付く', gone.reason === 'aborted' && c.since(cancelFrom).some((e) => e.type === 'permissionSettled' && e.id === relay.id));

    // ---- 巻き戻し: ターンが走っていなくても、その会話の待ちを aborted で片付ける
    const base = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'echo:one' });
    const rewindId = base.sessionId;
    await c.runTurn({ sessionId: rewindId, prompt: script({ open: {} }) });
    const [wait3] = await waitCards(rewindId);
    const users = (await c.cmd('loadSession', { sessionId: rewindId })).messages.filter((m) => m.role === 'user');
    const rwFrom = c.mark();
    const messageId = crypto.randomUUID();
    await c.cmd('sendMessage', { sessionId: rewindId, messageId, prompt: 'echo:again', rewind: { beforeMessageId: users[1].uuid } });
    const rewound = await c.waitFor((e) => e.type === 'permissionSettled' && e.id === wait3.id, { from: rwFrom, ms: 15_000 });
    t.ok('巻き戻しで、ターンの終わった後の待ちが aborted で片付く', rewound.allow === false && rewound.reason === 'aborted', JSON.stringify(rewound));
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === rewindId, { from: rwFrom, ms: 15_000 });

    // ---- 会話の削除
    const doomed = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: script({ open: {} }) });
    const [wait4] = await waitCards(doomed.sessionId);
    const dFrom = c.mark();
    await c.cmd('deleteSession', { sessionId: doomed.sessionId });
    const deleted = await c.waitFor((e) => e.type === 'permissionSettled' && e.id === wait4.id, { from: dFrom, ms: 15_000 });
    t.ok('会話の削除で、ターンの終わった後の待ちが aborted で片付く', deleted.reason === 'aborted' && !(await running()).permissions.some((p) => p.id === wait4.id));
  } finally { c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- host が戻らなくても（giveUp）、ターンの終わった後の待ちは断らない。走っているターンの普通の待ちは断る
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-permission-update-grace-'));
    const s = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_GRACE_MS: '700' }, dataDir: dir });
    const a = await open({ port: s.port, token: s.token });
    try {
      const idle = await a.runTurn({ backend: 'fake', cwd: ROOT, prompt: script({ open: {} }) });
      // 別のターンを走らせたまま画面を離す（走るターンが無いと猶予が始まらない）
      const from = a.mark();
      await a.cmd('runTurn', { backend: 'fake', cwd: ROOT, prompt: 'slow' });
      await a.waitFor((e) => e.type === 'session', { from, ms: 15_000 });
      a.close();
      await sleep(2500);
      const b = await open({ port: s.port, token: s.token });
      try {
        const state = await b.cmd('running');
        t.ok('前提: 猶予が切れて走っていたターンは中断された', state.turns.length === 0);
        const waits = state.permissions;
        t.ok('giveUp: ターンの終わった後の待ちは断られず残る', waits.some((p) => p.sessionId === idle.sessionId && p.outlivesTurn), JSON.stringify(waits));
        const ev = b.events.filter((e) => e.type === 'permissionSettled');
        t.ok('giveUp: 取り下げの知らせも出ない', !ev.some((e) => e.sessionId === idle.sessionId));
      } finally { b.close(); }
    } finally { a.close(); await s.stop(); await fs.rm(dir, { recursive: true, force: true }); }
  }

  // ---- 画面の配線
  const roll = read('web/card-roll.mjs');
  t.ok('画面: 名簿は update(id, ev) でその承認のカード全部に差し替えを渡す', /update\(id, ev\)[\s\S]*?entry\.update\?\.\(ev\)/.test(roll));
  const client = read('web/client.mjs');
  t.ok('画面: permissionUpdate の受け口（pendingPerms の写しの書き替えと名簿への受け渡し）',
    /case "permissionUpdate":\s*return onPermissionUpdate\(ev\)/.test(client)
    && /function onPermissionUpdate\([\s\S]*?state\.pendingPerms\.set\([\s\S]*?openCards\.update\(ev\.id, ev\)/.test(client));
  t.ok('画面: 中継のカードの名簿の項目が update を持つ（種類ごとの描き直しは parts.onUpdate）', /openCards\.add\(ev\.id, \{[^}]*update: \(patch\) => parts\.onUpdate\?\.\(patch\)/.test(client));
  const protocol = read('core/protocol.mjs');
  t.ok('protocol.mjs の EVENTS に permissionUpdate', /"permissionUpdate"/.test(protocol));
}
