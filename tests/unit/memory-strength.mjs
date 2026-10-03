// 記憶の強さ（ADR 0117）: 種類・重み・半減期、markdown の後方互換（知らないキーを捨てない）、核の写しは強さの順で薄れたものを外す。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMemoryStore, parseLayer, renderLayer } from '../../core/memory/store.mjs';
import { strengthOf, weightOf, halfLifeOf, isFaded, FADED_BELOW } from '../../core/memory/strength.mjs';
import { pickCore, coreSnapshot } from '../../core/memory/tail.mjs';
import { capWeight } from '../../core/memory/guard.mjs';

export const name = 'memory-strength';
export const title = '記憶の強さ: 重み × 新しさ・後方互換・核の写しは強さの順で薄れたものを外す';

const DAY = 86_400_000;
const HUMAN = { kind: 'human' };
const AI = { kind: 'bot', botId: 'b_learner' };
const NOW = Date.UTC(2026, 9, 4);

export default async function (t) {
  // ---- 強さの計算
  const ai = (extra) => ({ id: 'm_x', layer: 'user', text: 'x', by: AI, at: NOW, updatedAt: NOW, sources: [], ...extra });
  t.ok('人の行は重み 3・薄れない（何年たっても 3）', weightOf({ by: HUMAN }) === 3 && halfLifeOf({ by: HUMAN }) === Infinity
    && strengthOf({ by: HUMAN, updatedAt: NOW - 3000 * DAY }, NOW) === 3);
  t.ok('種類の既定の重み: やめたこと 3・分担 2・メモ 1・種類なし 2', weightOf(ai({ kind: 'stop' })) === 3 && weightOf(ai({ kind: 'share' })) === 2
    && weightOf(ai({ kind: 'note' })) === 1 && weightOf(ai()) === 2);
  t.ok('行の重み w が既定より優先される', weightOf(ai({ kind: 'note', weight: 3 })) === 3 && weightOf({ by: HUMAN, weight: 1 }) === 1);
  t.ok('好みは 60 日で半分（重み 2 → 1）', Math.abs(strengthOf(ai({ kind: 'pref', updatedAt: NOW - 60 * DAY, at: NOW - 60 * DAY }), NOW) - 1) < 1e-9);
  t.ok('やめたこと・まだの約束は薄れない。済んだ約束は 7 日で半分', strengthOf(ai({ kind: 'stop', updatedAt: NOW - 900 * DAY }), NOW) === 3
    && strengthOf(ai({ kind: 'promise', status: 'open', updatedAt: NOW - 900 * DAY }), NOW) === 3
    && Math.abs(strengthOf(ai({ kind: 'promise', status: 'done', updatedAt: NOW - 7 * DAY, at: NOW - 7 * DAY }), NOW) - 1.5) < 1e-9);
  t.ok('強さの起点は書いた・直した時刻と思い出した時刻（recalledAt）の新しい方', strengthOf(ai({ kind: 'note', updatedAt: NOW - 90 * DAY, at: NOW - 90 * DAY }), NOW, { recalledAt: NOW }) === 1);
  t.ok('メモは 30 日を過ぎると薄れる（核の写しに入らない強さ）', !isFaded(ai({ kind: 'note', updatedAt: NOW - 29 * DAY, at: 0 }), NOW)
    && isFaded(ai({ kind: 'note', updatedAt: NOW - 31 * DAY, at: 0 }), NOW) && FADED_BELOW === 0.5);

  // ---- 重みの上限（AI）
  t.ok('AI の重み 3 は、強い種類か人の強い合図が無ければ 2', capWeight(3, { kind: 'pref', humanQuotes: ['読みやすい形が好み'] }) === 2
    && capWeight(3, { kind: 'pref', humanQuotes: ['これは絶対に守って'] }) === 3 && capWeight(3, { kind: 'stop' }) === 3
    && capWeight(3, { human: true }) === 3 && capWeight(2, {}) === 2 && capWeight(undefined, {}) === undefined);

  // ---- markdown: k・w・st と知らないキー
  const md = [
    '<!-- pleiad-memory v1 layer=user -->', '# あなたについて', '',
    '- 古い形の行 <!-- {"id":"m_0old000000001","at":5,"up":6,"by":{"kind":"bot","botId":"b_learner"},"src":[]} -->',
    '- 新しい形の行 <!-- {"id":"m_0new000000001","at":5,"up":6,"by":{"kind":"human"},"src":[],"k":"promise","w":3,"st":"open","future":{"x":1}} -->',
    '- 値の壊れた行 <!-- {"id":"m_0bad000000001","at":5,"up":6,"by":{"kind":"human"},"src":[],"k":"???","w":9,"st":"later"} -->',
    '- メタの無い手書きの行',
  ].join('\n');
  const parsed = parseLayer(md, 'user');
  t.ok('古い形（k・w・st の無い行）はそのまま読める', parsed[0].text === '古い形の行' && !('kind' in parsed[0]) && !('weight' in parsed[0]) && parsed[0].by.botId === 'b_learner');
  t.ok('k・w・st を読む', parsed[1].kind === 'promise' && parsed[1].weight === 3 && parsed[1].status === 'open');
  t.ok('正しくない種類・重み・状態は無いものとして読む', !('kind' in parsed[2]) && !('weight' in parsed[2]) && !('status' in parsed[2]));
  t.ok('メタの無い手書きの行は人の行（重み 3）', parsed[3].by.kind === 'human' && weightOf(parsed[3]) === 3);
  const rendered = renderLayer('user', parsed, 'あなたについて');
  t.ok('書き直しても知らないキー（future）と k・w・st が残る', rendered.includes('"future":{"x":1}') && rendered.includes('"k":"promise"') && rendered.includes('"w":3') && rendered.includes('"st":"open"'));
  const again = parseLayer(rendered, 'user');
  t.ok('書き直した形を読み戻すと同じ', again[1].kind === 'promise' && again[1].weight === 3 && again[1].status === 'open' && again[1].extraMeta.future.x === 1 && again[0].text === '古い形の行');

  // ---- store: 種類・重みの追加と直し、忘れて戻しても知らないキーが残る
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-strength-'));
  try {
    await fs.writeFile(path.join(dir, 'user.md'), md);
    let clock = NOW;
    const open = () => createMemoryStore({ dir, now: () => ++clock, titleOf: () => 'あなたについて' });
    const store = open();
    await store.init();
    t.ok('前の版の置き場（k・w の無い行）をそのまま開ける', store.entries('user').length === 4 && store.get('m_0old000000001').text === '古い形の行');
    t.ok('外へ出す行に extraMeta は出ない', !('extraMeta' in store.get('m_0new000000001')));
    const added = await store.add({ layer: 'user', text: '分担の行', by: AI, kind: 'share', weight: 2, sources: [] });
    t.ok('add は種類・重みを持つ', added.entry.kind === 'share' && added.entry.weight === 2);
    const tagged = await store.edit({ id: 'm_0old000000001', weight: 3, kind: 'decision', by: AI });
    t.ok('edit で種類・重みを直せる（本文は変わらない）', tagged.entry.kind === 'decision' && tagged.entry.weight === 3 && tagged.entry.text === '古い形の行');
    const cleared = await store.edit({ id: 'm_0old000000001', weight: null, by: AI });
    t.ok('edit の null は外す', !('weight' in cleared.entry) && cleared.entry.kind === 'decision');
    const humanTag = await store.edit({ id: 'm_0new000000001', weight: 2, by: AI });
    t.ok('本文の変わらない直しでは by は替わらない（AI が人の行を自分の行にしない）', humanTag.entry.by.kind === 'human' && !('origBy' in humanTag.entry)
      && store.recordsSince(0).at(-1).by.botId === 'b_learner');
    await store.forget({ id: 'm_0new000000001', by: HUMAN });
    await store.unforget({ id: 'm_0new000000001', by: HUMAN });
    const reread = open();
    await reread.init();
    const back = await fs.readFile(path.join(dir, 'user.md'), 'utf8');
    t.ok('忘れて戻しても、種類・重み・知らないキーが残る', reread.get('m_0new000000001').kind === 'promise' && reread.get('m_0new000000001').weight === 2 && back.includes('"future":{"x":1}'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ---- 核の写し: 強さの順・薄れたものは外す・種類の頭
  const e = (id, extra) => ({ id, layer: 'user', text: `記憶 ${id}`, by: AI, at: extra?.updatedAt ?? NOW, updatedAt: NOW, sources: [], ...extra });
  const list = [
    e('m_note_old', { kind: 'note', updatedAt: NOW - 100 * DAY }),        // 薄れた
    e('m_pref', { kind: 'pref' }),
    e('m_stop', { kind: 'stop', updatedAt: NOW - 400 * DAY }),          // 古くても強い
    e('m_human', { by: HUMAN, updatedAt: NOW - 800 * DAY }),
    e('m_promise_done', { kind: 'promise', status: 'done' }),
  ];
  const core = pickCore(list, [], { now: NOW });
  t.ok('薄れた記憶は核の写しに入れず、数える（消さない）', !core.ids.includes('m_note_old') && core.faded === 1 && core.omitted === 1);
  t.ok('古くても強い記憶（人の行・やめたこと）は入る', core.ids.includes('m_stop') && core.ids.includes('m_human'));
  t.ok('並びは種類の順（やめたこと → 約束 → 好み → 種類なし）', core.user.map((x) => x.id).join() === 'm_stop,m_promise_done,m_pref,m_human');
  const tight = pickCore(list, [], { now: NOW, layerTokens: 1 });
  t.ok('目安が足りないときは強い順（同じ強さなら人の行が先）', tight.ids.join() === 'm_human');
  const text = coreSnapshot({ core, locale: 'ja' });
  t.ok('核の写しの行に種類の頭が付く（済んだ約束は「約束・済み」）', text.includes('- [やめたこと] 記憶 m_stop') && text.includes('- [約束・済み] 記憶 m_promise_done')
    && text.includes('- [好み] 記憶 m_pref') && text.includes('- 記憶 m_human') && text.includes('ほか 1 件'));
}
