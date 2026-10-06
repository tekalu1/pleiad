// チャンネル・スレッドの入力欄の添付（docs/channels.md「画面」、ADR 0116）。Chats の入力欄（web/client.mjs の「添付」の節）と同じ操作を、
// 入力欄 1 つ分の持ち物として持つ: クリップ（ファイルの選択）・貼り付け・ドロップ・字の欄の中の札（web/md-editor.mjs の原子）・
// 送っている途中の進み具合と再試行・「添付 N 件 ▾」の一覧（web/attachment-list.mjs）・送れない理由。
// 部品は Chats と共有する: 断片の送り手（web/attach-upload.mjs）・一覧の面・札の描き方（web/user-message.mjs）・同名の札の見分け
// （web/composer-layout.mjs）。Chats の状態（state.attached・uploads）は会話・下書き・送信待ちに結び付いていて切り出せないので、ここは別に持つ。
// 中身はホストの置き場（<データ置き場>/uploads/<チャンネル id>/）へ送り、投稿の `attachments`（channels.post）にはパスだけを渡す。
// 出どころを選ばせる口（ホストのファイル・フォルダー）は持たない: Chats の作業ディレクトリに結び付いているため。
import { el, icon, randomId } from '../dom.mjs';
import { t, lang } from '../i18n.mjs';
import { sendAttachment, ATTACH_MAX_BYTES, IMAGE_READ_HINT_BYTES } from '../attach-upload.mjs';
import { formatBytes } from '../folder-upload.mjs';
import { openAttachmentList } from '../attachment-list.mjs';
import { createPasteImages } from '../paste-images.mjs';
import { attachFolderHints } from '../composer-layout.mjs';
import { attachedKey, composeBody } from './ch-attach-model.mjs';

const PAPERCLIP = 'M21.4 11.05l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.9-9.9a4 4 0 0 1 5.66 5.66l-9.9 9.9a2 2 0 0 1-2.83-2.83l9.2-9.2';

/** 添付の画像を大きく見る URL（/local-file。認証はクッキー）。パスが無ければ縮小の data URI */
const imageSrc = (a) => (a.path ? `/local-file?path=${encodeURIComponent(a.path)}` : a.dataUri);

/**
 * @param {object} o
 * @param {{ cmd: Function, whenOnline?: Function, openImage?: Function, filePreview?: object }} o.host
 * @param {() => string|null} o.bucket 置き場の分け先（チャンネルの id）
 * @param {() => string} o.owner いまの下書きの key。送っている間に別の下書きへ移っても、届いたものは持ち主の下書きへ入れる
 * @param {() => boolean} [o.accepts] 添付を受け付ける間か（書けない・アーカイブでは false）
 * @param {(text: string) => void} o.say 入力欄の下の一行（失敗など）
 * @param {() => void} o.onChange 添付が増減した・送る前の状態が変わった（下書きの保存・送信ボタンの状態）
 * @param {(owner: string, item: object) => void} o.adopt 別の下書きへ移った後に届いた添付を、その持ち主の下書きへ入れる
 */
