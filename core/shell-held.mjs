// 入力欄の `!`（シェルの行）を保持役（core/holder/）の子に載せる（無停止の更新 段階 3。docs/zero-downtime-update/plan.md「段階 3」の `!` の行の実装のメモ）。
// サーバーを入れ替えてもシェルは走り続け、新しいサーバーが記録から出力の続きと終わりを受ける（core/shell-runs.mjs の adopt）。
//   子: core/shell-held-child.mjs（シェルを runHostShell で走らせ、stdout・stderr・終わりを 1 行 1 JSON の記録にする包み）。policy は 'none'
//   印: 'shell' を通番 1 に置く（記録を捨てさせない。出力は runHostShell の上限で stdout・stderr それぞれ 256 KB まで）。ターンの印 'turn' は置かない
//       （core/adopt.mjs の readHolderSources はターンの子だけを拾う）
//   札: 子の label に { kind: 'shell', v, sessionId, runId, command, cwd, at, backend, skip }。起こすときに置き、「渡さない」を変えたら置き直す
//       （落ちたサーバーの後でも付け直せる）。サーバーの終わりで止める子は札を外す（次の起動が付け直さない）
//   ack: 画面へ流し終えた出力の行。付け直したサーバーは、通番 1 から ack までを出力の組み立てだけに使い（流さない）、その先を流す。
//       終わりの行（done）は、会話の記録（shellPending）に書き終えてから ack し、子の記録を捨てる（release）。ack 済みの終わりは付け直さずに捨てる
//   手を離す（handOff）: 読みを止めてから detach する（止めた後の行は ack しないので、新しいサーバーが流す。取りこぼし・重なりが無い）。
//       終わりの行を受けて記録に書いている最中の子は、書き終える（release する）のを待つ
// 載せるかの切り替え: AGENT_HOST_SHELL_HOLDER。既定は、実行場所の置き場（AGENT_HOST_RUNTIME_ROOT。AGENT_HOST_HANDOVER=on のパッケージ版で main が渡す）があれば載せる。
// `off` で今の流れ（サーバーの子として走らせる）。保持役につなげない・起こせないときも今の流れ。
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { bootEnv } from './boot-env.mjs';
import { holderLink } from './holder/link.mjs';
import { holderSource } from './adopt.mjs';

const CHILD = fileURLToPath(new URL('./shell-held-child.mjs', import.meta.url));
export const SHELL_MARK = 'shell';
export const SHELL_CARD_KIND = 'shell';
export const SHELL_CARD_VERSION = 1;
/** 札の上限（保持役の label の上限 256 KB より十分小さく。越える行は保持役に載せない） */
const CARD_MAX_BYTES = 64 * 1024;
/** 手を離すとき、記録に書いている最中の子を待つ上限 */
const SETTLE_WAIT_MS = 5_000;

const lineOf = value => `${JSON.stringify(value)}\n`;
const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/** 保持役に載せるか。`off` なら載せない。それ以外は実行場所の置き場があるとき（既定 on） */
export const shellHolderEnabled = (env = process.env) => String(bootEnv('AGENT_HOST_SHELL_HOLDER') ?? env.AGENT_HOST_SHELL_HOLDER ?? '').toLowerCase() !== 'off'
  && Boolean(bootEnv('AGENT_HOST_RUNTIME_ROOT'));

/** 走っている行の札 */
export const shellCard = run => ({ kind: SHELL_CARD_KIND, v: SHELL_CARD_VERSION, sessionId: run.sessionId, runId: run.runId, command: run.command, cwd: run.cwd,
  at: run.at, backend: run.backend, ...(run.skip ? { skip: true } : {}) });

/** 札から走っている行の形を戻す。形が合わなければ null */
export function readShellCard(card) {
  if (card?.kind !== SHELL_CARD_KIND || card.v !== SHELL_CARD_VERSION) return null;
  const { sessionId, runId, command, cwd, at, backend } = card;
  if (![sessionId, runId, command, at, backend].every(v => typeof v === 'string' && v)) return null;
  return { sessionId, runId, command, cwd: typeof cwd === 'string' ? cwd : null, at, backend, skip: card.skip === true };
}

/**
 * 保持役の子 1 つ分（source は core/adopt.mjs の holderSource）。shell-runs が使う:
 *   drive({ onOutput(stream, text, replay), signal }) … 記録を通番 1 から読み、終わりの結果を返す（{ handedOff: true }・{ already: true }・runHostShell と同じ形）。
 *     replay は ack 済みの出力（画面へ流し直さない）。signal の中断で子へ stop を書く
 *   finished()   … 終わりを会話の記録に書き終えた（終わりの行を ack し、子の記録を捨てる）
 *   label(run)   … 札を置き直す（「渡さない」を変えた）
 *   handOff()    … 手を離す（読みを止めて detach。記録に書いている最中なら finished を待つ）
 *   abandon()    … サーバーの終わり: 札を外して止める（同期。次の起動は付け直さない）
 */
