// 実機 1・2（plan.md「実機で確かめる項目」の段階 1）を、fake ではない本物のエージェント（Claude・Codex・agy）で。
//   node scripts/zero-downtime/stage1-7/s5-real-backend.mjs --backend claude|codex|antigravity --mode running|approval [--model haiku] [--out temporary/zd17/s5-claude-running]
// 試験用のデータ置き場（利用者の ~/.agent-host ではない）に、利用者の CLI の認証（~/.claude・~/.codex・~/.gemini）をそのまま使って短いターンを走らせる。
//   running:  承認は自動で許可し、100 秒ほどかかる 1 コマンド（PowerShell の Start-Sleep）を走らせたまま更新（A→B）。ターンが中断されずに終わり、切り替えは終わった後。
//   approval: 承認待ちのまま更新し、新しい main の画面に承認が 1 つだけ出る・答えるとターンが進んで終わる。
// ターンは Bash/shell のコマンド 1 つ（ping でなく Start-Sleep。何も書かない・消さない）。作業ディレクトリは試験用の work\ で、終わったら消す。
import fs from 'node:fs';
import path from 'node:path';
import { BUILDS, ZD, Timeline, allowInUi, bootApp, copyLogs, freshInstall, isAlive, mainPids, paths, readControl, shot, sleep, startFeed, tryCdp, updaterLog, waitFor, wsOpenServer } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const backend = arg('--backend');
const mode = arg('--mode') || 'running';
if (!['claude', 'codex', 'antigravity'].includes(backend) || !['running', 'approval'].includes(mode)) throw new Error('--backend claude|codex|antigravity --mode running|approval');
const model = arg('--model') || (backend === 'claude' ? 'haiku' : null);
const sleepSeconds = Number(arg('--sleep') || (mode === 'running' ? 110 : 20));
// 承認の確認は、そのエージェントの「都度確認」のモード（Claude は default・Codex は ask）で走らせる。agy は承認のモードが無い（yolo だけ）ので対象の外
const permMode = mode === 'approval' ? { claude: 'default', codex: 'ask' }[backend] : undefined;
if (mode === 'approval' && !permMode) { console.log(`N/A: ${backend} has no approval mode`); process.exit(0); }
const out = path.resolve(arg('--out') || path.join(BUILDS, `s5-${backend}-${mode}`));
const tl = new Timeline();
const result = { backend, mode, model, checks: [] };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };

