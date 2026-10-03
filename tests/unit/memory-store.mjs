// 記憶の正本（core/memory/store.mjs。ADR 0109）: markdown の読み書き・手で壊した行・手書きの直しの記録・墓石・rev・再起動。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMemoryStore, fingerprintOf, parseLayer, renderLayer, derivedId, oneLine } from '../../core/memory/store.mjs';

export const name = 'memory-store';
export const title = '記憶の正本: markdown・手で壊した行・手書きの直し・墓石・rev・再起動';

const BOT = 'b_owl12345';
const HUMAN = { kind: 'human' };
const BOT_AUTHOR = { kind: 'bot', botId: BOT };

const readLog = async (dir) => (await fs.readFile(path.join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-'));
  try {
    let clock = 1_000;
    const now = () => ++clock;
    const titleOf = (layer) => (layer === 'user' ? 'あなたについて' : 'この bot だけ');
    const open = () => createMemoryStore({ dir, now, titleOf });
    const store = open();
    await store.init();
    t.ok('空の置き場から始められる（rev 0・記憶なし）', store.rev() === 0 && store.entries().length === 0);

    // ---- 追加: 2 層の markdown と log.jsonl
    const a = await store.add({ layer: 'user', text: 'PR は小さく、テストを先に書く', why: '何度も言われた', sources: [{ kind: 'message', sessionId: 's1', messageId: 'u1', quote: 'PR は小さく', at: 5 }], by: HUMAN });
    const b = await store.add({ layer: BOT, text: 'acme-web の本番は金曜に出さない', by: BOT_AUTHOR, via: 's9' });
    t.ok('rev は欠番なく進む', a.rev === 1 && b.rev === 2 && store.rev() === 2);
    const userMd = await fs.readFile(path.join(dir, 'user.md'), 'utf8');
    const botMd = await fs.readFile(path.join(dir, 'bots', `${BOT}.md`), 'utf8');
    t.ok('user.md は層の印・見出し・1 行 1 件', userMd.startsWith('<!-- pleiad-memory v1 layer=user -->\n# あなたについて\n\n- PR は小さく、テストを先に書く <!-- {'));
    t.ok('bots/<botId>.md が層ごとに分かれる', botMd.includes(`layer=${BOT}`) && botMd.includes('# この bot だけ') && !botMd.includes('PR は小さく'));
    const log = await readLog(dir);
    t.ok('log.jsonl に rev・op・by・本文・指紋が残る', log.length === 2 && log[0].op === 'add' && log[0].fp === fingerprintOf('PR は小さく、テストを先に書く') && log[1].by.botId === BOT && log[1].via === 's9');
    t.ok('出どころ・理由が markdown のメタに入り、読み戻せる', (() => {
      const e = parseLayer(userMd, 'user')[0];
      return e.id === a.entry.id && e.why === '何度も言われた' && e.sources[0].quote === 'PR は小さく' && e.by.kind === 'human';
    })());

    // ---- 本文に壊しそうな文字
    const tricky = await store.add({ layer: 'user', text: '矢印 --> と <!-- が本文にある\n2 行目', by: HUMAN });
    t.ok('改行は 1 行にそろう', tricky.entry.text === '矢印 --> と <!-- が本文にある 2 行目');
    const again = open(); await again.init();
    t.ok('本文の --> や <!-- でメタが壊れず、読み戻せる', again.get(tricky.entry.id)?.text === tricky.entry.text && again.get(tricky.entry.id).by.kind === 'human');
    t.ok('メタの JSON は < > を文字参照にし、行末のコメントは 1 つだけ閉じる', (await fs.readFile(path.join(dir, 'user.md'), 'utf8')).split('\n').filter((l) => l.startsWith('- 矢印')).every((l) => l.endsWith('-->') && (l.match(/<!--/g) ?? []).length === 2));

    // ---- 直す・忘れる・戻す
    const edited = await store.edit({ id: a.entry.id, text: 'PR は小さく保つ', by: BOT_AUTHOR, via: 's9' });
    t.ok('edit は本文を変え、出どころは残る', edited.entry.text === 'PR は小さく保つ' && edited.entry.sources.length === 1 && edited.entry.by.botId === BOT && edited.rev === 4);
    t.ok('無い id の edit・forget は null', (await store.edit({ id: 'm_nothing1', text: 'x', by: HUMAN })) === null && (await store.forget({ id: 'm_nothing1', by: HUMAN })) === null);
    const fp = fingerprintOf(b.entry.text);
    const gone = await store.forget({ id: b.entry.id, by: HUMAN });
    t.ok('forget は md から外し、墓石（指紋）を残す', gone.fp === fp && store.isTombstoned(fp) && !(await fs.readFile(path.join(dir, 'bots', `${BOT}.md`), 'utf8')).includes('金曜'));
    const goneLog = (await readLog(dir)).at(-1);
    t.ok('forget の記録は消した記憶の全体（entry）と誰がしたかを持つ', goneLog.op === 'forget' && goneLog.entry.text === b.entry.text && goneLog.by.kind === 'human');
    t.ok('指紋は言い回しの細かい違い（全角・記号・空白）で逃げられない', fingerprintOf('ACME-web の 本番は、金曜に出さない！') === fp && store.isTombstoned(fingerprintOf('acme-web の本番は金曜に出さない')));
    const back = await store.unforget({ id: b.entry.id, by: HUMAN });
    t.ok('unforget は戻し、墓石を外す', back.entry.text === b.entry.text && !store.isTombstoned(fp) && store.entries(BOT).length === 1);
    t.ok('戻したものを重ねて戻せない', (await store.unforget({ id: b.entry.id, by: HUMAN })) === null);

    // ---- 手で壊した行・手書き（アプリが止まっている間も）
    const restartDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-hand-'));
    try {
      await fs.mkdir(path.join(restartDir, 'bots'), { recursive: true });
      const handwritten = [
        '<!-- pleiad-memory v1 layer=user -->', '# あなたについて', '',
        '- 手で足した行（メタなし）',
        '- メタが壊れた行 <!-- {"id":"m_zzzzzz" -->',
        '* 星の記号でも 1 件 <!-- {"id":"m_qqqqqq1","at":5,"by":{"kind":"human"},"src":[]} -->',
        '- 同じ id を手でコピーした行 <!-- {"id":"m_qqqqqq1","at":5} -->',
        '', '余談の段落は記憶ではない', '',
      ].join('\n');
      await fs.writeFile(path.join(restartDir, 'user.md'), handwritten);
      let tick = 5_000;
      const hand = createMemoryStore({ dir: restartDir, now: () => ++tick, titleOf });
      const changed = await hand.init();
      const list = hand.entries('user');
      t.ok('メタの無い行・壊れた行も本文だけ「出どころ不明の人の記憶」として読む', list.length === 3 && list[0].text === '手で足した行（メタなし）' && list[1].text === 'メタが壊れた行' && list.every((e) => e.by.kind === 'human'));
      t.ok('同じ id の重複は 1 つにする', list.filter((e) => e.id === 'm_qqqqqq1').length === 1 && list[2].text === '星の記号でも 1 件');
      t.ok('手書きの行は記録に add（by: 人）として足され、層が変わったと分かる', changed.includes('user') && (await readLog(restartDir)).filter((r) => r.op === 'add' && r.by.kind === 'human').length === 3);
      t.ok('メタの無い行は id・時刻を付けて書き戻す（読むたびに id が変わらない）', (() => {
        const first = parseLayer(handwritten, 'user')[0];
        return first.id === derivedId('user', first.text);
      })() && (await fs.readFile(path.join(restartDir, 'user.md'), 'utf8')).includes('"id":"m_h'));
      const rev0 = hand.rev();
      const second = createMemoryStore({ dir: restartDir, now: () => ++tick, titleOf });
      const none = await second.init();
      t.ok('もう一度読んでも記録は増えない（冪等）', second.rev() === rev0 && none.length === 0 && second.entries('user').length === 3);

      // 動いている間の手書きの直し: 本文を直す・行を消す・行を足す
      const raw = (await fs.readFile(path.join(restartDir, 'user.md'), 'utf8')).replace('手で足した行（メタなし）', '手で直した行').split('\n').filter((l) => !l.includes('メタが壊れた行')).join('\n');
      await fs.writeFile(path.join(restartDir, 'user.md'), `${raw.trimEnd()}\n- また手で足した\n`);
      const synced = await second.sync();
      const ops = (await readLog(restartDir)).filter((r) => r.rev > rev0).map((r) => `${r.op}:${r.by.kind}`);
      t.ok('手書きの直し・削除・追加は人の変更として記録される（edit・forget・add）', synced.includes('user') && ops.includes('edit:human') && ops.includes('forget:human') && ops.includes('add:human'), ops.join(','));
      t.ok('手で消した行は墓石になる', second.isTombstoned(fingerprintOf('メタが壊れた行')));
      t.ok('変わっていなければ sync は何もしない', (await second.sync()).length === 0);
    } finally {
      await fs.rm(restartDir, { recursive: true, force: true });
    }

    // ---- 再起動: 同じ置き場を開き直す
    const rev = store.rev();
    const reopened = open();
    await reopened.init();
    t.ok('開き直しても rev・記憶が同じ', reopened.rev() === rev && reopened.entries().length === store.entries().length);
    await fs.appendFile(path.join(dir, 'log.jsonl'), '{"rev":99,"op":"add","layer":"user","id":"m_broken1"'); // 書きかけで落ちた最後の行
    const damaged = open();
    await damaged.init();
    t.ok('log.jsonl の最後の書きかけの行は捨てる', damaged.rev() === rev && damaged.entries().length === store.entries().length);
    const next = await damaged.add({ layer: 'user', text: '落ちた後も書ける', by: HUMAN });
    t.ok('続きの rev から書ける', next.rev === rev + 1);

    // ---- 直列: 同時の書き込みでも rev が重ならない
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => damaged.add({ layer: 'user', text: `同時 ${i}`, by: HUMAN })));
    const revs = burst.map((x) => x.rev).sort((x, y) => x - y);
    t.ok('同時の 12 件でも rev は連番で欠けない', revs.every((r, i) => r === next.rev + 1 + i) && damaged.entries('user').filter((e) => e.text.startsWith('同時')).length === 12);
    t.ok('recordsSince は rev より後だけを昇順で返す', (() => { const r = damaged.recordsSince(rev); return r.length === 13 && r[0].rev === rev + 1 && r.at(-1).rev === damaged.rev(); })());

    // ---- 純関数
    t.ok('oneLine は連続の空白と改行を畳む', oneLine('  a \n\n b\t c ') === 'a b c');
    t.ok('renderLayer と parseLayer は往復する', (() => {
      const entries = [{ id: 'm_roundtrip1', text: 'あ', at: 1, updatedAt: 2, by: HUMAN, sources: [], why: '理由' }];
      const back2 = parseLayer(renderLayer('user', entries, 'T'), 'user');
      return back2.length === 1 && back2[0].id === 'm_roundtrip1' && back2[0].why === '理由' && back2[0].updatedAt === 2;
    })());
    t.ok('hash は内容が変わると変わる', (() => { const h = damaged.hash(); return typeof h === 'string' && h.length === 64 && h === damaged.hash(); })());

    // S-6: 壊れた最後の行の後ろに次の行をつなげない（つながると、新しい記録（たとえば forget の墓石）が 1 行として読めず失われる）
    const afterCrash = open();
    await afterCrash.init();
    t.ok('書きかけの行の後ろの追記は、次の起動でも読める（rev・記憶・記録が残る）', afterCrash.rev() === damaged.rev() && afterCrash.get(next.entry.id)?.text === '落ちた後も書ける'
      && afterCrash.recordsSince(rev).some((r) => r.rev === next.rev && r.op === 'add' && r.id === next.entry.id));
    const gravestone = await damaged.forget({ id: next.entry.id, by: BOT_AUTHOR });
    const afterForget = open();
    await afterForget.init();
    t.ok('壊れた行の後ろでも forget の墓石は 2 度目の起動で残る', afterForget.isTombstoned(gravestone.fp) && afterForget.rev() === gravestone.rev);
    await damaged.unforget({ id: next.entry.id, by: HUMAN });

    // S-1(e): 書き手が替わる直しは、元の書き手（origBy）を残す。by は今の本文を書いた者
    const humanLine = await damaged.add({ layer: 'user', text: '人が書いた行', by: HUMAN });
    const rewritten = await damaged.edit({ id: humanLine.entry.id, text: 'AI が書き換えた行', by: BOT_AUTHOR, via: 's9' });
    t.ok('人の行を bot が直すと、by は bot・origBy に元の人が残る（記録にも）', rewritten.entry.by.botId === BOT && rewritten.entry.origBy.kind === 'human'
      && damaged.recordsSince(0).findLast((r) => r.id === humanLine.entry.id && r.op === 'edit').origBy.kind === 'human');
    const reread = open(); await reread.init();
    t.ok('origBy は markdown のメタに残り、読み戻せる', reread.get(humanLine.entry.id).origBy.kind === 'human' && reread.get(humanLine.entry.id).by.botId === BOT);
    const sameAgain = await damaged.edit({ id: humanLine.entry.id, text: 'AI がもう一度', by: BOT_AUTHOR });
    t.ok('同じ書き手の直しでは origBy は変わらない（最初の人のまま）', sameAgain.entry.origBy.kind === 'human');
    const noOrig = await damaged.add({ layer: 'user', text: 'bot の行', by: BOT_AUTHOR });
    t.ok('書き手が替わらない直しには origBy が付かない', !('origBy' in (await damaged.edit({ id: noOrig.entry.id, text: 'bot の行 2', by: BOT_AUTHOR })).entry));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
