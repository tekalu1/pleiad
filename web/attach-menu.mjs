// 添付（クリップ）のボタンのメニュー（docs/remote.md §8.1、
// docs/design-system.md「添付の出どころ」）。
//
// 出どころを選べる接続（composer-layout.mjs の attachSources）でだけ開く:
//   - デスクトップ版のリモートの窓・モバイル版の殻（plyRemote）
//   - ホストの画面ではないブラウザー（hostCapabilities の osActions === false）
// ホストの PC の画面（ローカルの窓・ホストで開いたブラウザー）ではホスト＝この端末なので選ばせず、クリップはすぐファイルを選ぶ。
//
// 面は出どころで見出しを分ける:
//   「この端末から」: ファイル…（今までのクリップの動き）。デスクトップ版のリモートの窓だけ、フォルダーを送る…（web/folder-upload.mjs）
//   「ホストから <ホスト名>」: ファイルを選ぶ… → 同じ面がホストのファイルの一覧に替わる。場所のパンくず・このフォルダーでの絞り込み・
//     フォルダー（押すと入る）とファイル（✓ で複数選択）。「添付する」でホストのパスのまま添付に積む（送らない。
//     ファイルプレビューの「会話で使う」と同じ仕組み）。件数の上限は無い
import { t } from './i18n.mjs';
import { el, relTime } from './dom.mjs';
import { panel } from './composer-controls.mjs';
import { renderUpload, pickFolder, glyph, FOLDER, formatBytes } from './folder-upload.mjs';
import { searchTerms, matchesTerms } from './search-terms.mjs';
import { crumbs, joinPath } from './composer-layout.mjs';

const CLIP = 'M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.9-9.9a4 4 0 0 1 5.66 5.66l-9.9 9.9a2 2 0 0 1-2.83-2.83l9.2-9.2';
const FOLDER_UP = 'M12 16.5v-6M9.5 13l2.5-2.5 2.5 2.5';
const BACK = 'M15 6l-6 6 6 6';
const NEXT = 'M9 6l6 6-6 6';

/**
 * @param {object} o
 * @param {HTMLButtonElement} o.button 添付のボタン
 * @param {() => (null | { folder: boolean })} o.sources 出どころを選ばせるか（null ならメニューを開かない）
 * @param {ReturnType<import('./folder-upload.mjs').createFolderUpload> | null} o.upload フォルダーを送る（デスクトップ版のリモートの窓だけ）
 * @param {() => void} o.pickFiles この端末のファイルを選ぶ（今までのクリップの動き）
 * @param {() => Array<{value:string,time?:number}>} o.recent 最近の作業フォルダー（送り先の候補）
 * @param {(command: string, args?: object) => Promise<any>} o.cmd
 * @param {() => string} o.hostName 見出しに出すホストの名前
 * @param {() => string} o.startDir ホストのファイルを最初に開くフォルダー（作業ディレクトリ。空ならホーム）
 * @param {(files: Array<{path:string,name:string}>) => void} o.attachHost ホストのパスのまま添付に積む
 */
