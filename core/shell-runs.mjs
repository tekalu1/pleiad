// 入力欄の `!`（シェルの行）で走らせたコマンドの管理（ADR 0054、docs/multi-backend.md「シェルの行」）。
//
// - 走らせ方はバックエンドの capabilities.shell で決まる
//   - 'host'   … Pleiad がホストのシェルで走らせ（core/host-shell.mjs）、結果を会話の「未送の追記」（sessions.json の shellPending）に貯める。
//                次のターンの始めにエージェントへ渡す（Claude は shouldQuery: false の 2 行）。渡したら終了コードを shellExits に控える
//   - 'native' … エージェントが走らせる（Codex の thread/shellCommand）。記録もエージェントの会話に残る
//   - 無し     … 使えない（Antigravity）
// - エージェントは返答しない。送信待ち（outbox）にも送り直しの控え（receipts）にも積まない。同じ runId は 2 度走らせない
// - 出来事: shell.start / shell.output / shell.done / shell.handed（全部の接続へ）
import { messageShellKey, runHostShell, shellKey, shellLines } from './host-shell.mjs';

export const SHELL_TIMEOUT_MS = 10 * 60 * 1000;
/** 控えておく終了コードの数（会話ごと。古いものから捨てる） */
const EXITS_KEEP = 200;
/** runId の形（画面が振る）。これ以外は断る */
const RUN_ID = /^[a-zA-Z0-9-]{8,80}$/;

export const shellMode = (backend) => {
  const mode = backend?.capabilities?.shell;
  return mode === 'host' || mode === 'native' ? mode : null;
};

/**
 * @param store core/store.mjs（get / setSessionData）
 * @param emit 出来事を全部の接続へ流す（server の emitGlobal）
 * @param timeoutMs 上限。既定 10 分（AGENT_HOST_SHELL_TIMEOUT_MS で短くできる。テスト用）
 */
