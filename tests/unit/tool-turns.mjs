import { mergeToolTurns } from '../../web/tool-turns.mjs';

export const name = 'tool-turns';
export const title = '委譲した子の詳細: ツールだけの発言が続いたら、本文が来るまで 1 つの発言にまとめる（ADR 0067）';

const tool = (id) => ({ id, name: 'Read', input: { file_path: `/a/${id}` } });
const ai = (o) => ({ role: 'assistant', ...o });

export default async function (t) {
  const a = [ai({ toolCalls: [tool('1')] }), ai({ toolCalls: [tool('2')] }), ai({ toolCalls: [tool('3')] }), ai({ text: '読み終えました' })];
  const merged = mergeToolTurns(a);
  t.ok('ツールだけの発言が続くと 1 つにまとまり、続く本文はその発言の本文になる', merged.length === 1 && merged[0].toolCalls.length === 3 && merged[0].text === '読み終えました');
  t.ok('元の配列は変えない', a.length === 4 && a[0].toolCalls.length === 1);

  const b = mergeToolTurns([ai({ text: '始めます', toolCalls: [tool('1')] }), ai({ toolCalls: [tool('2')] }), ai({ toolCalls: [tool('3')] })]);
  t.ok('本文とツールの発言に、ツールだけの発言が続けば、同じ発言のツールとして続く', b.length === 1 && b[0].toolCalls.length === 3 && b[0].text === '始めます');

  const c = mergeToolTurns([ai({ toolCalls: [tool('1')] }), ai({ text: '途中', toolCalls: [tool('2')] })]);
  t.ok('本文の前にツールがある発言（本文のあとにツールが続く）は区切りのまま', c.length === 2);

  const d = mergeToolTurns([ai({ toolCalls: [tool('1')] }), ai({ thinking: '考える', toolCalls: [tool('2')] })]);
  t.ok('考えた内容を持つ発言は区切りのまま', d.length === 2);

  const e = mergeToolTurns([ai({ toolCalls: [tool('1')] }), { role: 'user', text: '追加' }, ai({ toolCalls: [tool('2')] })]);
  t.ok('人の発言をまたいではまとめない', e.length === 3);

  const f = mergeToolTurns([ai({ text: 'a' }), ai({ text: 'b' })]);
  t.ok('本文だけの発言は何もしない', f.length === 2);
}
