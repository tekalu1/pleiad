// Claude の CLI を保持役（core/holder/）の子に載せる（無停止の更新 段階 2 の 2c。docs/zero-downtime-update/plan.md「2c」・stage2-claude.md）。
// SDK の spawnClaudeCodeProcess に偽の SpawnedProcess を渡し、CLI の起動と stdin・stdout を保持役のパイプへ回す。サーバーを入れ替えても CLI は走り続け、
// 新しいサーバーが同じ CLI に query を作り直して付け直す（claude.mjs の adoptTurn。空の入力の流れで 2 回目の initialize を送り、
// CLI が pending_permission_requests で承認待ちを canUseTool へ回し直す）。
//   載せるか（heldPlan）: AGENT_HOST_CLAUDE_HOLDER が off でない（既定は載せる）・実行場所の置き場（AGENT_HOST_RUNTIME_ROOT。パッケージ版の main が
//     起こしたサーバーだけにある。開発の npm start・テストのサーバーは無いので今の流れ）・CLI の版が下限以上（heldVersionOk）・
//     npm の包み（claude.cmd）なら中身の bin/claude.exe に解ける・保持役につなげる。どれかが外れたら今の流れ（SDK が CLI を自分で起こす）
//   記録の読み: 子の stdout の行をそのまま SDK の stdout へ流す。ack は、ループで処理し終えた SDK のメッセージの uuid の行
//     （uuid の無い制御の行は、その後の uuid の行の ack で覆われる。答えていない依頼は保持役の控えと CLI の送り直しで戻る）
//   付け直し: 印から ack までは claude.mjs が読み直して状態を作り（再生）、続きを SDK へ流す。attach の答えの時点までの行のうち、
//     答え済みの control_request（attach の答えの pendingRequests に無いもの）と、旧い親への control_response は流さない（stage2-claude.md「注意」）
//   detach の後: write・end・kill を保持役へ転送しない（旧サーバーの query を閉じても、CLI の stdin は閉じず止めない）
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { bootEnv } from '../boot-env.mjs';
import { holderLink } from '../holder/link.mjs';
import { ADOPT_TURN_MARK, holderSource } from '../adopt.mjs';

/**
 * 付け直しを確かめた CLI の版の下限（backend-shape-diagnostics.mjs の VERIFIED とは別。あちらは記録の形を確かめた版）。
 * 2.1.284（ネイティブ・npm の包み）・2.1.288 で、承認待ち・サブエージェント・裏の作業・途中送信・圧縮・elicitation の最中の付け直しを
 * 確かめた（stage0-claude.md・stage2-claude.md）。頼っている CLI の口（2 回目の initialize の pending_permission_requests・付け直し直後の
 * background_tasks_changed・resume での cost-state の読み戻し）は、確かめた最も古い版 2.1.284 までに揃っている。
 * 既定で載せるので、利用者の CLI が更新されるたびに黙って外れないよう、完全一致ではなく「この版以上で同じ major」にする。
 * 外れる版（下限より古い・major が違う）のターンは保持役に載せない。リリースごとに新しい版で実機の確かめをやり直す（docs/desktop-releases.md）
 */
export const HELD_CLI_MIN_VERSION = '2.1.284';

const versionParts = text => /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text ?? ''))?.slice(1).map(Number) ?? null;

/** この CLI の版を保持役に載せてよいか（HELD_CLI_MIN_VERSION 以上で、major が同じ） */
export function heldVersionOk(version) {
  const have = versionParts(version), min = versionParts(HELD_CLI_MIN_VERSION);
  if (!have || have[0] !== min[0]) return false;
  for (let i = 1; i < 3; i++) if (have[i] !== min[i]) return have[i] > min[i];
  return true;
}

/** 保持役に載せる切り替え。既定は載せる（2026-10-07 の利用者の決定）。AGENT_HOST_CLAUDE_HOLDER=off で載せない（戻し道） */
export const heldEnabled = (env = process.env) => String(bootEnv('AGENT_HOST_CLAUDE_HOLDER') ?? env.AGENT_HOST_CLAUDE_HOLDER ?? '').trim().toLowerCase() !== 'off';

/** CLI の --version の出力から版を取り出す（"2.1.284 (Claude Code)"） */
export const parseCliVersion = text => /^\s*v?(\d+\.\d+\.\d+)\b/.exec(String(text ?? ''))?.[1] ?? null;

/**
 * 保持役に起こさせるコマンド。保持役は command と args を解釈せず shell: false で起こすので、ここで直に起こせる形にする。
 * npm の包み（claude.cmd）は中身のネイティブの bin/claude.exe に解く（cmd.exe を木に挟まない。.cmd は shell 無しでは EINVAL）。
 * 解けない .cmd は null（載せない）。SDK が JS の CLI を node で起こす形（command が "node"）は、このプロセスの node にする
 */
