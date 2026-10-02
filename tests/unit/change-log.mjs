import { changeRows, byText, aiMarkTitle } from '../../web/change-log.mjs';

export const name = 'change-log';
export const title = '変更の記録: 新しい順・項目の絞り込み・誰がの訳・理由の言語（ADR 0067）';

export default async function (t) {
  const changes = [
    { at: '2026-09-30T00:01:00.000Z', by: 'human', field: 'status', from: null, to: '進行中', reason: '手動で変更', reasonKey: 'manual' },
    { at: '2026-09-30T00:02:00.000Z', by: 'ai', field: 'status', from: '進行中', to: '保留', reason: '待ち', reasonKey: null },
    { at: '2026-09-30T00:03:00.000Z', by: 'ply', field: 'context', from: null, to: { pin: 1 }, reason: null },
    { at: '2026-09-30T00:04:00.000Z', by: 'ai', field: 'title', from: null, to: '会話の地図を筋と節にする', reason: null },
  ];
  const rows = changeRows(changes);
  t.ok('内部の記録（context・parent）は出さない', rows.length === 3 && rows.every(r => r.field !== 'context'));
  t.ok('新しい順', rows[0].field === 'title' && rows.at(-1).at === changes[0].at);
  t.ok('前 → 後。空は「なし」', rows.at(-1).from === 'なし' && rows.at(-1).to === '進行中' && rows[1].from === '進行中' && rows[1].to === '保留');
  t.ok('誰がを訳す（human → あなた、ai・agent → AI、ply → Pleiad）', byText('human') === 'あなた' && byText('ai') === 'AI' && byText('agent') === 'AI' && byText('ply') === 'Pleiad' && byText('x') === 'x');
  t.ok('操作の一覧からの変更（by: agent）も AI の行', changeRows([{ at: '2026-10-03T00:00:00.000Z', by: 'agent', via: 'mcp', sessionId: 's1', field: 'title', from: null, to: 'x', reason: null }])[0].ai === true);
  t.ok('AI が変えた行にだけ ai の印', rows.filter(r => r.ai).length === 2 && rows.at(-1).ai === false);
  t.ok('理由は今の言語の文（キーがあれば辞書）', rows.at(-1).reason === '手動で変更' && rows[1].reason === '待ち');
  t.ok('AI の印の title は理由を添える', aiMarkTitle({ reason: '待ち' }) === 'AI が変更: 待ち' && aiMarkTitle({}) === 'AI が変更');
}
