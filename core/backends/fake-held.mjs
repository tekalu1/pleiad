// fake の台本 "held:<台本>"（無停止の更新 段階 2 の 2b-5。docs/zero-downtime-update/stage2-server-state.md §6）。
// <台本> を別プロセスの偽の CLI（fake-agent.mjs）で走らせ、保持役（core/holder/）の子に載せる。偽の CLI は fake の台本をそのまま動かし、
// 出来事を 1 行 1 JSON で出す（行は fake の出来事そのもの。cli.* は偽の CLI とバックエンドの間の取り決め）。サーバーを入れ替えても CLI は走り続け、
// 新しいサーバーが記録を再生して続きを受ける（fake の adoptTurn）。
//   偽の CLI -> 記録  cli.start { text }（最初の 1 行。履歴の人の発言）・cli.ask { requestId, request }（承認待ち）・cli.settled { requestId }（答えを受けた）・
//                    cli.steer-result { id, accepted }・cli.log { text }（fake の合図 fake-signal: の出力）
//   バックエンド -> 偽の CLI の stdin  start { prompt, userText, sessionId, cwd, mode, model, notes }・permission.answer { requestId, answer }・
//                    steer { item }・interrupt {}
// 承認待ちは記録から作る: 付け直したサーバーは、cli.ask のうち cli.settled が無いものだけ、承認の画面へ出し直す（同じ id。ただし id を渡る札にするのは 2b-6）。
// 保持役の場所は AGENT_HOST_DATA（データ置き場）と AGENT_HOST_RUNTIME_ROOT（実行場所の置き場）。無ければ台本はエラーにする
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { holderLink } from '../holder/link.mjs';
import { ADOPT_TURN_MARK, holderSource, replayRecord } from '../adopt.mjs';

const FAKE_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
const lineOf = value => `${JSON.stringify(value)}\n`;
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/** 会話 id -> このサーバーが偽の CLI を見ている held のターン。旧サーバーの手を離す口（handOffHeld）が引く */
const helds = new Map();

/** 偽の CLI を保持役の子として起こし、ターンの印を置いて start を書く。戻り値は付け直し元と同じ形の source */
export async function spawnHeld({ sessionId, cwd, start }) {
  const dataDir = process.env.AGENT_HOST_DATA;
  const root = process.env.AGENT_HOST_RUNTIME_ROOT;
  if (!dataDir || !root) throw new Error('fake: held: needs AGENT_HOST_DATA and AGENT_HOST_RUNTIME_ROOT');
  const client = await holderLink({ dataDir, root, mode: 'detached' });
  const id = `fake-held-${crypto.randomUUID().slice(0, 8)}`;
  // 出来事の購読は spawn より前に始める。印と start は最初の書き込みより前（保持役の記録は印から再生する）
  const source = holderSource(client, { id, acked: 0, seq: 0, marks: { [ADOPT_TURN_MARK]: 1 } }, { spawned: true });
  const env = { ...process.env };
  delete env.AGENT_HOST_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  client.spawn({ id, command: process.execPath, args: [FAKE_AGENT], cwd: cwd || undefined, env, policy: 'none' });
  client.mark(id, ADOPT_TURN_MARK);
  source.write(lineOf({ type: 'start', sessionId, cwd, ...start }));
  return source;
}

/** 付け直すサーバーが、手を離した旧サーバーの代わりに会話の履歴を作る（fake の会話はプロセスのメモリ。fake.mjs の runTurn の steps と同じ形） */
function recorder(record, { user }) {
  let text = '', calls = [];
  const starts = new Map();
  const flush = extra => {
    record({ role: 'assistant', text, ...(calls.length ? { tools: calls.map(call => call.name), toolCalls: calls } : {}), ...extra });
    text = '';
    calls = [];
  };
  return {
    start(event) { if (user && event.text != null) record({ role: 'user', text: String(event.text) }); },
    event(event) {
      switch (event?.type) {
        case 'text.delta': text += String(event.text ?? ''); break;
        case 'text.end': if (text) flush(event.uuid ? { uuid: event.uuid } : {}); break;   // 本文の無い text.end は発言の切れ目だけ（ツールの続きは同じ発言に合成する）
        case 'tool.start': starts.set(event.id, { name: event.name, input: event.input ?? {} }); break;
        case 'tool.result': calls.push({ id: event.id, name: starts.get(event.id)?.name, input: starts.get(event.id)?.input ?? {}, result: { text: event.text, isError: Boolean(event.isError), truncated: Boolean(event.truncated) } }); break;
        default: break;
      }
    },
    finish() { if (calls.length) flush({}); },
  };
}

