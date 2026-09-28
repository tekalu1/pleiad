// 入力欄の `!`（シェルの行。core/shell-runs.mjs・core/host-shell.mjs、ADR 0054）。LLM は呼ばない。
//   - ホストで走らせる: 出力を流す・終了コード・止める・上限（短くして試す）・同じ runId は 2 度走らせない
//   - 渡し方: 次のターンで CLI の `!` と同じ 2 行を渡す（Claude は shouldQuery: false）。渡したら終了コードを控え、開き直した履歴に付ける
//   - エージェントが走らせる会話（Codex）: 履歴の userShell を kind: 'shell' に、最後の人の発言より後は「まだ渡していない」
import { createShellRuns } from '../../core/shell-runs.mjs';
import { shellLines, shellKey } from '../../core/host-shell.mjs';
import { classifySystemMessages } from '../../core/system-messages.mjs';
import { threadToMessages } from '../../core/backends/codex.mjs';
import { backend as claude, setClaudeSdkForTest } from '../../core/backends/claude.mjs';

export const name = 'shell-runs';
export const title = '入力欄の `!`: ホストで走らせる・止める・上限・渡し方（Claude の shouldQuery: false）・Codex の userShell の履歴';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { for (let t = 0; t < ms && !fn(); t += 20) await sleep(20); return fn(); };

function fakeStore() {
  const data = {};
  return {
    data,
    get: async (id) => structuredClone(data[id] ?? {}),
    setSessionData: async (id, field, value) => { data[id] = { ...(data[id] ?? {}), [field]: structuredClone(value) }; },
  };
}
const HOST = { id: 'claude', capabilities: { shell: 'host' } };