export function heldCommand({ command, args = [] }, { platform = process.platform, execPath = process.execPath } = {}) {
  if (/^node(\.exe)?$/i.test(String(command))) return { command: execPath, args };
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(String(command))) {
    const dir = path.dirname(command);
    // 全体に入れた包み（<prefix>/claude.cmd）と、手元に入れた包み（<prefix>/node_modules/.bin/claude.cmd）
    for (const pkg of [path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code'), path.join(dir, '..', '@anthropic-ai', 'claude-code')]) {
      try {
        const meta = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));
        const bin = typeof meta.bin === 'string' ? meta.bin : meta.bin?.claude;
        for (const exe of [bin && path.resolve(pkg, bin), path.join(pkg, 'bin', 'claude.exe')]) {
          if (exe && /\.exe$/i.test(exe) && statSync(exe).isFile()) return { command: path.resolve(exe), args };
        }
      } catch { /* 次の置き場 */ }
    }
    return null;
  }
  return { command, args };
}

/** SDK に渡す CLI（pathToClaudeCodeExecutable）を、保持役に起こさせる形にする。JS の CLI は node で起こす（SDK と同じ） */
const commandOf = exe => /\.[cm]?js$/i.test(exe) ? heldCommand({ command: 'node', args: [exe] }) : heldCommand({ command: exe });

// CLI の版。実体（パス・更新時刻・大きさ）ごとに 1 回だけ --version を聞く（claude update で変わる）
const versions = new Map();
export function cliVersion(exe, { run = askVersion } = {}) {
  let key;
  try { const st = statSync(exe); key = `${exe}|${st.mtimeMs}|${st.size}`; } catch { return Promise.resolve(null); }
  if (!versions.has(key)) {
    if (versions.size >= 8) versions.delete(versions.keys().next().value);
    versions.set(key, Promise.resolve().then(() => run(exe)).catch(() => null));
  }
  return versions.get(key);
}
function askVersion(exe) {
  const target = commandOf(exe);
  if (!target) return null;
  return new Promise(resolve => execFile(target.command, [...target.args, '--version'], { timeout: 10_000, windowsHide: true },
    (error, stdout) => resolve(error ? null : parseCliVersion(stdout))));
}

/**
 * このターンの CLI を保持役に載せるか。載せるなら { client }（保持役への共有の口。core/holder/link.mjs）、載せないなら null。
 * 圧縮・bot のターンは付け直さない（core/server.mjs の restoreTurn）ので載せない。保持役を起こせない（抜け道の無い Job など）ときも載せない
 */
export async function heldPlan({ dataDir, executable, compact = false, bot = false, log = console.error } = {}) {
  if (!heldEnabled() || compact || bot) return null;
  const root = bootEnv('AGENT_HOST_RUNTIME_ROOT');
  if (!dataDir || !root || !executable || !commandOf(executable)) return null;
  const version = await cliVersion(executable);
  if (!heldVersionOk(version)) return null;
  try {
    return { client: await holderLink({ dataDir, root, key: bootEnv('AGENT_HOST_RUNTIME_KEY') ?? '' }), version };
  } catch (error) {
    // i18n-ignore: サーバーのログ（log は console.error）
    log('  保持役につなげないので、Claude の CLI を今の形で起こす:', String(error?.code ?? error?.message ?? error));
    return null;
  }
}

const parse = line => { try { const value = JSON.parse(line); return value && typeof value === 'object' ? value : null; } catch { return null; } };

/**
 * 保持役の子を SDK の CLI に見せる口。spawnClaudeCodeProcess（SDK の options に渡す）・ack(uuid)・handOff（旧サーバーの手を離す口）と、
 * 子の終わり（exited）・片付け（finish）を持つ。
 *   mode 'spawn'  SDK が起こすときに保持役へ spawn させ、印（turn）を置く。client が要る
 *   mode 'adopt'  付け直す子（source は core/adopt.mjs の holderSource。redelivered: true で作る）の、from からの続きを SDK へ流す
 * onSpawn は spawn を送った直後に呼ぶ（札の最初の置き直し）
 */
