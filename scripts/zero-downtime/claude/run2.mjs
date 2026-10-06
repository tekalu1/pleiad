// 段階 2-0（頭の測定）: 段階 0 で測っていない場面の最中に、同じ CLI に query を作り直して付け直す。LLM は haiku で最小限。
// 使い方: node scripts/zero-downtime/claude/run2.mjs <scenario> [key=value ...]
//   subagent [bg=1|perm=1] サブエージェントが Bash を走らせている最中に付け直す（bg=1 は裏のサブエージェント。親のターンが終わった後。perm=1 はサブエージェントの中の承認待ち）
//   bgcmd                  裏のコマンド（Bash の run_in_background）が走っている間に付け直す
//   steer [cancel=1]       途中送信（uuid 付き・priority next）を流し込んで、折り込まれる前に付け直す。cancel=1 は新しい親が interrupt({cancelQueued}) で取り消す
//   compact [hook=1]       /compact の最中（hook=1 は PreCompact のコールバックの最中）に付け直す。skipCtl=1 は答え済みの control_request を流し直さない
//   elicit [redeliver=1]   stdio の MCP の elicitation に親が答える前に付け直す
//   dialog [redeliver=1]   supportedDialogKinds に mcp_elicitation を宣言し、request_user_dialog で来るかと、その最中の付け直し
//   dialog-kinds [ask=1]   CLI の中にある dialog_kind を全部宣言し、承認（ask=1 は AskUserQuestion）が request_user_dialog で来るか
//   oauth [redeliver=1]    getOAuthToken を渡し、偽のトークンで oauth_token_refresh を起こす。その最中の付け直し
//   options [snap=0]       Pleiad の実際のオプション（プリセット + append・settingSources・skills・フラグ設定）で付け直し、2 回目の initialize の値が効くか
//   npm                    npm で入れた claude（claude.cmd）を保持役に起こさせ、承認待ちの最中に付け直す
//   stdio-mcp [inflight=1] CLI の子の stdio MCP（probe-mcp.mjs）の状態が付け直しの後も残るか（inflight=1 は呼び出しの最中）
//   compat [del=1]         互換の接続先（fake-api.mjs）で、ツールの最中に付け直す。del=1 は付け直しの間にフラグ設定のファイルを消す
//                          touch=1 はその後プロジェクトの設定を書き直す・again=1 は付け直した後にもう 1 ターン・noflag=1 は対照（フラグ設定なし）
//   bigout bytes=N mode=direct|holder|reattach  数 MB の本文を流したときの遅さ（fake-api.mjs。LLM の費用なし）
// R15（Pleiad のサーバーが起こす外部の stdio MCP）は s-r15-stdio-mcp.mjs。記録を短く並べるのは brief2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRun, coverage, here, repoRoot, sleep } from './harness.mjs';

const [scenario, ...kv] = process.argv.slice(2);
const opt = Object.fromEntries(kv.map(s => s.split('=')));
const run = await createRun(scenario, opt);
const { log } = run;
const wait = 150_000;
const gap = Number(opt.gap ?? 1500);
const resultOf = p => p.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
const nthResult = (p, n, ms = wait) => p.waitFor(() => p.results().length >= n, ms).then(() => p.results()[n - 1] ?? null);

/** p1 を殺し、アプリが処理し終えた最後の行の次から p2 を付ける */
// skipCtl=1: 流し直す位置を「最初の親に届いた最後の行の次」にする（uuid の無い control_request を新しい親へ流し直さない）
async function swap(p1, over, { absent = 300 } = {}) {
  p1.kill();
  await sleep(200);
  const from = (opt.skipCtl === '1' ? p1.lastPushSeq() : p1.lastMsgSeq()) + 1;
  log(`p${p1.n} killed; attach from ${from} after ${absent} ms`);
  await sleep(absent);
  return startSecond({ from, ...over });
}
const startSecond = over => run.startParent({ role: 'second', exitAfterResult: true, ...over });