export default async function (t) {
  // ---- ホストで走らせる: 出力・終了コード・未送の追記
  {
    const store = fakeStore();
    const events = [];
    const runs = createShellRuns({ store, emit: (e) => events.push(e) });
    const cwd = process.cwd();
    const r = await runs.start({ sessionId: 's1', runId: 'run-0001', command: 'echo hi; echo oops 1>&2; exit 3', cwd, backend: HOST });
    t.ok('走り出したらすぐ返す（終わりを待たない）', r.runId === 'run-0001' && events[0]?.type === 'shell.start' && events[0].command.startsWith('echo hi'));
    await until(() => events.some(e => e.type === 'shell.done'));
    const done = events.find(e => e.type === 'shell.done');
    t.ok('終了コードを出す', done?.exitCode === 3, JSON.stringify(done));
    const out = events.filter(e => e.type === 'shell.output');
    t.ok('stdout と stderr を分けて流す', out.some(e => e.stream === 'stdout' && e.text.includes('hi')) && out.some(e => e.stream === 'stderr' && e.text.includes('oops')), JSON.stringify(out));
    await until(() => store.data.s1?.shellPending?.length === 1);
    t.ok('結果を会話の未送の追記に控える', store.data.s1?.shellPending?.[0]?.exitCode === 3);

    const again = await runs.start({ sessionId: 's1', runId: 'run-0001', command: 'echo twice', cwd, backend: HOST });
    t.ok('同じ runId は 2 度走らせない（送り直しで 2 回走らない）', again.duplicate === true && events.filter(e => e.type === 'shell.start').length === 1);

    const rows = runs.rows('s1', store.data.s1);
    t.ok('開き直すと、まだ渡していない行を末尾に足す', rows.length === 1 && rows[0].kind === 'shell' && rows[0].pending === true && rows[0].exitCode === 3 && rows[0].stdout.includes('hi'));

    const { ids, lines } = await runs.appendsFor('s1');
    t.ok('次のターンで渡すのは CLI の `!` と同じ 2 行', ids.length === 1 && lines.length === 2
      && lines[0] === '<bash-input>echo hi; echo oops 1>&2; exit 3</bash-input>' && /^<bash-stdout>hi\s*<\/bash-stdout><bash-stderr>oops\s*<\/bash-stderr>$/.test(lines[1]), JSON.stringify(lines));
    await runs.delivered('s1', ids);
    t.ok('渡したら未送の追記から外し、「渡した」を出す', !(store.data.s1.shellPending ?? []).length && events.some(e => e.type === 'shell.handed' && e.runIds.includes('run-0001')));
    // 開き直した履歴（transcript の 2 行を読んだ形）に終了コードが付く
    const history = classifySystemMessages(lines.map(text => ({ role: 'user', text })));
    const decorated = runs.decorate(history, store.data.s1, HOST);
    t.ok('履歴の `!` の行に、控えた終了コードを付ける', decorated.length === 1 && decorated[0].kind === 'shell' && decorated[0].exitCode === 3, JSON.stringify(decorated));
    t.ok('鍵は履歴の読み方と揃う（改行・末尾の空白）', shellKey({ command: 'a', stdout: 'x\r\n', stderr: '' }) === shellKey({ command: 'a', stdout: 'x', stderr: null }));
  }

  // ---- 止める・上限
  {
    const store = fakeStore();
    const events = [];
    const runs = createShellRuns({ store, emit: (e) => events.push(e), timeoutMs: 400 });
    await runs.start({ sessionId: 's2', runId: 'run-stop-1', command: 'echo start; sleep 20', cwd: process.cwd(), backend: HOST });
    await until(() => events.some(e => e.type === 'shell.output'));
    const began = Date.now();
    t.ok('走っている分を止められる', runs.stop('run-stop-1') === true);
    await until(() => events.some(e => e.type === 'shell.done' && e.runId === 'run-stop-1'));
    const stopped = events.find(e => e.type === 'shell.done' && e.runId === 'run-stop-1');
    t.ok('止めたら「止めました」（終了コードは無い）で終わる', stopped?.stopped === true && stopped.exitCode === null && Date.now() - began < 5000, JSON.stringify(stopped));
    await until(() => store.data.s2?.shellPending?.length === 1);
    t.ok('止めた分もそれまでの出力で残る', store.data.s2.shellPending[0].stdout.includes('start'));

    await runs.start({ sessionId: 's2', runId: 'run-timeout-1', command: 'sleep 20', cwd: process.cwd(), backend: HOST });
    await until(() => events.some(e => e.type === 'shell.done' && e.runId === 'run-timeout-1'));
    const timed = events.find(e => e.type === 'shell.done' && e.runId === 'run-timeout-1');
    t.ok('上限を過ぎたら止める（テストでは 400ms）', timed?.timedOut === true && timed.timeoutMs === 400, JSON.stringify(timed));

    await runs.start({ sessionId: 's3', runId: 'run-all-1', command: 'sleep 20', cwd: process.cwd(), backend: HOST });
    t.ok('会話の分を全部止める（切り替え・削除）', runs.stopSession('s3') === 1);
    await until(() => events.some(e => e.type === 'shell.done' && e.runId === 'run-all-1'));
    await runs.discard('s3');
    t.ok('渡せなくなった未送の追記は捨てる', (store.data.s3?.shellPending ?? []).length === 0);
  }

  // ---- 使えない会話・エージェントが走らせる会話
  {
    const store = fakeStore();
    const events = [];
    const runs = createShellRuns({ store, emit: (e) => events.push(e) });
    let err = null;
    try { await runs.start({ sessionId: 's4', runId: 'run-agy-01', command: 'ls', cwd: process.cwd(), backend: { id: 'antigravity', capabilities: {} } }); } catch (e) { err = e; }
    t.ok('シェルを持たないバックエンドでは断る', err?.code === 'SHELL_UNAVAILABLE' && !events.length);

    const calls = [];
    const native = { id: 'codex', capabilities: { shell: 'native' }, async shell(args) { calls.push(args); args.onOutput('stdout', 'a\n'); return { exitCode: 1, output: 'a\nb\n', durationMs: 5 }; } };
    await runs.start({ sessionId: 's4', runId: 'run-codex-1', command: 'false', cwd: process.cwd(), backend: native });
    await until(() => events.some(e => e.type === 'shell.done'));
    const done = events.find(e => e.type === 'shell.done');
    t.ok('エージェントが走らせる会話はバックエンドの shell に任せ、上限も渡す', calls[0]?.command === 'false' && calls[0].timeoutMs === 600000 && done.exitCode === 1 && done.stdout === 'a\nb\n');
    t.ok('エージェントが走らせた分は Pleiad の追記に貯めない', !(store.data.s4?.shellPending ?? []).length);
    await runs.delivered('s4');
    t.ok('次の発言が渡ったら「渡した」を出す', events.some(e => e.type === 'shell.handed' && e.runIds.includes('run-codex-1')));
    const msgs = [{ role: 'user', text: 'q' }, { role: 'user', kind: 'shell', command: 'a' }, { role: 'assistant', text: 'x' }, { role: 'user', text: 'r' }, { role: 'user', kind: 'shell', command: 'b' }];
    const marked = runs.decorate(msgs, {}, native);
    t.ok('最後の人の発言より後の `!` だけ「まだ渡していない」', !marked[1].pending && marked[4].pending === true);
  }

  // ---- Codex の履歴: userShell は人が走らせた行、agent はツールのカード
  {
    const thread = { turns: [
      { id: 'tn1', startedAt: 1, items: [{ type: 'commandExecution', id: 'c1', command: 'git status', cwd: '/w', source: 'userShell', status: 'completed', exitCode: 128, aggregatedOutput: 'fatal: not a repo\r\n' }] },
      { id: 'tn2', startedAt: 2, items: [
        { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'どう？' }] },
        { type: 'commandExecution', id: 'c2', command: 'ls', cwd: '/w', source: 'agent', status: 'completed', exitCode: 0, aggregatedOutput: 'a' },
        { type: 'agentMessage', id: 'a1', text: 'ok' },
      ] },
    ] };
    const messages = threadToMessages(thread);
    const shell = messages.find(m => m.kind === 'shell');
    t.ok('Codex の userShell は kind: shell（終了コードつき）', shell?.role === 'user' && shell.command === 'git status' && shell.exitCode === 128 && shell.stdout === 'fatal: not a repo' && shell.stderr === null, JSON.stringify(shell));
    t.ok('エージェントの commandExecution はツールのまま', messages.some(m => m.role === 'assistant' && m.toolCalls?.some(c => c.id === 'c2')) && messages.filter(m => m.kind === 'shell').length === 1);
  }

  // ---- Claude に渡す形: shouldQuery: false の 2 行を、プロンプトの前に
  {
    const frames = [];
    const restore = setClaudeSdkForTest({
      executable: () => 'claude-fake',
      query: ({ prompt }) => {
        let ended = false, wake = null;
        (async () => { for await (const f of prompt) { frames.push(f); if (f.message?.content === 'next') { ended = true; wake?.(); } } })();
        return {
          interrupt: async () => ({}), close() {},
          async *[Symbol.asyncIterator]() {
            while (!ended) await new Promise(r => { wake = r; });
            yield { type: 'result', subtype: 'success', num_turns: 1 };
          },
        };
      },
    });
    try {
      const lines = shellLines({ command: 'git log -1', stdout: 'abc', stderr: '' });
      await claude.runTurn({ prompt: 'next', sessionId: null, cwd: process.cwd(), mode: 'default', emit: () => {}, askPermission: async () => ({ allow: true }),
        signal: new AbortController(), control: {}, hostSessionId: 'host-shell', shellAppends: lines }).catch(() => {});
      await until(() => frames.length >= 3, 3000);
      t.ok('Claude: `!` の 2 行を shouldQuery: false で、プロンプトの前に渡す', frames.length >= 3
        && frames[0].shouldQuery === false && frames[0].message.content === '<bash-input>git log -1</bash-input>'
        && frames[1].shouldQuery === false && frames[1].message.content === '<bash-stdout>abc</bash-stdout><bash-stderr></bash-stderr>'
        && frames[2].message.content === 'next' && frames[2].shouldQuery === undefined, JSON.stringify(frames.map(f => [f.message?.content, f.shouldQuery])));
    } finally { restore(); }
  }
}
