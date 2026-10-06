// ファイルの操作（docs/design-system.md「ファイルの操作」）: パスの自動リンクの判定、画像の所在、操作メニューの中身、
// OS で開く口（起動の組み立て・接続元の判定・連打の制限・デスクトップ版の確かめ直し）と、サーバーの revealPath / openPath。
// OS の窓は開かない（起動は組み立てだけ確かめ、サーバーは AGENT_HOST_OS_OPEN=dry で起動する）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { looksLikePath, findWindowsPaths, fileReference } from '../../web/file-reference.mjs';
import { renderMarkdown, renderToolCall, renderPresent, applyToolResult } from '../../web/render.mjs';
import { fileMenuItems, browserTabMenuItems, displayPath, relativeTo, samePath, fileUrl, openHostFile } from '../../web/file-actions.mjs';
import { launchPlan, launch, isLocalRequest, createRateLimit, bridgeError } from '../../core/os-open.mjs';
import { startServer } from '../lib/server.mjs';
import { open as openWs } from '../lib/ws-client.mjs';

const require = createRequire(import.meta.url);
const { checkRequest, createFileHandler } = require('../../desktop/file-bridge.cjs');

export const name = 'file-actions';
export const title = 'パスの自動リンク・画像の所在・ファイルの操作メニュー・OS で開く口（範囲・遠隔・HTML だけ）';

const labels = items => items.filter(i => !i.sep).map(i => i.label);

