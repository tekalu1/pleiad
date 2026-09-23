// 添付（クリップ）のボタンのメニュー。リモートの窓（デスクトップ版）だけ（docs/remote.md §8.1、issue #15）。
//
// 手元のファイルを渡すのは添付と同じ種類の操作なので、フォルダーを送る入口もクリップに置く。
// 押すとボタンの上に小さな面「ファイルを添付… / フォルダーを送る…」。「フォルダーを送る…」は手元の OS のフォルダーの
// ダイアログを出し、同じ面が送る流れ（web/folder-upload.mjs の renderUpload）に替わる。送っている途中にクリップを押すと
// メニューではなく進み具合を出す。ローカルの窓・ブラウザー版・モバイルではこれを使わず、クリップはファイルを選ぶだけ。
import { t } from './i18n.mjs';
import { el } from './dom.mjs';
import { panel } from './composer-controls.mjs';
import { renderUpload, pickFolder, glyph, FOLDER } from './folder-upload.mjs';

const CLIP = 'M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.9-9.9a4 4 0 0 1 5.66 5.66l-9.9 9.9a2 2 0 0 1-2.83-2.83l9.2-9.2';
const FOLDER_UP = 'M12 16.5v-6M9.5 13l2.5-2.5 2.5 2.5';

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.button 添付のボタン
 * @param {ReturnType<import('./folder-upload.mjs').createFolderUpload>} o.upload
 * @param {() => void} o.pickFiles ファイルを選ぶ（今までのクリップの動き）
 * @param {() => Array<{value:string,time?:number}>} o.recent 最近の作業フォルダー（送り先の候補）
 */
export function setupAttachMenu({ button, upload, pickFiles, recent }) {
  const pop = el('div', 'pop cpop fu-pop');
  pop.id = 'attachPop';
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('upload.menu.label'));
  const anchor = document.getElementById('cwdPop');
  if (anchor) anchor.before(pop); else document.body.append(pop);
  button.setAttribute('aria-controls', pop.id);

  let view = 'menu';    // menu | upload
  let box = null;
  // 開く前に何を出すか決める（面の click より先に登録する）。送っている途中なら進み具合
  button.addEventListener('click', () => { if (pop.hidden) view = upload.busy ? 'upload' : 'menu'; });
  const self = panel(button, pop, { align: 'left', width: () => (view === 'menu' ? 240 : 360), render });
  // 送る流れを開いたときは面そのものにフォーカスを置く（先頭のボタンは「中断」や除外の × なので、Enter で押さないように）
  button.addEventListener('click', () => { if (self.open && view === 'upload') pop.focus(); });

  function action(paths, text, onClick, key) {
    const b = el('button', 'caction');
    b.type = 'button';
    b.dataset.key = key;
    b.append(glyph(...paths), el('span', null, text));
    b.onclick = onClick;
    return b;
  }

  function render() {
    box = null;
    if (view === 'upload') {
      box = el('div', 'fu-body');
      pop.replaceChildren(box);
      renderUpload(box, upload, { recent, close: () => self.hide() });
      return;
    }
    const list = el('div', 'fu-menu');
    list.append(
      action([CLIP], t('upload.menu.files'), () => { self.hide(false); pickFiles(); }, 'files'),
      action([FOLDER, FOLDER_UP], t('upload.menu.folder'), () => {
        const phase = upload.state.phase;
        if (phase === 'done') upload.reset();
        view = 'upload';
        render();
        self.place();
        // 選び終えた（送る前）・止まっているものがあれば、その続きを見せる。無ければすぐにダイアログを出す
        pop.focus();
        if (phase === 'empty' || phase === 'done') pickFolder(upload);
      }, 'folder'),
    );
    pop.replaceChildren(list);
  }

  return {
    /** 送る作業の状態が変わった。面が送る流れを出していれば描き直す */
    refresh() {
      if (!self.open || view !== 'upload' || !box) return;
      renderUpload(box, upload, { recent, close: () => self.hide() });
      self.place();
      // 押したボタンが描き直しで消えたら、面にフォーカスを戻す（Esc で閉じられるように）
      if (!pop.contains(document.activeElement)) pop.focus();
    },
    /** 送る流れで面を開く（フォルダーのドロップの「作業フォルダーとして送る」から） */
    openUpload() {
      view = 'upload';
      if (self.open) { render(); self.place(); } else self.show(false);
      pop.focus();
    },
    panel: self,
  };
}