export function createHeldCli({ mode, client = null, source = null, from = 1, onSpawn = () => {} }) {
  const seqOf = new Map();   // uuid -> 通番（SDK へ流した行のうち uuid を持つもの。ack すると前の分を捨てる）
  let detached = false, handedOff = false, exited = null, muted = false;
  let resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  let proc = null;

  const remember = (seq, line) => {
    const uuid = parse(line)?.uuid;
    if (typeof uuid === 'string' && !seqOf.has(uuid)) seqOf.set(uuid, seq);
  };
  /** 付け直しで流さない行（attach の答えの時点までの、答え済みの依頼と旧い親への応答） */
  const stale = (seq, line) => {
    const attached = source.attachedState;
    if (mode !== 'adopt' || !attached || seq > attached.seq) return false;
    const m = parse(line);
    if (m?.type === 'control_response') return true;
    return m?.type === 'control_request' && !(attached.pendingRequests ?? []).some(p => p.requestId === m.request_id);
  };

  async function pump(stdout, stderr) {
    let code = null, signal = null;
    try {
      for await (const item of source.attach(from)) {
        if (item.exit) {
          if (item.exit.handedOff) handedOff = true;
          code = item.exit.code ?? null; signal = item.exit.signal ?? null;
          break;
        }
        if (!item.redelivered) {
          if (stale(item.seq, item.line)) continue;
          remember(item.seq, item.line);
        }
        stdout.write(`${item.line}\n`);
      }
    } catch (error) {
      console.error('  保持役の Claude の CLI の読みが切れた:', String(error?.message ?? error));
    }
    exited = { code, signal, handedOff };
    if (proc) { proc.exitCode = code; proc.signalCode = signal; }
    stdout.end();
    stderr.end();
    resolveExit(exited);
    // SDK は stdout を読み終えてから exit を見る（ChildProcess と同じ順）
    setImmediate(() => proc?.emit('exit', code, signal));
  }

  const spawnClaudeCodeProcess = options => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc = new EventEmitter();
    if (mode === 'spawn') {
      const target = heldCommand(options);
      if (!target) throw new Error('claude: the CLI cannot be started by the holder');
      const id = `claude-${crypto.randomUUID().slice(0, 8)}`;
      // 出来事の購読は spawn より前。spawn と印は、SDK の最初の stdin の書き込み（initialize）より前（design.md §4.4）
      source = holderSource(client, { id, acked: 0, seq: 0, marks: { [ADOPT_TURN_MARK]: 1 } }, { spawned: true });
      client.spawn({ id, command: target.command, args: target.args, cwd: options.cwd, env: options.env, policy: 'claude-control' });
      client.mark(id, ADOPT_TURN_MARK);
      onSpawn(source);
    }
    const onErr = frame => { if (frame.id === source.id && !detached) stderr.write(String(frame.chunk ?? '')); };
    source.client.on('err', onErr);
    exit.then(() => source.client.off('err', onErr));
    const stdin = new Writable({
      write(chunk, _encoding, callback) { if (!detached && !muted) source.write(chunk.toString('utf8')); callback(); },
      final(callback) { if (!detached) source.client.end(source.id); callback(); },
    });
    Object.assign(proc, { stdin, stdout, stderr, killed: false, exitCode: null, signalCode: null });
    proc.kill = () => {
      proc.killed = true;
      if (!detached && !exited) source.client.kill(source.id, { tree: true });
      return true;
    };
    void pump(stdout, stderr);
    return proc;
  };

  return {
    spawnClaudeCodeProcess,
    get source() { return source; },
    get id() { return source?.id ?? null; },
    get handedOff() { return handedOff; },
    get detached() { return detached; },
    /** 子が終わった（または手を離した）ときの { code, signal, handedOff } */
    exit,
    /** ループで処理し終えた SDK のメッセージの uuid。その行までを ack する */
    ack(uuid) {
      const seq = typeof uuid === 'string' ? seqOf.get(uuid) : undefined;
      if (seq === undefined) return;
      for (const [key, value] of seqOf) { if (value > seq) break; seqOf.delete(key); }
      source.ack(seq);
    },
    /**
     * 旧サーバーの手を離す口: 札（handOffTurn の card）を子に置き、保持役に detach する（答えが来た時点で、この親からの write は転送されない）。
     * その後に読みを止める。query を閉じるのは呼び出し側（detach → close の順。design.md §4.4）
     */
    async handOff(card) {
      if (!source) throw new Error('claude: the CLI has not been started');
      source.client.label(source.id, card);
      await source.client.detach(source.id);
      detached = true;
      source.stop();
    },
    /** ターンの終わりの片付け。子が終わっていれば記録を捨て（release）、終わっていなければ木ごと止めてから捨てる。手を離した子には触れない */
    async finish({ waitMs = 5000 } = {}) {
      if (!source) return;
      if (!handedOff && !detached) {
        if (!exited) source.client.kill(source.id, { tree: true });
        const done = await Promise.race([exit, new Promise(resolve => setTimeout(resolve, waitMs, null).unref?.())]);
        if (done && !done.handedOff) source.release();
      }
      source.dispose();
    },
    /** テスト用: 子への書き込み（承認の答え・hooks・MCP の応答・途中送信）を止める／戻す。止めている間の書き込みは捨てる */
    mute(flag) { muted = Boolean(flag); },
    get muted() { return muted; },
  };
}
