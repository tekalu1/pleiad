// 手元のフォルダーを送る口（core/folder-uploads.mjs、docs/remote.md §8.1、issue #15）。
// パスの検査・送り先の規則・続きから・中断・上書きの確認・古い途中の掃除を、使い捨ての置き場で直接確かめ、
// 最後に fake バックエンドのサーバーで WS のコマンドとして通し、送り先を会話の作業フォルダー（nextSettings.cwd）にする。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFolderUploads, normalizeRelPath, normalizeFiles, CHUNK_BYTES } from '../../core/folder-uploads.mjs';
import { startServer, ROOT } from '../lib/server.mjs';
import { excludeMatcher, summarize, formatBytes, entriesFromFileList, createFolderUpload, canSendFolders, progressLine } from '../../web/folder-upload.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'folder-uploads';
export const title = '手元のフォルダーを送る: パスの検査・送り先・続きから・中断・上書きの確認・掃除・作業フォルダーにする';

const rejects = (p) => p.then(() => null, (e) => e);

/** 一覧と中身。{ path, data } の配列から start の files と、断片を送る関数を作る */
function sample(entries) {
  return entries.map((e) => ({ path: e.path, size: e.data.length, mtime: 1_700_000_000_000, data: e.data }));
}

/** 画面と同じく同時に 4 つまで断片を投げる。from は受け取り済みの位置 */
async function pump(send, files, received, { stopAfter = Infinity } = {}) {
  const jobs = [];
  files.forEach((f, i) => {
    for (let off = received[i] ?? 0; off < f.size; off += CHUNK_BYTES) jobs.push({ i, off });
  });
  let sent = 0, k = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (k < jobs.length && sent < stopAfter) {
      const { i, off } = jobs[k++];
      sent++;
      await send({ file: i, offset: off, data: files[i].data.subarray(off, off + CHUNK_BYTES).toString('base64') });
    }
  }));
  return sent;
}

