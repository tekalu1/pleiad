// ターンの保持役の握手・名前・二重起動（core/holder/。無停止の更新 段階 2 の 2a）。
// hello の secret が合わなければ何も返さず切る・合ったうえで規約の版が合わなければ reject・握手の前の操作・大きすぎる行・時間切れ・
// 失敗した接続はつながっている親に触らない・パイプと秘密のファイルの名前（版ごと・データ置き場ごと）・世代の違う保持役の並走・
// 二重起動の防止（後から立てた方は何も書かずに断られる）・保持役が居なくなった後の古いファイル・launchHolder の起こし方（Job の分岐）
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHolder } from '../../core/holder/holder.mjs';
import { HolderClient, connectHolder, launchHolder, readHolderFile } from '../../core/holder/client.mjs';
import { holderPipeName, holderFilePath, holderKey, ENV } from '../../core/holder/protocol.mjs';
import { startHolder, rawConnect, hello, waitFor, sleep, tempDir, removeDir, randomSecret } from '../lib/holder-harness.mjs';

export const name = 'holder-handshake';
export const title = '保持役の握手と名前: secret の不一致・規約の版の不一致・握手前の操作・名前の版・世代の並走・二重起動の防止・launchHolder の Job の分岐';

const settledError = promise => promise.then(() => null, error => error);

