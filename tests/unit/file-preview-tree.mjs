// プレビューの横のツリー（core/file-preview.mjs の buildTree・listTreeFolder と /file-preview?list=1）。
// 見るのは: 開いたファイルまでの経路の段は必ず中身を返す・深さの上限が無い・ほかのフォルダーは lazy・
// 除外名のフォルダーは経路だけ・1 フォルダーの件数の枠と枠の外の経路の足し込み・続きの読み込み・roots の外は読めない
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readPreview, listTreeFolder, TREE_PAGE } from '../../core/file-preview.mjs';
import { startServer } from '../lib/server.mjs';

export const name = 'file-preview-tree';
export const title = 'プレビューのツリー: 経路の段・遅延読み込み・件数の枠・除外名の経路';

const find = (nodes, id) => {
  for (const n of nodes ?? []) {
    if (n.id === id) return n;
    const hit = find(n.children, id);
    if (hit) return hit;
  }
  return null;
};

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-tree-')));
  const ws = path.join(scratch, 'ws'), data = path.join(scratch, 'data');
  const deepDir = path.join(ws, 'a', 'b', 'c', 'd', 'e', 'f');
  await fs.mkdir(deepDir, { recursive: true });
  await fs.mkdir(data);
  await fs.writeFile(path.join(deepDir, 'deep.md'), '# deep');
  await fs.writeFile(path.join(ws, 'top.md'), '# top');
  await fs.mkdir(path.join(ws, 'big'));
  for (let i = 0; i < 450; i++) await fs.writeFile(path.join(ws, 'big', `f${String(i).padStart(3, '0')}.txt`), '');
  await fs.mkdir(path.join(ws, 'dirs'));
  for (let i = 0; i < 250; i++) await fs.mkdir(path.join(ws, 'dirs', `d${String(i).padStart(3, '0')}`));
  await fs.writeFile(path.join(ws, 'dirs', 'd230', 'in.md'), '# in');
  await fs.mkdir(path.join(ws, 'temporary', 'notes'), { recursive: true });
  await fs.writeFile(path.join(ws, 'temporary', 'notes', 'x.md'), '# x');
  await fs.writeFile(path.join(ws, 'temporary', 'other.md'), '# other');
  await fs.mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(ws, 'node_modules', 'pkg', 'index.js'), '');
  await fs.mkdir(path.join(ws, 'private'));
  await fs.writeFile(path.join(ws, 'private', 'secret.txt'), 'secret');
  await fs.mkdir(path.join(scratch, 'outside'));
  const access = { dataDir: path.join(ws, 'private') };
  const open = (file) => readPreview(file, [ws], { access });

  try {
    // ---- 経路の段・深さ ----
    const deep = await open(path.join(deepDir, 'deep.md'));
    const [root] = deep.tree;
    t.ok('根は作業場所で開いている', root.id === ws && root.open === true);
    t.ok('深さ 7 のファイルもツリーに入る', !!find(deep.tree, path.join(deepDir, 'deep.md')));
    let dir = ws, ok = true;
    for (const step of ['a', 'b', 'c', 'd', 'e', 'f']) {
      dir = path.join(dir, step);
      const node = find(deep.tree, dir);
      ok &&= Array.isArray(node?.children) && !node.lazy;
    }
    t.ok('経路の各段のフォルダーは中身を持つ', ok);
    const big = find(deep.tree, path.join(ws, 'big'));
    t.ok('経路の外のフォルダーは中身を返さず lazy（空の [] と区別する）', big.lazy === true && big.children === undefined);
    t.ok('除外名は出さない', !root.children.some(n => n.name === 'node_modules' || n.name === 'temporary'));
    t.ok('データ置き場は出さない', !root.children.some(n => n.name === 'private'));
    t.ok('フォルダーが先、名前順', root.children.map(n => n.name).join() === 'a,big,dirs,top.md', root.children.map(n => n.name).join());

    const top = await open(path.join(ws, 'top.md'));
    t.ok('根の直下のファイルも入り、ほかのフォルダーは読まない', !!find(top.tree, path.join(ws, 'top.md')) && find(top.tree, path.join(ws, 'a')).lazy === true);
    const folder = await open(path.join(ws, 'a'));
    t.ok('フォルダーを開いたときは、そのフォルダーの行まで（中身は開いたときに読む）', find(folder.tree, path.join(ws, 'a'))?.lazy === true);

    // ---- 件数の枠と枠の外の足し込み ----
    const inBig = await open(path.join(ws, 'big', 'f420.txt'));
    const bigNode = find(inBig.tree, path.join(ws, 'big'));
    const last = bigNode.children.at(-1);
    t.ok(`1 フォルダーは ${TREE_PAGE} 件で打ち切る`, bigNode.children.length === TREE_PAGE + 1, String(bigNode.children.length));
    t.ok('枠の外の開いたファイルは末尾に足す（pinned）', last.name === 'f420.txt' && last.pinned === true);
    t.ok('続きの件数は足した行を数えない', bigNode.more === 450 - TREE_PAGE - 1 && bigNode.next === TREE_PAGE, `${bigNode.more} ${bigNode.next}`);
    const inDirs = await open(path.join(ws, 'dirs', 'd230', 'in.md'));
    const d230 = find(inDirs.tree, path.join(ws, 'dirs', 'd230'));
    t.ok('枠の外の経路のフォルダーも足し、その中身も返す', d230?.pinned === true && d230.children?.[0]?.name === 'in.md');

    // ---- 除外名のフォルダーは経路だけ ----
    const inTemp = await open(path.join(ws, 'temporary', 'notes', 'x.md'));
    const temp = find(inTemp.tree, path.join(ws, 'temporary'));
    t.ok('除外名のフォルダーに入ったら経路を出し、pathOnly を付ける', temp?.pathOnly === true);
    t.ok('除外名のフォルダーの中は経路だけ（兄弟は出さない）', temp.children.map(n => n.name).join() === 'notes'
      && find(inTemp.tree, path.join(ws, 'temporary', 'notes')).children.map(n => n.name).join() === 'x.md');
    t.ok('ほかの除外名は出さないまま', !find(inTemp.tree, path.join(ws, 'node_modules')));

    // ---- 遅延読み込み・続き・範囲 ----
    const lazy = await listTreeFolder(path.join(ws, 'a'), [ws], { access });
    t.ok('フォルダーを 1 つ読む', lazy.children.map(n => n.name).join() === 'b' && lazy.children[0].lazy === true && lazy.more === 0);
    const page2 = await listTreeFolder(path.join(ws, 'big'), [ws], { access, offset: TREE_PAGE });
    const page3 = await listTreeFolder(path.join(ws, 'big'), [ws], { access, offset: TREE_PAGE * 2 });
    t.ok('offset から続きを読む', page2.children[0].name === 'f200.txt' && page2.next === TREE_PAGE * 2 && page2.more === 450 - TREE_PAGE * 2);
    t.ok('最後のページは続きが無い', page3.children.length === 50 && page3.more === 0 && page3.next === null);
    await assert.rejects(listTreeFolder(path.join(scratch, 'outside'), [ws], { access }), { code: 'outside-tree' });
    await assert.rejects(listTreeFolder(path.join(ws, 'private'), [ws], { access }), { code: 'protected-data' });
    await assert.rejects(listTreeFolder(path.join(ws, 'top.md'), [ws], { access }), { code: 'not-directory' });
    t.ok('roots の外・データ置き場・ファイルは読めない', true);

    // ---- サーバーの口（/file-preview?list=1） ----
    await fs.writeFile(path.join(data, 'sessions.json'), JSON.stringify({ fixture: { cwd: ws, backend: 'fake' } }));
    const server = await startServer({ dataDir: data, env: { AGENT_HOST_BACKENDS: 'fake' } });
    try {
      const auth = { headers: { cookie: `agent_host_token=${server.token}` } };
      const url = (p, extra = {}) => `http://127.0.0.1:${server.port}/file-preview?${new URLSearchParams({ path: p, sessionId: 'fixture', list: '1', ...extra })}`;
      assert.equal((await fetch(url(path.join(ws, 'a')))).status, 401);
      const listed = await (await fetch(url(path.join(ws, 'a')), auth)).json();
      assert.deepEqual(listed.children.map(n => n.name), ['b']);
      const more = await (await fetch(url(path.join(ws, 'big'), { offset: String(TREE_PAGE) }), auth)).json();
      assert.equal(more.children[0].name, 'f200.txt');
      const outside = await fetch(url(path.join(scratch, 'outside')), auth);
      assert.equal(outside.status, 400);
      assert.equal((await outside.json()).error.code, 'outside-tree');
      const preview = await (await fetch(url(path.join(deepDir, 'deep.md'), { list: '0' }), auth)).json();
      assert(find(preview.tree, path.join(deepDir, 'deep.md')));
      t.ok('サーバーの口: 認証が要る・1 フォルダーと続きを返す・作業場所の外は 400', true);
    } finally { await server.stop(); }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