const P = {
  subagent: 'Use the Agent tool exactly once with subagent_type "general-purpose", run_in_background set to false (wait for it in the foreground), and this prompt: "Use the Bash tool in the foreground (do not set run_in_background) to run exactly: sleep 15 && echo SUB_MARK. Then reply with the single word SUB_DONE." After the agent returns, reply with the single word DONE.',
  subagentPerm: 'Use the Agent tool exactly once with subagent_type "general-purpose", run_in_background set to false (wait for it in the foreground), and this prompt: "Use the Bash tool in the foreground to run exactly: touch SUB_PERM.txt && echo SUB_MARK. Then reply with the single word SUB_DONE." After the agent returns, reply with the single word DONE.',
  subagentBg: 'Use the Agent tool exactly once with subagent_type "general-purpose", run_in_background set to true, and this prompt: "Use the Bash tool to run exactly: sleep 20 && echo SUB_MARK. Then reply with the single word SUB_DONE." Then reply with the single word STARTED. Later, when you are notified that the agent finished, reply with the single word FINISHED.',
  bgcmd: 'Use the Bash tool with run_in_background set to true to run exactly: sleep 15 && echo BG_MARK. Then reply with the single word STARTED. Later, when you are notified that the command finished, reply with the single word FINISHED.',
  steerTool: 'Use the Bash tool to run exactly: sleep 10 && echo TOOL_MARK. Then reply with the single word DONE.',
  one: 'Reply with the single word ONE.',
  ask: 'Call the tool mcp__probe__ask exactly once. Then reply with exactly the text the tool returned.',
  counter: 'Call the tool mcp__probe__counter exactly once. Then reply with exactly the text the tool returned.',
  slow: 'Call the tool mcp__probe__slow exactly once with seconds 15. Then reply with exactly the text the tool returned.',
  codeword: 'What is the CODEWORD written in your system prompt? Reply with the codeword only.',
  perm: 'Use the Bash tool to run exactly this command: touch PERM_MARK.txt && echo REINIT_OK. Then reply with the single word DONE.',
};

if (scenario === 'subagent') {
  const bg = opt.bg === '1';
  // perm=1: サブエージェントの中の Bash の承認を、最初の親が答えないまま付け直す
  const perm = opt.perm === '1';
  const tools = ['Bash', 'Agent'];
  const mode1 = perm ? { hangPermission: true } : { bypass: true };
  const mode2 = perm ? { allowDelayMs: 300 } : { bypass: true };
  const p1 = run.startParent({ role: 'first', prompt: bg ? P.subagentBg : perm ? P.subagentPerm : P.subagent, ...mode1, tools, replay: true });
  // サブエージェントの中の Bash の tool_use（parent_tool_use_id 付き）。bg は親のターンの result の後
  const hit = await p1.waitFor(e => e.ev === 'msg' && e.type === 'assistant' && e.ptu && (e.blocks ?? []).some(b => b.tool_use === 'Bash'), wait);
  log('p1 subagent bash seen', JSON.stringify(hit?.blocks));
  if (bg) await resultOf(p1);
  if (perm) log('p1 canUseTool', JSON.stringify(await p1.waitFor(e => e.ev === 'canUseTool', wait)));
  await sleep(gap);
  // 最後の返答（DONE / FINISHED）まで入力を閉じない（途中の result は裏の作業を待つ合間に出る）
  const p2 = await swap(p1, { ...mode2, tools, replay: true, exitAfterResult: false });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result' && /DONE|FINISHED/.test(e.result ?? ''), wait);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await run.finish({ cover: await coverage(run, [p1, p2]) });
}

if (scenario === 'bgcmd') {
  const p1 = run.startParent({ role: 'first', prompt: P.bgcmd, bypass: true, replay: true });
  const r1 = await resultOf(p1);
  log('p1 first result', JSON.stringify(r1?.result));
  await sleep(gap);
  const p2 = await swap(p1, { bypass: true, replay: true, exitAfterResult: false });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p2 result', JSON.stringify(r));
  await sleep(2000);
  await run.finish({ cover: await coverage(run, [p1, p2]) });
}

if (scenario === 'steer') {
  const p1 = run.startParent({ role: 'first', prompt: P.steerTool, bypass: true, replay: true, steer: { text: 'Also append the word PINEAPPLE to your final reply.', onToolUse: true, delayMs: 500 } });
  const s = await p1.waitFor(e => e.ev === 'steer.push', wait);
  log('p1 steer pushed', JSON.stringify(s));
  await sleep(gap);
  const cancel = opt.cancel === '1';
  const p2 = await swap(p1, { bypass: true, replay: true, ...(cancel ? { interruptAfterMs: 1500, cancelQueued: true } : {}) });
  const r = await resultOf(p2);
  log('p2 result', JSON.stringify(r), 'interrupt', JSON.stringify(p2.events.filter(e => e.ev.startsWith('interrupt'))));
  await sleep(1500);
  await run.finish({ steerUuid: s?.uuid, cover: await coverage(run, [p1, p2]) });
}

