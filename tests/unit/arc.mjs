// 走っている印は静的な DOM を返し、フレームごとの JS 処理を登録しない。
import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { runMark, satMark, stillMark } from '../../web/arc.mjs';
import { createHooksCard } from '../../web/hooks-card.mjs';

export const name = 'arc';
export const title = '走っている印: rAF を使わない・点の数・hooks の読み込み前後';

export default async function (t) {
  const oldRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => { throw new Error('印で rAF を使わない'); };
  const oldTextNode = document.createTextNode;
  document.createTextNode = (text) => { const node = new N('span'); node.textContent = text; return node; };
  try {
    const arc = runMark('実行中');
    assert.equal(arc.className, 'run');
    assert.equal(arc.querySelectorAll('path').length, 1);
    assert.equal(arc.querySelector('path').getAttribute('d'), 'M7.00,2.00 A5,5 0 1 1 2.00,7.00');
    assert.equal(satMark(8).querySelectorAll('circle').length, 3);
    assert.equal(stillMark('done').querySelectorAll('path').length, 1);
    t.ok('弧・衛星・静止の印は生成時に rAF を使わない', true);

    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const card = createHooksCard({
      cmd: (name) => name === 'scanHooks' ? pending : Promise.resolve(null),
      work: fn => fn(), saved: () => {}, opened: new Set(),
    });
    assert.equal(card.root.querySelectorAll('.run').length, 0, '作成直後は読み込み前');
    const loading = card.load();
    assert.equal(card.root.querySelectorAll('.run').length, 1, '読み込み中だけ印を置く');
    release({ entries: [], files: [] });
    await loading;
    assert.equal(card.root.querySelectorAll('.run').length, 0, '読み込みが終われば外す');
    t.ok('hooks は scan 開始まで印を置かない', true);
  } finally {
    globalThis.requestAnimationFrame = oldRaf;
    document.createTextNode = oldTextNode;
  }
}
