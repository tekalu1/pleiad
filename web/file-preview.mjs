import { el } from './dom.mjs';
import { fmt, t } from './i18n.mjs';
import { isComposingKey } from './keyboard.mjs';
import { fileReference, fileDownloadUrl } from './file-reference.mjs';
import { htmlDocument, markdownContent, parseTable, previewFrame } from './file-preview-content.mjs';
import { visualizationFrame, visualizationBlobUrl, visualizationFileName } from './visualize-frame.mjs';
import { copyIcon, closeIcon, backIcon, expandIcon, collapseIcon, folderIcon, fileIcon, moreIcon } from './icons.mjs';
import { fileMenuItems, relativeTo, samePath, notify, download } from './file-actions.mjs';
import { copyText } from './code-copy.mjs';
import { createTree } from './tree.mjs';

const KIND = { markdown:'Markdown', html:'HTML', image:'画像', table:'表', text:'テキスト', pdf:'PDF', unsupported:'プレビュー未対応', directory:'ディレクトリ' };
function formatSize(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const button = (label, action, className = 'btn') => { const b = el('button', className, label); b.type = 'button'; b.onclick = action; return b; };
/** 枠の操作はアイコンにして、名前は title と aria-label に持たせる */
const setIcon = (b, icon, label) => { b.innerHTML = icon; b.title = label; b.setAttribute('aria-label', label); };
const iconButton = (icon, label, action, className = 'btn btn-icon') => {
  const b = button('', action, className);
  setIcon(b, icon, label);
  return b;
};

/**
 * showMenu は web/client.mjs の右クリックメニュー（1 つを共有する）。cmd はサーバーへのコマンド。
 * osActions() はサーバーのある PC の画面から見ているか（OS の操作を出してよいか。判定はサーバー）
 */
export function setupFilePreview({ getContext, useFile, onLayout, showMenu, cmd, osActions = () => false }) {
  const panel = el('aside', 'file-preview'); panel.id = 'filePreview'; panel.hidden = true;
  panel.setAttribute('aria-label', 'ファイルプレビュー'); panel.tabIndex = -1;
  const head = el('header', 'file-preview-head'), title = el('div', 'file-preview-title');
  const name = el('h2'), path = el('div', 'file-preview-path'); title.append(name, path);
  const wide = iconButton(expandIcon, '広げる', () => { document.body.classList.toggle('file-preview-wide'); layout(); });
  wide.classList.add('btn-wide');
  const closeButton = iconButton(closeIcon, '閉じる', () => close());
  const treeToggle = iconButton(folderIcon, 'ツリー', () => {
    treePane.classList.toggle('collapsed');
    const collapsed = treePane.classList.contains('collapsed');
    treeToggle.setAttribute('aria-expanded', String(!collapsed));
  });
  treeToggle.setAttribute('aria-expanded', 'true');
  // 今のファイルの操作。道具の列を増やさず、ツリー・会話のリンクと同じメニューにまとめる
  const more = iconButton(moreIcon, t('files.currentActions'), () => {
    if (!file) return;
    const r = more.getBoundingClientRect();
    menu(r.left, r.bottom + 4, { path:file.path, kind:file.kind === 'directory' ? 'directory' : 'file', cwd:file.cwd, current:true });
  });
  more.setAttribute('aria-haspopup', 'menu'); more.hidden = true;
  const actions = el('div', 'file-preview-actions'); actions.append(treeToggle, more, wide, closeButton); head.append(title, actions);
  const toolbar = el('div', 'file-preview-toolbar'), switcher = el('div', 'file-preview-switch');
  switcher.setAttribute('aria-label', '表示方法');
  const rendered = button('プレビュー', () => { source = false; paint(); });
  const original = button('原文', () => { source = true; paint(); }); switcher.append(rendered, original);
  const locationButton = button('パス', () => { location.hidden = !location.hidden; locationButton.setAttribute('aria-expanded', String(!location.hidden)); if (!location.hidden) { fullPath.focus(); fullPath.select(); } });
  locationButton.setAttribute('aria-expanded', 'false');
  const reload = button('再読み込み', () => load());
  // HTML だけ。サーバーのある PC の既定のブラウザーで開く（相対のリンク・読み込みもそのまま動く）
  const browser = button(t('files.menu.openInBrowser'), () => file && osAction('openPath', { path:file.path }));
  browser.title = t('files.browserTitle'); browser.hidden = true; browser.classList.add('file-preview-browser');
  toolbar.append(switcher, browser, locationButton, reload);
  const location = el('div', 'file-preview-location'); location.hidden = true;
  const fullPath = el('input'); fullPath.readOnly = true; fullPath.setAttribute('aria-label', 'ファイルの完全パス');
  const copyPath = iconButton(copyIcon, 'パスをコピー', () => copyText(copyPath, fullPath.value, 'パスをコピー'));
  location.append(fullPath, copyPath);
  const note = el('div', 'file-preview-note'); note.hidden = true; note.setAttribute('role', 'status');
  const bodyLayout = el('div', 'file-preview-body-layout');
  const treePane = el('div', 'file-preview-tree-pane');
  const treeHeader = el('div', 'file-preview-tree-header');
  treeHeader.append(el('span', null, 'エクスプローラー'));
  const treeRoot = el('div', 'tree file-preview-tree');
  treePane.append(treeHeader, treeRoot);
  const content = el('div', 'file-preview-content'); content.setAttribute('aria-label', 'ファイルの内容'); content.tabIndex = 0;
  bodyLayout.append(treePane, content);
  const tree = createTree(treeRoot, {
    nodes: [],
    render(node, row) {
      const ic = el('span', 'ic');
      ic.innerHTML = node.kind === 'directory' ? folderIcon : fileIcon;
      const nm = el('span', 'nm', node.name);
      // ⋯ は触れた・選んだ行に出る。フォーカスはツリー 1 つのまま（tabindex -1）。支援技術には出さない
      // （行の名前に混ざる）。キーボードは Shift+F10・ContextMenu キーで同じメニュー
      const dots = el('button', 'btn btn-icon tree-more'); dots.type = 'button'; dots.tabIndex = -1;
      setIcon(dots, moreIcon, t('files.actionsFor', { name: node.name })); dots.setAttribute('aria-hidden', 'true');
      dots.onclick = e => { e.stopPropagation(); const r = dots.getBoundingClientRect(); treeMenu(node, r.left, r.bottom + 4); };
      dots.ondblclick = e => e.stopPropagation();
      row.append(ic, nm, dots);
    },
    onSelect(node) {
      open({ path: node.id });
    },
    onContext(node, x, y) { treeMenu(node, x, y); },
  });
  function treeMenu(node, x, y) {
    menu(x, y, { path:node.id, kind:node.kind === 'directory' ? 'directory' : 'file', cwd:file?.cwd, current:samePath(node.id, file?.path) });
  }
  const footer = el('footer', 'file-preview-foot'), status = el('span'); status.setAttribute('role', 'status');
  const reveal = button(t('files.menu.revealFile'), () => file && osAction('revealPath', { path:file.path }));
  reveal.hidden = true;
  const save = el('a', 'btn', '保存'); save.download = ''; save.hidden = true;
  const use = button('会話で使う', () => {
    if (!file || context.sessionId !== getContext().sessionId) return;
    const selectedFile = file;
    document.body.classList.remove('file-preview-wide');
    if (mobile.matches) close(false); else layout();
    useFile(selectedFile);
  });
  footer.append(status, reveal, save, use);
  const handle = el('div', 'file-preview-resize'); handle.tabIndex = 0; handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', 'プレビューの幅'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-valuemin', '30'); handle.setAttribute('aria-valuemax', '65');
  panel.append(handle, head, toolbar, location, note, bodyLayout, footer); document.body.append(panel);
  const main = document.querySelector('body > main'), sidebar = document.getElementById('sidebar');
  const mobile = matchMedia('(max-width:760px)');
  // 幅の割合の分母は、脇を除いた窓の幅。1150px 以下では脇が畳まれ、閉じた脇（web/client.mjs）も列を取らない
  const besideSidebar = () => innerWidth - (innerWidth > 1150 && !document.documentElement.classList.contains('side-closed') ? sidebar.offsetWidth : 0);
  let opener, context = {}, reference, file, visual, snapshotUrl, source = false, abort, generation = 0, paintId = 0, percentage = 48;
  let custom = null;   // ファイル以外の中身（この会話のコンテキストなど）を出しているときの { key, label }
  let pdfTask, pdfDoc, pdfPage = 1, pdfZoom = 1, imageZoom = 1, renderTask;
  const layout = () => {
    const open = !panel.hidden, expanded = document.body.classList.contains('file-preview-wide');
    main.inert = open && (mobile.matches || expanded); sidebar.inert = open && mobile.matches;
    panel.setAttribute('role', mobile.matches ? 'dialog' : 'complementary');
    if (mobile.matches) panel.setAttribute('aria-modal', 'true'); else panel.removeAttribute('aria-modal');
    setIcon(wide, expanded ? collapseIcon : expandIcon, expanded ? '会話と並べて表示' : '広げる');
    setIcon(closeButton, mobile.matches ? backIcon : closeIcon, mobile.matches ? '会話へ戻る' : 'プレビューを閉じる');
    panel.setAttribute('aria-label', custom ? custom.label : visual ? '可視化のプレビュー' : 'ファイルプレビュー');
    const available = besideSidebar();
    const pixels = Math.min(available - 360, Math.max(300, available * percentage / 100));
    document.body.style.setProperty('--file-preview-width', `${Math.max(300, pixels)}px`);
    handle.setAttribute('aria-valuenow', String(Math.round(percentage)));
    onLayout?.();
  };
  function disposePdf() { renderTask?.cancel(); renderTask = null; pdfTask?.destroy().catch(() => {}); pdfTask = null; pdfDoc = null; }
  // 保存用の URL は面に1つだけ。次を開く前に必ず手放す
  function disposeSnapshot() { if (snapshotUrl) URL.revokeObjectURL(snapshotUrl); snapshotUrl = null; }
  const clearCurrent = () => document.querySelectorAll('.file-link[aria-current],.visualize-expand[aria-current]').forEach(node => node.removeAttribute('aria-current'));
  function close(restore = true) {
    abort?.abort(); generation++; paintId++; disposePdf(); disposeSnapshot(); panel.hidden = true;
    document.body.classList.remove('file-preview-open','file-preview-wide');
    clearCurrent();
    const was = custom; leaveCustom();
    content.replaceChildren(); file = null; visual = null; layout();
    was?.onClose?.();
    if (restore && opener?.isConnected) opener.focus({ preventScroll:true });
  }
  function setNote(text) { note.textContent = text; note.hidden = !text; }
  function stateMessage(title, description) {
    const box = el('div', 'file-preview-state'); box.append(el('h3', null, title)); if (description) box.append(el('p', null, description)); content.replaceChildren(box);
  }
  async function request(raw, base, signal = abort?.signal, resource = false) {
    const params = new URLSearchParams({ path:raw, ...(context.sessionId ? { sessionId:context.sessionId } : {}), ...(context.at ? { at:context.at } : {}), ...(base ? { base } : {}), ...(resource ? { resource:'1' } : {}) });
    const response = await fetch(`/file-preview?${params}`, { signal, credentials:'same-origin' });
    if (response.status === 401) throw new Error('接続の認証が切れています。起動時のURLから開き直してください。');
    const data = await response.json();
    if (!response.ok) { const error = new Error(data.error?.message || 'ファイルを読み込めませんでした。'); error.path = data.path; throw error; }
    return data;
  }
  async function load() {
    abort?.abort(); abort = new AbortController(); const current = ++generation; paintId++; disposePdf();
    file = null; source = false; pdfPage = 1; pdfZoom = imageZoom = 1;
    switcher.hidden = true; use.disabled = true; save.hidden = true; setNote('');
    more.hidden = browser.hidden = reveal.hidden = true;
    status.textContent = '読み込み中…'; stateMessage('読み込み中…');
    try {
      const data = await request(reference.path + (reference.line ? `:${reference.line}` : ''), context.base);
      if (current !== generation || panel.hidden) return;
      file = data; name.textContent = data.name; fullPath.value = data.path;
      const normalized = data.path.replaceAll('\\','/'), cwd = (data.cwd || '').replaceAll('\\','/').replace(/\/$/, '');
      path.textContent = cwd && normalized.startsWith(cwd + '/') ? normalized.slice(cwd.length + 1) : normalized;
      use.disabled = false; save.hidden = !data.downloadable; save.href = fileDownloadUrl(data.path);
      more.hidden = false; osButtons();
      save.title = '現在のファイルを保存';
      if (data.kind === 'directory') {
        status.textContent = `ディレクトリ · ${(data.items || []).length} 項目`;
        status.title = `現在のフォルダー · 更新日時 ${fmt.dateTime(data.modifiedAt)}`;
      } else {
        status.textContent = `${KIND[data.kind] || data.kind} · ${fmt.time(data.fetchedAt)}に取得`;
        status.title = `現在のファイル · 更新日時 ${fmt.dateTime(data.modifiedAt)}`;
      }
      source = !!reference.line && typeof data.text === 'string';
      if (data.tree) {
        tree.setNodes(data.tree);
        tree.reveal(data.path);
        tree.select(data.path, false);
      }
      await paint();
    } catch (error) {
      if (current !== generation || error.name === 'AbortError' || panel.hidden) return;
      if (error.path) fullPath.value = error.path;
      status.textContent = '読み込みできません'; stateMessage('ファイルを開けません', error.message);
    }
  }
  /** 「原文」の中身。ファイルの本文でも可視化の HTML でも、同じ見た目で見せる */
  function sourceView(text, line = null) {
    const lines = String(text ?? '').split(/\r?\n/), target = line || 1;
    const start = Math.max(0, Math.min(lines.length - 5000, target - 2500));
    const end = Math.min(lines.length, start + 5000);
    const pre = el('pre', 'file-preview-source');
    for (let i = start; i < end; i++) {
      const row = el('span', 'file-preview-line' + (i + 1 === line ? ' on' : ''));
      const number = el('span', 'file-preview-line-number', String(i + 1)); number.setAttribute('aria-hidden', 'true');
      row.append(number, document.createTextNode(lines[i] || ' ')); pre.append(row);
    }
    content.replaceChildren(pre);
    if (lines.length > 5000) setNote(`${start + 1}〜${end}行を表示（全${lines.length}行）。全文は保存して確認できます。`);
    if (line > lines.length) setNote(`指定された${line}行目はありません（全${lines.length}行）。`);
    if (line) requestAnimationFrame(() => { const row = pre.querySelector('.on'); if (row?.isConnected) content.scrollTop = row.offsetTop - pre.offsetTop - 60; });
  }
  async function paintPdf(ticket) {
    const current = generation;
    if (!pdfDoc) {
      const pdf = await import('/vendor/pdfjs/build/pdf.mjs');
      if (ticket !== paintId || current !== generation) return;
      pdf.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/build/pdf.worker.mjs';
      const task = pdf.getDocument({ data:Uint8Array.from(atob(file.data), c => c.charCodeAt(0)), isEvalSupported:false,
        cMapUrl:'/vendor/pdfjs/cmaps/', cMapPacked:true, standardFontDataUrl:'/vendor/pdfjs/standard_fonts/', wasmUrl:'/vendor/pdfjs/wasm/' });
      pdfTask = task;
      const doc = await task.promise;
      if (ticket !== paintId || current !== generation) { await task.destroy(); return; }
      pdfDoc = doc;
    }
    if (ticket !== paintId || current !== generation) return;
    const tools = el('div', 'file-preview-media-tools');
    const prev = button('前のページ', () => { pdfPage--; paint(); }); prev.disabled = pdfPage <= 1;
    const next = button('次のページ', () => { pdfPage++; paint(); }); next.disabled = pdfPage >= pdfDoc.numPages;
    tools.append(prev, el('span', null, `${pdfPage} / ${pdfDoc.numPages}`), next,
      button('−', () => { pdfZoom = Math.max(.5, pdfZoom - .25); paint(); }), button('＋', () => { pdfZoom = Math.min(3, pdfZoom + .25); paint(); }));
    tools.children[3].setAttribute('aria-label','PDFを縮小'); tools.children[4].setAttribute('aria-label','PDFを拡大');
    const canvas = el('canvas'); canvas.setAttribute('role','img'); canvas.setAttribute('aria-label', `${file.name} ${pdfPage}ページ目`);
    const stage = el('div','file-preview-pdf'); stage.append(canvas); content.replaceChildren(tools, stage);
    const page = await pdfDoc.getPage(pdfPage);
    if (ticket !== paintId || current !== generation) return;
    const fit = Math.max(200, content.clientWidth - 40) / page.getViewport({scale:1}).width;
    const viewport = page.getViewport({scale:fit * pdfZoom});
    const pixelRatio = Math.min(devicePixelRatio || 1, 2, 4096 / Math.max(viewport.width, viewport.height));
    canvas.width = Math.floor(viewport.width * pixelRatio); canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
    renderTask = page.render({canvasContext:canvas.getContext('2d'), viewport, transform:[pixelRatio,0,0,pixelRatio,0,0]});
    await renderTask.promise;
    if (ticket !== paintId || current !== generation) return;
    const text = await page.getTextContent();
    if (ticket !== paintId || current !== generation) return;
    const accessible = el('details','file-preview-pdf-text'); accessible.append(el('summary',null,'このページのテキスト'),el('p',null,text.items.map(item=>item.str).join(' '))); content.append(accessible);
  }
  const setPressed = () => {
    rendered.setAttribute('aria-pressed', String(!source));
    original.setAttribute('aria-pressed', String(source));
  };
  /**
   * 可視化の面。ファイルと同じ切り替えを通す: プレビュー = 隔離した枠、原文 = 会話に残っている HTML そのもの。
   * 取り直しはできないので、再読み込みと「会話で使う」は出ないまま
   */
  function paintVisual() {
    setPressed();
    switcher.hidden = typeof visual.html !== 'string';
    setNote(''); content.scrollTop = 0;
    if (source) {
      content.setAttribute('aria-label', '可視化の原文');
      return sourceView(visual.html);
    }
    content.setAttribute('aria-label', '可視化の内容');
    content.replaceChildren(visualizationFrame(visual.html, visual.title, { fill:true }));
  }
  async function paint() {
    if (visual) return paintVisual();
    if (!file) return;
    renderTask?.cancel(); const ticket = ++paintId;
    setPressed();
    switcher.hidden = typeof file.text !== 'string' || file.kind === 'text' || file.kind === 'directory'; setNote(''); content.scrollTop = 0;
    const snapshot = file, signal = abort.signal;
    let resources = 0, resourceBytes = 0;
    const loadAsset = async (raw, base) => {
      if (++resources > 24 || !fileReference(raw)) throw new Error('resource');
      const asset = await request(raw, base || snapshot.path, signal, true); resourceBytes += asset.size;
      if (resourceBytes > 8 * 1024 * 1024) throw new Error('resource');
      return asset;
    };
    try {
      if (file.kind === 'directory') {
        const dirView = el('div', 'directory-view');
        const dirHead = el('div', 'dir-head');
        const dirTitle = el('h3', 'dir-title', file.name);
        const dirDesc = el('p', 'dir-desc', `${(file.items || []).length} 項目`);
        dirHead.append(dirTitle, dirDesc);

        const grid = el('div', 'directory-grid');
        for (const item of (file.items || [])) {
          const card = el('button', 'dir-card');
          card.type = 'button';
          const iconSpan = el('span', 'dir-card-icon');
          iconSpan.innerHTML = item.kind === 'directory' ? folderIcon : fileIcon;
          const info = el('div', 'dir-card-info');
          const nameSpan = el('span', 'dir-card-name', item.name);
          const metaSpan = el('span', 'dir-card-meta', item.kind === 'directory' ? 'フォルダー' : formatSize(item.size));
          info.append(nameSpan, metaSpan);
          card.append(iconSpan, info);
          card.onclick = () => {
            open({ path: item.path }, card, file.path);
          };
          card.oncontextmenu = e => {
            e.preventDefault();
            const at = pointAt(e, card);
            menu(at.x, at.y, { path:item.path, kind:item.kind === 'directory' ? 'directory' : 'file', cwd:file?.cwd });
          };
          grid.append(card);
        }
        if (!file.items || file.items.length === 0) {
          dirView.append(dirHead, el('div', 'dir-empty', 'フォルダーは空です'));
        } else {
          dirView.append(dirHead, grid);
        }
        content.replaceChildren(dirView);
        return;
      }
      if (source || file.kind === 'text') return sourceView(file.text, reference?.line ?? null);
      if (file.kind === 'unsupported') return stateMessage('このファイルはプレビューできません', file.reason);
      if (file.kind === 'markdown') {
        const result = await markdownContent(file.text, loadAsset);
        if (ticket !== paintId) return;
        content.replaceChildren(result.article); setNote(result.note);
      } else if (file.kind === 'html') {
        const result = await htmlDocument(file.text, loadAsset);
        if (ticket !== paintId) return;
        content.replaceChildren(previewFrame(result.document, file.name)); setNote(result.note);
      } else if (file.kind === 'table') {
        const { rows, truncated } = parseTable(file.text, file.delimiter);
        const table = el('table'), head = el('thead'), body = el('tbody');
        rows.forEach((row,i) => { const tr = el('tr'); row.forEach(value => { const cell = el(i ? 'td' : 'th', null, value); if (!i) cell.scope = 'col'; tr.append(cell); }); (i ? body : head).append(tr); });
        table.append(head, body); const wrapper = el('div', 'file-preview-table'); wrapper.append(table); content.replaceChildren(wrapper);
        setNote(truncated ? '先頭500行・100列まで表示しています。全文は原文または保存で確認できます。' : `${Math.max(0, rows.length - 1)}行 · ${Math.max(0, ...rows.map(row => row.length))}列`);
      } else if (file.kind === 'image') {
        const tools = el('div', 'file-preview-media-tools');
        const minus = button('−', () => { imageZoom = Math.max(.25, imageZoom - .25); paint(); }); minus.setAttribute('aria-label','画像を縮小');
        const plus = button('＋', () => { imageZoom = Math.min(3, imageZoom + .25); paint(); }); plus.setAttribute('aria-label','画像を拡大');
        tools.append(minus,el('span',null,`${Math.round(imageZoom * 100)}%`),plus,button('全体を表示',()=>{ imageZoom=1; paint(); }));
        const img = el('img'); img.alt = file.name; img.src = `data:${file.mime};base64,${file.data}`;
        img.style.width = `${imageZoom * 100}%`;
        img.onload = () => { if (ticket === paintId) setNote(`${img.naturalWidth} × ${img.naturalHeight}`); };
        img.onerror = () => { if (ticket === paintId) stateMessage('画像を表示できません', '破損または未対応の画像です。保存して確認できます。'); };
        const stage = el('div', 'file-preview-image'); stage.append(img); content.replaceChildren(tools,stage);
      } else if (file.kind === 'pdf') await paintPdf(ticket);
    } catch (error) {
      if (ticket !== paintId || error.name === 'AbortError' || error.name === 'RenderingCancelledException') return;
      stateMessage('プレビューを表示できません', file.kind === 'pdf' ? '暗号化・破損・未対応のPDFの可能性があります。保存して確認できます。' : '再読み込みするか、原文・保存で確認してください。');
    }
  }
  /** ファイル・可視化へ切り替えるとき、ファイル以外の中身の印を外して道具を戻す */
  function leaveCustom() {
    if (!custom) return;
    const was = custom; custom = null;
    panel.classList.remove('custom'); delete panel.dataset.panel;
    footer.hidden = false; wide.hidden = false; content.tabIndex = 0;
    treeToggle.hidden = false;
    if (was.opener?.isConnected) was.opener.setAttribute('aria-expanded', 'false');
  }
  /**
   * ファイル以外の中身を同じパネルに出す（会話の右パネル「この会話のコンテキスト」）。
   * 幅・広げる以外の枠の操作・Esc・狭い画面の全面表示はファイルと共有する。道具の列と下端は出さない
   */
  function openPanel({ key, title, subtitle = '', body, label, element, onClose }) {
    const previous = custom;
    abort?.abort(); generation++; paintId++; disposePdf(); disposeSnapshot();
    if (previous && previous.key !== key) { leaveCustom(); previous.onClose?.(); }
    opener = element ?? null; file = null; reference = null; visual = null;
    custom = { key, label, onClose, opener: element ?? null };
    context = getContext(element);
    panel.hidden = false; panel.classList.add('custom'); panel.dataset.panel = key; document.body.classList.add('file-preview-open');
    document.body.classList.remove('file-preview-wide');
    toolbar.hidden = true; location.hidden = true; footer.hidden = true; wide.hidden = true; setNote('');
    treeToggle.hidden = true; more.hidden = true;
    name.textContent = title; path.textContent = subtitle;
    content.setAttribute('aria-label', label); content.tabIndex = -1; content.scrollTop = 0;
    content.replaceChildren(body);
    clearCurrent();
    if (element) element.setAttribute('aria-expanded', 'true');
    layout(); panel.focus({ preventScroll:true });
  }
  /** 開いている自前の中身を差し替える（スクロール位置は保つ）。別の中身・閉じているときは何もしない */
  function updatePanel(key, { title, subtitle, body } = {}) {
    if (panel.hidden || custom?.key !== key) return false;
    const top = content.scrollTop;
    if (title !== undefined) name.textContent = title;
    if (subtitle !== undefined) path.textContent = subtitle;
    if (body) content.replaceChildren(body);
    content.scrollTop = top;
    return true;
  }
  function open(ref, element, base) {
    if (!base) opener = element;
    leaveCustom();
    disposeSnapshot();
    reference = ref; visual = null; context = { ...getContext(element), ...(base ? {base} : {}) };
    panel.hidden = false; document.body.classList.add('file-preview-open');
    toolbar.hidden = false; reload.hidden = false; use.hidden = false; locationButton.hidden = false; save.download = '';
    treeToggle.hidden = false;
    content.setAttribute('aria-label', 'ファイルの内容');
    name.textContent = ref.path.split(/[\\/]/).at(-1); path.textContent = ref.path; fullPath.value = ref.path;
    location.hidden = true; locationButton.setAttribute('aria-expanded','false');
    clearCurrent();
    // 印を付けるのはリンクだけ（画像や ⋯ から開いたときは、その横のリンクに付けない）
    if (element?.tagName === 'A') { element.classList.add('file-link'); element.setAttribute('aria-current','true'); }
    layout(); panel.focus({preventScroll:true}); load();
  }
  /**
   * 会話に載った可視化を同じパネルで開く。これは保存済みのスナップショットで、
   * ホスト上のファイルではない。**表示の切り替え（プレビュー / 原文）はファイルと同じ**で、
   * 原文は会話に残っている HTML そのもの。取り直しはできないので、再読み込みと「会話で使う」は出さない。
   * パスは元の在り処としてコピーでき、保存は見えている HTML をそのまま落とす。
   */
  function openVisualization({ content:html, title, path:origin }, element) {
    abort?.abort(); generation++; paintId++; disposePdf(); disposeSnapshot(); leaveCustom();
    opener = element; file = null; reference = null; source = false; visual = { html, title };
    context = getContext(element);
    panel.hidden = false; document.body.classList.add('file-preview-open');
    toolbar.hidden = false; reload.hidden = true; use.hidden = true; setNote('');
    treeToggle.hidden = true; more.hidden = browser.hidden = reveal.hidden = true;
    locationButton.hidden = !origin;
    location.hidden = true; locationButton.setAttribute('aria-expanded','false');
    name.textContent = title || '可視化'; path.textContent = origin ?? ''; fullPath.value = origin ?? '';
    snapshotUrl = visualizationBlobUrl(html);
    save.href = snapshotUrl; save.download = visualizationFileName({ path:origin, title }); save.hidden = false;
    save.title = '会話に残っている HTML を保存';
    status.textContent = '保存済みの可視化';
    status.title = 'この回答に保存された内容です。ホスト上のファイルの現在の内容ではありません。';
    paint();
    clearCurrent(); element.setAttribute('aria-current','true');
    layout(); panel.focus({preventScroll:true});
  }
  // ---- ファイルの操作（docs/mockups/file-actions.html）。メニューの中身は web/file-actions.mjs
  /** OS の操作の口（下の行・道具の列）。見ている場所と種類で出し分ける */
  function osButtons() {
    const local = osActions() && !!file && !visual && !custom;
    browser.hidden = !(local && file.kind === 'html');
    reveal.hidden = !local;
    if (local) reveal.textContent = file.kind === 'directory' ? t('files.menu.revealFolder') : t('files.menu.revealFile');
  }
  /** サーバーへ渡す場所の手がかり。相対パスは発言の時刻（at）かプレビュー中の文書（base）で解く */
  const whereFrom = target => {
    const ctx = target.element ? getContext(target.element) : context;
    return { path:target.path, ...(ctx.sessionId ? { sessionId:ctx.sessionId } : {}), ...(ctx.at ? { at:ctx.at } : {}), ...(target.base ? { base:target.base } : {}) };
  };
  const failed = error => notify(String(error?.message || error || t('files.actionFailed')));
  async function osAction(command, target) {
    if (!cmd) return;
    try { await cmd(command, whereFrom(target)); }
    catch (error) { failed(error); }
  }
  /** 完全なパスと作業ディレクトリ。分かっていればそのまま、相対なら発言の時点の作業ディレクトリでサーバーが解く */
  async function resolve(target) {
    if (/^(?:[a-z]:[\\/]|\/)/i.test(target.path) && target.cwd) return { path:target.path, cwd:target.cwd };
    return cmd('resolvePath', whereFrom(target));
  }
  /** relative は相対パスのコピーか（知らせの文言だけが違う） */
  async function copy(text, relative = false) {
    try { await navigator.clipboard.writeText(text); notify(relative ? t('files.copiedRelative') : t('files.copiedPath')); }
    catch { notify(relative ? t('files.copyRelativeFailed') : t('files.copyPathFailed')); }
  }
  async function run(action, target) {
    try {
      if (action === 'panel') return open({ path:target.path, line:target.line ?? null }, target.element, target.base);
      if (action === 'reveal') return osAction('revealPath', target);
      if (action === 'browser') return osAction('openPath', target);
      if (action === 'copy') return copy(/^(?:[a-z]:[\\/]|\/)/i.test(target.path) ? target.path : (await resolve(target)).path);
      if (action === 'copyRelative') {
        // 書かれたとおりの相対パスは、そのまま発言の時点の作業ディレクトリからの相対
        if (!/^(?:[a-z]:[\\/]|\/)/i.test(target.path) && !target.base) return copy(target.path.replace(/^\.[\\/]/, ''), true);
        const where = await resolve(target);
        const rel = relativeTo(where.path, where.cwd);
        return rel ? copy(rel, true) : notify(t('files.noRelative'));
      }
      const where = /^(?:[a-z]:[\\/]|\/)/i.test(target.path) ? { path:target.path } : await resolve(target);
      const name = where.path.split(/[\\/]/).at(-1);
      if (action === 'save') return download(fileDownloadUrl(where.path), name);
      if (action === 'use') {
        if (getContext().sessionId !== whereFrom(target).sessionId) return;
        useFile({ path:where.path, name, mime:'' });
      }
    } catch (error) { failed(error); }
  }
  /**
   * ファイルの操作メニューを開く。target は { path, kind?, line?, element?, base?, cwd?, current? }。
   * current（右パネルに出ているファイル）は「右パネルで開く」を出さない
   */
  function menu(x, y, target) {
    if (!showMenu || !target?.path) return;
    const current = target.current ?? (!!file && !panel.hidden && samePath(target.path, file.path));
    showMenu(x, y, fileMenuItems(target, { osActions:osActions(), current, canUse:!!useFile, run:action => run(action, target) }), menuTitle(target.path));
  }
  /** メニューの題はパス。長ければ先頭を省く（見たいのは末尾のファイル名） */
  const menuTitle = p => (p.length > 40 ? `…${p.slice(-39)}` : p);
  /** マウスなら押した位置、キーボード（ContextMenu キー・Shift+F10）なら要素の左下 */
  function pointAt(event, element) {
    if (event.clientX || event.clientY) return { x:event.clientX, y:event.clientY };
    const r = element.getBoundingClientRect();
    return { x:r.left + 8, y:r.bottom + 4 };
  }
  /** 会話・Markdown プレビューの中のファイル（リンク・画像・⋯）から操作の対象を作る */
  function targetOf(node) {
    const holder = node.closest('[data-file-path],[data-file-menu]');
    if (!holder || (!holder.closest('#log') && !holder.closest('.file-preview-document') && !holder.closest('#lightbox'))) return null;
    const path = holder.dataset.filePath ?? holder.dataset.fileMenu;
    if (!path) return null;
    return { path, line:Number(holder.dataset.fileLine) || null, element:holder, base:holder.closest('.file-preview-document') ? file?.path : undefined };
  }
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return;
    const target = targetOf(event.target);
    if (!target) return;
    event.preventDefault();
    const at = pointAt(event, target.element);
    menu(at.x, at.y, target);
  });
  document.addEventListener('click', event => {
    const more = event.target.closest('[data-file-menu]');
    if (!more) return;
    const target = targetOf(more);
    if (!target) return;
    event.preventDefault();
    const r = more.getBoundingClientRect();
    menu(r.left, r.bottom + 4, target);
  });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('a');
    if (!anchor || (!anchor.closest('#log') && !anchor.closest('.file-preview-document'))) return;
    const ref = anchor.dataset.filePath ? { path:anchor.dataset.filePath, line:Number(anchor.dataset.fileLine) || null } : fileReference(anchor.getAttribute('href'));
    if (!ref) return;
    event.preventDefault();
    const base = anchor.closest('.file-preview-document') ? file?.path : null;
    open(ref, anchor, base);
  });
  document.addEventListener('ply-visualize-expand', event => {
    if (event.detail && event.target?.isConnected) openVisualization(event.detail, event.target);
  });
  document.addEventListener('keydown', event => {
    if (panel.hidden || isComposingKey(event) || event.defaultPrevented || document.querySelector('dialog[open]')) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'Tab' && mobile.matches) {
      const nodes = [...panel.querySelectorAll('button,a,input,[tabindex="0"]')].filter(e => e.getClientRects().length && !e.disabled), first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first?.focus(); }
    }
  });
  handle.onpointerdown = event => {
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = e => { const available = besideSidebar(); percentage = Math.max(30, Math.min(65, (innerWidth - e.clientX) / available * 100)); layout(); };
    handle.onpointerup = handle.onpointercancel = () => { handle.onpointermove = null; };
  };
  handle.onkeydown = event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); percentage = Math.max(30,Math.min(65,percentage + (event.key === 'ArrowLeft' ? 2 : -2))); layout(); } };
  addEventListener('resize', layout);
  new MutationObserver(() => { if (!panel.hidden && document.body.classList.contains('settings')) close(false); }).observe(document.body,{attributes:true,attributeFilter:['class']});
  return { close, layout, openPanel, updatePanel, panelOpen: key => !panel.hidden && custom?.key === key,
    /** 右パネルでファイルを開く（拡大表示の「右パネルで開く」） */
    open: (ref, element) => open(ref, element),
    /** ファイルの操作メニュー（拡大表示・会話の画像） */
    menu, reveal: (target) => osAction('revealPath', target),
    /** 見ている場所（OS の操作の可否）が分かった・変わった */
    osChanged: osButtons,
    sessionChanged(id) { if (!panel.hidden && context.sessionId !== id) close(false); } };
}