export function createShellRuns({ store, emit, timeoutMs = Number(process.env.AGENT_HOST_SHELL_TIMEOUT_MS) || SHELL_TIMEOUT_MS, runHost = runHostShell }) {
  const runs = new Map();          // runId -> 走っている分 { sessionId, runId, command, cwd, at, backend, stdout, stderr, ac, mode }
  const nativeDone = new Map();    // sessionId -> Set<runId>  エージェントが走らせて終わった分（次の発言で「渡した」にする）
  const seen = new Set();          // 受け付けた runId（同じコマンドを 2 度走らせない。プロセスの寿命だけ）
  const writes = new Map();        // sessionId -> 書き込みの鎖（shellPending の読み書きを並べる）

  const serial = (sessionId, work) => {
    const next = (writes.get(sessionId) ?? Promise.resolve()).then(work, work);
    writes.set(sessionId, next.catch(() => {}));
    return next;
  };

  async function start({ sessionId, runId, command, cwd, backend }) {
    const mode = shellMode(backend);
    if (!mode) throw Object.assign(new Error('shell unavailable'), { code: 'SHELL_UNAVAILABLE' });
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw Object.assign(new Error('invalid runId'), { code: 'SHELL_INVALID' });
    if (typeof command !== 'string' || !command.trim()) throw Object.assign(new Error('empty command'), { code: 'SHELL_INVALID' });
    // 送り直された同じ runId は走らせない（つながり直しの再送で 2 回走る事故を防ぐ）
    if (seen.has(runId)) return { runId, duplicate: true };
    seen.add(runId);
    const run = { sessionId, runId, command, cwd, at: new Date().toISOString(), backend: backend.id, mode, stdout: '', stderr: '', ac: new AbortController() };
    runs.set(runId, run);
    emit({ type: 'shell.start', sessionId, runId, command, cwd, at: run.at, backend: backend.id, mode });
    const onOutput = (stream, text) => {
      if (!text) return;
      run[stream] += text;
      emit({ type: 'shell.output', sessionId, runId, stream, text });
    };
    const work = mode === 'host'
      ? runHost({ command, cwd, timeoutMs, signal: run.ac.signal, onOutput })
      : backend.shell({ sessionId, command, cwd, timeoutMs, signal: run.ac.signal, onOutput });
    void Promise.resolve(work).then(result => finish(run, result), error => finish(run, { error: String(error?.message ?? error), exitCode: null }));
    return { runId };
  }

  async function finish(run, result) {
    runs.delete(run.runId);
    const stdout = run.mode === 'native' ? (result?.output ?? run.stdout) : result?.stdout ?? run.stdout;
    const stderr = run.mode === 'native' ? null : result?.stderr ?? run.stderr;
    const done = {
      exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : null,
      durationMs: Number.isFinite(result?.durationMs) ? result.durationMs : Date.now() - Date.parse(run.at),
      truncated: Boolean(result?.truncated), timedOut: Boolean(result?.timedOut), stopped: Boolean(result?.stopped),
      ...(result?.timedOut ? { timeoutMs } : {}),
      ...(result?.startError || result?.error ? { error: String(result.startError ?? result.error) } : {}),
    };
    if (run.mode === 'host' && !done.error) {
      const entry = { runId: run.runId, command: run.command, cwd: run.cwd, at: run.at, backend: run.backend, stdout, stderr, ...done };
      await serial(run.sessionId, async () => {
        const list = (await store.get(run.sessionId)).shellPending ?? [];
        await store.setSessionData(run.sessionId, 'shellPending', [...list, entry]);
      }).catch(e => console.error('shell: 結果を控えられなかった:', e?.message ?? e));
    } else if (run.mode === 'native' && !done.error) {
      if (!nativeDone.has(run.sessionId)) nativeDone.set(run.sessionId, new Set());
      nativeDone.get(run.sessionId).add(run.runId);
    }
    emit({ type: 'shell.done', sessionId: run.sessionId, runId: run.runId, ...done,
      ...(run.mode === 'native' ? { stdout, stderr: null } : {}) });
  }

  /** 止める。止めた分の結果は「止めました」とそれまでの出力で残る */
  function stop(runId) {
    const run = runs.get(runId);
    if (!run) return false;
    run.ac.abort();
    return true;
  }
  /** 会話の分を全部止める（エージェントの切り替え・会話の削除） */
  function stopSession(sessionId) {
    let n = 0;
    for (const run of runs.values()) if (run.sessionId === sessionId) { run.ac.abort(); n++; }
    return n;
  }
  /** 全部止める（サーバーの終わり） */
  function stopAll() {
    for (const run of runs.values()) run.ac.abort();
  }

  /**
   * 次のターンで渡す 2 行ずつ（'host' の会話）。渡った合図を受けたら delivered(sessionId, ids) で片付ける。
   * 走っている分はまだ渡さない（終わってから次のターンで）
   */
  async function appendsFor(sessionId) {
    const list = sessionId ? (await store.get(sessionId)).shellPending ?? [] : [];
    return { ids: list.map(e => e.runId), lines: list.flatMap(e => shellLines(e)) };
  }

  /**
   * 次の発言がエージェントに渡った。'host' の分は未送の追記から外して終了コードを控え、'native' の分と合わせて「渡した」を出す
   * @param ids appendsFor が返した runId（'host' の会話）。省けば 'native' の分だけ
   */
  async function delivered(sessionId, ids = []) {
    const handed = [...ids];
    if (ids.length) {
      await serial(sessionId, async () => {
        const sidecar = await store.get(sessionId);
        const list = sidecar.shellPending ?? [];
        const gone = list.filter(e => ids.includes(e.runId));
        const exits = { ...(sidecar.shellExits ?? {}) };
        for (const e of gone) if (Number.isInteger(e.exitCode)) exits[shellKey(e)] = e.exitCode;
        const keys = Object.keys(exits);
        for (const key of keys.slice(0, Math.max(0, keys.length - EXITS_KEEP))) delete exits[key];
        await store.setSessionData(sessionId, 'shellExits', exits);
        await store.setSessionData(sessionId, 'shellPending', list.filter(e => !ids.includes(e.runId)));
      });
    }
    const native = nativeDone.get(sessionId);
    if (native?.size) { handed.push(...native); nativeDone.delete(sessionId); }
    if (handed.length) emit({ type: 'shell.handed', sessionId, runIds: handed });
  }

  /**
   * 会話のエージェントを替えた（切り替え・予約した設定の適用）。走っている分は止める。
   * 渡していない追記は、替えた先もホストで走らせる形なら次のターンで渡し、そうでなければ捨てる（渡す口が無い）
   */
  async function switched(sessionId, from, to) {
    stopSession(sessionId);
    nativeDone.delete(sessionId);
    if (!(shellMode(from) === 'host' && shellMode(to) === 'host')) await discard(sessionId);
  }

  /** 渡せなくなった未送の追記を捨てる */
  async function discard(sessionId) {
    nativeDone.delete(sessionId);
    await serial(sessionId, () => store.setSessionData(sessionId, 'shellPending', []));
  }

  /**
   * 開き直した会話の末尾に足す行（NormalizedMessage の形。kind: 'shell'）。
   * まだ渡していない分（pending）と、いま走っている分（running）
   */
  function rows(sessionId, sidecar) {
    const pending = (sidecar?.shellPending ?? []).map(e => ({ role: 'user', kind: 'shell', text: `! ${e.command}`, command: e.command,
      stdout: e.stdout || null, stderr: e.stderr || null, exitCode: e.exitCode ?? null, stopped: e.stopped || undefined, timedOut: e.timedOut || undefined,
      at: e.at, backend: e.backend, runId: e.runId, pending: true }));
    const running = [...runs.values()].filter(r => r.sessionId === sessionId).map(r => ({ role: 'user', kind: 'shell', text: `! ${r.command}`,
      command: r.command, stdout: r.stdout || null, stderr: r.stderr || null, at: r.at, backend: r.backend, runId: r.runId, pending: true, running: true }));
    return [...pending, ...running];
  }

  /**
   * 履歴の `!` の行を整える。
   * - Pleiad が走らせた分の終了コードを付ける（Claude の記録には残らない。shellExits で照らす）
   * - エージェントが走らせる会話（'native'）では、最後の人の発言より後の行はまだ渡っていない（pending）。次の発言のターンで履歴として読まれる
   */
  function decorate(messages, sidecar, backend = null) {
    if (!Array.isArray(messages)) return messages;
    const exits = sidecar?.shellExits ?? null;
    let out = exits ? messages.map(m => {
      if (m?.kind !== 'shell' || Number.isInteger(m.exitCode)) return m;
      const code = exits[messageShellKey(m)];
      return Number.isInteger(code) ? { ...m, exitCode: code } : m;
    }) : messages;
    if (shellMode(backend) === 'native') {
      out = [...out];
      for (let i = out.length - 1; i >= 0 && !(out[i]?.role === 'user' && !out[i].kind); i--) {
        if (out[i]?.kind === 'shell') out[i] = { ...out[i], pending: true };
      }
    }
    return out;
  }

  return { start, stop, stopSession, stopAll, appendsFor, delivered, switched, discard, rows, decorate, running: () => runs.size };
}
