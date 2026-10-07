// 走っているターンの付け直し（無停止の更新 2b-4。docs/zero-downtime-update/stage2-server-state.md §4.2-§4.4・§5、design.md §4.5）。
// サーバーの adoptTurn とバックエンドの adoptTurn が使う、付け直す元（source）の形と、記録の再生の道。
//
// 付け直す元（source）は、保持役の子 1 つ分の見え方（core/holder/protocol.mjs の「子の状態」と replay・attach・ack）:
//   state      … { id, alive, exitCode, signal, error, label（札）, seq, first, acked, marks: { name: seq }, truncated }
//   attachable … 続きを受けられるか（保持役の子なら生死によらず真。ファイルの元は終わった子だけ）
//   replay(from, to) … 記録の [seq, line] の配列
//   attach(from)     … from 以降の { seq, line } を順に、最後に { exit: { code, signal, error } } を返す非同期の列
//   ack(seq)         … アプリのループで処理し終えた最後の行
// 元は 2 つ: 保持役の子につないだ元（holderSource・readHolderSources。2b-5。接続は core/holder/link.mjs の共有の口）と、
// テストが「終わっていたターン」を置くファイルの元（readAdoptSources。AGENT_HOST_ADOPT_FROM）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { holderLink } from './holder/link.mjs';

/** ターンの始まりの印の名前（保持役の mark。再生はここから） */
export const ADOPT_TURN_MARK = 'turn';

/** 付け直す元のファイル（テスト用。保持役の welcome.children の形に、子ごとの記録 lines を足したもの） */
export const ADOPT_FILE = 'children.json';

/**
 * ファイルの付け直す元を読む（AGENT_HOST_ADOPT_FROM。テストだけが付ける）。
 * <dir>/children.json = { children: [{ ...子の状態, lines: [[seq, line], ...] }] }。読むだけで書かない（ack はメモリに持つ）
 */
export async function readAdoptSources(dir) {
  const parsed = JSON.parse(await fs.readFile(path.join(dir, ADOPT_FILE), 'utf8'));
  return (Array.isArray(parsed?.children) ? parsed.children : []).map(fileSource);
}

function fileSource(child) {
  const { lines: raw, ...state } = child ?? {};
  const lines = (Array.isArray(raw) ? raw : []).filter(l => Array.isArray(l) && Number.isInteger(l[0]) && typeof l[1] === 'string');
  const source = {
    id: String(state.id ?? ''),
    state: { ...state, acked: Number.isInteger(state.acked) ? state.acked : 0, marks: state.marks ?? {} },
    // ファイルの元には生きた子が無いので、終わった子だけ続きを受けられる（生きた子は 2b-5 の保持役の元）
    attachable: state.alive === false,
    acked: Number.isInteger(state.acked) ? state.acked : 0,
    async replay(from, to) { return lines.filter(([seq]) => seq >= from && seq <= to); },
    async *attach(from) {
      if (!source.attachable) throw new Error('adopt: the child is not attachable');
      for (const [seq, line] of lines) if (seq >= from) yield { seq, line };
      yield { exit: { code: state.exitCode ?? null, signal: state.signal ?? null, error: state.error ?? null } };
    },
    ack(seq) { if (seq > source.acked) source.acked = seq; },
  };
  return source;
}

/**
 * 保持役の子 1 つ分の元（core/holder/client.mjs の HolderClient を包む）。state は保持役の子の状態（welcome.children の 1 件か、自分で起こした子の見込み）。
 * 生きた子も続きを受けられる。attach(from) は out・exit をキューへ溜めて順に返す（attach の答えの直後の行を取りこぼさないよう、出来事の購読は
 * ここで先に始める）。spawned: true は、自分が spawn した子（spawn で最初から親に付いている。attach を送り直さない）。
 * 付け直す側の取り分は write（子の stdin へ。承認の答え・途中送信）・release（終わった子の記録を捨てる。終わりの記録を処理し終えた後）・dispose（購読をやめる）。
 * stop() は手を離すとき（旧サーバーの detach の後）に、読みの列を { exit: { handedOff: true } } で終わらせる。paused はテスト用（読みを止めて、保持役に溜めさせる）
 * redelivered: true は、保持役が付け直しで渡し直す控え（attach の from より前の mcp_message・elicitation。core/holder/holder.mjs）も
 * { seq, line, redelivered: true } で列に入れる（Claude の付け直しは SDK へ流し直す。2c）。attach の答え（子の状態と pendingRequests）は attachedState に残す
 */
