// 起動の読み込み（load）の途中に書き込みが入る競合と、agy の控えの保存の rename の失敗。
//   - ルーティン・bot の保存: load と同時に始めた put が、load の完了で消えない（メモリにもファイルにも残る）。タイミングに頼らず、
//     readFile / mkdir を差し替えて「読んでいる途中」「put が mkdir を待っている途中」に load / put を差し込む
//   - agy の控え: Windows で置き換え先を開いている間だけ rename が EPERM になる。再試行して最後の本文を残す（core/atomic-file.mjs の writeAtomic）
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRoutineStore } from '../../core/routines/store.mjs';
import { createBotStore } from '../../core/bots/store.mjs';

export const name = 'store-load-races';
export const title = '起動の読み込みと書き込みの競合（ルーティン・bot）: 読み込みの途中の作成が消えない／agy の控えは rename の EPERM を再試行して残す';

const routine = (id, extra = {}) => ({ id, name: id, botId: 'b_1', channelId: 'c_1', prompt: 'まとめて', trigger: { kind: 'cron', expr: '* * * * *' }, createdAt: 1, ...extra });
const bot = (id, name) => ({ id, name, icon: '🦉', persona: '', backend: 'fake', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [], createdAt: 1, updatedAt: 1 });
const idsOf = (list) => list.map((x) => x.id).sort().join();
const fileIds = async (file, key) => idsOf(JSON.parse(await fs.readFile(file, 'utf8'))[key]);

/** fs.promises の関数を一時的に差し替える（store は `fs.xxx` を呼ぶ時に引くので効く）。戻す関数を返す */
function patch(name, make) {
  const original = fs[name];
  fs[name] = make(original);
  return () => { fs[name] = original; };
}
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

const STORES = [
  { label: 'ルーティン', key: 'routines', create: (file) => createRoutineStore({ file }), item: routine, file: 'routines.json' },
  { label: 'bot', key: 'bots', create: (file) => createBotStore({ file }), item: (id) => bot(id, id), file: 'bots.json' },
];

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'store-load-races-'));
  const savedData = process.env.AGENT_HOST_DATA;
  try {
    for (const s of STORES) {
      // ---- 1. 保存の途中（mkdir を待っている間）に load が入る。ファイルが無い場合
      {
        const file = path.join(root, 'a', s.file);
        const store = s.create(file);
        const mkdirGate = gate();
        const restore = patch('mkdir', (orig) => async (...args) => { await mkdirGate.p; return orig(...args); });
        let put, load;
        try {
          put = store.put(s.item('x1'));
          load = store.load();
          await new Promise((r) => setTimeout(r, 30));   // put が mkdir を待ち、load が走れる状態になるまで
          mkdirGate.open();
          await Promise.all([put, load]);
        } finally { restore(); }
        assert.equal(idsOf(store.list()), 'x1', `${s.label}: 保存の途中の load で作ったものがメモリから消えない`);
        assert.equal(await fileIds(file, s.key), 'x1', `${s.label}: 保存の途中の load で作ったものがファイルから消えない`);
      }

      // ---- 2. 保存の途中に load が入る。ファイルに先の 1 件がある場合（読み込みの結果と合わさる）
      {
        const file = path.join(root, 'b', s.file);
        const first = s.create(file);
        await first.load();
        await first.put(s.item('old'));
        const store = s.create(file);
        const mkdirGate = gate();
        const restore = patch('mkdir', (orig) => async (...args) => { await mkdirGate.p; return orig(...args); });
        try {
          const put = store.put(s.item('new'));
          const load = store.load();
          await new Promise((r) => setTimeout(r, 30));
          mkdirGate.open();
          await Promise.all([put, load]);
        } finally { restore(); }
        assert.equal(idsOf(store.list()), 'new,old', `${s.label}: 先にあった 1 件と作った 1 件がメモリで揃う`);
        assert.equal(await fileIds(file, s.key), 'new,old', `${s.label}: ファイルでも揃う`);
      }

      // ---- 3. 読んでいる途中（readFile が返る前）に put が入る
      {
        const file = path.join(root, 'c', s.file);
        const first = s.create(file);
        await first.load();
        await first.put(s.item('old'));
        const store = s.create(file);
        const readGate = gate();
        const restore = patch('readFile', (orig) => async (...args) => {
          const text = await orig(...args);   // 古い内容を読み終えたところで止める
          await readGate.p;
          return text;
        });
        let load, put;
        try {
          load = store.load();
          await new Promise((r) => setTimeout(r, 30));
          put = store.put(s.item('new'));
          await new Promise((r) => setTimeout(r, 30));
          readGate.open();
          await Promise.all([load, put]);
        } finally { restore(); }
        assert.equal(idsOf(store.list()), 'new,old', `${s.label}: 読み込みの途中に作ったものが、読み込みの完了で消えない`);
        assert.equal(await fileIds(file, s.key), 'new,old', `${s.label}: 読み込みの途中に作ったものがファイルに残る`);
      }

      // ---- 4. 読めない版の load は、待たせていた書き込みを断る（上書きして消さない）
      {
        const file = path.join(root, 'd', s.file);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, '{ not json');
        const store = s.create(file);
        const load = store.load().then(() => null, (e) => e.code);
        const put = store.put(s.item('x')).then(() => null, (e) => e.code);
        assert.match(String(await load), /CORRUPT/, `${s.label}: 壊れた JSON は load が止める`);
        assert.match(String(await put), /CORRUPT/, `${s.label}: 壊れたままの保存へ書き込まない`);
        assert.equal(await fs.readFile(file, 'utf8'), '{ not json', `${s.label}: 壊れたファイルは上書きしない`);
      }
      t.ok(`${s.label}の保存: 読み込みと同時・途中の作成が、読み込みの完了で消えない（メモリにもファイルにも残る）`, true);
    }

    // ---- agy の控え: rename が一時的に EPERM でも最後の本文が残る
    process.env.AGENT_HOST_DATA = path.join(root, 'data');
    const agy = await import('../../core/backends/antigravity-store.mjs');
    const id = 'conv-eperm';
    const msg = (uuid, text) => ({ uuid, role: 'assistant', text });
    await agy.appendMessages(id, { cwd: root, messages: [msg('m1', '前置き。')] });
    let failures = 0;
    const restore = patch('rename', (orig) => async (from, to) => {
      if (String(to).endsWith(`${id}.json`) && failures < 2) { failures++; throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }); }
      return orig(from, to);
    });
    try { await agy.appendMessages(id, { cwd: root, messages: [msg('m2', '終わり。')] }); }
    finally { restore(); }
    assert.equal(failures, 2, 'rename は 2 回 EPERM で失敗させた');
    assert.deepEqual((await agy.getMessages(id)).map((m) => m.text), ['前置き。', '終わり。'], 'agy の控え: rename の EPERM を再試行して最後の本文が残る');
    const left = (await fs.readdir(path.join(root, 'data', 'antigravity'))).filter((n) => n.endsWith('.tmp'));
    assert.deepEqual(left, [], 'agy の控え: 一時ファイルを残さない');
    t.ok('agy の控え: 置き換え先を開かれていて rename が EPERM でも、再試行して最後の本文を保存する（一時ファイルは残さない）', true);
  } finally {
    if (savedData === undefined) delete process.env.AGENT_HOST_DATA; else process.env.AGENT_HOST_DATA = savedData;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10 }).catch(() => {});
  }
}
