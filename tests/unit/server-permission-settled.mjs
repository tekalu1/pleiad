// 片付いた承認を画面へ知らせる（permissionSettled。docs/agent-delegation.md「承認の中継と承認待ちの伝達」）。fake バックエンドのサーバー越し。LLM は呼ばない。
//   - 子の承認に答えると、子のカードと依頼元への中継の複製のそれぞれの id で permissionSettled が出る（答えた画面を含む全接続へ）
//   - 中断（子のタスクの取り消し）でも、複製の分まで出る（allow: false・reason: aborted）
//   - 片付いた承認への resolvePermission は ALREADY_RESOLVED（画面は失敗にせず畳む）。知らない id も同じ
//   - 画面の配線（client.mjs）: 受ける・突き合わせる・ALREADY_RESOLVED を畳む・辞書
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import * as P from '../../core/protocol.mjs';

export const name = 'server-permission-settled';
export const title = '承認が片付いた知らせ: 子と中継の複製の id ごとに出る・中断でも出る・片付いた承認への答えは ALREADY_RESOLVED・画面の配線';

const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default async function (t) {
  t.ok('permissionSettled は EVENTS に登録されている', P.EVENTS.has('permissionSettled'));

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-permission-settled-'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: scratch });
  // 子の承認を保留する（答えは各節が決める）。親より強い子の確認など、ほかの承認は無い
  const held = new Map();
  const c = await open({ port: server.port, token: server.token, onEvent: (ev) => { if (ev.type === 'permission') held.set(ev.id, ev); } });
  // 2 本目の接続（ほかの窓・スマホの画面）。答えを送る側とは別に、同じ知らせが届くことを見る
  const other = await open({ port: server.port, token: server.token });
  const rowsOf = async (parent) => (await c.cmd('agentTasks')).filter((r) => r.parentSessionId === parent);
  const awaitTask = async (parent) => {
    for (let i = 0; i < 400; i++) { const row = (await rowsOf(parent))[0]; if (row) return row; await sleep(50); }
    throw new Error('委譲のタスクが作られない');
  };
  const awaitCards = async (parent, child) => {
    for (let i = 0; i < 400; i++) {
      const cards = [...held.values()];
      const own = cards.find((e) => e.sessionId === child), relay = cards.find((e) => e.sessionId === parent);
      if (own && relay) return { own, relay };
      await sleep(50);
    }
    throw new Error('子のカードと中継の複製がそろわない');
  };
  const settledOf = (conn, id, from) => conn.waitFor((e) => e.type === 'permissionSettled' && e.id === id, { from, ms: 15_000 });
  const noneOf = (conn, from) => conn.since(from).filter((e) => e.type === 'permissionSettled');
  try {
    // ---- 子の承認に答える
    held.clear();
    const parent = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }) })).sessionId;
    const task = await awaitTask(parent);
    const { own, relay } = await awaitCards(parent, task.sessionId);
    t.ok('子の承認は依頼元にも別の id の複製で出る', own.id !== relay.id && relay.sessionId === parent && own.sessionId === task.sessionId);
    const from = c.mark(), otherFrom = other.mark();
    await c.cmd('resolvePermission', { id: own.id, allow: true });
    const settledOwn = await settledOf(c, own.id, from);
    const settledRelay = await settledOf(c, relay.id, from);
    t.ok('答えると、子のカードの id と中継の複製の id のそれぞれで permissionSettled が出る（会話は各カードのもの）',
      settledOwn.sessionId === task.sessionId && settledRelay.sessionId === parent && settledOwn.allow === true && settledRelay.allow === true, JSON.stringify([settledOwn, settledRelay]));
    t.ok('答えた接続と、別の接続（別の窓・スマホ）の両方に届く', (await settledOf(other, own.id, otherFrom)).id === own.id && (await settledOf(other, relay.id, otherFrom)).id === relay.id);
    t.ok('1 つの承認につき、カードの数（2）だけ出て、重ならない', noneOf(c, from).length === 2 && new Set(noneOf(c, from).map((e) => e.id)).size === 2);
    t.ok('running の permissions からも消える（突き合わせの正本）', !(await c.cmd('running')).permissions.some((p) => [own.id, relay.id].includes(p.id)));

    // ---- 片付いた承認への答えは ALREADY_RESOLVED。複製の id も、知らない id も同じ
    const late = await c.cmd('resolvePermission', { id: relay.id, allow: true }).then(() => null, (e) => e);
    t.ok('片付いた承認（中継の複製）への答えは code: ALREADY_RESOLVED で断る', late?.code === 'ALREADY_RESOLVED' && /処理され|resolved/i.test(late.message), late?.message);
    const unknown = await c.cmd('resolvePermission', { id: 'no-such-approval', allow: true }).then(() => null, (e) => e);
    t.ok('知らない id も同じ code', unknown?.code === 'ALREADY_RESOLVED');
    await sleep(200);
    t.ok('断った答えは、片付いた知らせを増やさない', noneOf(c, from).length === 2);

    // ---- 中断（子のタスクの取り消し）でも複製の分まで出る
    held.clear();
    const parent2 = (await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: prompt('ply_delegate', { kind: 'mechanical', backend: 'fake', task: 'ask' }) })).sessionId;
    const task2 = await awaitTask(parent2);
    const cards2 = await awaitCards(parent2, task2.sessionId);
    const from2 = c.mark();
    await c.cmd('cancelAgentTask', { taskId: task2.taskId });
    const abortedOwn = await settledOf(c, cards2.own.id, from2);
    const abortedRelay = await settledOf(c, cards2.relay.id, from2);
    t.ok('中断では allow: false と理由の印（aborted）つきで、子のカードと複製の両方に出る',
      abortedOwn.allow === false && abortedRelay.allow === false && abortedOwn.reason === 'aborted' && abortedRelay.reason === 'aborted', JSON.stringify([abortedOwn, abortedRelay]));
    const lateAbort = await c.cmd('resolvePermission', { id: cards2.relay.id, allow: true }).then(() => null, (e) => e);
    t.ok('中断で片付いた複製に、遅れて押しても ALREADY_RESOLVED', lateAbort?.code === 'ALREADY_RESOLVED');
  } finally { other.close(); c.close(); await server.stop(); await fs.rm(scratch, { recursive: true, force: true }); }

  // ---- 画面の配線（動きは tests/browser/permission-settled.cjs で確かめる）
  const client = read('web/client.mjs');
  const onEvent = client.slice(client.indexOf('function onEvent('));
  t.ok('画面: permissionSettled は会話の絞り込み（isMine）の前に受ける（開いていない会話の覚えと、子の会話のダイアログのカードを畳むため）',
    onEvent.indexOf("ev.type === 'permissionSettled'") > 0 && onEvent.indexOf("ev.type === 'permissionSettled'") < onEvent.indexOf('if (!isMine(ev))'));
  t.ok('画面: 答えを送っている最中のカードは触らず、応答で畳む', /function onPermissionSettled\([\s\S]*?entry\.sending\(\)/.test(client));
  const apply = client.slice(client.indexOf('function applyRunning('), client.indexOf('const behind = new Map();'));
  t.ok('画面: running のたびに、出ているカードを permissions と突き合わせる', /reconcileOpenCards\(\)/.test(apply));
  const reconcile = client.slice(client.indexOf('function reconcileOpenCards('), client.indexOf('function registerRelayCard('));
  t.ok('画面: 突き合わせは少し待ち、そのとき最新の一覧にも無いカードだけを畳む', /setTimeout\(/.test(reconcile) && /state\.work\.permissions/.test(reconcile) && /SETTLE_RECONCILE_MS/.test(reconcile));
  // 使う所 5（承認・質問・行の承認・コンピューターの承認・設定の変更の承認）
  const uses = (client.match(/alreadyResolved\(/g) ?? []).length;
  t.ok('画面: 承認・質問・行の承認・コンピューターの承認・設定の変更の承認の答えが ALREADY_RESOLVED なら、失敗の表示にせず畳む', uses >= 5, String(uses));
  t.ok('画面: どの承認カードも名簿に載る（中継のカードだけではない）', !/if \(ev\.remote \|\| ev\.remoteOrigin\) registerRelayCard/.test(client) && !/if \(ev\.remote\) registerRelayCard/.test(client));
  for (const lng of ['ja', 'en']) {
    const ui = JSON.parse(read(`web/locales/${lng}/ui.json`));
    t.ok(`辞書（${lng}）: 別の場所で処理された`, typeof ui.chat?.approval?.elsewhere === 'string' && ui.chat.approval.elsewhere.length > 0);
  }
}