export default async function (t) {
  // ---- 握手
  {
    const h = await startHolder({ helloTimeoutMs: 300 });
    try {
      const a = await h.connect();

      const wrong = await rawConnect(h.pipe);
      wrong.write(hello(randomSecret()));
      await waitFor(() => wrong.state.closed, 3000, 'wrong secret closed');
      t.ok('hello の secret が合わなければ、何も返さず切る', wrong.state.frames.length === 0 && wrong.state.closed);

      const before = await rawConnect(h.pipe);
      before.write({ t: 'spawn', id: 'x', command: process.execPath, args: ['-e', ''], policy: 'none' });
      await waitFor(() => before.state.closed, 3000, 'pre-hello closed');
      t.ok('握手の前の操作（spawn）は何も返さず切り、子は起こさない', before.state.frames.length === 0 && h.holder.snapshot().children.length === 0);

      const role = await rawConnect(h.pipe);
      role.write(hello(h.secret, { role: 'client' }));
      await waitFor(() => role.state.frames.length > 0, 3000, 'role reject');
      t.ok('役割が server でなければ reject（秘密が合っていても）', role.state.frames[0].t === 'reject' && role.state.frames[0].reason === 'protocol');

      const range = await rawConnect(h.pipe);
      range.write(hello(h.secret, { protocol: [2, 3] }));
      await waitFor(() => range.state.closed, 3000, 'protocol reject');
      const rejected = range.state.frames[0];
      t.ok('秘密が合って規約の版が合わなければ reject（保持役の範囲・世代・版つき）を返して切る', rejected.t === 'reject' && rejected.reason === 'protocol' && rejected.range.join() === '1,1' && rejected.generation === 1 && rejected.appVersion === '9.9.9' && rejected.pid === process.pid);
      const viaClient = await settledError(new HolderClient({ pipe: h.pipe, secret: h.secret, range: [2, 2] }).connect());
      t.ok('クライアント: 規約の版が合わなければ HOLDER_REJECTED（相手の世代が .holder に付く）', viaClient?.code === 'HOLDER_REJECTED' && viaClient.holder.generation === 1);
      const badSecret = await settledError(new HolderClient({ pipe: h.pipe, secret: 'nope' }).connect());
      t.ok('クライアント: 秘密が合わなければ HOLDER_CLOSED', badSecret?.code === 'HOLDER_CLOSED');

      const big = await rawConnect(h.pipe);
      big.socket.write(`${'x'.repeat(100 * 1024)}\n`);
      await waitFor(() => big.state.closed, 3000, 'oversize hello closed');
      t.ok('握手の前の大きすぎる行（64 KB 超）は切る', big.state.frames.length === 0);

      const silent = await rawConnect(h.pipe);
      await waitFor(() => silent.state.closed, 3000, 'hello timeout');
      t.ok('握手の前に何も送らなければ、時間切れで切る', silent.state.frames.length === 0);

      await sleep(100);
      t.ok('失敗した接続は、つながっている親を替えない（bye も来ない）', a.client.connected && a.events.disconnect.length === 0 && h.holder.snapshot().connected);
    } finally { await h.stop(); }
  }

  // ---- 名前
  {
    const dataDir = path.join(tempDir(), 'data');
    const v1 = holderPipeName(dataDir, { platform: 'win32', user: 'u' });
    const v2 = holderPipeName(dataDir, { protocol: 2, platform: 'win32', user: 'u' });
    t.ok('パイプの名前: 規約の版が入り、データ置き場・利用者で変わる（Windows は \\\\.\\pipe\\pleiad-holder-<キー>-v<版>）',
      /^\\\\\.\\pipe\\pleiad-holder-[0-9a-f]{16}-v1$/.test(v1) && v2 === v1.replace(/-v1$/, '-v2') && v1 !== holderPipeName(`${dataDir}2`, { platform: 'win32', user: 'u' }) && v1 !== holderPipeName(dataDir, { platform: 'win32', user: 'w' }) && v1 === holderPipeName(dataDir.toUpperCase(), { platform: 'win32', user: 'u' }));
    t.ok('キーは Windows では大小を区別せず、それ以外では区別する', holderKey('C:\\A', { platform: 'win32', user: 'u' }) === holderKey('c:\\a', { platform: 'win32', user: 'u' }) && holderKey('/A', { platform: 'linux', user: 'u' }) !== holderKey('/a', { platform: 'linux', user: 'u' }));
    const file = holderFilePath(path.join('R', 'root'), dataDir, { platform: 'win32', user: 'u' });
    t.ok('秘密のファイル: 実行場所の run\\ の下の holder-<キー>-v1.json（<版>-<pid>.lock.db と重ならない）', path.basename(path.dirname(file)) === 'run' && /^holder-[0-9a-f]{16}-v1\.json$/.test(path.basename(file)) && !/^(.+)-(\d+)\.lock\.db$/.test(path.basename(file)));
  }

  // ---- 世代の並走（規約の版ごとに別のパイプ・別のファイル）
  {
    const dir = tempDir();
    const dataDir = path.join(dir, 'data');
    const root = path.join(dir, 'runtime');
    const logs = [];
    const old = createHolder({ pipe: holderPipeName(dataDir), file: holderFilePath(root, dataDir), appVersion: 'old', idleMs: 0, log: line => logs.push(line) });
    const next = createHolder({ pipe: holderPipeName(dataDir, { protocol: 2 }), file: holderFilePath(root, dataDir, { protocol: 2 }), range: [2, 2], appVersion: 'new', idleMs: 0, log: line => logs.push(line) });
    try {
      await old.listen();
      await next.listen();
      t.ok('世代の違う保持役は、別のパイプ・別のファイルで並んで動く', old.pipe !== next.pipe && readHolderFile(holderFilePath(root, dataDir)).pid === process.pid && readHolderFile(holderFilePath(root, dataDir, { protocol: 2 })).protocol.join() === '2,2' && readHolderFile(holderFilePath(root, dataDir)).secret !== readHolderFile(holderFilePath(root, dataDir, { protocol: 2 })).secret);
      const one = await connectHolder({ dataDir, root, generation: 1 });
      const two = await connectHolder({ dataDir, root, generation: 2 });
      t.ok('connectHolder は世代を指して付ける（世代 1 の保持役は世代 1 で、世代 2 は世代 2 で話す）', one.welcome.generation === 1 && one.welcome.protocol === 1 && two.welcome.generation === 2 && two.welcome.protocol === 2 && one.welcome.appVersion === 'old' && two.welcome.appVersion === 'new');
      const wrongGeneration = await settledError(new HolderClient({ pipe: old.pipe, secret: old.secret, range: [2, 2] }).connect());
      t.ok('古い世代のパイプへ新しい世代の規約で話しかければ、reject で断られる（古い保持役の子は触られない）', wrongGeneration?.code === 'HOLDER_REJECTED' && wrongGeneration.holder.range.join() === '1,1');
      const both = await new HolderClient({ pipe: next.pipe, secret: next.secret, range: [1, 2] }).connect();
      t.ok('範囲 [1, 2] を話せる親は、新しい世代の保持役と世代 2 で話す', both.protocol === 2);
      one.close(); two.close();
    } finally { await old.close(); await next.close(); removeDir(dir); }
  }

  // ---- 二重起動の防止・古いファイル
  {
    const h = await startHolder();
    try {
      const written = fs.readFileSync(h.file, 'utf8');
      const second = createHolder({ pipe: h.pipe, file: h.file, appVersion: 'second', idleMs: 0 });
      const error = await settledError(second.listen());
      t.ok('二重起動: 同じパイプの 2 つ目は HOLDER_RUNNING で断られ、ファイルには触れない', error?.code === 'HOLDER_RUNNING' && fs.readFileSync(h.file, 'utf8') === written);
      await second.close({ killChildren: false });
      t.ok('二重起動を断った方が close しても、先に居る保持役のファイルを消さない・先の保持役はつながる', fs.existsSync(h.file) && (await h.connect()).client.connected);
      await h.holder.close();
      t.ok('保持役が閉じたら、ファイルを消す（自分のものだけ）', !fs.existsSync(h.file));
      const again = createHolder({ pipe: h.pipe, file: h.file, appVersion: 'again', idleMs: 0 });
      await again.listen();
      t.ok('閉じた後は、同じパイプでもう一度立てられる', readHolderFile(h.file)?.appVersion === 'again');
      await again.close();
      // 同時に立てようとしても、立てられるのは 1 つだけ（unix ソケットは、先に居るかを確かめてから消して立てると、先に立てた方のソケットを消して 2 つとも立ててしまう）
      let both = 0;
      for (let i = 0; i < 20; i++) {
        const x = createHolder({ pipe: h.pipe, file: null, idleMs: 0 });
        const y = createHolder({ pipe: h.pipe, file: null, idleMs: 0 });
        const settled = await Promise.allSettled([x.listen(), y.listen()]);
        const lost = settled.filter(r => r.status === 'rejected');
        if (lost.length !== 1 || lost[0].reason?.code !== 'HOLDER_RUNNING') both++;
        await x.close({ killChildren: false });
        await y.close({ killChildren: false });
      }
      t.ok('同時に立てようとした 2 つのうち、立てられるのは 1 つだけ（もう 1 つは HOLDER_RUNNING）', both === 0, `${both} / 20 rounds`);
      if (process.platform !== 'win32') {
        // 落ちて残った古いソケット（つながる持ち主が居ないファイル）は、使用中とせず消して立て直す
        fs.writeFileSync(h.pipe, '');
        const revived = createHolder({ pipe: h.pipe, file: h.file, appVersion: 'revived', idleMs: 0 });
        await revived.listen();
        t.ok('持ち主の居ない古いソケットのファイルが残っていても、消して立てられる（unix ソケット）', readHolderFile(h.file)?.appVersion === 'revived');
        await revived.close();
      }
    } finally { await h.stop(); }
  }
  {
    const dir = tempDir();
    try {
      const dataDir = path.join(dir, 'data');
      const root = path.join(dir, 'runtime');
      t.ok('居なければ connectHolder は HOLDER_NONE', (await settledError(connectHolder({ dataDir, root })))?.code === 'HOLDER_NONE');
      const file = holderFilePath(root, dataDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, pid: 1, pipe: holderPipeName(path.join(dir, 'nobody')), secret: 'old' }));
      t.ok('保持役が落ちて残った古いファイル（パイプが無い）は HOLDER_NONE（起こし直す側へ）', (await settledError(connectHolder({ dataDir, root })))?.code === 'HOLDER_NONE');
      fs.writeFileSync(file, '{broken');
      t.ok('壊れたファイルも HOLDER_NONE', (await settledError(connectHolder({ dataDir, root })))?.code === 'HOLDER_NONE');
    } finally { removeDir(dir); }
  }

  // ---- launchHolder の起こし方（段階 1 のサーバーと同じ。Job の分岐は desktop/job.cjs の判定）
  {
    const calls = [];
    const spawnProcess = (exe, args, options) => {
      calls.push({ exe, args, options });
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    };
    const jobModule = (mode, reason = 'test') => () => ({ inspectJob: () => ({}), decideLaunch: () => ({ mode, reason }), launchBreakaway: options => { calls.push({ breakaway: options }); return { pid: 77 }; } });
    const base = { dataDir: 'D:/data', root: 'R:/runtime', key: 'k-1', appVersion: '1.2.3', nodeExe: 'N:/pleiad-node.exe', script: 'S:/holder/main.mjs', env: { PATH: 'p', AGENT_HOST_TOKEN: 'secret-token', ELECTRON_RUN_AS_NODE: '1' }, spawnProcess };

    const detached = await launchHolder({ ...base, jobModule: jobModule('detached') });
    const call = calls.at(-1);
    t.ok('起こし方(detached): detached・stdio なし・windowsHide。pid を返す', detached.pid === 4242 && call.exe === 'N:/pleiad-node.exe' && call.args.join() === 'S:/holder/main.mjs' && call.options.detached === true && call.options.stdio === 'ignore' && call.options.windowsHide === true);
    t.ok('起こし方: 環境変数でデータ置き場・実行場所の置き場・版を渡し、画面のトークンと ELECTRON_RUN_AS_NODE は渡さない', call.options.env[ENV.data] === 'D:/data' && call.options.env[ENV.root] === 'R:/runtime' && call.options.env[ENV.key] === 'k-1' && call.options.env[ENV.appVersion] === '1.2.3' && !('AGENT_HOST_TOKEN' in call.options.env) && !('ELECTRON_RUN_AS_NODE' in call.options.env) && call.options.env.PATH === 'p');

    const callsBefore = calls.length;
    const breakaway = await launchHolder({ ...base, jobModule: jobModule('breakaway') });
    t.ok('起こし方(breakaway): Job が KILL_ON_JOB_CLOSE + BREAKAWAY_OK なら CreateProcessW の経路（Node の spawn は使わない）', breakaway.pid === 77 && calls.length === callsBefore + 1 && calls.at(-1).breakaway.exe === 'N:/pleiad-node.exe' && calls.at(-1).breakaway.args.join() === 'S:/holder/main.mjs' && !('AGENT_HOST_TOKEN' in calls.at(-1).breakaway.env));

    const callsBeforeUnsupported = calls.length;
    const unsupported = await settledError(launchHolder({ ...base, jobModule: jobModule('unsupported', 'no breakaway') }));
    t.ok('起こし方(unsupported): 抜け道の無い Job では起こさず HOLDER_UNSUPPORTED（呼び出し側は今の流れに落とす）', unsupported?.code === 'HOLDER_UNSUPPORTED' && calls.length === callsBeforeUnsupported);

    const forced = await launchHolder({ ...base, mode: 'detached', jobModule: () => { throw new Error('should not be loaded'); }, idleMs: 1234 });
    t.ok('mode を指せば Job を調べない（idleMs は環境変数で渡る）', forced.pid === 4242 && calls.at(-1).options.env[ENV.idleMs] === '1234');
    const noModule = await launchHolder({ ...base, jobModule: () => { throw new Error('no job module'); } });
    t.ok('Job の部品が読めなければ detached で起こす', noModule.pid === 4242 && calls.at(-1).options.detached === true);
  }
}