/**
 * 記録を再生して続きを受け、承認の答え・途中送信・中断を偽の CLI の stdin へ返す。付け直しも、起こした直後のターンも同じ道（fake の runTurn・adoptTurn が呼ぶ）。
 * 戻り値は { handedOff: true }（旧サーバーが手を離した）か { exit }。終わりの記録を処理し終えたら子の記録を捨てる（release）。
 * source.write が無い元（ファイルの元。終わった子）は、書く道具を持たない
 */
export async function driveHeld({ source, record, emit, askPermission, signal, control, sessionId, recordUser }) {
  const history = recorder(record, { user: recordUser });
  const mark = source.state.marks?.[ADOPT_TURN_MARK];
  // 承認の答えが記録に残っているもの（旧サーバーが答えを渡した後に手を離した）は出し直さない
  const settled = new Set();
  if (source.write && Number.isInteger(mark) && source.state.seq >= mark) {
    for (const [, line] of await source.replay(mark, source.state.seq)) { const m = parse(line); if (m?.type === 'cli.settled') settled.add(m.requestId); }
  }
  let stopped = false;
  const asked = new Set();
  const steers = new Map();
  const send = value => { if (!stopped && source.write) source.write(lineOf(value)); };
  const onAbort = () => send({ type: 'interrupt' });
  if (signal?.signal?.aborted) onAbort(); else signal?.signal?.addEventListener?.('abort', onAbort, { once: true });
  if (control && source.write) {
    control.steer = item => new Promise(resolve => {
      steers.set(item?.id, resolve);
      send({ type: 'steer', item: { id: item?.id, args: { prompt: item?.args?.prompt } } });
    });
    control.onReady?.();
  }

  let ended = false;
  const handle = async (event, opts) => {
    switch (event?.type) {
      case 'cli.start': history.start(event); return;
      case 'cli.log': if (!opts?.replay) console.log(event.text); return;
      case 'cli.settled': return;
      case 'cli.steer-result': steers.get(event.id)?.(Boolean(event.accepted)); steers.delete(event.id); return;
      case 'cli.ask': {
        const { requestId, request } = event;
        if (settled.has(requestId) || asked.has(requestId)) return;
        asked.add(requestId);
        // 答えは待たずに続きを読む（偽の CLI は答えまで何も出さない。手を離す・中断のときに読みの列を止められるように）
        void askPermission({ ...request, sessionId, toolUseID: requestId, signal: signal?.signal })
          .then(answer => send({ type: 'permission.answer', requestId, answer }), () => {});
        return;
      }
      default: break;
    }
    if (event?.type === 'turnResult') ended = true;
    history.event(event);
    return emit(event, opts);
  };
  try {
    const result = await replayRecord({ source, signal: signal?.signal, normalize: line => { const m = parse(line); return m ? [m] : []; }, emit: handle });
    if (result.exit?.handedOff) { stopped = true; return { handedOff: true }; }
    stopped = true;
    history.finish();
    if (!ended) throw new Error(`fake: the adopted turn ended without a result (exit ${result.exit?.code ?? 'none'})`);
    source.release?.();
    return { exit: result.exit };
  } finally {
    stopped = true;
    for (const resolve of steers.values()) resolve(false);
    signal?.signal?.removeEventListener?.('abort', onAbort);
    source.dispose?.();
  }
}

/** 台本 "held:" のターン 1 つ。偽の CLI を起こして、記録の続きを受ける（fake の runTurn が呼ぶ） */
export async function runHeld({ id, cwd, mode, model, notes, prompt, userText, record, emit, askPermission, signal, control }) {
  const source = await spawnHeld({ sessionId: id, cwd, start: { prompt, userText, mode, model, notes } });
  helds.set(id, source);
  try {
    return await driveHeld({ source, record, emit, askPermission, signal, control, sessionId: id, recordUser: false });
  } finally {
    if (helds.get(id) === source) helds.delete(id);
  }
}

/**
 * 旧サーバーの手を離す口（2d が呼ぶ形のバックエンド側。今はテストの入口 tests/lib/adopt-server.mjs が呼ぶ）: 札（handOffTurn の card）を子に置き、
 * 保持役に detach して（答えが来た時点で、この親からの write は転送されない）、この道の読みを止める
 */
export async function handOffHeld(sessionId, card) {
  const source = helds.get(sessionId);
  if (!source) throw new Error(`fake: no held turn to hand off (${sessionId})`);
  source.client.label(source.id, card);
  await source.client.detach(source.id);
  source.stop();
  return { childId: source.id };
}

/** テスト用: 読みを止める（偽の CLI の出力は保持役に溜まり、このサーバーは処理も ack もしない）／再開する */
export function pauseHeld(sessionId, paused) {
  const source = helds.get(sessionId);
  if (!source) throw new Error(`fake: no held turn (${sessionId})`);
  source.pause(paused);
  return true;
}