export function holderSource(client, state, { spawned = false, redelivered = false } = {}) {
  const id = String(state.id);
  const queue = [];
  let wake = null, stopped = false;
  // attach の前の write は保持役が捨てる（subscribe していない親は子に触れない）。attach の後に順に送る（付け直す側が最初に出す中断など）
  let attached = spawned;
  const early = [];
  const poke = () => { const w = wake; wake = null; w?.(); };
  const onOut = frame => {
    if (frame.id !== id || (frame.redelivered && !redelivered)) return;
    queue.push(frame.redelivered ? { seq: frame.seq, line: frame.line, redelivered: true } : { seq: frame.seq, line: frame.line });
    poke();
  };
  const onExit = frame => { if (frame.id === id) { queue.push({ exit: { code: frame.code ?? null, signal: frame.signal ?? null, error: frame.error ?? null } }); poke(); } };
  const onDisconnect = reason => { queue.push({ lost: String(reason ?? 'closed') }); poke(); };
  client.on('out', onOut);
  client.on('exit', onExit);
  client.on('disconnect', onDisconnect);
  const source = {
    id,
    client,
    state: { ...state, acked: Number.isInteger(state.acked) ? state.acked : 0, marks: state.marks ?? {} },
    attachable: true,
    acked: Number.isInteger(state.acked) ? state.acked : 0,
    paused: false,
    async replay(from, to) {
      const { lines, truncated } = await client.replay(id, from, to);
      if (truncated) throw new Error('adopt: the record was truncated');
      return lines.map(({ seq, line }) => [seq, line]);
    },
    attachedState: null,
    /** attach の答えまで先に済ませる（付け直す側が、答えの pendingRequests を見てから記録を読み直すため）。attach(from) はこの後なら送り直さない */
    async open(from) {
      if (!spawned && !source.attachedState) source.attachedState = await client.attach(id, { from });
      attached = true;
      for (const data of early.splice(0)) client.write(id, data);
      return source.attachedState;
    },
    async *attach(from) {
      await source.open(from);
      for (;;) {
        while (!stopped && (source.paused || !queue.length)) await new Promise(resolve => { wake = resolve; });
        if (stopped) { yield { exit: { handedOff: true } }; return; }
        const item = queue.shift();
        if (item.lost) throw new Error(`adopt: the holder connection was lost (${item.lost})`);
        if (item.exit) { yield item; return; }
        if (item.redelivered) { yield item; continue; }      // 控えの渡し直し（通番は from より前。from は進めない）
        if (item.seq < from) continue;                       // 自分で起こした子の最初の記録と、attach の送り直しの重なり
        from = item.seq + 1;
        yield item;
      }
    },
    ack(seq) { if (seq > source.acked) { source.acked = seq; client.ack(id, seq); } },
    write(data) { if (attached) return client.write(id, data); early.push(data); return true; },
    release() { return client.release(id); },
    stop() { stopped = true; poke(); },
    pause(flag) { source.paused = Boolean(flag); poke(); },
    dispose() { client.off('out', onOut); client.off('exit', onExit); client.off('disconnect', onDisconnect); },
  };
  return source;
}

/**
 * 起動で付け直す、保持役の子の元（無停止の更新 2b-5）。居る保持役にだけつなぐ（起こさない）。付け直せるのは、札（label）と
 * ターンの印を持つ子だけ（旧サーバーが手を離すときに置く。stage2-server-state.md §6 の 2b-5 の実装のメモ）。居なければ空。
 * 控えの渡し直しも列に入れる（Claude の付け直しが SDK へ流す。2c。fake の held: の記録には控えが無い）
 */