export default async function (t) {
  // ---- インラインコードの判定
  const yes = { 'web/render.mjs': 'web/render.mjs', 'docs/a.md:42': 'docs/a.md', './x': './x', '../a/b': '../a/b',
    'C:\\Program Files\\a b.txt': 'C:\\Program Files\\a b.txt', 'D:/work/logo.png': 'D:/work/logo.png', 'src\\app.ts': 'src\\app.ts',
    'docs/設計.md': 'docs/設計.md', 'a/b/c.MD': 'a/b/c.MD', 'docs/readme.md#L12': 'docs/readme.md' };
  for (const [input, want] of Object.entries(yes)) assert.equal(looksLikePath(input)?.path, want, input);
  assert.equal(looksLikePath('docs/a.md:42').line, 42);
  const no = ['Node.js', 'and/or', 'feat/remote', 'origin/main', '12:30', 'application/json', '/api/foo', 'e.g.', 'v1.2.3', 'npm test',
    '~/x.md', 'x.md', 'README', '2026/09/23', 'km/h', 'https://example.com/a.md', '//host/a.md', '\\\\host\\share\\a.md', '/\\d+/',
    'D:/', 'a/b/', 'D:/a:b.md', 'a b/c.md', 'a/<b>.md', 'a/b.md|c', 'file:///D:/a.md', 'javascript:alert(1)/a.js'];
  for (const input of no) assert.equal(looksLikePath(input), null, input);
  t.ok('インラインコード: ドライブ文字・./・区切り＋既知の拡張子だけをパスとみなす', true, `${Object.keys(yes).length} 件の正例・${no.length} 件の負例`);

  // ---- 地の文（Windows の絶対パスだけ）
  const found = s => findWindowsPaths(s).map(f => f.path);
  assert.deepEqual(found(String.raw`D:\a\b.pngを開いて`), [String.raw`D:\a\b.png`]);
  assert.deepEqual(found(String.raw`保存先は D:\a\b.png。次は E:/x/y.md、(C:\t\z.txt), F:\p\q.ts:42. でした`),
    [String.raw`D:\a\b.png`, 'E:/x/y.md', String.raw`C:\t\z.txt`, String.raw`F:\p\q.ts`]);
  assert.equal(findWindowsPaths(String.raw`F:\p\q.ts:42.`)[0].line, 42);
  assert.deepEqual(found(String.raw`末尾 D:\a\b.md; と D:\c\d.md! と D:\e\f.md,`), [String.raw`D:\a\b.md`, String.raw`D:\c\d.md`, String.raw`D:\e\f.md`]);
  assert.deepEqual(found('Node.js 20 以上、and/or、feat/remote、12:30、e.g.、v1.2.3、application/json、/api/foo'), []);
  assert.deepEqual(found(String.raw`D:\ と xD:\a\b.md と https://h/C:/x.md と "G:\q\r.html"`), [String.raw`G:\q\r.html`]);
  t.ok('地の文: Windows の絶対パスだけ。日本語・句読点・括弧で止め、末尾の . , ; ! を外す', true);

  // ---- 描画
  const md = renderMarkdown(String.raw`見て D:\my_dir\a_b.md と **D:\x\y.ts:4** と ` + '`web/render.mjs` と `npm test`');
  assert(md.includes('data-file-path="D:\\my_dir\\a_b.md"'), md);
  assert(md.includes('data-file-path="D:\\x\\y.ts" data-file-line="4"'), md);
  assert(md.includes('<a class="md-link file-link code-link" href="web/render.mjs" data-file-path="web/render.mjs"><code>web/render.mjs</code></a>'), md);
  assert(md.includes('<code>npm test</code>') && !md.includes('<em>'), md);
  const inLink = renderMarkdown(String.raw`[D:\a\b.md と ` + '`web/x.md`](https://example.com)');
  assert.equal((inLink.match(/<a /g) || []).length, 1, inLink);
  const fenced = renderMarkdown('```\nD:\\a\\b.md `web/x.md`\n```');
  assert(!fenced.includes('file-link'), fenced);
  t.ok('強調の _ で途中が切れない・行番号・リンクとコードブロックの中はリンクにしない', true);

  const quoted = renderMarkdown(String.raw`D:\a\"><script>x</script>.md と ` + "`D:\\it's\\a&b.md`");
  assert(!/<script/i.test(quoted) && quoted.includes('data-file-path="D:\\it&#39;s\\a&amp;b.md"') && quoted.includes('data-file-path="D:\\a\\"'), quoted);
  const image = renderMarkdown('![logo "x"](<D:/work/a"b\'&c.png>)');
  assert(image.includes('data-file-path="D:/work/a&quot;b&#39;&amp;c.png"') && image.includes('class="file-where"') && image.includes('title="D:/work"'), image);
  assert(image.includes('aria-label="a&quot;b&#39;&amp;c.png の操作"'), image);
  t.ok('引用符・<>・& を含むパスは属性値としてエスケープされる（画像の所在の一行も）', true);

  const figure = renderMarkdown('![logo](D:/work/logo.png)');
  assert(figure.includes('<img class="md-img" src="/local-file?path=D%3A%2Fwork%2Flogo.png"') && figure.includes('data-file-path="D:/work/logo.png"'));
  assert(figure.includes('<span class="file-where-dir" title="D:/work">') && figure.includes('data-file-menu="D:/work/logo.png"') && figure.includes('aria-haspopup="menu"'));
  assert(!renderMarkdown('![x](data:image/png;base64,AAAA)').includes('file-where'));
  const read = renderToolCall('Read', { file_path: 'D:/work/src/app.ts' });
  assert(read.outerHTML.includes('data-file-path="D:/work/src/app.ts"') && read.outerHTML.includes('tc-file'), read.outerHTML);
  const present = renderPresent({ kind: 'image', caption: '添付', path: 'D:/data/uploads/a.png', dataUri: 'data:image/png;base64,AAAA' });
  assert(present.outerHTML.includes('data-file-path="D:/data/uploads/a.png"') && present.outerHTML.includes('data-file-menu'), present.outerHTML);
  const generated = renderToolCall('imageGeneration', {});
  applyToolResult(generated, { text: '{}', images: [{ url: '/local-file?path=C%3A%5Cgen%5Cimg.png', path: 'C:\\gen\\img.png' }] });
  assert(generated.outerHTML.includes('data-file-path="C:\\gen\\img.png"') && generated.outerHTML.includes('file-where'), generated.outerHTML);
  t.ok('本文の画像・読む/書く/編集の対象・添付・生成画像がパスを持ち、所在の一行か ⋯ を出す', true);

  // ---- 操作メニュー
  const run = () => {};
  assert.deepEqual(labels(fileMenuItems({ path: 'D:/a/page.html' }, { osActions: true, run })),
    ['ブラウザーで開く', 'プレビューで開く', 'エクスプローラーで表示', 'パスをコピー', '相対パスをコピー', '保存', '会話で使う']);
  assert.deepEqual(labels(fileMenuItems({ path: 'D:/a/page.html' }, { osActions: true, current: true, run })).slice(0, 2), ['ブラウザーで開く', 'エクスプローラーで表示'], '表示中はプレビューを出さない');
  assert.deepEqual(labels(fileMenuItems({ path: 'D:/a/doc.md' }, { osActions: true, run })).slice(0, 2), ['右パネルで開く', 'エクスプローラーで表示'], 'HTML 以外は今までどおり');
  assert.deepEqual(labels(fileMenuItems({ path: 'D:/a/page.html' }, { osActions: false, run })),
    ['右パネルで開く', 'パスをコピー', '相対パスをコピー', '保存', '会話で使う']);
  assert.deepEqual(labels(fileMenuItems({ path: 'D:/a', kind: 'directory' }, { osActions: true, current: true, run })),
    ['エクスプローラーで開く', 'パスをコピー', '相対パスをコピー']);
  assert(!labels(fileMenuItems({ path: 'D:/a/run.bat' }, { osActions: true, run })).includes('ブラウザーで開く'));
  const seps = fileMenuItems({ path: 'D:/a', kind: 'directory' }, { osActions: false, current: true, run });
  assert(!seps[0].sep && !seps.at(-1).sep);
  assert.equal(relativeTo('D:\\Dev\\app\\src\\a.ts', 'd:/dev/app'), 'src\\a.ts');
  assert.equal(relativeTo('/home/u/app/a.ts', '/home/u/app/'), 'a.ts');
  assert.equal(relativeTo('/home/u/other/a.ts', '/home/u/app'), null);
  assert(samePath('D:\\A\\b.md', 'd:/a/b.md') && !samePath('/a/B.md', '/a/b.md'));
  t.ok('メニュー: 遠隔では OS の操作を出さない・HTML だけブラウザー・フォルダーは「開く」で保存なし・表示中は右パネルを出さない', true);

  const sent = [], tabs = [];
  const openCmd = async (command, args) => { sent.push([command, args]); return { path:'D:\\work\\a #?.html' }; };
  const openTab = (url, options) => { tabs.push([url, options]); return true; };
  assert.equal(fileUrl('D:\\work\\a #?.html'), 'file:///D:/work/a%20%23%3F.html');
  assert.equal(fileUrl('D:\\work\\100%.html'), 'file:///D:/work/100%25.html');
  await openHostFile('openPath', { path:'page.html' }, { cmd:openCmd, inApp:true, openInPanel:openTab });
  assert.deepEqual(sent, [['openPath', { path:'page.html', returnPath:true }]]);
  assert.deepEqual(tabs, [['file:///D:/work/a%20%23%3F.html', { newTab:true, reuse:false }]]);
  sent.length = 0;
  await openHostFile('openVisualization', { sessionId:'s', id:'v' }, { cmd:openCmd, inApp:true, openInPanel:openTab });
  assert.deepEqual(sent, [['openVisualization', { sessionId:'s', id:'v', returnPath:true }]]);
  sent.length = 0;
  // 同じファイル・同じ記録のタブを使い回す指定と、タブの印（⋯ のファイルの操作とアドレス欄）
  tabs.length = 0;
  const opened = await openHostFile('openPath', { path:'page.html' }, { cmd:async () => ({ path:'D:\\work\\sub\\a.html', cwd:'D:\\work' }), inApp:true, openInPanel:openTab, reuse:true,
    source:found => ({ kind:'file', label:displayPath(found.path, found.cwd) }) });
  assert.deepEqual(tabs, [['file:///D:/work/sub/a.html', { newTab:true, reuse:true, source:{ kind:'file', label:'sub/a.html' } }]]);
  assert.equal(opened.inApp, true, '内蔵ブラウザーで開けたと分かる（リンクに「表示中」を添える）');
  assert.equal(displayPath('D:\\w\\x\\a.html', 'D:\\w'), 'x/a.html'); assert.equal(displayPath('E:\\o\\a.html', 'D:\\w'), 'E:/o/a.html', '外は完全なパス');
  sent.length = 0;
  await openHostFile('openPath', { path:'page.html' }, { cmd:openCmd });
  assert.deepEqual(sent, [['openPath', { path:'page.html' }]], '既定のブラウザーは従来の経路');
  sent.length = 0;
  await openHostFile('openPath', { path:'page.html' }, { cmd:openCmd, inApp:true, openInPanel:() => false });
  assert.deepEqual(sent, [['openPath', { path:'page.html', returnPath:true }], ['openPath', { path:'page.html' }]], '内蔵ブラウザーを開けなければ既定へ');
  // 内蔵ブラウザーの ⋯ のファイルの操作（画面が開いた PC のファイル・可視化の写しのタブだけ）
  assert.deepEqual(labels(browserTabMenuItems('file', {}, { osActions: true, run })),
    ['原文を見る', 'エクスプローラーで表示', 'パスをコピー', '相対パスをコピー', '保存', '会話で使う']);
  assert.deepEqual(labels(browserTabMenuItems('file', {}, { osActions: false, canUse: false, run })), ['原文を見る', 'パスをコピー', '相対パスをコピー', '保存']);
  assert.deepEqual(labels(browserTabMenuItems('snapshot', { origin: 'D:/w/a.html', hasHtml: true }, { osActions: true, run })),
    ['原文を見る', '元のファイルを開く', 'エクスプローラーで表示', '元のパスをコピー', '相対パスをコピー', 'HTML を保存', '会話で使う']);
  assert.deepEqual(labels(browserTabMenuItems('snapshot', { origin: null, hasHtml: true }, { osActions: true, run })), ['原文を見る', 'HTML を保存'], '元が分からない写しは元のパスの操作を出さない');
  assert.deepEqual(labels(browserTabMenuItems('snapshot', { origin: 'D:/w/a.html', hasHtml: false }, { osActions: false, run })), ['元のファイルを開く', '元のパスをコピー', '相対パスをコピー', '会話で使う'], '手元に中身が無ければ原文と保存は出さない');
  t.ok('設定に応じた開き先と、検査済みパスの file: URL・新しいタブを使う・同じファイルのタブの使い回しと印・内蔵ブラウザーの ⋯ のファイルの操作', true);

  // ---- 起動の組み立て（起動はしない）
  const env = { SystemRoot: 'C:\\Windows' };
  const reveal = launchPlan('reveal', 'C:/a b/c&d%PATH%^.png', { platform: 'win32', env });
  assert.equal(reveal.command, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(reveal.args, ['/select,"C:\\a b\\c&d%PATH%^.png"']);
  assert.equal(reveal.options.windowsVerbatimArguments, true); assert.equal(reveal.options.shell, false); assert.equal(reveal.options.detached, true);
  assert.deepEqual(launchPlan('reveal', 'C:\\a b', { platform: 'win32', env, directory: true }).args, ['"C:\\a b"']);
  assert.deepEqual(launchPlan('open', 'C:\\a\\page.HTML', { platform: 'win32', env }).args, ['"C:\\a\\page.HTML"']);
  for (const [action, file, options] of [['open', 'C:\\a\\run.bat'], ['open', 'C:\\a\\x.lnk'], ['open', 'C:\\a\\dir.html', { directory: true }], ['reveal', 'C:\\a\\"x'], ['reveal', 'C:\\a\nb']]) {
    assert.throws(() => launchPlan(action, file, { platform: 'win32', env, ...options }), undefined, file);
  }
  assert.deepEqual(launchPlan('reveal', '/Users/u/a.png', { platform: 'darwin' }), { command: '/usr/bin/open', args: ['-R', '/Users/u/a.png'], options: launchPlan('reveal', '/x', { platform: 'darwin' }).options });
  assert.deepEqual(launchPlan('reveal', '/home/u/a.png', { platform: 'linux' }).args, ['/home/u']);
  assert.deepEqual(launchPlan('open', '/home/u/a.html', { platform: 'linux' }).args, ['/home/u/a.html']);
  t.ok('explorer.exe は絶対パス・/select,"…" を verbatim・シェルなし・切り離し。開けるのは HTML だけ', true);

  const fakeSpawn = (outcome) => (command, args, options) => {
    const child = new EventEmitter(); child.unref = () => { child.unrefed = true; };
    fakeSpawn.last = { command, args, options, child };
    queueMicrotask(() => { if (outcome === 'error') child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })); else { child.emit('spawn'); child.emit('exit', 1); } });
    return child;
  };
  await launch(reveal, { spawnImpl: fakeSpawn('ok') });
  assert(fakeSpawn.last.child.unrefed);
  await assert.rejects(launch(reveal, { spawnImpl: fakeSpawn('error') }), /ENOENT/);
  t.ok('起動できれば成功（終了コード 1 は失敗にしない）。起動できなければ失敗', true);

  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers });
  assert(isLocalRequest(req('127.0.0.1')) && isLocalRequest(req('::1')) && isLocalRequest(req('::ffff:127.0.0.1')));
  assert(!isLocalRequest(req('192.168.1.5')) && !isLocalRequest(req('::ffff:10.0.0.1')) && !isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })) && !isLocalRequest(undefined));
  let clock = 0;
  const allowed = createRateLimit({ limit: 3, windowMs: 1000, now: () => clock });
  assert.deepEqual([allowed(), allowed(), allowed(), allowed()], [true, true, true, false]);
  clock = 1500; assert.equal(allowed(), true);
  t.ok('ループバックで中継なしだけを「この PC」とみなす。短い時間の連打を断る', true);

  // ---- デスクトップ版（main）の確かめ直し
  const stat = kind => () => ({ isDirectory: () => kind === 'dir', isFile: () => kind === 'file' });
  assert.equal(checkRequest({ action: 'open', path: path.resolve('/x/page.html') }, { stat: stat('file') }).action, 'open');
  for (const message of [{ action: 'open', path: path.resolve('/x/run.bat') }, { action: 'open', path: path.resolve('/x/dir.html') }, { action: 'reveal', path: 'relative/a.md' }, { action: 'reveal', path: '\\\\host\\share\\a' }, { action: 'exec', path: path.resolve('/x/a') }]) {
    assert.throws(() => checkRequest(message, { stat: stat(message.path.endsWith('dir.html') ? 'dir' : 'file') }), undefined, message.path);
  }
  const calls = [];
  const shell = { showItemInFolder: p => calls.push(['show', p]), openPath: async p => { calls.push(['open', p]); return p.includes('broken') ? 'no handler' : ''; } };
  const handle = createFileHandler({ shell, stat: stat('file') });
  assert.deepEqual(await handle({ id: 1, action: 'reveal', path: path.resolve('/x/a.png') }), { type: 'os-open', id: 1, ok: true });
  assert.deepEqual(await handle({ id: 2, action: 'open', path: path.resolve('/x/a.html') }), { type: 'os-open', id: 2, ok: true });
  assert.deepEqual(await handle({ id: 3, action: 'open', path: path.resolve('/x/broken.html') }), { type: 'os-open', id: 3, ok: false, code: 'open-failed', detail: 'no handler' });
  assert.equal((await handle({ id: 4, action: 'open', path: path.resolve('/x/a.exe') })).code, 'html-only');
  // 本体は言語を知らない。文言はサーバーが code から引く
  assert.match(bridgeError({ code: 'html-only' }), /HTML/);
  assert.match(bridgeError({ code: 'open-failed', detail: 'no handler' }), /no handler/);
  assert.deepEqual(calls.map(c => c[0]), ['show', 'open', 'open']);
  t.ok('デスクトップ版: 本体も絶対パス・実在・HTML だけを確かめ、showItemInFolder / openPath を使う', true);

  // ---- サーバー（起動はしない: AGENT_HOST_OS_OPEN=dry）
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-file-actions-'));
  const work = path.join(scratch, 'work'), outside = path.join(scratch, 'outside'), data = path.join(scratch, 'data');
  await Promise.all([work, outside, data, path.join(work, 'sub')].map(p => fs.mkdir(p, { recursive: true })));
  await fs.writeFile(path.join(work, 'page.html'), '<link rel="stylesheet" href="style.css"><img src="proof.svg"><script src="script.js"></script>');
  await fs.writeFile(path.join(work, 'style.css'), 'body { color: red; }');
  await fs.writeFile(path.join(work, 'script.js'), 'window.proof = true;');
  await fs.writeFile(path.join(work, 'proof.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await fs.writeFile(path.join(work, 'run.bat'), 'echo x');
  await fs.writeFile(path.join(outside, 'secret.html'), 'secret');
  await fs.writeFile(path.join(data, 'secret.html'), 'private');
  await fs.symlink(outside, path.join(work, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.symlink(data, path.join(work, 'private'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.writeFile(path.join(data, 'sessions.json'), JSON.stringify({ fixture: { cwd: work, backend: 'fake' } }));
  const server = await startServer({ dataDir: data, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_OS_OPEN: 'dry' } });
  let client, remote;
  try {
    client = await openWs({ port: server.port, token: server.token });
    const real = p => fs.realpath(p);
    // npm start（デスクトップ版でない）には内蔵ブラウザーが無いので pcBrowser は false
    assert.deepEqual(await client.cmd('hostCapabilities'), { osActions: true, hostName: os.hostname(), pcBrowser: false, chromeBrowser: false, computerUse: { supported: false, reason: 'desktop' } });
    assert.equal((await client.cmd('revealPath', { path: path.join(outside, 'secret.html') })).path, await real(path.join(outside, 'secret.html')));
    assert.equal((await client.cmd('revealPath', { path: 'sub', sessionId: 'fixture' })).path, await real(path.join(work, 'sub')));
    assert.equal((await client.cmd('openPath', { path: 'escape/secret.html:3', sessionId: 'fixture' })).path, await real(path.join(outside, 'secret.html')));
    assert.equal((await client.cmd('openPath', { path:'./escape/secret.html', sessionId:'fixture', returnPath:true })).path, await real(path.join(outside, 'secret.html')));
    const opened = await client.cmd('openPath', { path:'page.html', sessionId:'fixture', returnPath:true });
    assert.equal(path.resolve(opened.cwd), path.resolve(work), '作業ディレクトリも返す（内蔵ブラウザーのタブの相対パス。docs/inapp-browser.md）');
    const htmlUrl = fileUrl(opened.path);
    assert((await fs.readFile(new URL(htmlUrl), 'utf8')).includes('style.css'));
    assert((await fs.readFile(new URL('./style.css', htmlUrl), 'utf8')).includes('color: red'));
    assert((await fs.readFile(new URL('./script.js', htmlUrl), 'utf8')).includes('window.proof'));
    assert((await fs.readFile(new URL('./proof.svg', htmlUrl), 'utf8')).includes('<svg'));
    t.ok('検査済み HTML の file: URL から相対 CSS・JS・画像を同じフォルダーで解決する', true);
    const resolved = await client.cmd('resolvePath', { path: './page.html', sessionId: 'fixture' });
    assert.deepEqual(resolved, { path: await real(path.join(work, 'page.html')), cwd: work, kind: 'file' });
    assert.equal((await client.cmd('resolvePath', { path: path.join(work, 'escape', 'secret.html') })).path, await real(path.join(outside, 'secret.html')));
    t.ok('作業場所外も実体を解決して通す（相対は会話の作業ディレクトリ、フォルダーも可）', true);

    await assert.rejects(client.cmd('revealPath', { path: path.join(data, 'secret.html') }), /データ置き場/);
    await assert.rejects(client.cmd('openPath', { path: path.join(work, 'private', 'secret.html') }), /データ置き場/);
    await assert.rejects(client.cmd('openPath', { path: path.join(work, 'private', 'secret.html'), returnPath:true }), /データ置き場/);
    await assert.rejects(client.cmd('resolvePath', { path: path.join(work, 'private', 'secret.html') }), /データ置き場/);
    await assert.rejects(client.cmd('openPath', { path: path.join(work, 'run.bat') }), /HTML だけ/);
    await assert.rejects(client.cmd('openPath', { path: path.join(work, 'run.bat'), returnPath:true }), /HTML だけ/);
    await assert.rejects(client.cmd('openPath', { path: path.join(work, 'sub') }), /HTML だけ/);
    await assert.rejects(client.cmd('revealPath', { path: '\\\\host\\share\\a.html' }), /UNC/);
    await assert.rejects(client.cmd('revealPath', { path: path.join(work, 'missing.html') }), /見つかりません/);
    t.ok('データ置き場はリンク経由も拒否。HTML 以外の「開く」・UNC・無いファイルも断る', true);

    // 中継を通った接続（遠隔）は断る。画面に出さないだけでなく、サーバーが断る
    remote = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${server.token}`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const replies = new Map();
    await new Promise((resolve, reject) => { remote.once('error', reject); remote.on('message', raw => { const m = JSON.parse(raw); if (m.kind === 'ready') resolve(); if (m.kind === 'response') replies.get(m.id)?.(m); }); });
    const ask = (command, args) => new Promise(resolve => { const id = `r${replies.size + 1}`; replies.set(id, resolve); remote.send(JSON.stringify({ kind: 'command', command, id, args })); });
    assert.deepEqual((await ask('hostCapabilities', {})).result, { osActions: false, hostName: os.hostname(), pcBrowser: false, chromeBrowser: false, computerUse: { supported: false, reason: 'desktop' } });
    const refused = await ask('revealPath', { path: path.join(work, 'page.html') });
    assert(!refused.ok && /サーバーのある PC/.test(refused.error), JSON.stringify(refused));
    assert.equal((await ask('openPath', { path: path.join(work, 'page.html') })).ok, false);
    assert.equal((await ask('openPath', { path: path.join(work, 'page.html'), returnPath:true })).ok, false);
    assert.equal((await ask('resolvePath', { path: path.join(work, 'page.html') })).ok, true);
    t.ok('遠隔（ループバック以外・中継経由）からの OS の操作はサーバーが断る。パスの解決はできる', true);

    // 連打: 10 秒に 5 回まで（ここまでに 5 回通っている）
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await client.cmd('revealPath', { path: path.join(work, 'page.html') }).then(() => 'ok', e => e.message));
    assert(/続けて開きすぎ/.test(results[0]), results.join(' / '));
    t.ok('短い時間に何度も開かせない', true, results.at(-1));
  } finally {
    client?.close?.(); remote?.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