function heldShell(source) {
  let state = 'driving';            // driving -> finishing -> done ／ driving -> handedOff
  let doneSeq = null, lastSeq = 0;
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const client = source.client;
  const write = value => source.write(lineOf(value));
  return {
    id: source.id,
    async drive({ onOutput, signal }) {
      const acked = source.state.acked ?? 0;
      let result = null;
      const onAbort = () => write({ t: 'stop' });
      if (signal?.aborted) onAbort(); else signal?.addEventListener?.('abort', onAbort, { once: true });
      // 保持役が断った spawn（id の重なり・札の大きさ）は exit が来ないので、ここで終わりにする
      let fault;
      const faulted = new Promise(resolve => { fault = frame => { if (frame?.id === source.id) resolve({ exit: { code: null, signal: null, error: `holder: ${frame.op} ${frame.reason}` } }); }; });
      client.on('fault', fault);
      const items = source.attach(1)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const item = await Promise.race([items.next().then(next => (next.done ? { exit: null } : next.value)), faulted]);
          if (item.exit !== undefined) {
            if (item.exit?.handedOff) return { handedOff: true };
            state = 'finishing';
            if (doneSeq !== null && doneSeq <= acked) return { already: true };
            if (result) return result;
            return { exitCode: null, error: item.exit?.error ? String(item.exit.error) : `the shell wrapper exited without a result (code ${item.exit?.code ?? 'none'})` };
          }
          lastSeq = item.seq;
          const m = parse(item.line);
          if (m?.t === 'o' || m?.t === 'e') {
            onOutput(m.t === 'e' ? 'stderr' : 'stdout', String(m.x ?? ''), item.seq <= acked);
            if (item.seq > acked) source.ack(item.seq);
          } else if (m?.t === 'done') {
            const { t: _t, ...rest } = m;
            result = rest;
            doneSeq = item.seq;
          }
        }
      } catch (error) {
        state = 'finishing';
        return { exitCode: null, error: String(error?.message ?? error) };
      } finally {
        signal?.removeEventListener?.('abort', onAbort);
        client.off('fault', fault);
        if (state === 'handedOff') source.dispose();
      }
    },
    finished() {
      if (state === 'done') return;
      state = 'done';
      if (lastSeq) source.ack(lastSeq);
      source.release();
      source.dispose();
      settle();
    },
    label: run => client.label(source.id, shellCard(run)),
    async handOff() {
      if (state === 'finishing') {
        let timer;
        await Promise.race([settled, new Promise(resolve => { timer = setTimeout(resolve, SETTLE_WAIT_MS); })]).finally(() => clearTimeout(timer));
        return;
      }
      if (state !== 'driving') return;
      state = 'handedOff';
      source.stop();
      await client.detach(source.id);
    },
    abandon() {
      if (state !== 'driving') return;
      client.label(source.id, null);
      write({ t: 'stop' });
    },
  };
}

/**
 * サーバーの口。shell-runs の holder に渡す:
 *   start(run, { timeoutMs }) … 保持役に子を起こし、heldShell を返す。載せないとき（切り替えが off・つなげない・札が大きすぎる）は null（今の流れ）
 *   adoptable()               … 起動で付け直す子（[{ card, held }]）。居る保持役にだけつなぐ
 */
export function createShellHolder({ dataDir, root = bootEnv('AGENT_HOST_RUNTIME_ROOT'), key = bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '', appVersion = '',
  enabled = shellHolderEnabled, log = console.error } = {}) {
  return {
    async start(run, { timeoutMs }) {
      if (!enabled() || !dataDir || !root) return null;
      const card = shellCard(run);
      if (Buffer.byteLength(JSON.stringify(card), 'utf8') > CARD_MAX_BYTES) return null;
      let client;
      try { client = await holderLink({ dataDir, root, key, appVersion }); }
      catch (error) {
        // i18n-ignore: サーバーのログ（log は console.error）
        log('  保持役につなげないので、`!` の行を今の形で走らせる:', String(error?.code ?? error?.message ?? error));
        return null;
      }
      const id = `shell-${run.runId}-${crypto.randomBytes(3).toString('hex')}`;
      // 出来事の購読は spawn より前に始める。印と始めの行は spawn の直後（同じ接続の中の順序は保たれる）
      const source = holderSource(client, { id, acked: 0, seq: 0, marks: { [SHELL_MARK]: 1 } }, { spawned: true });
      client.spawn({ id, command: process.execPath, args: [CHILD], cwd: run.cwd || undefined, env: { ...process.env }, policy: 'none', label: card });
      client.mark(id, SHELL_MARK, 1);
      source.write(lineOf({ t: 'run', command: run.command, cwd: run.cwd, timeoutMs }));
      return heldShell(source);
    },
    async adoptable() {
      if (!dataDir || !root) return [];
      let client;
      try { client = await holderLink({ dataDir, root, appVersion, launch: false }); }
      catch (error) { if (error?.code === 'HOLDER_NONE') return []; throw error; }
      return (client.welcome?.children ?? [])
        .filter(child => readShellCard(child.label) && Number.isInteger(child.marks?.[SHELL_MARK]))
        .map(child => ({ card: readShellCard(child.label), held: heldShell(holderSource(client, child)) }));
    },
  };
}