if (scenario === 'compact') {
  const hook = opt.hook === '1';
  const p1 = run.startParent({ role: 'first', prompt: P.one, bypass: true, compactHookDelayMs: hook ? 30_000 : 0, pushes: [{ afterResults: 1, text: '/compact' }] });
  const pushed = await p1.waitFor(e => e.ev === 'push.input', wait);
  if (hook) { const h = await p1.waitFor(e => e.ev === 'hook.precompact.start', wait); log('p1 precompact hook started', JSON.stringify(h)); }
  await sleep(hook ? gap : Number(opt.gap ?? 2500));
  log('p1 pushed /compact at', pushed?.ms);
  const p2 = await swap(p1, { bypass: true, compactHookDelayMs: 0, exitAfterResult: false });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', wait);
  log('p2 result', JSON.stringify(r));
  await sleep(2000);
  await run.finish({ cover: await coverage(run, [p1, p2]), boundary: [p1, p2].map(p => p.events.filter(e => e.ev === 'msg' && e.subtype === 'compact_boundary').length) });
}

if (scenario === 'elicit' || scenario === 'dialog') {
  const dialog = scenario === 'dialog';
  const common = { bypass: true, probeMcp: true };
  const p1 = run.startParent({ role: 'first', prompt: P.ask, ...common, elicit: 'hang', ...(dialog ? { dialog: { kinds: ['mcp_elicitation'], mode: 'hang' } } : {}) });
  const hit = await p1.waitFor(e => e.ev === 'elicitation' || e.ev === 'userDialog', wait);
  log('p1 got', JSON.stringify(hit));
  if (!hit) await run.finish({ error: 'no elicitation/userDialog in p1' });
  await sleep(gap);
  const p2 = await swap(p1, { ...common, redeliver: opt.redeliver === '1', elicit: 'accept', ...(dialog ? { dialog: { kinds: ['mcp_elicitation'], mode: 'answer', answer: { behavior: 'cancelled' } } } : {}) });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', Number(opt.waitMs ?? 60_000));
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await run.finish({ cover: await coverage(run, [p1, p2]) });
}

// dialog-kinds: CLI 2.1.284 の中にある dialog_kind を全部宣言し、承認（Bash の touch）と AskUserQuestion で request_user_dialog が来るか（来たら付け直す）
if (scenario === 'dialog-kinds') {
  const kinds = ['permission_bash', 'permission_powershell', 'permission_prompt', 'permission_file', 'permission_ask_user_question', 'permission_skill', 'permission_webfetch', 'permission_monitor', 'permission_workflow', 'permission_enter_plan_mode', 'mcp_elicitation', 'refusal_fallback_prompt', 'local_jsx'];
  const ask = opt.ask === '1';
  const prompt = ask ? 'Use the AskUserQuestion tool once to ask me which color I like, with the options red and blue. Then reply with my answer only.' : P.perm;
  const p1 = run.startParent({ role: 'first', prompt, tools: ask ? ['AskUserQuestion'] : ['Bash'], hangPermission: true, dialog: { kinds, mode: 'hang' } });
  const hit = await p1.waitFor(e => e.ev === 'canUseTool' || e.ev === 'userDialog' || (e.ev === 'msg' && e.type === 'result'), 90_000);
  log('p1 got', JSON.stringify(hit));
  if (hit?.ev !== 'userDialog') { await sleep(500); await run.finish({ note: 'no request_user_dialog' }); }
  await sleep(gap);
  const p2 = await swap(p1, { tools: ask ? ['AskUserQuestion'] : ['Bash'], allowDelayMs: 300, dialog: { kinds, mode: 'answer', answer: { behavior: 'cancelled' } }, redeliver: opt.redeliver === '1' });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', 60_000);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await run.finish({});
}

if (scenario === 'oauth') {
  const envOver = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-zdu-probe-invalid-token', ANTHROPIC_API_KEY: '' };
  const p1 = run.startParent({ role: 'first', prompt: P.one, bypass: true, oauth: 'hang', envOver });
  const hit = await p1.waitFor(e => e.ev === 'oauthRefresh' || (e.ev === 'msg' && e.type === 'result'), 90_000);
  log('p1 got', JSON.stringify(hit));
  if (!hit || hit.ev !== 'oauthRefresh') { await sleep(1000); await run.finish({ note: 'no oauth_token_refresh before result' }); }
  await sleep(gap);
  const p2 = await swap(p1, { bypass: true, oauth: 'null', envOver, redeliver: opt.redeliver === '1' });
  const r = await p2.waitFor(e => e.ev === 'msg' && e.type === 'result', 60_000);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await run.finish({});
}