export async function readHolderSources({ dataDir, root, appVersion = '', log = () => {} } = {}) {
  let client;
  try { client = await holderLink({ dataDir, root, appVersion, launch: false, log }); }
  catch (error) { if (error?.code === 'HOLDER_NONE') return []; throw error; }
  const sources = [];
  for (const child of client.welcome?.children ?? []) {
    // 1 つの子が複数のターンを運ぶバックエンド（Codex の共有の app-server）は、子の札の種類（label.k）で登録した口が、ターンごとの元に分ける
    const expand = typeof child.label?.k === 'string' ? childExpanders.get(child.label.k) : null;
    if (expand) sources.push(...await expand({ client, child, log }).catch(error => { log(`  付け直す元を読めない（${child.id}）: ${error?.message ?? error}`); return []; }));
    else if (child.label && Number.isInteger(child.marks?.[ADOPT_TURN_MARK])) sources.push(holderSource(client, child, { redelivered: true }));
  }
  return sources;
}

/**
 * 子の札の種類（label.k）ごとの、子 → ターンごとの元の展開（Codex の共有の app-server。core/backends/codex-held.mjs が登録する）。
 * expand({ client, child, log }) は、付け直す元（restoreTurn が読む state・attachable・dispose を持つもの）の配列を返す
 */
const childExpanders = new Map();
export const registerChildExpander = (kind, expand) => { childExpanders.set(kind, expand); };

/** 重なって届いた出来事を見分ける鍵（uuid・ツールの id を持つものだけ） */
function eventKey(event) {
  if (event?.type === 'text.end' && event.uuid) return `text:${event.uuid}`;
  if ((event?.type === 'tool.start' || event?.type === 'tool.result') && event.id) return `${event.type}:${event.id}`;
  return null;
}

/**
 * 記録を印から流す（バックエンドの adoptTurn が呼ぶ）。normalize(line) は記録の 1 行を今の正規化の出来事の配列にする。
 * - 印から ack までは emit(event, { replay: true })（画面へ出さず、実行中のスナップショットとメモリの状態だけを作る。server の makeEmit）
 * - ack より後ろは普通に emit し、出来事を流し終えた行で ack する（design.md §4.5 の 3）
 * - uuid・ツールの id で冪等（重なって届いた発言の終わり・ツールの始まりと結果は 1 回だけ。終わった発言の text.delta も捨てる）
 * 戻り値は { exit, replayed, live, acked }。exit は子の終わり（記録に exit が無いまま列が尽きたら null）
 */
export async function replayRecord({ source, normalize, emit }) {
  const from = source.state.marks?.[ADOPT_TURN_MARK];
  if (!Number.isInteger(from)) throw new Error('adopt: the record has no turn mark');
  // 印より前の ack は前のターンのもの。このターンの再生は印から
  const acked = Math.max(from - 1, source.state.acked ?? 0);
  const seen = new Set();
  let replayed = 0, live = 0, last = acked;
  const pass = async (line, replay) => {
    for (const event of normalize(line) ?? []) {
      const key = eventKey(event);
      if (key && seen.has(key)) continue;
      if (event?.type === 'text.delta' && event.uuid && seen.has(`text:${event.uuid}`)) continue;
      if (key) seen.add(key);
      await emit(event, replay ? { replay: true } : undefined);
    }
  };
  // 再生は中断（signal）でも止めない: 止め始めていたターンの付け直し（T7）でも、実行中のスナップショットは印から全部作る
  if (acked >= from) for (const [, line] of await source.replay(from, acked)) {
    await pass(line, true);
    replayed++;
  }
  for await (const item of source.attach(acked + 1)) {
    if (item.exit) return { exit: item.exit, replayed, live, acked: last };
    if (item.redelivered) continue;
    await pass(item.line, false);
    source.ack(item.seq);
    last = item.seq;
    live++;
  }
  return { exit: null, replayed, live, acked: last };
}