export function setupAttachMenu({ button, sources, upload = null, pickFiles, recent = () => [], cmd, hostName = () => '', startDir = () => '', attachHost }) {
  const pop = el('div', 'pop cpop fu-pop at-pop');
  pop.id = 'attachPop';
  pop.hidden = true;
  pop.tabIndex = -1;
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('upload.menu.label'));
  const anchor = document.getElementById('cwdPop');
  if (anchor) anchor.before(pop); else document.body.append(pop);
  button.setAttribute('aria-controls', pop.id);

  let view = 'menu';    // menu | upload | host
  let box = null;
  // ホストのファイルの面の状態。面を閉じても、同じ会話の間は開いていた場所と選んだものを覚えておく
  const host = { dir: null, listing: null, selected: new Map(), filter: '', error: '', seq: 0, busy: false };

  // 開く前に何を出すか決める（面の click より先に登録する）。送っている途中なら進み具合
  button.addEventListener('click', () => { if (pop.hidden) view = upload?.busy ? 'upload' : 'menu'; });
  const self = panel(button, pop, {
    align: 'left',
    // スマホの幅（480px 以下）は入力欄の幅いっぱい（面は画面の幅から 16px 引いたところで止まる）
    width: () => ((document.documentElement.clientWidth || innerWidth) <= 480 ? 9999 : view === 'menu' ? 260 : 360),
    render,
    when: () => Boolean(sources()),
  });
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
    if (view === 'upload' && upload) {
      box = el('div', 'fu-body');
      pop.replaceChildren(box);
      renderUpload(box, upload, { recent, close: () => self.hide() });
      return;
    }
    if (view === 'host') { renderHost(); return; }
    const src = sources() ?? { folder: false };
    const list = el('div', 'fu-menu at-menu');
    const device = el('div', 'chead', t('chat.attach.source.device'));
    const hostHead = el('div', 'chead');
    const name = hostName();
    hostHead.append(t('chat.attach.source.host'), ...(name ? [' ', el('span', 'at-host', name)] : []));
    list.append(
      device,
      action([CLIP], t('chat.attach.source.files'), () => { self.hide(false); pickFiles(); }, 'files'),
      ...(src.folder && upload ? [action([FOLDER, FOLDER_UP], t('upload.menu.folder'), () => {
        const phase = upload.state.phase;
        if (phase === 'done') upload.reset();
        view = 'upload';
        render();
        self.place();
        // 選び終えた（送る前）・止まっているものがあれば、その続きを見せる。無ければすぐにダイアログを出す
        pop.focus();
        if (phase === 'empty' || phase === 'done') pickFolder(upload);
      }, 'folder')] : []),
      hostHead,
      action([FOLDER], t('chat.attach.source.hostFiles'), () => {
        view = 'host';
        render();
        self.place();
        if (host.dir == null) browse(startDir() || '');
      }, 'host'),
    );
    pop.replaceChildren(list);
  }

  // ---------------------------------------------------------------- ホストのファイル

  async function browse(dir) {
    const seq = ++host.seq;
    host.busy = true;
    if (view === 'host' && self.open) paintBusy();
    let r;
    try { r = await cmd('listDirs', { path: dir, files: true }); }
    catch (e) {
      if (seq !== host.seq) return;
      host.busy = false;
      host.error = e.message;
      // 最初から開けなければホームへ（理由は残す）
      if (host.listing == null && dir) { host.seq++; browse('').then(() => { host.error = e.message; if (view === 'host' && self.open) renderHost(); }); return; }
      if (view === 'host' && self.open) renderHost();
      return;
    }
    if (seq !== host.seq) return;
    host.busy = false;
    host.error = '';
    host.dir = r.path;
    host.listing = r;
    host.filter = '';
    if (view === 'host' && self.open) { renderHost(); self.place(); pop.querySelector('.hf-list [role=option]')?.focus(); }
  }

  function paintBusy() { pop.querySelector('.hf-list')?.setAttribute('aria-busy', 'true'); }

  function renderHost() {
    const r = host.listing;
    const top = el('div', 'hf-top');
    const back = el('button', 'btn btn-icon hf-back');
    back.type = 'button';
    back.dataset.key = 'hostBack';
    back.title = t('chat.attach.host.back');
    back.setAttribute('aria-label', t('chat.attach.host.back'));
    back.append(glyph(BACK));
    back.onclick = () => { view = 'menu'; render(); self.place(); pop.querySelector('[data-key=host]')?.focus(); };
    top.append(back, el('b', 'hf-title', t('chat.attach.host.title')));

    const crumb = el('div', 'hf-crumb');
    crumb.setAttribute('role', 'navigation');
    crumb.setAttribute('aria-label', t('chat.attach.host.location'));
    const parts = crumbs(r?.path ?? '');
    parts.forEach((c, i) => {
      if (i) crumb.append(el('span', 'hf-sep', '›'));
      const b = el('button', 'hf-crumb-b', c.name);
      b.type = 'button';
      b.title = c.path;
      if (i === parts.length - 1) b.setAttribute('aria-current', 'location');
      b.onclick = () => browse(c.path);
      crumb.append(b);
    });

    const q = el('input', 'hf-q');
    q.type = 'search';
    q.value = host.filter;
    q.placeholder = t('chat.attach.host.filter');
    q.setAttribute('aria-label', t('chat.attach.host.filter'));
    q.autocomplete = 'off'; q.spellcheck = false;
    q.dataset.key = 'hostFilter';

    const list = el('div', 'hf-list clistbox');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-multiselectable', 'true');
    list.setAttribute('aria-label', t('chat.attach.host.listLabel', { path: r?.path ?? '' }));
    const note = el('p', 'cnote');
    const paintList = () => {
      const terms = searchTerms(host.filter);
      const rows = [];
      if (r) {
        if (r.parent && !terms.length) rows.push(dirRow('..', r.parent, t('composer.cwd.up'), BACK));
        if (!terms.length) for (const root of r.roots ?? []) if (root !== r.path) rows.push(dirRow(root, root, t('composer.cwd.drive')));
        for (const name of r.dirs) if (matchesTerms(terms, [name])) rows.push(dirRow(name, joinPath(r.path, name)));
        for (const f of r.files ?? []) if (matchesTerms(terms, [f.name])) rows.push(fileRow(f));
      }
      list.replaceChildren(...rows);
      const empty = r && !(r.dirs.length || r.files?.length);
      note.textContent = !r ? (host.busy ? t('chat.attach.host.loading') : '')
        : terms.length && !rows.length ? t('chat.attach.host.noMatch')
        : empty ? t('chat.attach.host.empty')
        : r.truncated ? t('chat.attach.host.truncated') : '';
      note.hidden = !note.textContent;
    };
    q.addEventListener('input', () => { host.filter = q.value; paintList(); });
    paintList();

    const err = el('p', 'cerr', host.error);
    err.setAttribute('role', 'alert');

    const foot = el('div', 'hf-foot');
    const count = host.selected.size;
    const status = el('span', 'hf-note', count ? t('chat.attach.host.selected', { count }) : t('chat.attach.host.none'));
    status.setAttribute('aria-live', 'polite');
    const go = el('button', 'btn btn-primary', t('chat.attach.host.attach', { count }));
    go.type = 'button';
    go.dataset.key = 'hostAttach';
    go.disabled = !count;
    go.onclick = () => {
      const files = [...host.selected.values()].map((f) => ({ path: f.path, name: f.name }));
      if (!files.length) return;
      host.selected.clear();
      self.hide(false);
      attachHost(files);
    };
    foot.append(status, go);
    pop.replaceChildren(top, crumb, q, list, note, err, foot);

    function dirRow(label, full, sub, iconPath) {
      const b = el('button', 'hf-row hf-dir');
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', 'false');
      b.title = full;
      b.append(glyph(iconPath ?? FOLDER), el('span', 'hf-name', label));
      if (sub) b.append(el('span', 'hf-meta', sub));
      else b.append(glyph(NEXT));
      b.onclick = () => browse(full);
      return b;
    }
    function fileRow(f) {
      const full = joinPath(r.path, f.name);
      const on = host.selected.has(full);
      const b = el('button', 'hf-row hf-file' + (on ? ' sel' : ''));
      b.type = 'button';
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(on));
      b.title = full;
      b.dataset.path = full;
      const ck = el('span', 'hf-ck', on ? '✓' : '');
      ck.setAttribute('aria-hidden', 'true');
      b.append(ck, el('span', 'hf-name', f.name), el('span', 'hf-meta', `${formatBytes(f.size)} · ${relTime(f.mtime)}`));
      b.onclick = () => {
        if (host.selected.has(full)) host.selected.delete(full); else host.selected.set(full, { path: full, name: f.name });
        const now = host.selected.has(full);
        b.classList.toggle('sel', now);
        b.setAttribute('aria-selected', String(now));
        ck.textContent = now ? '✓' : '';
        const n = host.selected.size;
        status.textContent = n ? t('chat.attach.host.selected', { count: n }) : t('chat.attach.host.none');
        go.textContent = t('chat.attach.host.attach', { count: n });
        go.disabled = !n;
      };
      return b;
    }
  }

  return {
    /** 送る作業の状態が変わった。面が送る流れを出していれば描き直す */
    refresh() {
      if (!self.open || view !== 'upload' || !box || !upload) return;
      renderUpload(box, upload, { recent, close: () => self.hide() });
      self.place();
      // 押したボタンが描き直しで消えたら、面にフォーカスを戻す（Esc で閉じられるように）
      if (!pop.contains(document.activeElement)) pop.focus();
    },
    /** 送る流れで面を開く（フォルダーのドロップの「作業フォルダーとして送る」から） */
    openUpload() {
      if (!upload) return;
      view = 'upload';
      if (self.open) { render(); self.place(); } else self.show(false);
      pop.focus();
    },
    /** 会話を替えたら、ホストのファイルの面で選んでいたものは捨てる（場所は作業ディレクトリから開き直す） */
    reset() { host.selected.clear(); host.dir = null; host.listing = null; host.filter = ''; host.error = ''; },
    panel: self,
  };
}