if (scenario === 'options') {
  // 2 回目の initialize で送り直す値（systemPrompt の append・skills）を、最初の query と変える
  // snap=0: bot の会話と同じく systemPrompt の snapshot: false（毎ターン組み直す）
  const snap = opt.snap === '0' ? { snapshot: false } : {};
  const p1 = run.startParent({ role: 'first', prompt: P.codeword, pleiad: true, bypass: true, append: 'CODEWORD=ALPHA. You are a test fixture. Be terse.', initInfo: true, ...snap });
  const r1 = await resultOf(p1);
  log('p1 result', JSON.stringify(r1?.result));
  await sleep(500);
  const p2 = await swap(p1, { pleiad: true, bypass: true, append: 'CODEWORD=BRAVO. You are a test fixture. Be terse.', skills: [], initInfo: true, ...snap, prompt: P.codeword, promptDelayMs: 1500 }, {});
  const r2 = await resultOf(p2);
  log('p2 result', JSON.stringify(r2?.result));
  await sleep(1500);
  const inits = [p1, p2].map(p => p.events.filter(e => e.ev === 'init.result' || (e.ev === 'msg' && e.subtype === 'init')).map(e => ({ ev: e.ev, skills: e.skills, slash: e.slash, plugins: e.plugins, mcp: e.mcp?.map(m => `${m.name}:${m.status}`), commands: e.commands, keys: e.keys, hooksApplied: e.hooksApplied, model: e.model })));
  await run.finish({ inits });
}

if (scenario === 'npm') {
  const claudeBin = path.join(repoRoot, 'temporary', 'npm-claude', 'node_modules', '.bin', 'claude.cmd');
  const p1 = run.startParent({ role: 'first', prompt: P.perm, hangPermission: true, claudeBin });
  const hit = await p1.waitFor(e => e.ev === 'canUseTool', wait);
  log('p1 canUseTool', JSON.stringify(hit), 'spawn', JSON.stringify(p1.events.find(e => e.ev === 'spawn.options')));
  if (!hit) await run.finish({ error: 'no canUseTool in p1' });
  await sleep(gap);
  const p2 = await swap(p1, { allowDelayMs: 300, claudeBin });
  const r = await resultOf(p2);
  log('p2 result', JSON.stringify(r));
  await sleep(1500);
  await run.finish({ spawn: p1.events.find(e => e.ev === 'spawn.options') });
}

if (scenario === 'stdio-mcp') {
  const inflight = opt.inflight === '1';
  const p1 = run.startParent({ role: 'first', prompt: inflight ? P.slow : P.counter, bypass: true, probeMcp: true });
  if (inflight) { for (let i = 0; i < 300 && !run.probeEvents().some(e => e.ev === 'slow.start'); i++) await sleep(300); log('probe slow started'); }
  else { const r1 = await resultOf(p1); log('p1 result', JSON.stringify(r1?.result)); }
  await sleep(gap);
  const p2 = await swap(p1, { bypass: true, probeMcp: true, ...(inflight ? {} : { prompt: P.counter, promptDelayMs: 1500 }) });
  const r2 = await resultOf(p2);
  log('p2 result', JSON.stringify(r2?.result));
  await sleep(1500);
  await run.finish({ cover: await coverage(run, [p1, p2]) });
}

