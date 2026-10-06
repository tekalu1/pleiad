// 実機 10（と plan.md 1-7 のハーネス 1・4 の実機版）: main だけを止めても、サーバーとターンが残り、起動し直した main が付け直す。
//   node scripts/zero-downtime/stage1-7/s4-main-down.mjs [--out temporary/zd17/s4]
// 1. fake の 90 秒のターンを走らせたまま main（試験用のアプリの main の 1 プロセス）を止める → サーバーは生き残り、ターンは進む
// 2. main が居ない間: computer use のターンは「止めた（stopped / update）」で返る・秘密の保存（savePlyMcp）は待たされる
// 3. main を起動し直す → 同じサーバーに付け直す（同じ pid）・待たされていた秘密の保存が通る・ターンは最後まで終わる
// 4. 作業が 0 件で main を止め直し、アンインストールしても（実行場所は $INSTDIR の外）サーバーは止まらず、約 3 分で自分で終わる（孤児の見張り）
import fs from 'node:fs';
import path from 'node:path';
import { BUILDS, FAKE_TURN, ZD, Timeline, bootApp, copyLogs, freshInstall, isAlive, killMain, mainPids, paths, processesUnder, readControl, readJson, sleep, uninstall, waitFor, wsOpenServer } from './zd.mjs';

const arg = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const out = path.resolve(arg('--out') || path.join(BUILDS, 's4'));
const tl = new Timeline();
const result = { checks: [] };
const check = (label, ok, detail) => { result.checks.push({ label, ok: Boolean(ok), detail }); tl.mark(`${ok ? 'OK ' : 'NG '} ${label}`, detail ?? ''); };

await freshInstall({ variant: 'A', feed: 'B', tl });
try {
  const app = await bootApp(tl, { page: false });
  const s1 = app.control;
  const s1proc = processesUnder([paths.runtime]).find(p => p.pid === s1.pid);
  check('サーバーは実行場所の pleiad-node.exe で走っている', s1proc && /pleiad-node\.exe$/i.test(s1proc.path), s1proc);
  const client = await wsOpenServer(s1);
  const events = [];
  client.ws.on('message', raw => { try { const m = JSON.parse(raw.toString()); if (m.kind === 'event') events.push({ at: Date.now(), ...m.event }); } catch { /* 無視 */ } });
  const cwd = path.join(ZD.home, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const mark = client.mark();
  void client.cmd('runTurn', { backend: 'fake', cwd, prompt: FAKE_TURN(90000) }).catch(() => {});
  const session = await client.waitFor(e => e.type === 'session' && e.sessionId, { from: mark, ms: 20000 });
  const sessionId = session.sessionId;
  tl.mark('turn started', { sessionId });
  await sleep(5000);

  // 1. main を止める
  killMain(app.mainPid);
  await waitFor(() => !mainPids().includes(app.mainPid), { ms: 15000, what: 'main gone' });
  await sleep(2000);
  check('main を止めてもサーバーは生きている（同じ pid・control.json がある）', isAlive(s1.pid) && readControl()?.pid === s1.pid, { pid: s1.pid });
  check('ターンの接続は切れていない（サーバーが動き続けている）', client.ws.readyState === 1, client.ws.readyState);

  // 2. main が居ない間
  const away = Date.now();
  const listed = await client.cmd('listPlyMcp', {}).catch(() => null);
  const saved = client.cmd('savePlyMcp', { name: 'zdsecret', mode: 'add', revision: listed?.revision, value: { command: 'node', args: [], env: { ZD_TOKEN: 'zdtest-secret-value' } } })
    .then(value => ({ ok: true, ms: Date.now() - away, value }), error => ({ ok: false, ms: Date.now() - away, error: error.message }));
  const markC = client.mark();
  const computer = await client.runTurn({ backend: 'fake', cwd, prompt: 'computer:[{"name":"screenshot","arguments":{"title":"zd"}}]' }, { ms: 60000 }).catch(error => ({ error: error.message }));
  const toolResult = client.since(markC).find(e => e.type === 'tool.result' && e.computer);
  check('main が居ない間の computer use は「止めた」（stopped / update）で返り、ターンは止まらない', toolResult?.computer?.state === 'stopped' && toolResult.computer.reason === 'update', toolResult?.computer ?? computer);
  await sleep(8000);
  const pendingSave = await Promise.race([saved, sleep(100).then(() => null)]);
  check('居ない間の秘密の保存は待たされている（まだ返らない）', pendingSave === null, pendingSave);

  // 3. main を起動し直す
  const second = await bootApp(tl, { page: false });
  check('起動し直した main は同じサーバーに付け直した（pid・origin が同じ）', second.control.pid === s1.pid && second.control.origin === s1.origin, { pid: second.control.pid });
  const savedResult = await Promise.race([saved, sleep(30000).then(() => ({ timeout: true }))]);
  check('待たされていた秘密の保存が、付け直した main で通る', savedResult.ok === true, { ms: savedResult.ms, error: savedResult.error });
  const secrets = readJson(path.join(paths.data, 'mcp-secrets.json'));
  const text = secrets ? JSON.stringify(secrets) : '';
  check('秘密は safeStorage で暗号化されて保存された（平文が無い）', text.length > 0 && !text.includes('zdtest-secret-value'), { keys: secrets ? Object.keys(secrets) : null, enc: /safeStorage/i.test(text) });
  const end = await client.waitFor(e => e.type === 'turnEnd' && e.sessionId === sessionId, { from: mark, ms: 120000 }).catch(error => ({ error: error.message }));
  const turnResult = events.find(e => e.type === 'turnResult' && e.sessionId === sessionId);
  check('main が居なかったターンは、最後まで終わった（中断されていない）', !end.error && turnResult && !/interrupt|abort/i.test(JSON.stringify(turnResult.outcome)), turnResult ?? end);
  await client.cmd('deletePlyMcp', { name: 'zdsecret' }).catch(() => {});

  // 4. 作業が 0 件で main を止め直し、アンインストール
  const idleAt = Date.now();
  killMain(second.mainPid);
  await waitFor(() => !mainPids().includes(second.mainPid), { ms: 15000, what: 'main gone 2' });
  tl.mark('main stopped with no work; uninstalling');
  const uninstallMs = uninstall();
  tl.mark('uninstalled', `${uninstallMs} ms`);
  check('アンインストールしてもサーバー（実行場所）は止まらない', isAlive(s1.pid) && !fs.existsSync(path.join(ZD.installDir, ZD.exe)), { alive: isAlive(s1.pid), installDirLeft: fs.existsSync(ZD.installDir) });
  await waitFor(() => !isAlive(s1.pid), { ms: 300000, every: 2000, what: 'orphan guard exit' });
  const afterSeconds = (Date.now() - idleAt) / 1000;
  tl.mark('server exited by itself', `${afterSeconds.toFixed(0)}s after main stopped`);
  check('作業が 0 件のまま約 3 分で、サーバーが自分で終わる（孤児の見張り）', afterSeconds > 150 && afterSeconds < 260 && !readControl(), { afterSeconds: Math.round(afterSeconds), control: Boolean(readControl()) });
  client.close();
} finally {
  result.timeline = tl.lines;
  copyLogs(out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
}
const failed = result.checks.filter(c => !c.ok);
console.log(`\nRESULT ${result.checks.length - failed.length}/${result.checks.length} ok`, failed.map(c => c.label));
process.exit(failed.length ? 1 : 0);
