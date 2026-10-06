// 走っているターンの付け直し（無停止の更新 2b-4。docs/zero-downtime-update/stage2-server-state.md §4.2-§4.4・§5、design.md §4.5）。
// サーバーの adoptTurn とバックエンドの adoptTurn が使う、付け直す元（source）の形と、記録の再生の道。
//
// 付け直す元（source）は、保持役の子 1 つ分の見え方（core/holder/protocol.mjs の「子の状態」と replay・attach・ack）:
//   state      … { id, alive, exitCode, signal, error, label（札）, seq, first, acked, marks: { name: seq }, truncated }
//   attachable … 続きを受けられるか（保持役の子なら生死によらず真。ファイルの元は終わった子だけ）
//   replay(from, to) … 記録の [seq, line] の配列
//   attach(from)     … from 以降の { seq, line } を順に、最後に { exit: { code, signal, error } } を返す非同期の列
//   ack(seq)         … アプリのループで処理し終えた最後の行
// 保持役につないだ元は 2b-5 で足す。今あるのは、テストが「終わっていたターン」を置くファイルの元（AGENT_HOST_ADOPT_FROM）だけ。
import fs from 'node:fs/promises';
import path from 'node:path';

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
export async function replayRecord({ source, normalize, emit, signal }) {
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
  if (acked >= from) for (const [, line] of await source.replay(from, acked)) {
    if (signal?.aborted) break;
    await pass(line, true);
    replayed++;
  }
  for await (const item of source.attach(acked + 1)) {
    if (item.exit) return { exit: item.exit, replayed, live, acked: last };
    await pass(item.line, false);
    source.ack(item.seq);
    last = item.seq;
    live++;
  }
  return { exit: null, replayed, live, acked: last };
}