if (scenario === 'compat' || scenario === 'bigout') {
  const { writeClaudeFlagSettings } = await import('../../../core/compat-endpoints.mjs');
  const portA = 18000 + (process.pid % 1000), portB = portA + 1000;
  const apiLog = path.join(run.runDir, 'fake-api.jsonl');
  const bytes = Number(opt.bytes ?? 64);
  const fakeEnv = { ...process.env, FAKE_BYTES: String(scenario === 'bigout' ? bytes : 64), ...(scenario === 'compat' ? { FAKE_TOOL: 'sleep 8 && echo COMPAT_TOOL_MARK' } : {}) };
  const servers = [['A', portA], ['B', portB]].map(([tag, port]) => spawn(process.execPath, [path.join(here, 'fake-api.mjs'), String(port), tag, apiLog], { env: fakeEnv, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true }));
  await Promise.all(servers.map(s => new Promise(r => s.stdout.once('data', r))));
  const endpoint = { id: 'zdu-fake', baseUrl: `http://127.0.0.1:${portA}`, auth: 'x-api-key', key: 'fake-key', roles: { main: 'fake-model' }, options: {} };
  const flag = await writeClaudeFlagSettings(run.runDir, endpoint, { disableAllHooks: true });
  // プロジェクトの settings.local.json は別の接続先（B）を指す。フラグ設定が効いている間は A が勝つ
  fs.mkdirSync(path.join(run.workDir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(run.workDir, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${portB}` } }));
  // noflag=1 は対照（フラグ設定を渡さない。プロジェクトの B が勝つかを見る）
  const common = { pleiad: true, compat: endpoint, settingsFile: opt.noflag === '1' ? null : flag.file, bypass: true, model: null, append: 'Be terse.' };
  const apiEvents = () => { try { return fs.readFileSync(apiLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const stop = async extra => { for (const s of servers) s.kill(); await flag.dispose(); await run.finish({ api: apiEvents().map(e => `${e.tag}:${e.path}:${e.model}:${e.lastIsToolResult ? 'after-tool' : e.useTool ? 'tool' : 'text'}`), ...extra }); };

  if (scenario === 'compat') {
    const p1 = run.startParent({ role: 'first', prompt: 'Run the probe.', ...common });
    const hit = await p1.waitFor(e => e.ev === 'msg' && e.type === 'assistant' && (e.blocks ?? []).some(b => b.tool_use === 'Bash'), wait);
    log('p1 tool_use', JSON.stringify(hit?.blocks));
    await sleep(gap);
    p1.kill();
    if (opt.del === '1') { fs.rmSync(flag.file, { force: true }); log('flag settings file deleted'); }
    // touch=1: 消した後にプロジェクトの settings.local.json を書き直す（CLI が設定を読み直す合図）
    if (opt.touch === '1') { await sleep(500); fs.writeFileSync(path.join(run.workDir, '.claude', 'settings.local.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${portB}` } }, null, 1)); log('project settings rewritten'); }
    await sleep(300);
    const from = p1.lastMsgSeq() + 1;
    // again=1: 付け直した後にもう 1 ターン回す（消したファイルが次のターンで効くか）
    const again = opt.again === '1';
    const p2 = startSecond({ from, ...common, ...(again ? { pushes: [{ afterResults: 1, text: 'Run the probe again.', delayMs: 1500 }], resultsToExit: 2 } : {}) });
    const r = again ? await nthResult(p2, 2) : await resultOf(p2);
    log('p2 result', JSON.stringify(r?.result));
    await sleep(1000);
    await stop({ flagDeleted: opt.del === '1' });
  }

  if (scenario === 'bigout') {
    const mode = opt.mode ?? 'holder';
    const quiet = { quietStream: mode !== 'reattach', quietPush: true };
    const t = Date.now();
    const p1 = run.startParent({ role: 'first', prompt: 'Write it.', ...common, ...quiet, ...(mode === 'direct' ? { direct: true } : {}), exitAfterResult: mode !== 'reattach' });
    let p2 = null;
    if (mode === 'reattach') {
      await p1.waitFor(() => p1.events.filter(e => e.ev === 'msg' && e.type === 'stream_event').length >= Number(opt.killAfter ?? 300), wait);
      p2 = await swap(p1, { ...common, quietStream: true, quietPush: true }, { absent: Number(opt.absent ?? 300) });
    }
    const last = p2 ?? p1;
    const r = await resultOf(last);
    const elapsed = Date.now() - t;
    const info = await run.info();
    log('result', JSON.stringify({ ms: r?.ms, resultLen: r?.resultLen, streams: r?.streams, firstStream: r?.firstStream, lastStream: r?.lastStream }), 'elapsed', elapsed, 'holder rss', info?.mem?.rss);
    await sleep(500);
    await stop({ bigout: { mode, bytes, elapsed, result: r && { ms: r.ms, resultLen: r.resultLen, streams: r.streams, firstStream: r.firstStream, lastStream: r.lastStream }, holderRss: info?.mem?.rss, holderHeap: info?.mem?.heapUsed, p1Start: p1.events.find(e => e.ev === 'query.created')?.ms } });
  }
}

log('unknown scenario');
process.exit(1);