export default async function (t) {
  // ---- パスの検査
  const good = ['a.txt', 'src/index.ts', 'a\\b\\c.md', '日本語/ファイル.txt', '.env', 'x/.git-keep'];
  t.ok('相対パスは通し、区切りを / に揃える', good.every((p) => normalizeRelPath(p)) && normalizeRelPath('a\\b\\c.md') === 'a/b/c.md');
  const bad = ['', '../x', 'a/../b', './a', '/abs', '\\abs', 'C:/x', 'C:x', 'a//b', 'a/', 'con', 'CON.txt', 'a/nul.log', 'com1', 'lpt9.x',
    'a:b', 'file.txt:stream', 'a/b.', 'trail ', 'q?', 'x*y', 'p|q', '<a>', 'a"b', 'ctl\u0001', 'x'.repeat(1025)];
  const passed = bad.filter((p) => normalizeRelPath(p) !== null);
  t.ok('..・.・空・絶対パス・ドライブ名・:・予約名・末尾の . と空白・使えない字・長すぎるものを拒否', passed.length === 0, JSON.stringify(passed));
  const clash = (files) => { try { normalizeFiles(files); return null; } catch (e) { return e.code; } };
  t.ok('大文字小文字だけが違う名前は重なりとして拒否', clash([{ path: 'A.txt', size: 1 }, { path: 'a.txt', size: 1 }]) === 'duplicatePath');
  t.ok('ファイルとフォルダーが同じ名前の組を拒否', clash([{ path: 'a', size: 1 }, { path: 'a/b', size: 1 }]) === 'duplicatePath');
  t.ok('大きさが整数でなければ拒否', clash([{ path: 'a', size: -1 }]) === 'invalidPath' && clash([{ path: 'a', size: 1.5 }]) === 'invalidPath');
  t.ok('上限を超える数・大きさを拒否',
    (() => { try { normalizeFiles([{ path: 'a', size: 1 }, { path: 'b', size: 1 }], { files: 1, fileBytes: 10, totalBytes: 10, pathLength: 100 }); } catch (e) { return e.code === 'tooManyFiles'; } })()
    && (() => { try { normalizeFiles([{ path: 'a', size: 11 }], { files: 5, fileBytes: 10, totalBytes: 100, pathLength: 100 }); } catch (e) { return e.code === 'tooLarge'; } })());

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-folder-uploads-')));
  const root = path.join(scratch, 'uploads');
  let up = createFolderUploads({ root });
  try {
    // ---- 新しいフォルダーへ送る
    const big = crypto.randomBytes(CHUNK_BYTES * 2 + 1234);
    const files = sample([
      { path: 'README.md', data: Buffer.from('# hello\n') },
      { path: 'src/main.js', data: big },
      { path: 'src/empty.txt', data: Buffer.alloc(0) },
      { path: 'docs/日本語.md', data: Buffer.from('こんにちは') },
    ]);
    const meta = files.map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
    const check = await up.check({ name: 'my-app', paths: meta.map((f) => f.path) });
    t.ok('下見: 既定の送り先は置き場の下の新しいフォルダー', check.dest === path.join(root, 'my-app') && !check.exists && check.inRoot && !check.needsConfirm, JSON.stringify(check));
    const s1 = await up.start({ name: 'my-app', files: meta });
    t.ok('uploadStart: uploadId と受け取り済みの位置（全部 0）', /^[a-f0-9]{32}$/.test(s1.uploadId) && s1.received.every((x) => x === 0) && !s1.resumed && s1.chunkBytes === CHUNK_BYTES);
    t.ok('途中の置き場は .partial/<uploadId>/ に manifest.json', await fs.stat(path.join(root, '.partial', s1.uploadId, 'manifest.json')).then(() => true, () => false));

    // 途中まで送ってから、サーバーの起動し直しを模して作り直す
    const firstSent = await pump((c) => up.chunk({ uploadId: s1.uploadId, ...c }), files, s1.received, { stopAfter: 2 });
    up = createFolderUploads({ root });
    const s2 = await up.start({ name: 'my-app', files: meta });
    const got = s2.received.reduce((a, b) => a + b, 0);
    t.ok('続きから: 同じ name・files なら同じ uploadId と、置いたファイルの大きさの位置が返る（起動し直しても）',
      s2.uploadId === s1.uploadId && s2.resumed && got > 0 && got < big.length + 30, `${firstSent} 断片 → ${JSON.stringify(s2.received)}`);
    // 抜けのある断片は書かない
    const gap = await up.chunk({ uploadId: s2.uploadId, file: 1, offset: s2.received[1] + CHUNK_BYTES, data: big.subarray(0, 10).toString('base64') });
    t.ok('抜けのある断片は書かずに今の位置を返す', gap.received === s2.received[1]);
    // 送り直し（重なり）は害が無い
    if (s2.received[1] > 0) {
      const again = await up.chunk({ uploadId: s2.uploadId, file: 1, offset: 0, data: big.subarray(0, CHUNK_BYTES).toString('base64') });
      t.ok('受け取り済みの断片の送り直しは位置を変えない', again.received === s2.received[1]);
    }
    const early = await rejects(up.finish({ uploadId: s2.uploadId }));
    t.ok('揃う前の uploadFinish は断る（incomplete）', early?.code === 'incomplete', early?.message);
    const badChunk = await rejects(up.chunk({ uploadId: s2.uploadId, file: 0, offset: 5, data: Buffer.from('0123456789').toString('base64') }));
    t.ok('大きさを超える断片は断る', badChunk?.code === 'badChunk');
    await pump((c) => up.chunk({ uploadId: s2.uploadId, ...c }), files, (await up.start({ name: 'my-app', files: meta })).received);
    const done = await up.finish({ uploadId: s2.uploadId });
    const dest = path.join(root, 'my-app');
    const same = await Promise.all(files.map(async (f) => (await fs.readFile(path.join(dest, ...f.path.split('/')))).equals(f.data)));
    t.ok('uploadFinish: 送り先に全部同じ中身で置かれる（空のファイルも）', done.dest === dest && done.files === 4 && same.every(Boolean), JSON.stringify(done));
    t.ok('終わったら途中の置き場を消す', !(await fs.stat(path.join(root, '.partial', s1.uploadId)).then(() => true, () => false)));

    // ---- 既定の送り先がふさがっていれば -2
    const next = await up.check({ name: 'my-app', paths: [] });
    t.ok('同じ名前が既にあれば my-app-2', next.dest === path.join(root, 'my-app-2') && !next.exists);

    // ---- 既にあるフォルダーへ: 確認が要る
    const conflictFiles = sample([{ path: 'README.md', data: Buffer.from('new readme') }, { path: 'new.txt', data: Buffer.from('n') }]);
    const cmeta = conflictFiles.map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
    const need = await up.start({ name: 'my-app', dest, files: cmeta });
    t.ok('空でない既存のフォルダーは needsConfirm と上書きする件数・名前を返し、何も作らない',
      need.needsConfirm === true && need.conflicts === 1 && need.sample[0] === 'README.md' && !need.uploadId, JSON.stringify(need));
    const ok = await up.start({ name: 'my-app', dest, files: cmeta, overwrite: true });
    await pump((c) => up.chunk({ uploadId: ok.uploadId, ...c }), conflictFiles, ok.received);
    await up.finish({ uploadId: ok.uploadId });
    t.ok('上書きして送ると、同じ名前は置き換え、ほかのファイルは残す',
      await fs.readFile(path.join(dest, 'README.md'), 'utf8') === 'new readme' && await fs.readFile(path.join(dest, 'new.txt'), 'utf8') === 'n'
      && (await fs.readFile(path.join(dest, 'src', 'main.js'))).equals(big));

    // ---- 置き場の外
    const outside = path.join(scratch, 'elsewhere');
    const e1 = await rejects(up.start({ name: 'x', dest: path.join(outside, 'new'), files: cmeta }));
    t.ok('置き場の外の無いフォルダーは断る（destOutside）', e1?.code === 'destOutside', e1?.message);
    await fs.mkdir(outside);
    const e2 = await up.start({ name: 'x', dest: outside, files: cmeta });
    t.ok('置き場の外の既存のフォルダーは空でも確認が要る', e2.needsConfirm === true && e2.inRoot === false && e2.empty === true);
    for (const [label, d] of [['置き場そのもの', root], ['途中の置き場', path.join(root, '.partial')], ['相対パス', 'rel/dir'], ['ドライブの根', path.parse(scratch).root], ['ファイル', path.join(dest, 'new.txt')]]) {
      const e = await rejects(up.start({ name: 'x', dest: d, files: cmeta, overwrite: true }));
      t.ok(`送り先に使えない: ${label}`, e?.code === 'invalidDest', e?.message);
    }
    const e3 = await rejects(up.start({ name: '..', files: cmeta }));
    t.ok('フォルダーの名前も 1 要素として検査する', e3?.code === 'invalidName');

    // ---- 送り先の中のリンクで外へ出ない
    const secret = path.join(scratch, 'secret');
    await fs.mkdir(secret);
    let linked = true;
    try { await fs.symlink(secret, path.join(dest, 'link'), 'junction'); } catch { linked = false; }
    if (linked) {
      const lf = sample([{ path: 'link/evil.txt', data: Buffer.from('x') }]);
      const lm = lf.map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
      const ls = await up.start({ name: 'my-app', dest, files: lm, overwrite: true });
      await pump((c) => up.chunk({ uploadId: ls.uploadId, ...c }), lf, ls.received);
      const le = await rejects(up.finish({ uploadId: ls.uploadId }));
      t.ok('送り先の中のリンク（ジャンクション）を辿って外へ書かない', le?.code === 'escape' && !(await fs.stat(path.join(secret, 'evil.txt')).then(() => true, () => false)), le?.message);
      await up.cancel({ uploadId: ls.uploadId });
    } else t.note('リンクを作れない環境なので、リンクの確認はとばした');
    const symDest = path.join(root, 'via-link');
    try {
      await fs.symlink(outside, symDest, 'junction');
      const sd = await up.start({ name: 'x', dest: symDest, files: cmeta });
      t.ok('置き場の中のリンクが外を指すなら、外の既存フォルダーとして確認を求める', sd.needsConfirm === true && sd.inRoot === false && sd.dest === outside, JSON.stringify(sd));
    } catch (e) { t.note(`リンクを作れない: ${e.message}`); }

    // ---- 中断
    const cf = sample([{ path: 'a.bin', data: crypto.randomBytes(CHUNK_BYTES + 5) }]);
    const cm = cf.map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
    const cs = await up.start({ name: 'cancel-me', files: cm });
    await pump((c) => up.chunk({ uploadId: cs.uploadId, ...c }), cf, cs.received, { stopAfter: 1 });
    await up.cancel({ uploadId: cs.uploadId });
    const after = await rejects(up.chunk({ uploadId: cs.uploadId, file: 0, offset: 0, data: 'AA==' }));
    t.ok('uploadCancel: 途中の置き場を消し、以後の断片は unknownUpload', after?.code === 'unknownUpload'
      && !(await fs.stat(path.join(root, '.partial', cs.uploadId)).then(() => true, () => false)) && !(await fs.stat(path.join(root, 'cancel-me')).then(() => true, () => false)));
    const badId = await rejects(up.chunk({ uploadId: '../../x', file: 0, offset: 0, data: '' }));
    t.ok('uploadId の形を確かめる（パスに使わせない）', badId?.code === 'unknownUpload');

    // ---- 掃除
    let clock = Date.now();
    const aged = createFolderUploads({ root, now: () => clock });
    const old = await aged.start({ name: 'old', files: cm });
    clock += 8 * 24 * 60 * 60_000;
    const fresh = createFolderUploads({ root, now: () => clock });
    const removed = await fresh.sweep();
    t.ok('7 日触られていない途中のものは sweep で捨てる', removed >= 1 && !(await fs.stat(path.join(root, '.partial', old.uploadId)).then(() => true, () => false)));
    const few = createFolderUploads({ root, limits: { partials: 2 } });
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await few.start({ name: `p${i}`, files: cm })).uploadId);
    const left = (await fs.readdir(path.join(root, '.partial'))).filter((n) => ids.includes(n));
    t.ok('途中のものが上限を超えたら古いものから捨てる', left.length === 2 && !left.includes(ids[0]), JSON.stringify(left));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  // ---- 画面の側（web/folder-upload.mjs）
  t.ok('フォルダーを送れるのはデスクトップ版のリモートの窓だけ',
    canSendFolders({ hostId: 'h', shell: 'desktop' }) && !canSendFolders({ hostId: 'h', shell: 'mobile' }) && !canSendFolders(undefined) && !canSendFolders({}));
  const m = (p) => excludeMatcher(p);
  t.ok('除外: 名前はどの階層にも当たり、* が使え、/ を含めば先頭から',
    m('node_modules').test('node_modules/x.js') && m('node_modules').test('a/node_modules/b') && !m('node_modules').test('node_modules2/x')
    && m('*.log').test('logs/a.log') && !m('*.log').test('a.logx') && m('build/out').test('build/out/a') && !m('build/out').test('x/build/out/a'));
  const fake = (p, size) => ({ path: p, file: { size } });
  const sum = summarize([fake('a.js', 10), fake('.git/HEAD', 5), fake('node_modules/x/y.js', 7), fake('src/b.js', 3)]);
  t.ok('件数と大きさを数え、除外で省いた分も数える', sum.files === 2 && sum.bytes === 13 && sum.skippedFiles === 2 && sum.skippedBytes === 12 && !sum.large);
  t.ok('大きさの書き方（1024 進、10 未満は小数 1 桁）', formatBytes(0) === '0 B' && formatBytes(1536) === '1.5 KB' && formatBytes(131 * 1024 ** 2) === '131 MB');
  t.ok('進み具合の一行', progressLine({ doneFiles: 1204, files: 3410, sentBytes: 48.2 * 1024 ** 2, bytes: 131 * 1024 ** 2 }) === '1,204 / 3,410 件 · 48.2 / 131 MB',
    progressLine({ doneFiles: 1204, files: 3410, sentBytes: 48.2 * 1024 ** 2, bytes: 131 * 1024 ** 2 }));
  const picked = entriesFromFileList([{ webkitRelativePath: 'my-app/src/a.js', name: 'a.js', size: 1 }, { webkitRelativePath: 'my-app/README.md', name: 'README.md', size: 2 }]);
  t.ok('webkitdirectory の一覧: 先頭がフォルダー名、残りが相対パス', picked.name === 'my-app' && picked.entries.map((e) => e.path).join() === 'src/a.js,README.md');

  // 画面の作業を本物の置き場（直接呼ぶ）につなぎ、途中で切れて続きから送るところまで
  const hadReader = globalThis.FileReader;
  globalThis.FileReader = class {
    readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:application/octet-stream;base64,${Buffer.from(b).toString('base64')}`; this.onload(); }, (e) => { this.error = e; this.onerror(); }); }
  };
  const s3 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-folder-uploads-ui-')));
  try {
    const store = createFolderUploads({ root: path.join(s3, 'uploads') });
    let online = true, chunks = 0, dropAfter = 3;
    const handlers = { uploadCheck: store.check, uploadStart: store.start, uploadChunk: store.chunk, uploadFinish: store.finish, uploadCancel: store.cancel };
    const cmd = async (c, a) => {
      if (!online) throw new Error('接続が切れた');
      if (c === 'uploadChunk' && ++chunks === dropAfter) { online = false; throw new Error('接続が切れた'); }
      return handlers[c](structuredClone(a));
    };
    const changes = [];
    const applied = [];
    const up2 = createFolderUpload({ cmd, connected: () => online, session: () => 'sess-1', onDone: async (dest, sid, o) => { applied.push([dest, sid, o?.makeCwd]); return o?.makeCwd ? 'next' : 'other'; }, onChange: () => changes.push(up2.state.phase) });
    const blobs = [['src/a.bin', crypto.randomBytes(CHUNK_BYTES * 3 + 7)], ['README.md', Buffer.from('hi')], ['.git/HEAD', Buffer.from('ref')], ['empty.txt', Buffer.alloc(0)]];
    const entries = blobs.map(([p, b]) => ({ path: p, file: new File([b], path.basename(p), { lastModified: 1_700_000_000_000 }) }));
    await up2.choose({ name: 'proj', entries });
    t.ok('選ぶと ready になり、既定の送り先を下見する', up2.state.phase === 'ready' && up2.state.plan?.dest === path.join(s3, 'uploads', 'proj') && up2.state.summary.files === 3);
    await up2.send();
    t.ok('途中で切れたら paused で止まる（error にしない）', up2.state.phase === 'paused', `${up2.state.phase} ${up2.state.error}`);
    await new Promise((r) => setTimeout(r, 50));
    online = true;
    up2.online();
    for (let i = 0; i < 100 && up2.state.phase !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    const destDir = path.join(s3, 'uploads', 'proj');
    t.ok('つながり直すと続きから送り、終わったら送り先を送り始めた会話の作業フォルダーにする',
      up2.state.phase === 'done' && applied[0]?.[0] === destDir && applied[0]?.[1] === 'sess-1' && up2.state.result.applied === 'next'
      && (await fs.readFile(path.join(destDir, 'src', 'a.bin'))).equals(blobs[0][1]) && await fs.readFile(path.join(destDir, 'empty.txt'), 'utf8') === ''
      && !(await fs.stat(path.join(destDir, '.git')).then(() => true, () => false)), `${up2.state.phase} ${up2.state.error}`);
    t.ok('「作業フォルダーにする」は既定で入で、onDone に makeCwd: true が渡る', applied[0]?.[2] === true);
    t.ok('切れる前に受け取った分は送り直さない（断片の数が最小に近い）', chunks <= 4 + 1 + 2, `断片 ${chunks}`);
    // 既にあるフォルダーを送り先にすると確認を求める
    await up2.choose({ name: 'proj', entries });
    await up2.setDest(destDir);
    t.ok('送り先を既にあるフォルダーにすると、確認（needsConfirm）と上書きする件数', up2.state.plan?.needsConfirm === true && up2.state.plan.conflicts === 3);
    // 中断
    dropAfter = -1; chunks = 0;
    await up2.setDest('');
    const sending = up2.send({ overwrite: false });
    await new Promise((r) => setTimeout(r, 0));
    await up2.cancel();
    await sending;
    await new Promise((r) => setTimeout(r, 50));
    t.ok('中断すると ready に戻り、置き場の途中のものを捨てる', up2.state.phase === 'ready'
      && (await fs.readdir(path.join(s3, 'uploads', '.partial'))).length === 0);
    // 「作業フォルダーにする」を切って送ると、onDone に makeCwd: false が渡り、作業フォルダーは変えない（'other'）
    up2.setMakeCwd(false);
    await up2.choose({ name: 'proj-b', entries });
    t.ok('選び直しても「作業フォルダーにする」は切ったまま', up2.state.makeCwd === false);
    await up2.send();
    for (let i = 0; i < 100 && up2.state.phase !== 'done'; i++) await new Promise((r) => setTimeout(r, 20));
    t.ok('切って送ると onDone に makeCwd: false が渡り、終わりの字は作業フォルダーを変えていない方', up2.state.phase === 'done'
      && applied.at(-1)?.[0] === path.join(s3, 'uploads', 'proj-b') && applied.at(-1)?.[2] === false && up2.state.result.applied === 'other', `${up2.state.phase} ${up2.state.error}`);
    up2.reset();
    t.ok('閉じる（reset）と「作業フォルダーにする」は入に戻る', up2.state.makeCwd === true);
    up2.setMakeCwd(false);
    up2.choose({ name: 'proj-c', entries }, { makeCwd: true });
    t.ok('ドロップの「作業フォルダーとして送る」（choose に makeCwd: true）は入にする', up2.state.makeCwd === true);
    up2.reset();
  } finally {
    globalThis.FileReader = hadReader;
    await fs.rm(s3, { recursive: true, force: true }).catch(() => {});
  }

  // ---- サーバーの WS コマンドとして
  const s2 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-folder-uploads-srv-')));
  const uploads = path.join(s2, 'uploads');
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_FOLDER_UPLOADS: uploads }, dataDir: path.join(s2, 'data'), timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  try {
    const files = sample([{ path: 'index.html', data: Buffer.from('<p>hi</p>') }, { path: 'css/site.css', data: crypto.randomBytes(CHUNK_BYTES + 99) }]);
    const meta = files.map(({ path: p, size, mtime }) => ({ path: p, size, mtime }));
    const plan = await c.cmd('uploadCheck', { name: 'site', paths: meta.map((f) => f.path) });
    t.ok('WS: uploadCheck が置き場（AGENT_HOST_FOLDER_UPLOADS）の下の既定を返す', plan.dest === path.join(uploads, 'site') && plan.root === uploads);
    const st = await c.cmd('uploadStart', { name: 'site', files: meta });
    await pump((x) => c.cmd('uploadChunk', { uploadId: st.uploadId, ...x }), files, st.received);
    const fin = await c.cmd('uploadFinish', { uploadId: st.uploadId });
    t.ok('WS: uploadStart → uploadChunk → uploadFinish で送り先に置かれる', fin.dest === plan.dest && (await fs.readFile(path.join(fin.dest, 'css', 'site.css'))).equals(files[1].data));
    const err = await rejects(c.cmd('uploadStart', { name: 'x', files: [{ path: '../evil', size: 1 }] }));
    t.ok('WS: 不正なパスは訳した一文で断る', /送れない名前/.test(err?.message ?? ''), err?.message);
    // 作業フォルダーにする: 送信済みの会話は次のターンから（nextSettings.cwd）
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.runTurn({ sessionId, cwd: ROOT, prompt: 'echo:hi' }, { ms: 20_000 });
    await c.cmd('setTurnSettings', { sessionId, cwd: fin.dest });
    const row = (await c.cmd('listSessions')).find((s) => s.id === sessionId);
    t.ok('送り先を setTurnSettings の cwd に渡すと、会話の次のターンの作業フォルダーになる', row?.nextSettings?.cwd === fin.dest, JSON.stringify(row?.nextSettings));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(s2, { recursive: true, force: true }).catch(() => {});
  }
}
