// agy（Antigravity CLI）を保持役（core/holder/）の子に載せる（無停止の更新 段階 3。docs/zero-downtime-update/stage3-agy.md・plan.md「段階 3」）。
// agy は会話ごとに 1 プロセスで、stdin に 1 行 1 JSON を書き、stdout の 1 行 1 JSON を読むだけ（握手が無い。stage0-codex-agy.md §3）。
// 保持役の子にすれば、サーバーが入れ替わっても agy は走り続け、新しいサーバーが同じ子の記録を印から読み直して続きを受ける（antigravity.mjs の adoptTurn）。
//   載せるか（heldPlan）: 切り替え（AGENT_HOST_AGY_HOLDER。既定は実行場所の置き場 AGENT_HOST_RUNTIME_ROOT があるとき on）・shell 無しで起こせる実行ファイル・
//     bot の会話でない・保持役につなげる。どれかが外れたら今の流れ（サーバーが agy を直に起こす）
//   policy 'none'（行だけ。保持役は agy のプロトコルを知らない）。ターンの印（turn）は、ターンの最初の行を書く直前に打つ（markTurn）。agy の子は会話のあいだ生きて
//     次のターンも書かれるので、印はターンごとに打ち直す（init は最初のターンの再生にだけ入る。会話の id は札が持つ）
//   読み: 子の stdout の行を 1 行ずつ処理し（session.feedLine。Promise を返すものはそれを待つ）、処理し終えた行を ack する。付け直しは印から ack までを
//     処理の再生（opts.replay）として流し、続きは普通に流す（core/adopt.mjs の replayRecord）
//   ターンが終わったら札と印を外す（endTurn）: 子は idle のまま次のターンを待つ。印の無い子は、引き継ぎで旧サーバーが止める（releaseIdle）・サーバーが落ちた後は
//     次の起動の最初の保持役の使用で止める（sweepIdle）。札と印を持つ子は付け直す（server の restoreAdoptedTurns）
//   detach の後: write・end・kill を保持役へ転送しない（旧サーバーが手を離した子には触れない）
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { bootEnv } from '../boot-env.mjs';
import { holderLink } from '../holder/link.mjs';
import { ADOPT_TURN_MARK, holderSource, replayRecord } from '../adopt.mjs';
import { sweepHeldHomes } from './antigravity-context.mjs';

/** 保持役の子の id の頭。保持役は Claude・fake の子とも共有するので、agy の子だけを見分ける */
export const AGY_CHILD_PREFIX = 'agy-';

/**
 * 保持役に載せる切り替え（AGENT_HOST_AGY_HOLDER）。`on` は載せる・`off` は載せない（今の流れ）。**無ければ、実行場所の置き場（AGENT_HOST_RUNTIME_ROOT。
 * パッケージ版の main が渡す）があるときだけ載せる**。置き場の無い起動（`npm start`・テスト）は何も変わらない。起動用の変数（core/boot-env.mjs）
 */
export function heldEnabled(env = process.env) {
  const value = String(bootEnv('AGENT_HOST_AGY_HOLDER') ?? env.AGENT_HOST_AGY_HOLDER ?? '').toLowerCase();
  if (value === 'on') return true;
  if (value === 'off') return false;
  return Boolean(bootEnv('AGENT_HOST_RUNTIME_ROOT') ?? env.AGENT_HOST_RUNTIME_ROOT);
}

/** 保持役に起こさせるコマンド。保持役は command と args を解釈せず shell: false で起こす。shell が要る .cmd・.bat は null（載せない） */
export function heldAgyCommand(argv, { platform = process.platform } = {}) {
  const [command, ...args] = Array.isArray(argv) ? argv : [];
  if (!command || (platform === 'win32' && /\.(cmd|bat)$/i.test(command))) return null;
  return { command, args };
}

/**
 * この会話の agy を保持役に載せるか。載せるなら { client }（保持役への共有の口。core/holder/link.mjs）、載せないなら null。
 * bot の会話は付け直さない（server の restoreTurn が断る）ので載せない。保持役を起こせない（抜け道の無い Job など）ときも載せない
 */
