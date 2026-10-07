// ターンの保持役の本物のプロセス（core/holder/main.mjs。無停止の更新 段階 2 の 2a）。サーバー役の身代わりが起こして終わっても保持役と子が残る・
// 秘密のファイルとログ（env・秘密を書かない）・同時に 2 つ起こしても 1 つだけ・shutdown で子ごと終わる・idle で終わる・起こしたものが試験の後に残らない
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureHolder, connectHolder, holderLogFile, readHolderFile } from '../../core/holder/client.mjs';
import { holderFilePath } from '../../core/holder/protocol.mjs';
import { fakeChild, collect, waitFor, sleep, isAlive, tempDir, removeDir } from '../lib/holder-harness.mjs';

export const name = 'holder-process';
export const title = '保持役の本物のプロセス: 起こした側が終わっても残る・秘密のファイルとログ・同時に起こしても 1 つ・shutdown で子ごと終わる・idle で終わる・後に残らない';

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'holder-launcher.mjs');
// ログに載ってはいけないもの: 子の引数の中のパス（コマンドはファイル名だけを書く）
const FAKE_PATH_MARK = 'holder-fake-child.mjs';
const gone = async (pid, label) => waitFor(() => !isAlive(pid), 15000, label).then(() => true, () => false);

export default async function (t) {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  const root = path.join(dir, 'runtime');
  const pids = new Set();           // 起こしたもの（保持役と子）。最後に残っていれば止める（自分が起こしたものだけ）
  let childPid = null;
  try {
    // 起こす側（サーバー役の身代わり）が終わった後も、保持役が残る
    const launched = spawnSync(process.execPath, [LAUNCHER, dataDir, root], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    const info = JSON.parse(launched.stdout.trim().split('\n').at(-1));
    pids.add(info.pid);
    t.ok('起こす: 起こした側が終わっても保持役が生きている（detached・stdio なし）。起こしたのは別のプロセス', launched.status === 0 && info.started === true && info.pid !== process.pid && isAlive(info.pid));

    const file = holderFilePath(root, dataDir);
    const written = readHolderFile(file);
    t.ok('秘密のファイル: 実行場所の run\\ に pid・パイプ・秘密・世代を書く（データ置き場には何も書かない）', written?.pid === info.pid && written.secret.length === 64 && written.generation === 1 && file.startsWith(root) && !fs.existsSync(dataDir));
    if (process.platform !== 'win32') t.ok('秘密のファイルの権限は 0600', (fs.statSync(file).mode & 0o777) === 0o600);

    const log = holderLogFile(root);
    await waitFor(() => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('listening'), 8000, 'holder.log');
    const text = fs.readFileSync(log, 'utf8');
    t.ok('ログ: logs\\holder.log に始まりと待ち受けが残る', text.includes('--- holder start') && text.includes('listening (generation 1)'));

    // つなぎ直し（別の親）。子は保持役の子として動き続ける
    const again = await ensureHolder({ dataDir, root, appVersion: 'second', mode: 'detached' });
    t.ok('ensureHolder: 居れば起こさずつなぐ（同じ保持役）', again.started === false && again.pid === info.pid && again.client.welcome.appVersion === 'launcher');
    const events = collect(again.client);
    again.client.spawn({ ...fakeChild('p1', 'echo'), env: { ...process.env, PLEIAD_TEST_CHILD_SECRET: 'sekret-env-value-123' } });
    again.client.write('p1', '{"hello":"holder"}\n');
    await waitFor(() => events.lines('p1').some(l => l.echo === '{"hello":"holder"}'), 10000, 'echo from the real holder');
    childPid = events.lines('p1')[0].pid;
    pids.add(childPid);
    t.ok('本物の保持役が子を起こし、書いたものが返る（子の pid は保持役とも試験とも別）', childPid !== info.pid && childPid !== process.pid && isAlive(childPid));

    again.client.close();
    await sleep(500);
    const third = await connectHolder({ dataDir, root });
    const snap = third.welcome.children.find(c => c.id === 'p1');
    t.ok('親が居なくなっても保持役と子は残り、次の親の welcome に子が載る', isAlive(info.pid) && isAlive(childPid) && snap.alive === true && snap.pid === childPid);
    const events3 = collect(third);
    await third.attach('p1');
    third.write('p1', '{"again":1}\n');
    await waitFor(() => events3.lines('p1').some(l => l.echo === '{"again":1}'), 10000, 'echo after reconnect');
    t.ok('付け直した親の write も届く（子の stdin は親が居ない間も閉じていない）', !events3.lines('p1').some(l => l.stdin));

    const logText = fs.readFileSync(log, 'utf8');
    t.ok('ログに子の env・秘密・パイプの秘密を書かない（コマンドは名前だけ）', !logText.includes('sekret-env-value-123') && !logText.includes(written.secret) && !logText.includes(FAKE_PATH_MARK) && logText.includes('child p1: started'));

    // shutdown: 子も木ごと止まり、ファイルが消え、パイプが無くなる
    third.shutdown();
    t.ok('shutdown: 保持役が終わり、子も止まる', await gone(info.pid, 'holder gone') && await gone(childPid, 'child gone'));
    t.ok('shutdown: 秘密のファイルを消し、つなげなくなる（HOLDER_NONE）', !fs.existsSync(file) && (await connectHolder({ dataDir, root }).catch(error => error)).code === 'HOLDER_NONE');
    third.close();

    // 同時に 2 つ起こしても、保持役は 1 つ（パイプを作れるのは最初の 1 つだけ）
    const [x, y] = await Promise.all([
      ensureHolder({ dataDir, root, appVersion: 'x', mode: 'detached' }),
      ensureHolder({ dataDir, root, appVersion: 'y', mode: 'detached' }),
    ]);
    pids.add(x.pid); pids.add(y.pid);
    t.ok('同時に起こしても、2 つの親が同じ保持役につながる（2 つ目に起こされた方は何も書かずに終わる）', x.pid === y.pid && x.client.welcome.pid === y.client.welcome.pid && isAlive(x.pid));
    // 負けた方が「既に居る」と書いて終わるまで待つ（遅れて起きた方は、先の保持役が shutdown した後だと、新しい保持役として立ってしまう）
    await waitFor(() => { const text = fs.readFileSync(log, 'utf8'); return (text.match(/listening \(generation/g) ?? []).length === 2 && text.includes('a holder is already running'); }, 8000, 'second listening and the loser exit').catch(() => {});
    const starts = fs.readFileSync(log, 'utf8');
    const listens = (starts.match(/listening \(generation/g) ?? []).length;
    // 1 つ目の保持役（shutdown 済み）の分が 1 回、今の保持役の分が 1 回。負けた方が書くのは「既に居る」だけ
    t.ok('起こされたのに負けた保持役は「待ち受け」を書かない（今の保持役の分の 1 回だけが増える）', listens === 2, `${listens} listening lines`);
    // つながっている親は常に 1 つ（後から合格した方が勝ち、先の親の依頼は届かない）。x と y のどちらが勝ったかは決まっていないので、新しくつないだ親から止める
    x.client.close(); y.client.close();
    const closer = await connectHolder({ dataDir, root });
    closer.shutdown();
    t.ok('shutdown: 2 つ目の保持役も終わる', await gone(x.pid, 'second holder gone'));
    closer.close();

    // idle: 子が無く親も居なければ、idleMs の後に終わる
    const idle = await ensureHolder({ dataDir, root, appVersion: 'idle', mode: 'detached', idleMs: 800 });
    pids.add(idle.pid);
    idle.client.close();
    t.ok('idle: 子が無く親が居なければ終わる（秘密のファイルも消える）', await gone(idle.pid, 'idle exit') && !fs.existsSync(file));
  } finally {
    // 起こしたものが残っていれば止める（保持役が落ちれば子も止まる）。試験の後に残さない
    for (const pid of pids) if (isAlive(pid)) { try { process.kill(pid); } catch { /* 既に終わっている */ } }
    await sleep(300);
    for (const pid of pids) if (isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* 既に終わっている */ } }
    removeDir(dir);
  }
  t.ok('後片付け: 試験が起こした保持役と子が残っていない', [...pids].every(pid => !isAlive(pid)));
}
