// 貼り付けた HTML の画像の取り込みの、画面側の段取り（web/paste-images.mjs。docs/adr/0141）。
//   - 同時に取りに行くのは 3 枚まで・順番待ちの分をやめたら取りに行かない（貼ってすぐ Ctrl+Z しても、ホストへは「取りに行く」3 件のあと「やめる」6 件だけ）
//   - やめたあとに結果が届いても札にしない・取れなければ札は静かに外れる（失敗の知らせは出さない）・読み上げは始まりと終わりの 1 回ずつ
// 編集欄・ホストの呼び出し・読み上げの要素は身代わり。
import { createPasteImages, IMPORT_CONCURRENCY } from '../../web/paste-images.mjs';

export const name = 'paste-images';
export const title = '貼った画像の取り込みの段取り: 同時 3 枚・順番待ちのやめる・やめたあとに届いた結果は捨てる・取れなければ静かに外す・読み上げ';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

export default async function (t) {
  const spoken = [];
  // 読み上げの要素だけを身代わりにする。ほかの suite（同じ worker で動く DOM の身代わり）へ残さないよう、終わりに元へ戻す
  const hadDocument = Object.hasOwn(globalThis, 'document'), previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, className: '', set textContent(v) { if (v) spoken.push(v); } }),
    body: { append() {} },
  };
  try {
    await body(t, spoken);
  } finally {
    if (hadDocument) globalThis.document = previousDocument; else delete globalThis.document;
  }
}

async function body(t, spoken) {

  /** 身代わりを作る。attachImport は手で終わらせる（pending に溜まる） */
  function rig() {
    const log = [], uploads = new Map(), pending = [], forgotten = [], finished = [];
    let running = 0, peak = 0;
    const editor = { forgetPending: async (id) => { forgotten.push(id); } };
    const pasted = createPasteImages({
      cmd: (command, args) => {
        log.push(command);
        if (command === 'attachImportCancel') return Promise.resolve({ cancelled: true });
        running++; peak = Math.max(peak, running);
        return new Promise((resolve, reject) => pending.push({ args, resolve: (r) => { running--; resolve(r); }, reject: (e) => { running--; reject(e); } }));
      },
      editor: () => editor,
      entry: (base) => { const u = { sent: 0, sessionId: 's', cancelled: false, failed: null, placed: true, ...base }; uploads.set(u.id, u); return u; },
      bucketOf: (u) => u.sessionId,
      uploadFile: async () => true,
      finished: async (u, r) => { finished.push(u.id); uploads.delete(u.id); },
      dropped: (u) => { uploads.delete(u.id); },
    });
    return { pasted, log, uploads, pending, forgotten, finished, peak: () => peak };
  }
  const six = Array.from({ length: 6 }, (_, i) => ({ src: `https://cdn.example.com/${i}.png`, alt: `n${i}`, kind: 'https' }));

  // ---- 6 枚貼ってすぐ全部やめる（Ctrl+Z）
  {
    const r = rig();
    const pids = r.pasted.start(six);
    await tick();
    t.ok(`同時に取りに行くのは ${IMPORT_CONCURRENCY} 枚まで（あとの 3 枚は順番待ち）`, r.log.join() === 'attachImport,attachImport,attachImport' && r.pasted && pids.length === 6, r.log.join());
    for (const pid of pids) r.pasted.cancel(r.uploads.get(pid));
    await tick();
    // ホストが取りに行っていた 3 枚は、やめられて失敗で返る
    for (const p of r.pending.splice(0)) p.reject(new Error('cancelled'));
    await tick(20);
    t.ok('送る順は「取りに行く」3 件 → 「やめる」6 件で終わる（順番待ちの 3 枚は取りに行かない）', r.log.join() === `${'attachImport,'.repeat(3)}${'attachImportCancel,'.repeat(6)}`.replace(/,$/, ''), r.log.join());
    t.ok('取りに行く要求は 3 件のまま増えない・送信中の一覧に何も残らない・札は 6 枚とも外れる', r.pending.length === 0 && r.uploads.size === 0 && r.forgotten.length === 6 && r.finished.length === 0);
    await tick(50);
    t.ok('やめた分は、取れたものとして数えない（読み上げは始まりの 1 回だけ。終わりは出ない）', spoken.length === 1 && /6 件を取り込んでいます/.test(spoken[0]), spoken.join('|'));
  }

  // ---- やめたあとに結果が届いても、札にしない（ホストには「やめる」を送ってある）
  {
    const r = rig();
    const pids = r.pasted.start(six.slice(0, 2));
    await tick();
    r.pasted.cancel(r.uploads.get(pids[0]));
    r.pending[0].resolve({ path: 'C:\\up\\late.png', bytes: 10, kind: 'image', mime: 'image/png', name: 'late.png' });
    r.pending[1].resolve({ path: 'C:\\up\\ok.png', bytes: 10, kind: 'image', mime: 'image/png', name: 'ok.png' });
    await tick(20);
    t.ok('やめたあとに届いた結果は捨てる（札にしない）。ほかの 1 枚は札になる', r.finished.length === 1 && r.finished[0] === pids[1] && r.log.filter((c) => c === 'attachImportCancel').length === 1);
  }

  // ---- 取れなければ札は静かに外れる・取れたら finished・読み上げ
  {
    await tick(50);   // 前の場面の読み上げ（遅れて入る）を待ってから数える
    spoken.length = 0;
    const r = rig();
    const pids = r.pasted.start(six.slice(0, 4));
    await tick();
    r.pending[0].reject(new Error('404'));
    await tick();
    t.ok('取れなかった札は、失敗にせず外れる（forgetPending）。待っていた 4 枚目が代わりに取りに行き始める', r.forgotten.join() === pids[0] && r.pending.length === 4 && r.uploads.has(pids[0]) === false);
    for (const p of r.pending.slice(1)) p.resolve({ path: `C:\\up\\${Math.random()}.png`, bytes: 10, kind: 'image', mime: 'image/png', name: 'x.png' });
    await tick(60);
    t.ok('3 枚が取れて finished・同時に取りに行ったのは 3 枚まで', r.finished.length === 3 && r.peak() <= IMPORT_CONCURRENCY && r.uploads.size === 0);
    t.ok('読み上げは始まり（4 件）と終わり（取れた 3 件）の 2 回だけ', spoken.length === 2 && /4/.test(spoken[0]) && /3/.test(spoken[1]), spoken.join('|'));
  }
}