export async function heldPlan({ dataDir, argv, bot = false, log = console.error } = {}) {
  if (!heldEnabled() || bot) return null;
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  if (!dataDir || !root || !heldAgyCommand(argv)) return null;
  try {
    return { client: await holderLink({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' }) };
  } catch (error) {
    // i18n-ignore: サーバーのログ（log は console.error）
    log('  保持役につなげないので、agy を今の形で起こす:', String(error?.code ?? error?.message ?? error));
    return null;
  }
}

/**
 * 保持役の子を、AgySession の proc に見せる口。AgySession の held に渡す（AgySession.start が start を呼ぶ）。
 *   createHeldAgy({ client })   このサーバーが起こす子（start で spawn する）
 *   createHeldAgy({ source })   付け直す子（source は core/adopt.mjs の holderSource。印から ack までを再生し、続きを受ける）
 */
export function createHeldAgy({ client = null, source = null } = {}) {
  let id = source?.id ?? null;
  const adopting = Boolean(source);
  let detached = false, handedOff = false, exited = null, muted = false;
  let idle = false;   // ターンの間（endTurn の後、次の markTurn まで）。札は置かない（遅れて届いた置き直しで idle の子を付け直す対象に戻さない）
  let proc = null;

  async function pump(onLine) {
    let info = { code: null, signal: null };
    try {
      if (adopting) {
        const result = await replayRecord({ source, normalize: line => [line], emit: (line, opts) => onLine(line, { replay: Boolean(opts?.replay) }) });
        if (result.exit) info = result.exit;
        else info = { code: null, signal: null, lost: true };
      } else {
        for await (const item of source.attach(1)) {
          if (item.exit) { info = item.exit; break; }
          await onLine(item.line);
          source.ack(item.seq);
        }
      }
    } catch (error) {
      console.error('  保持役の agy の読みが切れた:', String(error?.message ?? error));
      info = { code: null, signal: null, lost: true };
    }
    exited = info;
    // 旧サーバーが手を離した（handOff）: proc は終わらせない（子は走り続ける。agent の置き場も消さない）
    if (info.handedOff) return;
    proc.exitCode = info.code ?? null;
    proc.signalCode = info.signal ?? null;
    // 終わった子の記録を捨てる（保持役の側の控え）。つながりが切れて終わりが分からないときは触れない
    if (!info.lost) { try { source.release(); } catch { /* つながりが切れた */ } }
    source.dispose();
    // AgySession の close（die）→ exit（片付け）の順（ChildProcess と同じ）
    setImmediate(() => { proc.emit('close', proc.exitCode, proc.signalCode); proc.emit('exit', proc.exitCode, proc.signalCode); });
  }

  const held = {
    get id() { return id; },
    get source() { return source; },
    get client() { return source?.client ?? client; },
    get adopting() { return adopting; },
    /** 手を離した（detach の答えが来た）。この後の書き込み・止めは転送されない */
    get handedOff() { return handedOff; },
    get detached() { return detached; },
    /** 子が終わった（または手を離した）ときの { code, signal, handedOff? } */
    get exited() { return exited; },

    /** AgySession.start が呼ぶ。保持役に子を起こさせ（付け直しは起こさない）、出力の読みを始める。proc は ChildProcess の最小の写し */
    start({ argv, args, cwd, env, onLine, onStderr }) {
      proc = new EventEmitter();
      if (!source) {
        const target = heldAgyCommand(argv);
        if (!target) throw new Error('antigravity: the CLI cannot be started by the holder');
        id = `${AGY_CHILD_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
        // 出来事の購読は spawn より前（holderSource が先に購読を始める）。agy は spawn しただけでは何も出さない（最初の行を書いてから init）
        source = holderSource(client, { id, acked: 0, seq: 0, marks: {} }, { spawned: true });
        client.spawn({ id, command: target.command, args: [...target.args, ...args], cwd: cwd || undefined, env, policy: 'none' });
      }
      const onErr = frame => { if (frame.id === id && !detached && onStderr) onStderr(String(frame.chunk ?? '')); };
      source.client.on('err', onErr);
      const stdin = {
        get writable() { return !detached && !exited; },
        write(data) { if (!detached && !muted) source.write(String(data)); return true; },
        end() { if (!detached) source.client.end(id); },
      };
      Object.assign(proc, { stdin, pid: null, killed: false, exitCode: null, signalCode: null });
      proc.kill = () => {
        proc.killed = true;
        if (!detached && !exited) source.client.kill(id, { tree: true });
        return true;
      };
      proc.once('exit', () => source.client.off('err', onErr));
      void pump(onLine);
      return proc;
    },

    /** ターンの最初の行を書く直前に打つ。印は次の行（保持役が子の出力の通番で数える）。再生はここから */
    markTurn() { if (source && !detached && !exited) { idle = false; source.client.mark(id, ADOPT_TURN_MARK); } },
    /** 札を子に置く（server の touchCard が、札の中身が変わるたびに呼ぶ） */
    label(card) { if (source && !detached && !idle) source.client.label(id, card); },

    /**
     * 旧サーバーの手を離す口: 札を子に置いて detach し（答えが来た時点で、この親からの write は転送されない）、読みを止める。子は走り続ける
     * （保持役が持つ）。呼び出し側は、これを待ってから AgySession を捨てる
     */
    async handOff(card) {
      if (!source) throw new Error('antigravity: the CLI has not been started');
      source.client.label(id, card);
      await source.client.detach(id);
      detached = true;
      handedOff = true;
      source.stop();
    },

    /** ターンが終わった（子は idle で次のターンを待つ）。札と印を外し、付け直す対象から外す。手を離した子・終わった子には触れない */
    endTurn() {
      if (!source || detached || exited) return;
      idle = true;
      source.client.label(id, null);
      source.client.unmark(id, ADOPT_TURN_MARK);
    },

    /** プロセスが終わる間際に子を止める依頼（stdin を閉じ、木ごと止める）。続けて write せず、client.sendBatch で 1 回にまとめて送る。手を離した子・終わった子は空 */
    exitFrames() {
      if (!source || detached || exited) return [];
      return [{ t: 'end', id }, { t: 'kill', id, tree: true }];
    },

    /** テスト用: 子への書き込みを止める／戻す。止めている間の書き込みは捨てる */
    mute(flag) { muted = Boolean(flag); },
    /** テスト用: 読みを止める（子の出力は保持役に溜まり、このサーバーは処理も ack もしない）／再開する */
    pause(flag) { source?.pause(flag); },
  };
  return held;
}

let swept = false;
/**
 * このプロセスの最初の保持役の使用で 1 回だけ、前のサーバーが残した agy の子を片付ける: **ターンの印の無い**（idle の）agy の子は止める
 * （旧サーバーの落ち・強制終了で、止める人が居なくなった）。札と印を持つ子は付け直し（server の restoreAdoptedTurns）が読むので触れない。
 * agent の置き場（held-*）も、生きている子が指していないものを消す。この呼び出しの前に保持役へつないでいた自分の子（ids）は止めない
 */
export async function sweepIdle(client, { ids = new Set() } = {}) {
  if (swept) return [];
  swept = true;
  const children = (client.welcome?.children ?? []).filter(child => String(child.id).startsWith(AGY_CHILD_PREFIX) && !ids.has(child.id));
  const stopped = [];
  for (const child of children) {
    if (Number.isInteger(child.marks?.[ADOPT_TURN_MARK])) continue;
    try {
      await client.attach(child.id, { from: (child.seq ?? 0) + 1 });
      if (child.alive) client.kill(child.id, { tree: true }); else client.release(child.id);
      await client.detach(child.id);
      stopped.push(child.id);
    } catch { /* つながりが切れた・子が消えた */ }
  }
  const referenced = new Set(children.filter(child => child.alive && Number.isInteger(child.marks?.[ADOPT_TURN_MARK])).map(child => child.label?.backendCard?.agy?.home).filter(Boolean));
  sweepHeldHomes(referenced);
  return stopped;
}

/** テスト用: sweepIdle の「1 回だけ」を戻す */
export function resetSweep() { swept = false; }