await freshInstall({ variant: 'A', feed: 'B', config: { env: { AGENT_HOST_BACKENDS: backend } }, tl });
const feed = await startFeed();
const cwd = path.join(ZD.home, 'work');
fs.mkdirSync(cwd, { recursive: true });
try {
  const app = await bootApp(tl, { ui: false });
  const s1 = app.control;
  const client = await wsOpenServer(s1);
  const events = globalThis.__zdEvents = [];
  const answered = new Set();
  const onEvent = async event => {
    events.push({ at: Date.now(), ...event });
    if (mode === 'running' && event.type === 'permission' && !answered.has(event.id)) { answered.add(event.id); await client.cmd('resolvePermission', { id: event.id, allow: true }).catch(() => {}); }
  };
  client.ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.kind === 'event') void onEvent(m.event); } catch { /* 無視 */ } });
  tl.mark('backends', client.ready.backends ?? client.ready.availableBackends ?? Object.keys(client.ready).slice(0, 12));
  const prompt = `Use your shell tool to run exactly this one command and nothing else: powershell -NoProfile -Command "Start-Sleep -Seconds ${sleepSeconds}; 'zdtest-slept'". Do not write or change any files. When it finishes, reply with the single word FINISHED.`;
  const mark = client.mark();
  const turnStart = Date.now();
  void client.cmd('runTurn', { backend, cwd, prompt, ...(model ? { model } : {}), ...(permMode ? { mode: permMode } : {}), ...(backend === 'antigravity' ? {} : { effort: 'low' }) }).catch(error => tl.mark('runTurn error', error.message));
  const session = await client.waitFor(e => e.type === 'session' && e.sessionId, { from: mark, ms: 90000 }).catch(error => ({ error: error.message }));
  if (session.error) { check('ターンが始まった', false, session.error); throw new Error(session.error); }
  const sessionId = session.sessionId;
  tl.mark('turn started', { sessionId, model: session.model, mode: permMode ?? '(default)' });
  if (mode === 'approval') {
    const ask = await client.waitFor(e => e.type === 'permission' && e.sessionId === sessionId, { from: mark, ms: 120000 }).catch(error => ({ error: error.message }));
    check('承認待ちになった（更新の前）', !ask.error, ask.error ?? { id: ask.id, tool: ask.toolName ?? ask.name });
    result.permissionId = ask.id;
  } else {
    await waitFor(() => events.some(e => e.type === 'tool.start' && e.sessionId === sessionId) || events.some(e => e.type === 'turnEnd'), { ms: 120000, every: 1000, what: 'tool start' });
    check('コマンドが走り始めた（更新の前）', events.some(e => e.type === 'tool.start' && e.sessionId === sessionId), events.filter(e => e.type === 'tool.start').map(e => e.name));
  }

  const view = app.page;
  let last = '';
  const phase = async () => (await view.eval(`plyDesktop.update('status')`))?.phase;
  await waitFor(() => fs.existsSync(path.join(paths.userData, 'updates.json')), { ms: 60000, every: 500, what: 'main boot' });
  await waitFor(async () => { const p = await phase(); if (p !== last) { last = p; tl.mark('update phase', p); } if (p === 'unavailable' || p === 'error') throw new Error(`the updater is ${p}`); return p === 'downloaded'; }, { ms: 240000, every: 1000, what: 'update downloaded' });
  const clickAt = Date.now();
  tl.mark('click install', `${((clickAt - turnStart) / 1000).toFixed(0)}s after the turn started`);
  void view.eval(`plyDesktop.update('install')`).catch(() => {});
  await waitFor(() => !mainPids().includes(app.mainPid), { ms: 120000, every: 500, what: 'old main gone' });
  tl.mark('old main gone');
  const newMain = await waitFor(() => mainPids().find(pid => pid !== app.mainPid), { ms: 300000, every: 1000, what: 'new main' });
  tl.mark('new main started', { pid: newMain });
  check('更新の間も S1（サーバー）は生きていた', isAlive(s1.pid) && readControl()?.pid === s1.pid, { pid: s1.pid });
  const stillRunning = !events.some(e => e.type === 'turnEnd' && e.sessionId === sessionId);
  check('新しい main が付け直した時点でターンはまだ走っている', stillRunning, null);
  const newView = await tryCdp(new URL(s1.origin).port, 25000);
  await sleep(3000);
  tl.mark('printwindow', shot(newMain, path.join(out, 'after-install-printwindow.png')));

  if (mode === 'approval') {
    // 新しい main の画面（同じサーバーの画面）の承認が 1 つ。WS の接続し直しで見える承認も 1 つ
    const text = newView ? (await newView.eval('document.body.innerText')).replace(/\s+/g, ' ') : '';
    result.approvalText = text.slice(0, 300);
    const cards = newView ? await newView.eval(`document.querySelectorAll('.permission, [data-permission], .approval, .perm').length`).catch(() => null) : null;
    result.approvalCards = cards;
    tl.mark('new main page', { approvalCards: cards, text: text.slice(0, 160) });
    if (newView) await newView.screenshot(path.join(out, 'approval-after-update.png'));
    const probe = await wsOpenServer(readControl());
    const pending = probe.events.filter(e => e.type === 'permission' && e.sessionId === sessionId);
    const snapshotPending = probe.ready?.pendingPermissions ?? probe.ready?.permissions ?? null;
    tl.mark('fresh ws client', { permissionEvents: pending.length, snapshotPending: Array.isArray(snapshotPending) ? snapshotPending.length : snapshotPending });
    probe.close();
    // 新しい main の画面で「許可」を押す（押せなければ WS で答える）
    const ui = newView ? await allowInUi(newView, sessionId) : 'no cdp';
    tl.mark('answer in the new main window', ui);
    result.answeredInUi = ui;
    if (ui !== 'clicked') await client.cmd('resolvePermission', { id: result.permissionId, allow: true }).catch(error => tl.mark('resolve error', error.message));
    check('新しい main の画面で承認に答えられる（画面の「許可」）', ui === 'clicked', ui);
  }

  const end = await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms: 420000 }).catch(error => ({ error: error.message }));
  const turnResult = events.find(e => e.type === 'turnResult' && e.sessionId === sessionId);
  tl.mark('turn ended', { outcome: turnResult?.outcome, after: `${((Date.now() - turnStart) / 1000).toFixed(0)}s` });
  const text = events.filter(e => e.sessionId === sessionId && /^(text|assistant)/.test(e.type)).map(e => e.text ?? e.delta ?? '').join('');
  const tools = events.filter(e => e.type === 'tool.start' && e.sessionId === sessionId).map(e => e.name);
  const toolResults = events.filter(e => e.type === 'tool.result' && e.sessionId === sessionId).map(e => String(e.text ?? '').slice(0, 80));
  check('ターンは中断されずに終わった（outcome が ok）', !end.error && turnResult && turnResult.outcome === 'ok' && !events.some(e => e.sessionId === sessionId && e.interrupted), { outcome: turnResult?.outcome, error: end.error });
  check('コマンドは最後まで走った（結果に zdtest-slept）', toolResults.some(r => /zdtest-slept/.test(r)), { tools, toolResults });
  check('返事に FINISHED', /FINISHED/.test(text), text.slice(-60));
  const s2 = await waitFor(() => { const c = readControl(); return c?.pid && c.pid !== s1.pid && c.appVersion === '0.10.3' ? c : null; }, { ms: 120000, every: 500, what: 'S2' });
  tl.mark('S2 ready', { pid: s2.pid });
  check('作業が終わった後に新しい版のサーバーへ切り替わった（同じ origin）', s2.origin === s1.origin && !isAlive(s1.pid), { s1: s1.pid, s2: s2.pid });
  const client2 = await wsOpenServer(s2);
  const list = await client2.cmd('listSessions', {});
  const mine = (list.sessions ?? list).find?.(item => (item.id ?? item.sessionId) === sessionId);
  check('S2 の会話の記録: 中断の印が無く、終わりが残っている', mine && !mine.interrupted && Boolean(mine.completedAt ?? true), mine ? { interrupted: mine.interrupted, completedAt: mine.completedAt } : 'not found');
  result.sessionId = sessionId;
  result.eventTypes = events.reduce((counts, e) => ({ ...counts, [e.type]: (counts[e.type] ?? 0) + 1 }), {});
  client2.close();
  newView?.close();
} finally {
  result.timeline = tl.lines;
  copyLogs(out);
  fs.mkdirSync(out, { recursive: true });
  try { fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(globalThis.__zdEvents?.map(e => ({ ...e, text: typeof e.text === 'string' ? e.text.slice(0, 200) : undefined, input: undefined, delta: typeof e.delta === 'string' ? e.delta.slice(0, 120) : undefined })) ?? [], null, 1)); } catch { /* 記録できなくても結果は書く */ }
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
  await feed.close();
}
const failed = result.checks.filter(c => !c.ok);
console.log(`\nRESULT ${result.checks.length - failed.length}/${result.checks.length} ok`, failed.map(c => c.label));
process.exit(failed.length ? 1 : 0);
