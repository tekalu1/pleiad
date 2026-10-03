// 記憶の索引（core/memory/index.mjs・service の search）: FTS5 trigram と、node:sqlite を読み込めないときのメモリ上の走査。
// どちらの道でも同じ結果になること・壊れた索引は捨てて作り直すこと・Node 20.19 相当（node:sqlite なし）でも検索が動くこと。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMemoryIndex, queryTerms, relatedTerms, rankSearch } from '../../core/memory/index.mjs';
import { createMemoryService } from '../../core/memory/service.mjs';

export const name = 'memory-index';
export const title = '記憶の索引: FTS5 と走査が同じ結果・node:sqlite が無くても検索できる・壊れた索引の作り直し';

const HUMAN = { kind: 'human' };
const entry = (id, text, extra = {}) => ({ id, layer: 'user', text, sources: [], at: 1, updatedAt: 1, by: HUMAN, ...extra });
const CORPUS = [
  entry('m_a00001', 'PR は小さく、テストを先に書く', { updatedAt: 5 }),
  entry('m_a00002', 'acme-web の本番デプロイは金曜に出さない', { why: '週末に障害を持ち越さないため', updatedAt: 4 }),
  entry('m_a00003', 'Prefers pnpm over npm for the monorepo', { updatedAt: 3 }),
  entry('m_a00004', 'レビューは日本語で書く', { layer: 'b_owl12345', updatedAt: 2 }),
  entry('m_a00005', 'Go で書く CLI は cobra を使う', { updatedAt: 1 }),
  entry('m_a00006', 'コミットメッセージは日本語で、末尾に署名を入れる', { updatedAt: 6 }),
];
const unavailable = async () => { throw new Error('node:sqlite is not available (simulated Node 20.19)'); };
const ids = (list) => list.map((e) => e.id);

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-index-'));
  try {
    // ---- 語の取り方（純関数）
    t.ok('queryTerms は空白で分け、引用符・括弧を外し、大小と全角をそろえる', queryTerms(' "PR"  「テスト」 ＰＲ ').join(',') === 'pr,テスト');
    t.ok('relatedTerms は英数字の語と日本語の 3 文字の窓を取り、ひらがなだけ・短い語・数字・ストップワードは除く', (() => {
      const terms = relatedTerms('the pnpm monorepo を 本番デプロイ して 2026 です');
      return terms.has('pnpm') && terms.has('monorepo') && terms.has('本番デ') && !terms.has('the') && !terms.has('2026') && ![...terms.keys()].some((k) => /^[ぁ-ん]+$/.test(k));
    })());

    // ---- 2 つの道
    const sqliteFile = path.join(dir, 'a.sqlite');
    const viaSqlite = createMemoryIndex({ file: sqliteFile });
    await viaSqlite.sync(CORPUS, 'h1');
    const viaScan = createMemoryIndex({ file: path.join(dir, 'b.sqlite'), loadSqlite: unavailable });
    await viaScan.sync(CORPUS, 'h1');
    t.ok('node:sqlite を読み込めない状態を差し込むと走査に切り替わる', viaScan.mode() === 'scan');
    t.ok('読み込めるときは sqlite の道（FTS5 trigram）', viaSqlite.mode() === 'sqlite', `mode=${viaSqlite.mode()}`);
    t.ok('走査の道は索引のファイルを作らない', await fs.access(path.join(dir, 'b.sqlite')).then(() => false, () => true));

    const queries = [
      'PR', 'pr テスト', 'テスト 先に', '金曜', '本番デプロイ', 'デプロイ 金曜 本番', 'pnpm monorepo', 'PNPM', 'cobra', '日本語', '日本語 レビュー',
      'go', '署名', '存在しない言葉', '週末', '障害 週末',
    ];
    for (const q of queries) {
      const x = ids(await viaSqlite.search({ query: q, limit: 8 }));
      const y = ids(await viaScan.search({ query: q, limit: 8 }));
      t.ok(`検索「${q}」は sqlite と走査で同じ結果`, JSON.stringify(x) === JSON.stringify(y), `${x} / ${y}`);
    }
    t.ok('語は AND（全部を含むものだけ）', ids(await viaScan.search({ query: '日本語 レビュー' })).join() === 'm_a00004' && (await viaScan.search({ query: '存在しない言葉' })).length === 0);
    t.ok('3 文字未満の語（PR・Go）は部分一致の走査で引ける', ids(await viaScan.search({ query: 'PR' })).includes('m_a00001') && ids(await viaScan.search({ query: 'go' })).includes('m_a00005'));
    t.ok('理由（why）の語でも引け、本文の一致のほうが先に出る', ids(await viaScan.search({ query: '週末' })).join() === 'm_a00002');
    t.ok('層で絞れる', ids(await viaScan.search({ query: '日本語', layers: ['b_owl12345'] })).join() === 'm_a00004' && ids(await viaScan.search({ query: '日本語', layers: ['user'] })).join() === 'm_a00006');
    t.ok('limit で切る', (await viaScan.search({ query: '日本語', limit: 1 })).length === 1);
    t.ok('同じ点なら新しい更新が先', rankSearch([entry('m_x00001', 'テスト', { updatedAt: 1 }), entry('m_x00002', 'テスト', { updatedAt: 9 })], ['テスト']).map((r) => r.entry.id).join() === 'm_x00002,m_x00001');

    // 関係する記憶（末尾用）も同じ結果になる
    const text = 'acme-web の本番デプロイの手順を見直したい。pnpm の monorepo で';
    const r1 = await viaSqlite.related({ text, limit: 5 });
    const r2 = await viaScan.related({ text, limit: 5 });
    t.ok('related は sqlite と走査で同じ並び', JSON.stringify(ids(r1.map((r) => r.entry))) === JSON.stringify(ids(r2.map((r) => r.entry))) && r2.length >= 2, ids(r2.map((r) => r.entry)).join());
    t.ok('related は渡し済み（exclude）を除く', !ids((await viaScan.related({ text, exclude: ['m_a00002'] })).map((r) => r.entry)).includes('m_a00002'));
    t.ok('related は日本語の 3 文字が 1 つ重なっただけでは出さず（点の下限）、固有の英単語 1 つなら出す', (await viaScan.related({ text: 'テスト' })).length === 0 && ids((await viaScan.related({ text: 'cobra' })).map((r) => r.entry)).join() === 'm_a00005');
    t.ok('related は関係のない文には何も返さない', (await viaScan.related({ text: 'こんにちは。いい天気ですね' })).length === 0);

    // ---- 鮮度: hash が変わったら作り直す
    const next = [...CORPUS, entry('m_a00007', 'ターミナルは WezTerm を使う', { updatedAt: 7 })];
    await viaSqlite.sync(next, 'h2');
    await viaScan.sync(next, 'h2');
    t.ok('正本が増えると索引にも反映される（どちらの道も）', ids(await viaSqlite.search({ query: 'wezterm' })).join() === 'm_a00007' && ids(await viaScan.search({ query: 'wezterm' })).join() === 'm_a00007');
    await viaSqlite.sync(CORPUS, 'h1');
    t.ok('正本から消えたものは索引からも消える', (await viaSqlite.search({ query: 'wezterm' })).length === 0);
    viaSqlite.close(); viaScan.close();

    // ---- 壊れた索引ファイルは捨てて作り直す
    const brokenFile = path.join(dir, 'broken.sqlite');
    await fs.writeFile(brokenFile, 'これは sqlite のファイルではない'.repeat(200));
    const logs = [];
    const rebuilt = createMemoryIndex({ file: brokenFile, log: (m) => logs.push(m) });
    await rebuilt.sync(CORPUS, 'h1');
    t.ok('壊れた索引ファイルでも落ちず、検索できる', ids(await rebuilt.search({ query: '金曜' })).join() === 'm_a00002', `mode=${rebuilt.mode()}`);
    if (rebuilt.mode() === 'sqlite') t.ok('壊れた索引は作り直した（記録が残る）', logs.some((m) => m.includes('rebuilding')));
    rebuilt.close();
    const reopened = createMemoryIndex({ file: brokenFile });
    await reopened.sync(CORPUS, 'h1');
    t.ok('作り直した索引は次に開いても使える', ids(await reopened.search({ query: 'cobra' })).join() === 'm_a00005');
    reopened.close();

    // ---- 環境変数でも読み込めない状態を作れる（Node 20.19 相当の確認用）
    const saved = process.env.AGENT_HOST_MEMORY_NO_SQLITE;
    process.env.AGENT_HOST_MEMORY_NO_SQLITE = '1';
    try {
      const viaEnv = createMemoryIndex({ file: path.join(dir, 'env.sqlite') });
      await viaEnv.sync(CORPUS, 'h1');
      t.ok('AGENT_HOST_MEMORY_NO_SQLITE=1 で走査になり、検索が動く', viaEnv.mode() === 'scan' && ids(await viaEnv.search({ query: '金曜' })).join() === 'm_a00002');
    } finally {
      if (saved === undefined) delete process.env.AGENT_HOST_MEMORY_NO_SQLITE; else process.env.AGENT_HOST_MEMORY_NO_SQLITE = saved;
    }

    // ---- サービスの search（node:sqlite なし）
    for (const [label, loadSqlite] of [['node:sqlite あり', undefined], ['node:sqlite なし（Node 20.19 相当）', unavailable]]) {
      const data = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-service-'));
      try {
        const events = [];
        const svc = createMemoryService({ dataDir: data, emit: (e) => events.push(e), ...(loadSqlite ? { loadSqlite } : {}) });
        await svc.start();
        t.ok(`${label}: 起動しただけでは索引のファイルを作らない`, await fs.access(path.join(data, 'memory', 'index.sqlite')).then(() => false, () => true));
        await svc.write({ layer: 'user', text: 'PR は小さく、テストを先に書く' }, HUMAN);
        await svc.write({ layer: 'user', text: 'Prefers pnpm over npm' }, HUMAN);
        const mine = await svc.write({ layer: 'b_owl12345', text: '朝のあいさつは短く' }, HUMAN);
        t.ok(`${label}: write の直後に search で引ける`, (await svc.search({ query: 'テスト' })).length === 1 && (await svc.search({ query: 'PNPM' })).length === 1);
        t.ok(`${label}: 層を指定した search`, (await svc.search({ query: 'あいさつ', layer: 'user' })).length === 0 && (await svc.search({ query: 'あいさつ', layer: 'b_owl12345' })).length === 1);
        t.ok(`${label}: layers で範囲を渡せる（bot は user と自分の層だけ）`, (await svc.search({ query: 'あいさつ', layers: ['user'] })).length === 0 && (await svc.search({ query: 'あいさつ', layers: ['user', 'b_owl12345'] })).length === 1);
        await svc.forget({ id: mine.id }, HUMAN);
        t.ok(`${label}: 忘れた記憶は引けなくなる`, (await svc.search({ query: 'あいさつ' })).length === 0);
        t.ok(`${label}: 走る道が期待どおり`, loadSqlite ? svc.index.mode() === 'scan' : ['sqlite', 'scan'].includes(svc.index.mode()));
        t.ok(`${label}: 各件は 150 トークンまで`, (await svc.search({ query: 'テスト' })).every((e) => e.text.length <= 300));
        // 人が markdown を直接直したら、次の検索で索引に入る
        const file = path.join(data, 'memory', 'user.md');
        await fs.writeFile(file, `${(await fs.readFile(file, 'utf8')).trimEnd()}\n- 手で足した記憶 WezTerm\n`);
        t.ok(`${label}: 手書きの追加も次の検索で引け、memoryChanged が出る`, (await svc.search({ query: 'wezterm' })).length === 1 && events.some((e) => e.type === 'memoryChanged'));
        svc.stop();
      } finally {
        await fs.rm(data, { recursive: true, force: true });
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
