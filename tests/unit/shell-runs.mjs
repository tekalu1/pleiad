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
    // 本物の Claude の transcript は、shouldQuery: false の行を `\n` でつないだ 1 行（2026-09-28 に確認）
    const joined = runs.decorate(classifySystemMessages([{ role: 'user', text: lines.join('\n'), uuid: 'u1' }]), store.data.s1, HOST);
    t.ok('つながった 1 行で残っても、終了コードを付ける', joined.length === 1 && joined[0].exitCode === 3 && joined[0].stdout.includes('hi'), JSON.stringify(joined));
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
    await until(() => store.data.s3?.shellPending?.length === 1);
    await runs.switched('s3', HOST, { id: 'fake', capabilities: { shell: 'host' } });
    t.ok('ホストで走らせるエージェントどうしの切り替えでは、未送の追記を次のターンで渡す', store.data.s3.shellPending.length === 1);
    await runs.switched('s3', HOST, { id: 'codex', capabilities: { shell: 'native' } });
    t.ok('渡す口の違うエージェントに替えたら、未送の追記は捨てる', (store.data.s3?.shellPending ?? []).length === 0);
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
  // 本物の Codex（codex-cli 0.156.1、2026-09-28 に確認）: command はシェルに包んだ形。止めた分は exitCode -1 と定型の文
  {
    const ps = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command';
    const item = (id, command, extra) => ({ type: 'commandExecution', id, command, cwd: '/w', source: 'userShell', status: 'completed', exitCode: 0, aggregatedOutput: 'x', ...extra });
    const messages = threadToMessages({ turns: [{ id: 'tn1', startedAt: 1, items: [
      item('c1', `${ps} 'echo hello-codex'`),
      item('c2', `${ps} "echo \\"it's ok\\" 'a\\"b' "'$HOME'`),
      item('c3', "/bin/bash -lc 'git log --oneline | head -3'"),
      item('c4', `${ps} 'sleep 30'`, { status: 'failed', exitCode: -1, aggregatedOutput: 'command aborted by user' }),
      item('c5', 'something odd', { commandActions: [{ type: 'unknown', command: 'odd' }] }),
    ] }] }).filter(m => m.kind === 'shell');
    t.ok('Codex: 包んだ command を人が打った形に戻す', messages[0].command === 'echo hello-codex' && messages[0].text === '! echo hello-codex'
      && messages[1].command === `echo "it's ok" 'a"b' $HOME` && messages[2].command === 'git log --oneline | head -3', JSON.stringify(messages.map(m => m.command)));
    t.ok('Codex: 戻せない形は commandActions が 1 つならその command', messages[4].command === 'odd');
    t.ok('Codex: 止めた分は「止めました」（終了コード・定型の文を出さない）', messages[3].stopped === true && messages[3].exitCode === null && messages[3].stdout === null, JSON.stringify(messages[3]));
  }

  // ---- 行ごとの「渡さない」（ADR 0055）: 走っている間・終わった後に切り替える・渡す行から外す・渡さないまま残す
  {
    const store = fakeStore();
    const events = [];
    const runs = createShellRuns({ store, emit: (e) => events.push(e) });
    const cwd = process.cwd();
    await runs.start({ sessionId: 'k1', runId: 'run-skip-01', command: 'echo held; sleep 1', cwd, backend: HOST });
    await until(() => events.some(e => e.type === 'shell.output' && e.runId === 'run-skip-01'));
    const r1 = await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: true, backend: HOST });
    t.ok('走っている間に「渡さない」にできる', r1.skip === true && events.some(e => e.type === 'shell.skip' && e.runId === 'run-skip-01' && e.skip === true && e.sessionId === 'k1'));
    t.ok('走っている行の開き直しにも「渡さない」が出る', runs.rows('k1', store.data.k1).find(r => r.runId === 'run-skip-01')?.skip === true);
    await until(() => store.data.k1?.shellPending?.length === 1);
    t.ok('走っている間に選んだ「渡さない」が、終わった結果に残る', store.data.k1.shellPending[0].skip === true);
    await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: false, backend: HOST });
    t.ok('終わった後に「渡す」へ戻せる', !store.data.k1.shellPending[0].skip && events.filter(e => e.type === 'shell.skip').at(-1).skip === false);
    await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: true, backend: HOST });
    t.ok('渡す前なら何度でも切り替えられる', store.data.k1.shellPending[0].skip === true && runs.rows('k1', store.data.k1)[0].skip === true);

    await runs.start({ sessionId: 'k1', runId: 'run-give-01', command: 'echo given', cwd, backend: HOST });
    await until(() => store.data.k1?.shellPending?.length === 2);
    const handoff = await runs.appendsFor('k1');
    t.ok('「渡さない」の行は次のターンで渡す行から外れる', handoff.ids.join() === 'run-give-01' && handoff.skipped.join() === 'run-skip-01'
      && handoff.lines.length === 2 && !handoff.lines.some(l => l.includes('held')), JSON.stringify(handoff));
    const handing = await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: false, backend: HOST }).then(() => null, e => e.code);
    t.ok('渡しかけている間は切り替えない', handing === 'SHELL_HANDING');
    runs.release('k1', handoff);
    await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: true, backend: HOST });
    t.ok('渡らずに終わったら、また切り替えられる', store.data.k1.shellPending.find(e => e.runId === 'run-skip-01').skip === true);

    const again = await runs.appendsFor('k1');
    await runs.delivered('k1', again.ids, again.skipped);
    const handed = events.filter(e => e.type === 'shell.handed').at(-1);
    t.ok('次の発言が渡ったら、渡した行と渡さなかった行を分けて知らせる', handed.runIds.join() === 'run-give-01' && handed.keptIds.join() === 'run-skip-01', JSON.stringify(handed));
    t.ok('渡さなかった行は未送の追記から外し、残す行（shellKept）へ移す', !store.data.k1.shellPending.length
      && store.data.k1.shellKept.length === 1 && store.data.k1.shellKept[0].runId === 'run-skip-01' && !('skip' in store.data.k1.shellKept[0]) && store.data.k1.shellKept[0].stdout.includes('held'));
    t.ok('渡さなかった行の終了コードは shellExits に控えない（記録に無いので照らす先が無い）', Object.keys(store.data.k1.shellExits ?? {}).length === 1);
    const late = await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: false, backend: HOST }).then(() => null, e => e.code);
    t.ok('渡した後（渡さないで送った後）は切り替えない', late === 'SHELL_HANDED');

    // 開き直し: 走らせた時刻の後の最初の人の発言の前に差す
    const at = Date.parse(store.data.k1.shellKept[0].at);
    const iso = (ms) => new Date(ms).toISOString();
    const history = [{ role: 'user', text: 'before', at: iso(at - 5000) }, { role: 'assistant', text: 'a', at: iso(at - 4000) },
      { role: 'user', kind: 'shell', command: 'echo given', at: iso(at + 1000) }, { role: 'user', text: 'after', at: iso(at + 2000) }, { role: 'assistant', text: 'b', at: iso(at + 3000) }];
    const placed = runs.placeKept(history, store.data.k1);
    const idx = placed.findIndex(m => m.kept);
    t.ok('開き直すと、渡さなかった行を次の人の発言の前に「渡していない」で出す', placed.length === 6 && idx === 3 && placed[4].text === 'after'
      && placed[idx].kind === 'shell' && placed[idx].command === 'echo held; sleep 1' && placed[idx].pending === undefined && placed[idx].runId === 'run-skip-01', JSON.stringify(placed.map(m => [m.text, m.kept])));
    t.ok('後に人の発言が無ければ末尾に出す', runs.placeKept(history.slice(0, 2), store.data.k1).at(-1)?.kept === true);

    // 上限: 残す行は 20 まで・出力は 32KB まで
    const many = Array.from({ length: 25 }, (_, i) => ({ runId: `run-many-${String(i).padStart(2, '0')}`, command: `c${i}`, at: iso(at + i), backend: 'claude',
      stdout: i === 24 ? 'x'.repeat(40 * 1024) : 'o', stderr: '', exitCode: 0, skip: true }));
    store.data.k2 = { shellPending: many };
    const h2 = await runs.appendsFor('k2');
    await runs.delivered('k2', h2.ids, h2.skipped);
    t.ok('渡さなかった行は会話ごとに 20 まで残す（古いものから捨てる）', store.data.k2.shellKept.length === 20 && store.data.k2.shellKept[0].runId === 'run-many-05');
    t.ok('渡さなかった行の出力は 32KB まで残し、省いた印を付ける', store.data.k2.shellKept.at(-1).stdout.length === 32 * 1024 && store.data.k2.shellKept.at(-1).truncated === true);

    // 切り替えで渡せなくなったとき: 渡さない行は残し、それ以外は捨てる
    store.data.k3 = { shellPending: [{ ...many[0], runId: 'run-k3-skip-1' }, { ...many[1], runId: 'run-k3-give-1', skip: undefined }] };
    await runs.switched('k3', HOST, { id: 'codex', capabilities: { shell: 'native' } });
    t.ok('渡す口の違うエージェントに替えても、渡さない行は残す', !store.data.k3.shellPending.length && store.data.k3.shellKept.map(e => e.runId).join() === 'run-k3-skip-1');

    const native = { id: 'codex', capabilities: { shell: 'native' } };
    const refused = await runs.setSkip({ sessionId: 'k1', runId: 'run-skip-01', skip: true, backend: native }).then(() => null, e => e.code);
    t.ok('エージェントが走らせる会話（Codex）では断る', refused === 'SHELL_UNAVAILABLE');
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

      // 「渡さない」の行（ADR 0055）は Claude に渡らない
      const store = fakeStore();
      store.data.c1 = { shellPending: [
        { runId: 'run-claude-skip', command: 'cat secret.txt', stdout: 'SECRET', stderr: '', exitCode: 0, at: new Date().toISOString(), backend: 'claude', skip: true },
        { runId: 'run-claude-give', command: 'git status', stdout: 'clean', stderr: '', exitCode: 0, at: new Date().toISOString(), backend: 'claude' },
      ] };
      const runs = createShellRuns({ store, emit: () => {} });
      const handoff = await runs.appendsFor('c1');
      frames.length = 0;
      await claude.runTurn({ prompt: 'next', sessionId: null, cwd: process.cwd(), mode: 'default', emit: () => {}, askPermission: async () => ({ allow: true }),
        signal: new AbortController(), control: {}, hostSessionId: 'host-shell-skip', shellAppends: handoff.lines }).catch(() => {});
      await until(() => frames.length >= 3, 3000);
      const sent = frames.map(f => String(f.message?.content ?? ''));
      t.ok('Claude: 「渡さない」の行は渡さず、ほかの行と発言だけを渡す', frames.length === 3 && sent[0] === '<bash-input>git status</bash-input>'
        && sent[2] === 'next' && !sent.some(text => text.includes('secret') || text.includes('SECRET')), JSON.stringify(sent));
    } finally { restore(); }
  }
}
