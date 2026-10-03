import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import * as P from '../../core/protocol.mjs';
import { readSessions } from '../lib/data-store.mjs';

export const name = 'server-computer';
export const title = 'ply_computer をサーバー越しに: 承認カードの payload・スクショの保存と配信・ロックと computer.state・止める・委譲の子の承認（fake + 偽の driver）';

const NOTEPAD = 'exe:c:/windows/system32/notepad.exe';
const computer = list => 'computer:' + JSON.stringify([].concat(list));
const hold = list => 'computer-hold:' + JSON.stringify([].concat(list));
const shotCall = { name: 'screenshot', arguments: { title: '画面を確かめる' } };
const clickCall = { name: 'left_click', arguments: { coordinate: [100, 100], title: '保存を押す' } };

export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-computer-srv-'));
  const servers = [], clients = [];
  const boot = async ({ env = {}, prefs, answer } = {}) => {
    const dataDir = await fs.mkdtemp(path.join(scratch, 'data-'));
    if (prefs) await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify(prefs));
    const log = path.join(dataDir, 'computer-log.ndjson');
    const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_COMPUTER_DRIVER: 'fake', AGENT_HOST_COMPUTER_LOG: log, ...env }, dataDir });
    const cards = [];
    const state = { answer: answer ?? (() => ({ allow: true, scope: 'session' })) };
    const connect = async () => {
      const c = await open({ port: server.port, token: server.token, onEvent: async (ev, api) => {
        if (ev.type !== 'permission') return;
        // 接続が複数あると同じ承認が全部に届く。1 枚として数える
        if (cards.some(x => x.id === ev.id)) return;
        cards.push(ev);
        if (ev.computerApp) {
          const a = state.answer(ev, cards.length - 1);
          if (a) await api.cmd('resolvePermission', { id: ev.id, ...a }).catch(() => {});
        } else await api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {});
      } });
      clients.push(c);
      return c;
    };
    const c = await connect();
    servers.push(server);
    const entries = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    const shotUrl = (id, withToken = true) => `http://127.0.0.1:${server.port}/computer-shot/${id}.jpg${withToken ? `?token=${server.token}` : ''}`;
    const sessionsFile = async () => readSessions(dataDir);
    return { server, c, cards, state, connect, entries, shotUrl, dataDir, sessionsFile };
  };
  try {
    t.ok('computerStop は COMMANDS に、computer.state は EVENTS に登録されている（無いとサーバーが黙って捨てる）', P.COMMANDS.has('computerStop') && P.EVENTS.has('computer.state'));

    // ---- 承認のカード・スクショの保存と配信・会話に覚える
    const { server, c, cards, state, connect, entries, shotUrl, dataDir, sessionsFile } = await boot();
    t.ok('hostCapabilities.computerUse: 使える', (await c.cmd('hostCapabilities')).computerUse?.supported === true);
    const instr = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'computer-instructions' });
    t.ok('ply_computer の指示文が、そのターンの runArgs.computerRuntime に載って渡る', instr.events.some(e => e.type === 'text.delta' && /screenshot/.test(e.text ?? e.delta ?? '')) || (await c.cmd('loadSession', { sessionId: instr.sessionId })).messages.some(m => m.role === 'assistant' && m.text.includes('screenshot') && m.text.includes('ターミナル')));

    const mark1 = c.mark();
    const turn1 = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, clickCall]) });
    const s1 = turn1.sessionId;
    const card = cards.find(x => x.computerApp);
    t.ok('承認のカードの payload: toolName ply_computer・canAlways・input {}・notifyReply・computerApp { agent, apps, first }', card && card.toolName === 'ply_computer' && card.kind === 'tool' && card.canAlways === true && JSON.stringify(card.input) === '{}'
      && card.notifyReply === true && card.sessionId === s1 && card.computerApp.agent.id === 'fake' && card.computerApp.agent.label === 'Fake (test)' && card.computerApp.apps.length === 1
      && card.computerApp.apps[0].id === NOTEPAD && card.computerApp.apps[0].name === 'メモ帳' && card.computerApp.apps[0].risk === 'normal' && card.computerApp.first === true, JSON.stringify(card));
    t.ok('見出しは「{エージェント名} に「{アプリ名}」の操作を許可しますか？」', card.title === 'Fake (test) に「メモ帳」の操作を許可しますか？', card.title);

    const results = turn1.events.filter(e => e.type === 'tool.result' && e.sessionId === s1);
    const starts = turn1.events.filter(e => e.type === 'tool.start' && e.sessionId === s1);
    t.ok('tool.start は mcp__ply_computer__<ツール名> で、入力は引数', starts.map(e => e.name).join() === 'mcp__ply_computer__screenshot,mcp__ply_computer__left_click' && starts[1].input.coordinate.join() === '100,100');
    const shotResult = results[0];
    t.ok('tool.result の text は印の行を除いた本文。images（/computer-shot/<id>.jpg）と computer（印の中身）が付く', shotResult.text === 'ディスプレイ 1 / 2・1460×821（実寸 1920×1080 を縮小）' && shotResult.images.length === 1
      && /^\/computer-shot\/[0-9a-f]{32}\.jpg$/.test(shotResult.images[0].url) && shotResult.images[0].width === 1460 && shotResult.computer.tool === 'screenshot' && shotResult.computer.state === 'ok' && shotResult.computer.title === '画面を確かめる');
    t.ok('クリックの結果は印にアプリ名。画像は付かない', results[1].computer.app === 'メモ帳' && results[1].computer.title === '保存を押す' && !results[1].images?.length && results[1].text === '左クリックしました（メモ帳）');

    const shotId = shotResult.computer.shot;
    const file = path.join(dataDir, 'computer-use', 'shots', `${shotId}.jpg`);
    const saved = await fs.readFile(file);
    const index = JSON.parse(await fs.readFile(path.join(dataDir, 'computer-use', 'shots.json'), 'utf8'));
    t.ok('スクリーンショットが保存される（computer-use/shots/<id>.jpg と shots.json の索引）', saved.length > 100 && saved[0] === 0xff && saved[1] === 0xd8 && index.version === 1 && index.shots[shotId].session === s1 && index.shots[shotId].bytes === saved.length);
    const got = await fetch(shotUrl(shotId));
    const body = Buffer.from(await got.arrayBuffer());
    t.ok('GET /computer-shot/<id>.jpg は保存した JPEG を返す（トークンの認証つき）', got.status === 200 && got.headers.get('content-type') === 'image/jpeg' && body.equals(saved));
    t.ok('トークンが無ければ 401。形の違う id・無い id は 404', (await fetch(shotUrl(shotId, false))).status === 401 && (await fetch(shotUrl('zz', true))).status === 404 && (await fetch(shotUrl('0'.repeat(32)))).status === 404
      && (await fetch(`http://127.0.0.1:${server.port}/computer-shot/..%2f..%2fpleiad.db?token=${server.token}`)).status === 404);

    const prefs1 = await c.cmd('prefs');
    const sessions = await sessionsFile();
    t.ok('答えたら introduced が立つ。「この会話で許可」は会話のデータ computerApps に残る', prefs1.computerUse?.introduced === true && sessions[s1].computerApps?.join() === NOTEPAD);
    const before = cards.length;
    await c.runTurn({ sessionId: s1, prompt: computer([shotCall, clickCall]) });
    t.ok('同じ会話の次のターンでは、許可済みのアプリを聞かない', cards.length === before);
    const log1 = await entries();
    t.ok('main へ送ったもの: 撮影（ディスプレイの id・上限）・点の下のアプリ・入力。入力は物理座標', log1.some(e => e.kind === 'call' && e.op === 'screenshot' && e.args.maxPixels === 1_200_000 && e.args.display === 'fake-1')
      && log1.some(e => e.kind === 'call' && e.op === 'appAt') && log1.some(e => e.kind === 'call' && e.op === 'input' && e.args.actions[0].type === 'click' && e.args.actions[0].x === 131));
    const owner1 = log1.find(e => e.kind === 'call').owner;
    t.ok('ロックを取ったら computer-arm（持ち主の印）。ターンが終わったら arm を外し、computer-turn-ended', log1.some(e => e.kind === 'arm' && e.owner === owner1) && log1.some(e => e.kind === 'arm' && e.owner === null) && log1.some(e => e.kind === 'turnEnded' && e.owner === owner1));
    t.ok('操作の後は computer-overlay の activity（エージェント名・会話のタイトル・cursor）。承認の間は hide', log1.some(e => e.kind === 'overlay' && e.state === 'activity' && e.agent === 'Fake (test)' && e.cursor && e.owner === owner1) && log1.some(e => e.kind === 'overlay' && e.state === 'hide'));
    const states1 = c.since(mark1).filter(e => e.type === 'computer.state' && e.sessionId === s1);
    t.ok('computer.state: 取ったら running、ターンの終わりで idle（全部の接続へ）', states1.some(e => e.state === 'running') && states1.at(-1).state === 'idle');

    // ---- 常に許可・拒否はターンの間だけ
    state.answer = () => ({ allow: true, scope: 'always' });
    const alwaysTurn = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, { name: 'left_click', arguments: { coordinate: [100, 700], title: 'x' } }]) });
    const prefs2 = await c.cmd('prefs');
    const exp = prefs2.computerUse.alwaysAllowed;
    t.ok('「常に許可」は prefs に残る（id・name・kind・at）。エクスプローラーは risk: high のカード', exp.length === 1 && exp[0].id === 'exe:c:/windows/explorer.exe' && exp[0].name === 'エクスプローラー' && exp[0].kind === 'exe' && !Number.isNaN(Date.parse(exp[0].at))
      && cards.filter(x => x.computerApp).at(-1).computerApp.apps[0].risk === 'high' && cards.filter(x => x.computerApp).at(-1).computerApp.first === false && alwaysTurn.sessionId);
    const afterAlways = cards.length;
    await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, { name: 'left_click', arguments: { coordinate: [100, 700], title: 'x' } }]) });
    t.ok('別の会話でも、常に許可したアプリは聞かない', cards.length === afterAlways);

    state.answer = () => ({ allow: false });
    const deny = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, clickCall, clickCall]) });
    const denyResults = deny.events.filter(e => e.type === 'tool.result' && e.sessionId === deny.sessionId);
    t.ok('拒否: stopped / denied を返す（失敗に数えない）。同じターンの 2 回目は聞き直さない（カードは 1 枚）', denyResults[1].computer.state === 'stopped' && denyResults[1].computer.reason === 'denied' && denyResults[2].computer.reason === 'denied'
      && cards.filter(x => x.sessionId === deny.sessionId && x.computerApp).length === 1 && denyResults[1].isError === true);
    state.answer = () => ({ allow: true, scope: 'session' });
    await c.runTurn({ sessionId: deny.sessionId, prompt: computer([shotCall, clickCall]) });
    t.ok('拒否は次のターンには持ち越さない（また聞く）', cards.filter(x => x.sessionId === deny.sessionId && x.computerApp).length === 2);

    // 禁止
    const forbidden = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, { name: 'left_click', arguments: { coordinate: [100, 790], title: 'x' } }]) });
    const fr = forbidden.events.filter(e => e.type === 'tool.result' && e.sessionId === forbidden.sessionId)[1];
    t.ok('禁止のアプリ（ターミナル）は、カードを出さずに stopped / forbidden', fr.computer.reason === 'forbidden' && fr.computer.state === 'stopped' && fr.computer.app === 'Windows Terminal' && !cards.some(x => x.sessionId === forbidden.sessionId));

    // type の入力の秘密は画面へ流す tool.start で伏せる
    const typed = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall, { name: 'type', arguments: { text: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', title: '入力' } }]) });
    const typeStart = typed.events.find(e => e.type === 'tool.start' && e.name === 'mcp__ply_computer__type');
    t.ok('type の tool.start の入力は、秘密らしいものを伏せる。main へは中身のまま送る', !typeStart.input.text.includes('abcdefghijklmnopqrstuvwxyz') && (await entries()).some(e => e.kind === 'call' && e.op === 'input' && e.args.actions[0].type === 'text' && e.args.actions[0].text.includes('abcdefghijklmnopqrstuvwxyz')));

    // ---- ロック: 2 つの会話・computer.state・止める
    const mark2 = c.mark();
    const holdRun = c.runTurn({ backend: 'fake', cwd: ROOT, prompt: hold([shotCall]) });
    const holderState = await c.waitFor(e => e.type === 'computer.state' && e.state === 'running', { from: mark2, ms: 20000 });
    const holder = holderState.sessionId;
    await c.waitFor(e => e.type === 'tool.result' && e.sessionId === holder, { from: mark2, ms: 20000 });
    const shotsAtHold = (await entries()).filter(e => e.kind === 'call' && e.op === 'screenshot').length;
    const lateClient = await connect();
    await sleep(100);
    t.ok('接続し直した画面には、今 running の会話の状態を送り直す', lateClient.events.some(e => e.type === 'computer.state' && e.sessionId === holder && e.state === 'running'));
    const mark3 = c.mark();
    const waiterRun = c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall]) });
    const waiting = await c.waitFor(e => e.type === 'computer.state' && e.state === 'waiting', { from: mark3, ms: 20000 });
    t.ok('2 つ目の会話は待つ。computer.state waiting に、持ち主の会話（sessionId・タイトル）と since', waiting.holder.sessionId === holder && typeof waiting.sessionId === 'string' && waiting.sessionId !== holder && Number.isFinite(waiting.since) && 'title' in waiting.holder);
    await sleep(150);
    t.ok('待っている間は撮影が走らない（main への撮影は持ち主の 1 回だけ増える）', (await entries()).filter(e => e.kind === 'call' && e.op === 'screenshot').length === shotsAtHold && (await c.cmd('running')).turns.length >= 2);
    t.ok('computerStop: 走っているターンに止めた印を付けて stopped: true、main へ computer-stop。知らない会話は false', await (async () => {
      const r = await c.cmd('computerStop', { sessionId: holder });
      const none = await c.cmd('computerStop', { sessionId: 'no-such-session' });
      const log = await entries();
      return r.stopped === true && none.stopped === false && log.some(e => e.kind === 'stop');
    })());
    await c.cmd('abort', { sessionId: holder });
    await holdRun;
    const waiterResult = await waiterRun;
    const waited = waiterResult.events.filter(e => e.type === 'tool.result' && e.sessionId === waiterResult.sessionId);
    t.ok('持ち主のターンが終わると、待っていた会話の撮影が通る', waited[0]?.computer?.state === 'ok' && waited[0].images?.length === 1);
    await c.waitFor(e => e.type === 'computer.state' && e.state === 'idle' && e.sessionId === waiterResult.sessionId, { from: mark3, ms: 10000 });
    const waiterStates = c.since(mark3).filter(e => e.type === 'computer.state' && e.sessionId === waiterResult.sessionId).map(e => e.state);
    t.ok('待っていた会話の computer.state は waiting → running → idle', waiterStates.join() === 'waiting,running,idle', waiterStates.join());
    await c.waitFor(e => e.type === 'computer.state' && e.state === 'idle' && e.sessionId === holder, { from: mark2, ms: 10000 });
    t.ok('止めたターンの終わりで、持ち主の会話も idle（待ちが 1 つも残らない）', c.since(mark2).filter(e => e.type === 'computer.state' && e.sessionId === holder).at(-1).state === 'idle');

    // ---- 委譲の子の承認: 祖先の会話にも複製し、許可は子に付く
    state.answer = () => null;
    const parent = await c.runTurn({ backend: 'fake', cwd: ROOT, prompt: 'hello' });
    cards.length = 0;
    const childTask = 'ply:' + JSON.stringify({ name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', task: computer([shotCall, clickCall]) } });
    await c.runTurn({ sessionId: parent.sessionId, prompt: childTask });
    const tasks = async () => (await c.cmd('agentTasks')).filter(r => r.parentSessionId === parent.sessionId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && cards.filter(x => x.computerApp).length < 2) await sleep(50);
    const childCards = cards.filter(x => x.computerApp);
    const task = (await tasks())[0];
    t.ok('委譲の子の承認は、子の会話と依頼元の会話の両方に出る。依頼元側も canAlways: true で、アプリが見える', childCards.length === 2 && childCards.some(x => x.sessionId === task.sessionId) && childCards.some(x => x.sessionId === parent.sessionId && x.canAlways === true && x.computerApp.apps[0].id === NOTEPAD), JSON.stringify(childCards.map(x => [x.sessionId, x.canAlways])) + ' task ' + task?.sessionId + ' parent ' + parent.sessionId);
    const relayed = childCards.find(x => x.sessionId === parent.sessionId);
    await c.cmd('resolvePermission', { id: relayed.id, allow: true, scope: 'session' });
    const end = Date.now() + 30_000;
    let finished;
    while (Date.now() < end) { finished = (await tasks())[0]; if (finished?.status === 'completed') break; await sleep(50); }
    const after = await sessionsFile();
    t.ok('依頼元の画面で答えても、許可は承認を求めた会話（子）に付く。子の操作はそのまま通る', finished?.status === 'completed' && after[task.sessionId]?.computerApps?.join() === NOTEPAD && !after[parent.sessionId]?.computerApps);
    c.close(); lateClient.close();
    await server.stop();

    // ---- ロックの待ちが上限（短縮）を過ぎたら busy
    const busy = await boot({ env: { AGENT_HOST_COMPUTER_LOCK_WAIT_MS: '500' } });
    const m = busy.c.mark();
    const holdBusy = busy.c.runTurn({ backend: 'fake', cwd: ROOT, prompt: hold([shotCall]) });
    await busy.c.waitFor(e => e.type === 'computer.state' && e.state === 'running', { from: m, ms: 20000 });
    const late = await busy.c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall]) });
    const lateResult = late.events.find(e => e.type === 'tool.result' && e.sessionId === late.sessionId);
    t.ok('上限を過ぎたら busy（stopped）。文に持ち主の会話。持ち主の会話は止まらない', lateResult.computer.reason === 'busy' && lateResult.computer.state === 'stopped' && lateResult.isError === true);
    await busy.c.cmd('abort', {});
    await holdBusy;
    await busy.server.stop();

    // ---- 使えないとき: エージェントが対応しない・設定でオフ・Electron でない
    const off = await boot({ env: { FAKE_COMPUTER_USE: 'off' } });
    const offTurn = await off.c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall]) });
    t.ok('エージェントが対応しない（capabilities.computerUse が false）なら MCP を渡さない', offTurn.events.some(e => e.type === 'text.delta' && /computer: unavailable/.test(e.text ?? e.delta ?? '')) || (await off.c.cmd('loadSession', { sessionId: offTurn.sessionId })).messages.some(m => m.text?.includes('computer: unavailable')));
    await off.server.stop();
    const disabled = await boot({ prefs: { computerUse: { enabled: false } } });
    const dTurn = await disabled.c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall]) });
    t.ok('設定でオフなら MCP を渡さない', (await disabled.c.cmd('loadSession', { sessionId: dTurn.sessionId })).messages.some(m => m.text?.includes('computer: unavailable')));
    await disabled.server.stop();
    const noDriver = await boot({ env: { AGENT_HOST_COMPUTER_DRIVER: '' } });
    const nTurn = await noDriver.c.runTurn({ backend: 'fake', cwd: ROOT, prompt: computer([shotCall]) });
    t.ok('Electron でない起動（driver が無い）は MCP を渡さず、hostCapabilities は supported: false / reason: desktop', (await noDriver.c.cmd('hostCapabilities')).computerUse?.reason === 'desktop' && (await noDriver.c.cmd('hostCapabilities')).computerUse?.supported === false
      && (await noDriver.c.cmd('loadSession', { sessionId: nTurn.sessionId })).messages.some(m => m.text?.includes('computer: unavailable')));
    t.ok('driver が無いときの /mcp/computer は 404（ply_agents の口とは別）', (await fetch(`http://127.0.0.1:${noDriver.server.port}/mcp/computer?token=${noDriver.server.token}`)).status === 404);
    await noDriver.server.stop();
  } finally {
    for (const c of clients) c.close();
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
