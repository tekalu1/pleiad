// git パネルの差分の組み立て（web/git-diff.mjs）: 行番号・語の強調・畳みの範囲・展開・左右。
import { buildItems, diffHTML, wordRange } from '../../web/git-diff.mjs';

export const name = 'git-diff';
export const title = 'git の差分: 行番号・語の強調・畳みの前後と展開・左右の組';

const after = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
const diff = { after, hunks: [
  { oldStart: 3, oldCount: 3, newStart: 3, newCount: 4, lines: [{ t: ' ', s: 'line 3' }, { t: '-', s: 'const TAX = 0.1;' }, { t: '+', s: 'const TAX = 0.08;' }, { t: '+', s: 'new' }, { t: ' ', s: 'line 5' }] },
  { oldStart: 30, oldCount: 2, newStart: 31, newCount: 2, lines: [{ t: ' ', s: 'line 31' }, { t: '-', s: 'a' }, { t: '+', s: 'b' }] },
] };

export default async function (t) {
  const w = wordRange('const TAX = 0.1;', 'const TAX = 0.08;');
  t.ok('語の強調: 共通の頭と尻を除いた所', w.a.join() === '14,15' && w.b.join() === '14,16', JSON.stringify(w));
  t.ok('語の強調: 同じ行・全く違う行は null でなくても範囲が全体', wordRange('a', 'a') === null);
  const items = buildItems(diff);
  t.ok('畳み: 先頭・ハンクの間・末尾を作る', items.filter((i) => i.gap).map((g) => `${g.from}-${g.to}`).join() === '1-2,7-30,33-40', JSON.stringify(items.filter((i) => i.gap)));
  const rows = items.find((i) => i.rows).rows;
  t.ok('行番号: 文脈は旧新の両方・削除は旧・追加は新', rows[0].o === 3 && rows[0].n === 3 && rows[1].o === 4 && rows[1].n === undefined && rows[2].n === 4 && rows[3].n === 5 && rows[4].o === 5 && rows[4].n === 6, JSON.stringify(rows.map((r) => [r.t, r.o, r.n])));
  t.ok('畳みの旧新のずれ（delta = 旧 − 新）', items.find((i) => i.gap && i.from === 7).delta === -1 && items.find((i) => i.gap && i.from === 1).delta === 0);
  const closed = diffHTML(diff, { mode: 'inline' });
  t.ok('インライン: 畳みは 3 つ・変更のかたまりは 2 つ', closed.gaps === 3 && closed.changes === 2 && (closed.html.match(/class="dgap"/g) ?? []).length === 3);
  const opened = diffHTML(diff, { mode: 'inline', open: new Set([1]) });
  t.ok('畳みを開くと、後ろ側のファイルの行が旧新の番号つきで出る', opened.html.includes('dgap-lines') && opened.html.includes('line 10') && (opened.html.match(/class="dgap"/g) ?? []).length === 2);
  const side = diffHTML(diff, { mode: 'side' });
  t.ok('左右: 削除と追加を横に組にし、余る側は斜線の空き', side.html.startsWith('<div class="sbs">') && side.html.includes('hc f'));
  const noAfter = diffHTML({ hunks: diff.hunks }, { mode: 'inline' });
  t.ok('後ろ側のファイルが無ければ畳みは開けない', noAfter.html.includes('disabled'));
  const added = diffHTML({ hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2, lines: [{ t: '+', s: 'x' }, { t: '+', s: 'y' }] }], after: ['x', 'y'] });
  t.ok('新規ファイル: 畳みなし・全行が追加', added.gaps === 0 && (added.html.match(/class="dl a"/g) ?? []).length + (added.html.match(/class="dl a"/g) ? 0 : (added.html.match(/dl a/g) ?? []).length) >= 2);
  const removed = buildItems({ hunks: [{ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0, lines: [{ t: '-', s: 'x' }, { t: '-', s: 'y' }] }] });
  t.ok('削除だけのファイル: 旧の番号が 1 から', removed[0].rows[0].o === 1 && removed[0].rows[1].o === 2 && removed.length === 1);
}
