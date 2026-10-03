// bot の定義の保存（core/bots/store.mjs。bots.json）: 追加・更新・削除・名前の一意（NFKC・大小）・予約名・読めない版は上書きしない・
// 同時の書き込みの直列化・保存に失敗したら巻き戻す・フォルダーの整え方。docs/channels.md
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBotStore, normalizeBot, normalizeFolders, nameProblem, iconProblem, personaProblem, nameKey, BotStoreError, PERSONA_MAX_CHARS } from '../../core/bots/store.mjs';

export const name = 'bots-store';
export const title = 'bot の定義の保存: 名前の一意・予約名・読めない bots.json は上書きしない・同時の作成の直列化・保存失敗の巻き戻し';

const bot = (id, name, extra = {}) => ({ id, name, icon: '🦉', persona: '', backend: 'fake', model: '', effort: '', mode: 'default', folders: [], sendToOthers: true, sendTargets: [],
  dmChannelId: '', dmSessionId: null, createdAt: 1, updatedAt: 1, ...extra });
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof BotStoreError ? e.code : `other:${e?.message}`; } };

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bots-store-'));
  try {
    const file = path.join(dir, 'bots.json');
    const store = createBotStore({ file });
    await store.load();
    t.ok('無ければ空で始まる', store.list().length === 0 && store.problem === null);

    // ---- 追加・取得
    await store.put(bot('b_1', 'Owl', { persona: 'のんびり' }));
    await store.put(bot('b_2', 'Fox'));
    t.ok('追加した bot を list・get・byName で引ける', store.list().length === 2 && store.get('b_1')?.persona === 'のんびり' && store.byName('Fox')?.id === 'b_2');
    t.ok('get は写し（書き換えても保存側は変わらない）', (() => { const b = store.get('b_1'); b.name = 'X'; return store.get('b_1').name === 'Owl'; })());
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('bots.json は { version: 1, bots }', saved.version === 1 && saved.bots.length === 2);

    // ---- 名前の一意（NFKC・大小を区別しない）
    t.ok('同じ名前は BOT_NAME_TAKEN', (await code(() => store.put(bot('b_3', 'Owl')))) === 'BOT_NAME_TAKEN');
    t.ok('大小・全角半角が違うだけの名前も重なる', (await code(() => store.put(bot('b_3', 'ＯＷＬ')))) === 'BOT_NAME_TAKEN' && (await code(() => store.put(bot('b_3', 'owl')))) === 'BOT_NAME_TAKEN');
    t.ok('自分の名前のままの置き換えは通る', (await code(() => store.put(bot('b_1', 'Owl', { persona: '変えた' })))) === null && store.get('b_1').persona === '変えた');
    t.ok('update で別の bot の名前にはできない', (await code(() => store.update('b_1', (b) => ({ ...b, name: 'fox' })))) === 'BOT_NAME_TAKEN' && store.get('b_1').name === 'Owl');
    t.ok('nameKey は NFKC・小文字', nameKey(' ＯＷＬ ') === 'owl');

    // ---- 名前・アイコン・人格の検査
    t.ok('名前: 空・前後の空白・空白を含む・@ や句読点・長すぎる・予約名を断る',
      ['', ' a', 'a b', 'a@b', 'a,b', 'a。', 'あ'.repeat(33), 'you', 'あなた', 'YOU'].every((n) => nameProblem(n) !== null));
    t.ok('名前: 普通の名前・日本語・絵文字を含まない記号は通る', ['Owl', 'ふくろう', 'bot-1', 'レビュアー_2'].every((n) => nameProblem(n) === null));
    t.ok('アイコン: 絵文字 1 つだけ', iconProblem('🦉') === null && iconProblem('') !== null && iconProblem('🦉🦊') !== null && iconProblem('a') !== null);
    t.ok('人格: 上限を超えると断る', personaProblem('あ'.repeat(PERSONA_MAX_CHARS)) === null && personaProblem('あ'.repeat(PERSONA_MAX_CHARS + 1)) !== null);

    // ---- update は直列化の中で現在の値を読む
    await store.update('b_2', (b) => ({ ...b, persona: 'a' }));
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.update('b_2', (b) => ({ ...b, persona: `${b.persona}${n}`, updatedAt: b.updatedAt + 1 }))));
    t.ok('同時の update が互いを巻き戻さない（5 回とも反映）', store.get('b_2').persona === 'a12345' && store.get('b_2').updatedAt === 6, store.get('b_2').persona);
    t.ok('update は id を変えられない', (await code(() => store.update('b_2', (b) => ({ ...b, id: 'b_9' })))) === 'BOT_INVALID');
    t.ok('無い bot の update は BOT_NOT_FOUND', (await code(() => store.update('b_nope', (b) => b))) === 'BOT_NOT_FOUND');

    // ---- 同時の作成: 同じ名前は 1 つだけ
    const race = await Promise.all(['Hawk', 'hawk', 'ＨＡＷＫ'].map((n, i) => code(() => store.put(bot(`b_h${i}`, n)))));
    t.ok('同じ名前の同時の作成は 1 つだけ通る', race.filter((r) => r === null).length === 1 && race.filter((r) => r === 'BOT_NAME_TAKEN').length === 2, race.join());

    // ---- 読み直し（再起動）
    const again = createBotStore({ file });
    await again.load();
    t.ok('読み直しても同じ', again.list().length === store.list().length && again.get('b_2').persona === 'a12345');

    // ---- 削除
    t.ok('remove は消した bot を返し、無ければ null', (await again.remove('b_1'))?.id === 'b_1' && (await again.remove('b_1')) === null && again.get('b_1') === null);
    t.ok('消した名前は使い回せる', (await code(() => again.put(bot('b_9', 'Owl')))) === null);

    // ---- 読めない bots.json は上書きしない
    const brokenFile = path.join(dir, 'broken', 'bots.json');
    await fs.mkdir(path.dirname(brokenFile), { recursive: true });
    await fs.writeFile(brokenFile, '{ not json');
    const broken = createBotStore({ file: brokenFile });
    t.ok('壊れた JSON は BOTS_CORRUPT で止まる', (await code(() => broken.load())) === 'BOTS_CORRUPT' && broken.problem?.code === 'BOTS_CORRUPT');
    t.ok('止まっている間は書かない（put・update・remove）', (await code(() => broken.put(bot('b_1', 'Owl')))) === 'BOTS_CORRUPT'
      && (await code(() => broken.update('b_1', (b) => b))) === 'BOTS_CORRUPT' && (await code(() => broken.remove('b_1'))) === 'BOTS_CORRUPT');
    t.ok('壊れたファイルはそのまま残る', (await fs.readFile(brokenFile, 'utf8')) === '{ not json');
    const futureFile = path.join(dir, 'future', 'bots.json');
    await fs.mkdir(path.dirname(futureFile), { recursive: true });
    await fs.writeFile(futureFile, JSON.stringify({ version: 2, bots: [] }));
    const future = createBotStore({ file: futureFile });
    t.ok('知らない版は BOTS_UNSUPPORTED_VERSION で止まり、上書きしない', (await code(() => future.load())) === 'BOTS_UNSUPPORTED_VERSION'
      && (await code(() => future.put(bot('b_1', 'Owl')))) === 'BOTS_UNSUPPORTED_VERSION' && JSON.parse(await fs.readFile(futureFile, 'utf8')).version === 2);

    // ---- S-7: 一時的に読めない（ENOENT 以外の読み取りの失敗）だけで「bot が 0 件」と見なして、次の保存で消さない
    const unreadableFile = path.join(dir, 'unreadable', 'bots.json');
    await fs.mkdir(unreadableFile, { recursive: true });   // ファイルの位置にフォルダーがある → EISDIR（読み取りの失敗の代わり。ウイルス対策の EBUSY・EACCES の再現は難しい）
    const unreadable = createBotStore({ file: unreadableFile });
    t.ok('S-7: ENOENT 以外の読み取りの失敗は BOTS_UNREADABLE で止まる（broken が立つ）', (await code(() => unreadable.load())) === 'BOTS_UNREADABLE' && unreadable.problem?.code === 'BOTS_UNREADABLE');
    t.ok('S-7: 止まっている間は書かない。bots.json の位置のものはそのまま', (await code(() => unreadable.put(bot('b_1', 'Owl')))) === 'BOTS_UNREADABLE'
      && (await code(() => unreadable.update('b_1', (b) => b))) === 'BOTS_UNREADABLE' && (await fs.stat(unreadableFile)).isDirectory());
    const hasBots = path.join(dir, 'hasbots');
    await fs.mkdir(path.join(hasBots, 'bots.json'), { recursive: true });
    const { createBotService } = await import('../../core/bots/service.mjs');
    const svc = createBotService({ dataDir: hasBots });
    await svc.start();
    t.ok('S-7: bots サービスは起動で読めなくても落ちず、problem を出し、bots.create は bots.json を上書きしない', svc.problem?.code === 'BOTS_UNREADABLE'
      && await svc.create({ name: 'Owl', backend: 'fake' }).then(() => false, (e) => e.code === 'BOTS_UNREADABLE') && (await fs.stat(path.join(hasBots, 'bots.json'))).isDirectory());
    const dropFile = path.join(dir, 'drop', 'bots.json');
    await fs.mkdir(path.dirname(dropFile), { recursive: true });
    await fs.writeFile(dropFile, JSON.stringify({ version: 1, bots: [bot('b_ok', 'Ok'), { name: 'id が無い' }, { id: 'b_noname' }] }));
    const logged = [];
    const origError = console.error;
    console.error = (...a) => { logged.push(a.join(' ')); };
    try { await createBotStore({ file: dropFile }).load(); } finally { console.error = origError; }
    t.ok('S-7: id か name が無い行は読み込まれない（次の保存で消える）ので、捨てた件数をログへ出す', logged.some((l) => /2 row\(s\)/.test(l)), logged.join('\n'));

    // 親がファイルのとき、Linux は ENOTDIR、Windows は ENOENT を返す。
    const blockedParent = path.join(dir, 'blocked-parent');
    await fs.writeFile(blockedParent, 'x');
    const blockedPath = path.join(blockedParent, 'bots.json');
    const readError = await fs.readFile(blockedPath).then(() => null, (e) => e.code);
    const blocked = createBotStore({ file: blockedPath });
    const loadError = await code(() => blocked.load());
    t.ok('親がファイルで ENOTDIR なら broken を立て、上書きしない', readError === 'ENOENT' ? loadError === null
      : readError === 'ENOTDIR' && loadError === 'BOTS_UNREADABLE' && blocked.problem?.code === 'BOTS_UNREADABLE'
        && (await code(() => blocked.put(bot('b_1', 'Owl')))) === 'BOTS_UNREADABLE' && (await fs.readFile(blockedParent, 'utf8')) === 'x', String(readError));

    // ---- 読み込み後に置き場が使えなくなって保存に失敗したら巻き戻す
    const blocker = path.join(dir, 'blocker');
    await fs.mkdir(blocker);
    const failing = createBotStore({ file: path.join(blocker, 'bots.json') });
    await failing.load();
    await fs.rmdir(blocker);
    await fs.writeFile(blocker, 'x');
    const failure = await code(() => failing.put(bot('b_1', 'Owl')));
    t.ok('保存できなければ追加は巻き戻る', failure !== null && failing.list().length === 0, String(failure));
    await fs.unlink(blocker);
    await fs.mkdir(blocker);
    t.ok('置き場が戻れば次の操作は通る', (await code(() => failing.put(bot('b_1', 'Owl')))) === null && failing.list().length === 1);

    // ---- 整え方（古い・足りない欄・知らない欄）
    t.ok('id か name が無い行は捨てる', normalizeBot({ name: 'x' }) === null && normalizeBot({ id: 'b' }) === null && normalizeBot(null) === null);
    const n = normalizeBot({ id: 'b_x', name: 'X', extra: 1, sendTargets: ['s', 's', 1, ''], folders: [{ path: '/a' }, '/a/', { path: '/b', access: 'ro' }] }, 5);
    t.ok('足りない欄は既定・知らない欄は捨てる・sendToOthers の既定は true', n.icon === '🤖' && n.persona === '' && n.sendToOthers === true && n.dmSessionId === null && n.createdAt === 5 && !('extra' in n));
    t.ok('sendTargets は文字列だけ・重複なし', n.sendTargets.length === 1 && n.sendTargets[0] === 's');
    t.ok('sendToOthers: false は保たれる', normalizeBot({ id: 'b', name: 'n', sendToOthers: false }).sendToOthers === false);
    const folders = normalizeFolders(['/a', '/a/', { path: '/b', access: 'ro' }, { path: '' }, { path: '/c', access: 'zzz' }, 5]);
    t.ok('フォルダー: 重複（末尾の区切り）は先を残し、access は rw か ro（既定 rw）', folders.map((f) => `${f.path}:${f.access}`).join() === '/a:rw,/b:ro,/c:rw', folders.map((f) => f.path).join());
    t.ok('フォルダーは 20 まで', normalizeFolders(Array.from({ length: 30 }, (_, i) => `/f${i}`)).length === 20);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
