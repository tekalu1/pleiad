// 入力欄の `!`（シェルの行）で走らせたコマンドの管理（ADR 0054、docs/multi-backend.md「シェルの行」）。
//
// - 走らせ方はバックエンドの capabilities.shell で決まる
//   - 'host'   … Pleiad がホストのシェルで走らせ（core/host-shell.mjs）、結果を会話の「未送の追記」（sessions.json の shellPending）に貯める。
//                次のターンの始めにエージェントへ渡す（Claude は shouldQuery: false の 2 行）。渡したら終了コードを shellExits に控える
//   - 'native' … エージェントが走らせる（Codex の thread/shellCommand）。記録もエージェントの会話に残る
//   - 無し     … 使えない（Antigravity）
// - エージェントは返答しない。送信待ち（outbox）にも送り直しの控え（receipts）にも積まない。同じ runId は 2 度走らせない
// - 'host' の会話では、行ごとに「渡さない」を選べる（ADR 0055）。渡さなかった行は次の発言の後、sessions.json の shellKept に移して会話に残す
// - 出来事: shell.start / shell.output / shell.done / shell.skip / shell.handed（全部の接続へ）
import { messageShellKey, runHostShell, shellKey, shellLines } from './host-shell.mjs';

export const SHELL_TIMEOUT_MS = 10 * 60 * 1000;
/** 控えておく終了コードの数（会話ごと。古いものから捨てる） */
const EXITS_KEEP = 200;
/** 渡さなかった行を残す数（会話ごと。古いものから捨てる。ADR 0055） */
const KEPT_KEEP = 20;
/** 渡さなかった行に残す出力（stdout・stderr それぞれ）。越えた分は捨て、truncated を立てる */
const KEPT_OUTPUT_MAX = 32 * 1024;
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
  const closing = new Map();       // runId -> 終わって未送の追記に書くまでの分（この間の「渡さない」も拾う）
  const claims = new Map();        // sessionId -> 渡しかけの分 { ids, skipped }（appendsFor から delivered / release まで。この間は切り替えない）
  const finished = new Map();      // runId -> 終わった結果 { exitCode, stdout, stderr, … }（wait で待つ AI の呼び出しへ返す。新しい FINISHED_KEEP 件だけ）
  const FINISHED_KEEP = 50;

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
    const run = { sessionId, runId, command, cwd, at: new Date().toISOString(), backend: backend.id, mode, stdout: '', stderr: '', skip: false, ac: new AbortController() };
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
    run.done = Promise.resolve(work).then(result => finish(run, result), error => finish(run, { error: String(error?.message ?? error), exitCode: null }));
    return { runId };
  }

  async function finish(run, result) {
    closing.set(run.runId, run);
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
      // 走っている間に切り替えた「渡さない」は、書き込みの鎖の中で読む（切り替えも同じ鎖に並ぶ）
      await serial(run.sessionId, async () => {
        run.finishing = true;
        const entry = { runId: run.runId, command: run.command, cwd: run.cwd, at: run.at, backend: run.backend, stdout, stderr, ...done, ...(run.skip ? { skip: true } : {}) };
        const list = (await store.get(run.sessionId)).shellPending ?? [];
        await store.setSessionData(run.sessionId, 'shellPending', [...list, entry]);
      }).finally(() => closing.delete(run.runId)).catch(e => console.error('shell: 結果を控えられなかった:', e?.message ?? e));
    } else if (run.mode === 'native' && !done.error) {
      if (!nativeDone.has(run.sessionId)) nativeDone.set(run.sessionId, new Set());
      nativeDone.get(run.sessionId).add(run.runId);
    }
    closing.delete(run.runId);
    finished.set(run.runId, { ...done, stdout, stderr });
    if (finished.size > FINISHED_KEEP) finished.delete(finished.keys().next().value);
    emit({ type: 'shell.done', sessionId: run.sessionId, runId: run.runId, ...done,
      ...(run.mode === 'native' ? { stdout, stderr: null } : {}) });
  }

  /** 終わるまで最長 ms 待って結果を返す（shell.run の AI の呼び出し。ADR 0105）。待ちきれなければ null（走り続ける）。知らない runId も null */
  async function wait(runId, ms) {
    const run = runs.get(runId);
    if (run && !finished.has(runId)) {
      let timer;
      await Promise.race([run.done, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => clearTimeout(timer));
    }
    return finished.get(runId) ?? null;
  }

  /** 止める。止めた分の結果は「止めました」とそれまでの出力で残る */
  function stop(runId) {
    const run = runs.get(runId);
    if (!run) return false;
    run.ac.abort();
    return true;
  }
  /**
   * 行を次の発言で渡すか（'host' の会話だけ。ADR 0055）。走っている間も、終わって未送の追記にある間も切り替えられる。
   * 次の発言と一緒に渡しかけている間（appendsFor から delivered まで）と、もう渡した行は切り替えない
   */
  async function setSkip({ sessionId, runId, skip, backend }) {
    if (shellMode(backend) !== 'host') throw Object.assign(new Error('shell skip unavailable'), { code: 'SHELL_UNAVAILABLE' });
    const want = Boolean(skip);
    const found = await serial(sessionId, async () => {
      const claim = claims.get(sessionId);
      if (claim && (claim.ids.includes(runId) || claim.skipped.includes(runId))) return 'handing';
      const run = runs.get(runId) ?? closing.get(runId);
      if (run?.sessionId === sessionId && !run.finishing) { run.skip = want; return 'ok'; }
      const list = (await store.get(sessionId)).shellPending ?? [];
      if (!list.some(e => e.runId === runId)) return 'gone';
      await store.setSessionData(sessionId, 'shellPending', list.map(e => {
        if (e.runId !== runId) return e;
        const { skip: _, ...rest } = e;
        return want ? { ...rest, skip: true } : rest;
      }));
      return 'ok';
    });
    if (found === 'handing') throw Object.assign(new Error('shell handing'), { code: 'SHELL_HANDING' });
    if (found === 'gone') throw Object.assign(new Error('shell handed'), { code: 'SHELL_HANDED' });
    emit({ type: 'shell.skip', sessionId, runId, skip: want });
    return { runId, skip: want };
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
  /** この会話で走っている分 */
  const runningIn = (sessionId) => [...runs.values()].some(r => r.sessionId === sessionId);
  /** 走っているシェルの作業ディレクトリ（分けた作業場所を消してよいかの確かめに使う。ADR 0089） */
  const cwds = () => [...runs.values()].map(r => r.cwd).filter(Boolean);
  /**
   * この会話で走っている分が全部終わるまで待つ。'native'（Codex）の会話で次のターンを始める前に使う。
   * Codex は `!` のターンの間に来た turn/start の発言を同じターンに入れ、モデルを呼ばずに閉じる（codex-cli 0.156.1 で確認）
   */
  async function settled(sessionId, signal = null) {
    while (!signal?.aborted) {
      const pending = [...runs.values()].filter(r => r.sessionId === sessionId).map(r => r.done);
      if (!pending.length) return;
      await Promise.race([Promise.allSettled(pending), new Promise(resolve => signal?.addEventListener?.('abort', resolve, { once: true }))]);
    }
  }

  /**
   * 次のターンで渡す 2 行ずつ（'host' の会話）。渡った合図を受けたら delivered(sessionId, ids, skipped) で片付ける。
   * 渡らずに終わったら release(sessionId, handoff) で切り替えられる状態に戻す。
   * 走っている分はまだ渡さない（終わってから次のターンで）。「渡さない」の分（skipped）は渡さず、渡った後に残す行へ移す
   */
  async function appendsFor(sessionId) {
    if (!sessionId) return { ids: [], skipped: [], lines: [] };
    return serial(sessionId, async () => {
      const list = (await store.get(sessionId)).shellPending ?? [];
      const give = list.filter(e => !e.skip);
      const handoff = { ids: give.map(e => e.runId), skipped: list.filter(e => e.skip).map(e => e.runId), lines: give.flatMap(e => shellLines(e)) };
      if (list.length) claims.set(sessionId, handoff);
      return handoff;
    });
  }
  /** 渡しかけた分が渡らずに終わった（ターンの失敗・送り直し）。未送の追記はそのまま、切り替えられる状態に戻す */
  function release(sessionId, handoff) {
    if (claims.get(sessionId) === handoff) claims.delete(sessionId);
  }

  /**
   * 次の発言がエージェントに渡った。'host' の分は未送の追記から外して終了コードを控え、'native' の分と合わせて「渡した」を出す。
   * 「渡さない」の分は、渡さないまま会話に残す行（shellKept）へ移す（ADR 0055）
   * @param ids appendsFor が返した runId（'host' の会話）。省けば 'native' の分だけ
   * @param skipped appendsFor が返した「渡さない」の runId
   */
  async function delivered(sessionId, ids = [], skipped = []) {
    const handed = [...ids];
    const kept = [];
    if (ids.length || skipped.length) {
      await serial(sessionId, async () => {
        const sidecar = await store.get(sessionId);
        const list = sidecar.shellPending ?? [];
        const gone = list.filter(e => ids.includes(e.runId));
        const keep = list.filter(e => skipped.includes(e.runId));
        if (keep.length) {
          await store.setSessionData(sessionId, 'shellKept', keepRows(sidecar.shellKept, keep));
          kept.push(...keep.map(e => e.runId));
        }
        const exits = { ...(sidecar.shellExits ?? {}) };
        for (const e of gone) if (Number.isInteger(e.exitCode)) exits[shellKey(e)] = e.exitCode;
        const keys = Object.keys(exits);
        for (const key of keys.slice(0, Math.max(0, keys.length - EXITS_KEEP))) delete exits[key];
        if (gone.length) await store.setSessionData(sessionId, 'shellExits', exits);
        await store.setSessionData(sessionId, 'shellPending', list.filter(e => !ids.includes(e.runId) && !skipped.includes(e.runId)));
      }).finally(() => claims.delete(sessionId));
    }
    const native = nativeDone.get(sessionId);
    if (native?.size) { handed.push(...native); nativeDone.delete(sessionId); }
    if (handed.length || kept.length) emit({ type: 'shell.handed', sessionId, runIds: handed, ...(kept.length ? { keptIds: kept } : {}) });
  }

  /** 渡さなかった行を残す行の末尾に足す。数と出力の長さに上限を掛ける（sessions.json を膨らませない） */
  function keepRows(before, entries) {
    const cut = (text) => typeof text === 'string' && text.length > KEPT_OUTPUT_MAX ? text.slice(0, KEPT_OUTPUT_MAX) : text;
    const fresh = entries.map(({ skip: _, ...e }) => {
      const long = [e.stdout, e.stderr].some(text => typeof text === 'string' && text.length > KEPT_OUTPUT_MAX);
      return { ...e, stdout: cut(e.stdout), stderr: cut(e.stderr), ...(long ? { truncated: true } : {}) };
    });
    return [...(before ?? []), ...fresh].slice(-KEPT_KEEP);
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

  /** 渡せなくなった未送の追記を捨てる。「渡さない」の分は、渡さないまま会話に残す行へ移す */
  async function discard(sessionId) {
    nativeDone.delete(sessionId);
    const kept = [];
    await serial(sessionId, async () => {
      const sidecar = await store.get(sessionId);
      const keep = (sidecar.shellPending ?? []).filter(e => e.skip);
      if (keep.length) {
        await store.setSessionData(sessionId, 'shellKept', keepRows(sidecar.shellKept, keep));
        kept.push(...keep.map(e => e.runId));
      }
      await store.setSessionData(sessionId, 'shellPending', []);
    });
    if (kept.length) emit({ type: 'shell.handed', sessionId, runIds: [], keptIds: kept });
  }

  /**
   * 開き直した会話の末尾に足す行（NormalizedMessage の形。kind: 'shell'）。
   * まだ渡していない分（pending）と、いま走っている分（running）
   */
  function rows(sessionId, sidecar) {
    const pending = (sidecar?.shellPending ?? []).map(e => ({ ...entryRow(e), pending: true, ...(e.skip ? { skip: true } : {}) }));
    const running = [...runs.values()].filter(r => r.sessionId === sessionId).map(r => ({ role: 'user', kind: 'shell', text: `! ${r.command}`,
      command: r.command, stdout: r.stdout || null, stderr: r.stderr || null, at: r.at, backend: r.backend, runId: r.runId, pending: true, running: true,
      ...(r.skip ? { skip: true } : {}) }));
    return [...pending, ...running];
  }
  const entryRow = (e) => ({ role: 'user', kind: 'shell', text: `! ${e.command}`, command: e.command,
    stdout: e.stdout || null, stderr: e.stderr || null, exitCode: e.exitCode ?? null, stopped: e.stopped || undefined, timedOut: e.timedOut || undefined,
    truncated: e.truncated || undefined, at: e.at, backend: e.backend, runId: e.runId });

  /**
   * 渡さなかった行（shellKept）を履歴の中に差す（ADR 0055）。走らせた時刻より後の最初の人の発言の前（渡した行が並ぶ場所と同じ）。
   * 後に人の発言が無ければ末尾
   */
  function placeKept(messages, sidecar) {
    const kept = sidecar?.shellKept ?? [];
    if (!kept.length || !Array.isArray(messages)) return messages;
    const time = (at) => typeof at === 'number' ? at : Date.parse(at ?? '');
    const out = [...messages];
    for (const e of [...kept].sort((a, b) => time(a.at) - time(b.at))) {
      const at = time(e.at);
      let i = out.findIndex(m => m?.role === 'user' && !m.kind && time(m.at) > at);
      if (i < 0) i = out.length;
      out.splice(i, 0, { ...entryRow(e), kept: true });
    }
    return out;
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

  return { start, wait, stop, setSkip, stopSession, stopAll, runningIn, cwds, settled, appendsFor, release, delivered, switched, discard, rows, placeKept, decorate, running: () => runs.size };
}