export function createChAttachments({ host, bucket, owner, accepts = () => true, say, onChange, adopt }) {
  /** @type {{ path: string, name: string, kind: 'image'|'file', mime: string, from: 'device', size: number }[]} */
  let attached = [];
  const uploads = new Map();
  const removed = new Map();   // 元に戻すで札が戻ったとき、添付の実体も戻す
  let editor = null, input = null, entry = null, list = null, hintSig = '', memo = null;

  const strip = el('div', 'att-strip');
  strip.hidden = true;
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const button = el('button', 'btn btn-icon ch-attach');
  button.type = 'button';
  button.title = t('chat.composer.attach');
  button.setAttribute('aria-label', t('chat.composer.attach'));
  button.append(icon(PAPERCLIP));

  const byPath = (path) => attached.find((a) => attachedKey(a.path) === attachedKey(path)) ?? null;
  const hintsOf = () => attachFolderHints(attached, { deviceLabel: t('chat.attach.deviceFolder') });
  const mine = () => [...uploads.values()].filter((u) => !u.gone && u.owner === owner() && (!u.cancelled || editor?.hasAttachment(`i:${u.id}`)));

  // ---------------------------------------------------------------- 字の欄へ渡すもの（createMarkdownEditor の引数）
  const editorOptions = {
    resolve: (path) => {
      const a = byPath(path);
      return a ? { ...a, hint: hintsOf()[attached.indexOf(a)] || '' } : null;
    },
    // 貼り付けた HTML の画像（data: はその場で、https はホストが取りに行く。ADR 0141）。書けない間は取り込まない
    importImages: (images) => (accepts() ? pasteImages.start(images) : []),
    pending: (pid) => {
      const u = uploads.get(pid);
      if (!u) return null;
      // ホストが取りに行っている画像。失敗の札は無い（取れなければ札ごと静かに消える）
      if (u.import) return { name: u.name, state: 'importing', host: u.import.host };
      const failed = u.failed || u.cancelled;
      return { name: u.name, size: u.size, state: failed ? 'failed' : 'sending', percent: u.size ? Math.floor((u.sent / u.size) * 100) : 0,
        error: u.failed ?? (u.cancelled ? t('chat.composerAtt.cancelled') : '') };
    },
    locale: () => lang,
    onAtoms: ({ added, removed: gone }) => {
      for (const key of gone) {
        if (key.startsWith('p:')) {
          const i = attached.findIndex((a) => attachedKey(a.path) === key);
          if (i >= 0) removed.set(key, attached.splice(i, 1)[0]);
        } else {
          const u = uploads.get(key.slice(2));
          if (u?.import) pasteImages.cancel(u);   // 取り込み中の札を外した・元に戻した: 取得もやめる
          else if (u && !u.failed) u.cancelled = true;
        }
      }
      for (const key of added) {
        if (!key.startsWith('p:')) continue;
        const a = removed.get(key);
        if (a && !byPath(a.path)) { attached.push(a); removed.delete(key); }
      }
      render();
      onChange();
    },
    onZoom: (info) => host.openImage?.(imageSrc(info), info.name, info.path),
    onOpenFile: (info, anchor) => host.filePreview?.open({ path: info.path, line: null }, anchor),
    onAtomAction: (act, key) => {
      if (act === 'retry') { const u = uploads.get(key.slice(2)); if (u) runUpload(u); return; }
      removeAttachment(key);
    },
  };

  // ---------------------------------------------------------------- 入口「添付 N 件 ▾」と一覧
  function render() {
    const here = mine();
    const failed = here.filter((u) => u.failed || u.cancelled).length, importing = here.filter((u) => u.import).length, sending = here.length - failed - importing;
    const total = attached.length + here.length;
    strip.hidden = total === 0;
    if (!entry) {
      const b = el('button', 'att-entry');
      b.type = 'button';
      b.setAttribute('aria-haspopup', 'dialog');
      b.setAttribute('aria-expanded', 'false');
      const count = el('span', 'att-count'), status = el('span', 'att-state');
      status.setAttribute('role', 'status');
      const caret = el('span', null, '▾');
      caret.setAttribute('aria-hidden', 'true');
      b.append(icon(PAPERCLIP), count, caret, status);
      b.onclick = openList;
      entry = { b, count, status };
      strip.append(b);
    }
    entry.count.textContent = t('chat.attachList.count', { count: total });
    entry.status.textContent = [failed ? t('chat.composerAtt.entryFailed', { count: failed }) : '', sending ? t('chat.composerAtt.entrySending', { count: sending }) : '',
      importing ? t('chat.composerAtt.entryImporting', { count: importing }) : ''].filter(Boolean).map((s) => ` · ${s}`).join('');
    entry.b.dataset.state = failed ? 'failed' : sending || importing ? 'sending' : '';
    // 同じ名前の添付が増えた・減った: 札に添える見分けのフォルダーが変わるので札を描き直す
    const hints = hintsOf().map((h, i) => (h ? `${attachedKey(attached[i].path)}=${h}` : '')).filter(Boolean).join('|');
    if (hints !== hintSig) { hintSig = hints; editor?.refresh(); }
    if (!total) list?.close();
    else list?.update(listRows(), t('chat.attachList.count', { count: total }));
  }

  function listRows() {
    const inDoc = editor?.attachmentKeys() ?? new Set();
    const inline = t('chat.attachList.section.inline'), tail = t('chat.attachList.section.tail');
    const hints = hintsOf();
    const file = (a, section) => ({
      id: attachedKey(a.path), kind: a.kind === 'image' ? 'image' : 'file', name: a.name, path: a.path || '', hint: hints[attached.indexOf(a)] || null,
      thumb: a.kind === 'image' ? imageSrc(a) : null, origin: 'device', size: Number.isFinite(a.size) ? a.size : null, status: t('chat.attachList.sent'), section,
    });
    const sending = (u, section) => {
      const p = editorOptions.pending(u.id);
      if (p.state === 'importing') return { id: `i:${u.id}`, kind: 'image', name: u.name, path: '', origin: null, size: null, section, status: t('chat.attachList.importing'), progress: null };
      return { id: `i:${u.id}`, kind: 'file', name: u.name, path: '', origin: 'device', size: u.size, section,
        status: p.state === 'failed' ? p.error : t('chat.composerAtt.entrySending', { count: 1 }), progress: p.state === 'sending' ? p.percent : null };
    };
    const rows = [];
    for (const key of inDoc) {
      const a = key.startsWith('p:') ? attached.find((x) => attachedKey(x.path) === key) : null;
      const u = key.startsWith('i:') ? uploads.get(key.slice(2)) : null;
      if (a) rows.push(file(a, inline)); else if (u) rows.push(sending(u, inline));
    }
    for (const a of attached) if (!inDoc.has(attachedKey(a.path))) rows.push(file(a, tail));
    for (const u of mine()) if (!inDoc.has(`i:${u.id}`)) rows.push(sending(u, tail));
    return rows;
  }

  function openList() {
    const at = editor?.rememberCaret();
    entry.b.setAttribute('aria-expanded', 'true');
    list = openAttachmentList({
      anchor: entry.b, title: t('chat.attachList.count', { count: attached.length + mine().length }), items: listRows(),
      // 全部外して入口ごと隠れたときは、フォーカスが <body> に落ちないよう入力欄へ
      onClose: () => { list = null; entry.b.setAttribute('aria-expanded', 'false'); if (!document.activeElement || document.activeElement === document.body) input?.focus({ preventScroll: true }); },
      actions: (item) => {
        const key = item.id;
        if (key.startsWith('i:')) {
          const p = editorOptions.pending(key.slice(2));
          return p?.state === 'importing'
            ? [{ label: t('chat.paste.cancelImport'), run: () => removeAttachment(key), keepOpen: true }]
            : p?.state === 'sending'
            ? [{ label: t('chat.attach.cancelSending'), run: () => removeAttachment(key), keepOpen: true }]
            : [{ label: t('chat.composerAtt.retry'), run: () => editorOptions.onAtomAction('retry', key), keepOpen: true },
               { label: t('chat.attach.remove'), run: () => removeAttachment(key), keepOpen: true }];
        }
        const placed = editor.hasAttachment(key);
        return [
          placed ? { label: t('chat.attachList.jump'), run: () => editor.reveal(key) }
            : { label: t('chat.attachList.insert'), run: () => {
              const a = attached.find((x) => attachedKey(x.path) === key);
              if (a) { editor.insertAttachment({ path: a.path }, { at }); render(); onChange(); editor.reveal(key); }
            } },
          { label: t('chat.attach.remove'), run: () => removeAttachment(key), keepOpen: true },
        ];
      },
    });
  }

  /** 添付を外す（札があれば札ごと。文末に付くものは実体だけ）。送っている途中ならやめる */
  function removeAttachment(key) {
    if (editor.removeAttachment(key)) return;
    if (key.startsWith('p:')) {
      const i = attached.findIndex((a) => attachedKey(a.path) === key);
      if (i >= 0) attached.splice(i, 1);
    } else {
      const u = uploads.get(key.slice(2));
      if (u) { u.cancelled = true; if (u.failed) uploads.delete(u.id); }
    }
    render();
    onChange();
  }

  function flash() {
    const b = entry?.b;
    if (!b) return;
    b.classList.remove('flash');
    void b.offsetWidth;
    b.classList.add('flash');
    b.addEventListener('animationend', () => b.classList.remove('flash'), { once: true });
  }

  // ---------------------------------------------------------------- 送る
  /** クリップを押した時点の字の欄の位置（メニューやファイルの選択でフォーカスが移っても、そこへ札を置く。2 分で忘れる） */
  const remember = () => { memo = { at: editor?.rememberCaret(), time: Date.now() }; };
  const takeAt = () => { const m = memo; memo = null; return m && Date.now() - m.time < 120_000 ? m.at : null; };

  /**
   * この端末のファイルを添付として送る（ドロップ・貼り付け・クリップの選択）。1 件 100MB まで・件数の上限は無い。
   * 字の欄のカーソル（ドロップは落とした位置）に仮の札を先に置き、中身は断片で送って札が進み具合（%）を出す。終わったらパスを持つ普通の札になる
   */
  async function attachFiles(files, { at = takeAt() } = {}) {
    if (!accepts()) return;
    const queue = [];
    for (const file of files) {
      if (file.size > ATTACH_MAX_BYTES) { say(t('chat.attach.tooLarge', { name: file.name, limit: formatBytes(ATTACH_MAX_BYTES) })); continue; }
      const u = { id: randomId(), file, name: file.name, size: file.size, sent: 0, owner: owner(), bucket: bucket(), cancelled: false, failed: null, placed: false };
      uploads.set(u.id, u);
      u.placed = editor.insertAttachment({ pid: u.id }, { at }) === 'inserted';
      at = null;
      queue.push(u);
    }
    render();
    for (const u of queue) await runUpload(u);
  }

  /** 1 件を送る（最初と「再試行」）。仮の札を、届いたパスを持つ札に替える */
  async function runUpload(u) {
    u.failed = null; u.cancelled = false; u.sent = 0;
    editor.updatePending(u.id);
    render();
    const { file } = u;
    try {
      const r = await sendAttachment({ cmd: host.cmd, file, sessionId: u.bucket, cancelled: () => u.cancelled, online: host.whenOnline,
        onProgress: (sent) => { u.sent = sent; paint(u); } });
      if (!r || u.cancelled) { u.cancelled = true; render(); return false; }   // やめた（札は外れている）
      settleUpload(u, { name: file.name, path: r.path, kind: r.kind, mime: file.type, from: 'device', size: file.size });
      if (r.kind === 'image' && file.size > IMAGE_READ_HINT_BYTES) say(t('chat.attach.largeImage', { name: file.name, size: formatBytes(file.size) }));
      return true;
    } catch (e) {
      u.failed = e?.message ?? String(e);
      // 札が字の欄にあれば札に理由・再試行・外すを出す。札の無い失敗は入力欄の下の一行で
      if (u.placed && editor.hasAttachment(`i:${u.id}`)) editor.updatePending(u.id);
      else { uploads.delete(u.id); say(t('chat.attach.failed', { name: file.name, error: u.failed })); }
      render();
      return false;
    }
  }

  /** 届いた添付（item）の始末（ファイルの送信・貼り付けた画像の取り込みが使う）。仮の札をパスの札に替える */
  function settleUpload(u, item) {
    if (u.owner === owner()) {
      uploads.delete(u.id);
      attached.push(item);
      editor.resolvePending(u.id, item.path);
      render();
      onChange();
    } else {
      // 送っている間に別の入力欄・スレッドへ移った。持ち主の下書きへ積む（位置は持たない: 文末に付く）
      adopt(u.owner, item);
      uploads.delete(u.id);
      render();
    }
  }

  /** 貼り付けた HTML の画像の取り込み（web/paste-images.mjs。ADR 0141）。送信中の一覧（uploads）に載せ、送れない間・入口の件数・下書きは添付と同じ扱い */
  const pasteImages = createPasteImages({
    cmd: (command, args) => host.cmd(command, args),
    editor: () => editor,
    entry: (base) => {
      const u = { sent: 0, owner: owner(), bucket: bucket(), cancelled: false, failed: null, placed: true, ...base };
      uploads.set(u.id, u);
      return u;
    },
    bucketOf: (u) => u.bucket,
    uploadFile: (u) => runUpload(u),
    finished: async (u, r) => {
      settleUpload(u, { name: r.name, path: r.path, kind: 'image', mime: r.mime, from: 'import', size: r.bytes });
      if (r.bytes > IMAGE_READ_HINT_BYTES) say(t('chat.attach.largeImage', { name: r.name, size: formatBytes(r.bytes) }));
    },
    dropped: (u) => { uploads.delete(u.id); render(); },
    registered: () => render(),
  });

  function paint(u) {
    editor.updatePending(u.id);
    const pct = u.size ? Math.floor((u.sent / u.size) * 100) : 0;
    const row = list?.dialog.querySelector(`.att-list-row[data-id="${CSS.escape(`i:${u.id}`)}"] .att-list-bar`);
    if (row) { row.style.setProperty('--p', `${pct}%`); row.setAttribute('aria-valuenow', String(pct)); }
  }

  // ---------------------------------------------------------------- ドロップ・貼り付け・選択
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');

  /** zone に落とされたファイルを添付にする。落とした位置が字の欄の上ならその位置へ。フォルダーは添付できないので知らせる */
  function bindDropZone(zone) {
    let depth = 0;
    const show = (on) => zone.classList.toggle('dropping', on);
    // 親（Chats の入力欄の受け口は main 全体）へ伝えない: チャンネルの画面に落としたファイルが Chats の入力欄へ入らないように
    zone.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); if (accepts()) { depth++; show(true); } });
    zone.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = accepts() ? 'copy' : 'none'; });
    zone.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; e.stopPropagation(); if (--depth <= 0) { depth = 0; show(false); } });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); e.stopPropagation(); depth = 0; show(false);
      if (!accepts()) return;
      const entries = [...(e.dataTransfer.items ?? [])].map((i) => (i.kind === 'file' ? i.webkitGetAsEntry?.() : null));
      const files = [...(e.dataTransfer.files ?? [])].filter((_, i) => !entries[i]?.isDirectory);
      if (files.length < (e.dataTransfer.files?.length ?? 0)) say(t('channels:feed.attach.folder'));
      if (files.length) attachFiles(files, { at: editor.posFromPoint(e.clientX, e.clientY) });
    });
  }

  /** 貼り付け（スクリーンショットを撮ってそのまま貼る動線）。ファイルが無ければ字の貼り付けに任せる */
  function bindPaste(target) {
    target.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      attachFiles(files);
    });
  }

  // ---------------------------------------------------------------- 状態
  /** 字の欄ができた後に結ぶ（字の欄の引数に editorOptions を渡すので、作る順が逆になる） */
  function bind(ed, el_) {
    editor = ed; input = el_;
    bindPaste(el_);
    button.addEventListener('pointerdown', remember, true);
    button.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') remember(); }, true);
    button.addEventListener('click', () => { if (accepts()) fileInput.click(); });
    fileInput.onchange = () => { attachFiles([...fileInput.files]); fileInput.value = ''; };
  }

  return {
    strip, button, fileInput, editorOptions, bind, bindDropZone, render, flash,
    attachFiles,
    get items() { return attached.slice(); },
    /** 送れない理由（送信中・失敗の添付があるとき）。無ければ null。欠けた添付を前提に bot が動き出さないように、届くまで送らない */
    blockReason() {
      const here = mine();
      if (here.some((u) => u.failed || u.cancelled)) return t('chat.composerAtt.blockFailed');
      if (!here.length) return null;
      return here.every((u) => u.import) ? t('chat.composerAtt.blockImporting') : t('chat.composerAtt.blockSending');
    },
    /** 送るもの（本文と、channels.post の attachments） */
    compose: (value) => composeBody(value, attached, editor.attachmentKeys(), lang),
    /** 下書きの添付の実体を置く。字の欄の値を入れる前に呼ぶ（本文の印は、ここにあるものだけが札になる） */
    restore(items) {
      attached = Array.isArray(items) ? items.filter((a) => a && typeof a.path === 'string').map((a) => ({ ...a })) : [];
      for (const [id, u] of uploads) if (u.cancelled || u.failed) uploads.delete(id);
      removed.clear();
      render();
    },
    /** 送った・書き直す前: 添付の実体を空にする（送っている途中のものは持ち主の下書きの分として残る） */
    clear() { attached = []; removed.clear(); render(); },
    get hasContent() { return attached.length > 0 || mine().length > 0; },
  };
}
