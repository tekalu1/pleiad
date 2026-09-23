// 手元のフォルダーをホストへ送る（docs/remote.md §8.1、issue #15。承認済みのモック docs/mockups/remote-folder-picker.html）。
//
// リモートの窓（window.plyRemote があり、shell が mobile ではない）だけで使う。手元のファイルを渡すのは添付と同じ種類の操作なので、
// 入口は添付（クリップ）のボタン: 押すと小さなメニュー「ファイルを添付… / フォルダーを送る…」（web/attach-menu.mjs）。
// 「フォルダーを送る…」は同じ面の中で送る流れ（renderUpload）に替わる。「送ったフォルダーを作業フォルダーにする」（既定で入）。
// フォルダーをドロップしたときの問い（添付する / 作業フォルダーとして送る）の「送る」も同じ流れを開く。
// 作業フォルダーの面（入力欄のチップ）はホストのフォルダーだけを扱う。ローカルの窓・ブラウザー版のクリップは今までどおりファイルを選ぶだけ。
//
// 手元のフォルダーの読み方: <input type="file" webkitdirectory> と、ドロップの DataTransferItem.webkitGetAsEntry()。
// どちらもブラウザー（Electron の描画側）の機能で、手元の OS のダイアログを出して File を返すだけなので、
// ホストが配るページに同じ PC のブリッジ（preload の口）を足さずに済む。showDirectoryPicker も Electron で動くが、
// 権限の問い合わせ・持ち越しの扱いが増えるわりに、送るには File が読めれば足りるので使わない。
// webkitdirectory はリンクを辿らず実体のファイルだけを返し、空のフォルダーは含まない。
//
// 送り方: uploadCheck で送り先を下見 → uploadStart（受け取り済みの位置が返る）→ uploadChunk を同時に 4 つまで
// （512 KiB を base64。応答が背圧になる）→ uploadFinish。切れたら止め、つながり直したら uploadStart をもう一度呼んで
// 受け取り済みの位置から続ける（トンネルはストリームを持ち越さないので、再開はこの層で行う）。
// 終わったら、入にしていれば送り先をその会話の作業フォルダーにする（client.mjs の onDone。未送信の会話はその場で、送信済みは次のターンから）。
import { t, fmt } from './i18n.mjs';
import { el, svgEl } from './dom.mjs';
import { createCombo } from './combo.mjs';
import { isComposingKey } from './keyboard.mjs';

export const DEFAULT_EXCLUDES = Object.freeze(['.git', 'node_modules']);
export const CHUNK_BYTES = 512 * 1024;
export const IN_FLIGHT = 4;
// これを超えたら送る前に一文で知らせる（送ることは止めない）
export const WARN_FILES = 20_000;
export const WARN_BYTES = 2 * 1024 ** 3;

/** フォルダーを送れる窓か（デスクトップ版のリモートの窓だけ。モバイル・ローカルの窓・ブラウザー版は出さない） */
export function canSendFolders(remote = globalThis.window?.plyRemote) {
  return Boolean(remote && typeof remote === 'object' && typeof remote.hostId === 'string' && remote.hostId && remote.shell !== 'mobile');
}

/** 除外の 1 つを正規表現に。名前（* と ? が使える）はどの階層の要素にも当たる。/ を含めば先頭からのパス */
export function excludeMatcher(pattern) {
  const p = String(pattern ?? '').trim().replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!p) return null;
  const body = p.split('/').map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]')).join('/');
  return p.includes('/') ? new RegExp(`^${body}(?:/|$)`, 'i') : new RegExp(`(?:^|/)${body}(?:/|$)`, 'i');
}

/** 手元の一覧を除外で分ける。entries は [{ path, file }]（path は選んだフォルダーからの相対） */
export function summarize(entries, excludes = DEFAULT_EXCLUDES) {
  const res = excludes.map(excludeMatcher).filter(Boolean);
  const included = [];
  let bytes = 0, skippedFiles = 0, skippedBytes = 0;
  for (const e of entries) {
    const size = e.file?.size ?? 0;
    if (res.some((re) => re.test(e.path))) { skippedFiles++; skippedBytes += size; continue; }
    included.push(e);
    bytes += size;
  }
  return { included, files: included.length, bytes, skippedFiles, skippedBytes, large: included.length > WARN_FILES || bytes > WARN_BYTES };
}

/** 大きさ（1024 進。100 未満は小数 1 桁まで） */
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, Number(n) || 0), u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${fmt.number(v, { maximumFractionDigits: u === 0 || v >= 100 ? 0 : 1 })} ${units[u]}`;
}

/** 件数と大きさの一行。「3,410 件 · 131 MB」 */
export const sizeLine = (files, bytes) => t('upload.count', { count: files, files: fmt.number(files), size: formatBytes(bytes) });

/** 進み具合の一行。「1,204 / 3,410 件 · 48.2 / 131 MB」（単位が同じなら送った分の単位は省く） */
export function progressLine(p) {
  const size = formatBytes(p.bytes);
  let sent = formatBytes(p.sentBytes);
  const unit = size.slice(size.lastIndexOf(' '));
  if (sent.endsWith(unit)) sent = sent.slice(0, -unit.length);
  return t('upload.progress', { count: p.files, done: fmt.number(p.doneFiles), files: fmt.number(p.files), sent, size });
}

/** <input webkitdirectory> の File の一覧を { name, entries } に（webkitRelativePath の先頭がフォルダー名） */
export function entriesFromFileList(list) {
  const entries = [];
  let name = '';
  for (const file of list ?? []) {
    const rel = String(file.webkitRelativePath || file.name).replaceAll('\\', '/');
    const i = rel.indexOf('/');
    if (i < 0) { entries.push({ path: rel, file }); continue; }
    name ||= rel.slice(0, i);
    entries.push({ path: rel.slice(i + 1), file });
  }
  return { name: name || 'folder', entries };
}

/** ドロップの FileSystemEntry（フォルダー）の中身を全部読む。{ name, entries } */
export async function entriesFromDirectory(dir) {
  const entries = [];
  const walk = async (d, prefix) => {
    const reader = d.createReader();
    // readEntries は 100 件ずつしか返さないので、空が返るまで読む
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory) await walk(e, rel);
        else if (e.isFile) entries.push({ path: rel, file: await new Promise((res, rej) => e.file(res, rej)) });
      }
    }
  };
  await walk(dir, '');
  return { name: dir.name, entries };
}

export const readChunk = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onerror = () => rej(fr.error ?? new Error('read'));
  fr.onload = () => { const s = String(fr.result); res(s.slice(s.indexOf(',') + 1)); };
  fr.readAsDataURL(blob);
});

/**
 * 送る作業の状態を持つ。画面（renderLocal）は phase を見て描く。
 *   phase: empty（未選択）| ready（送る前。plan が送り先の下見）| sending | paused（接続が切れた）| done | error
 * @param {object} o
 * @param {(command:string, args?:object) => Promise<any>} o.cmd
 * @param {() => boolean} o.connected 今サーバーにつながっているか
 * @param {() => string|null} o.session 今の会話（送り終えたときに作業フォルダーにする相手）
 * @param {(dest:string, sessionId:string|null, o:{ makeCwd:boolean }) => Promise<'now'|'next'|'other'>} o.onDone
 *   makeCwd が偽なら作業フォルダーは変えない（'other' を返す）
 * @param {() => void} [o.onChange]
 */
export function createFolderUpload({ cmd, connected, session, onDone, onChange = () => {} }) {
  const s = {
    phase: 'empty', name: '', entries: [], excludes: [...DEFAULT_EXCLUDES], summary: null,
    dest: '', plan: null, planError: '', checking: false,
    files: [], received: [], uploadId: null, overwrite: false, sessionId: null, current: '',
    error: '', result: null,
    makeCwd: true,      // 送ったフォルダーを作業フォルダーにする（既定で入）
  };
  let gen = 0;          // 送る作業の世代。中断・選び直しで上げ、古い作業の応答を捨てる
  let cancelled = -1;   // 中断した世代
  let checkSeq = 0;
  const changed = () => onChange();

  const progress = () => {
    let sentBytes = 0, doneFiles = 0;
    s.files.forEach((f, i) => { sentBytes += s.received[i] ?? 0; if ((s.received[i] ?? 0) >= f.size) doneFiles++; });
    return { files: s.files.length, bytes: s.summary?.bytes ?? 0, sentBytes, doneFiles };
  };

  async function check() {
    const seq = ++checkSeq;
    s.checking = true;
    s.planError = '';
    changed();
    try {
      const plan = await cmd('uploadCheck', { name: s.name, dest: s.dest || undefined, paths: s.summary.included.map((e) => e.path) });
      if (seq !== checkSeq) return;
      s.plan = plan;
      if (!s.dest) { s.dest = plan.dest; s.defaultDest = plan.dest; }
    } catch (e) {
      if (seq !== checkSeq) return;
      s.plan = null;
      s.planError = e.message;
    } finally {
      if (seq === checkSeq) { s.checking = false; changed(); }
    }
  }

  /** 送るフォルダーを決める。makeCwd を渡せば「作業フォルダーにする」もそれにする（ドロップの「作業フォルダーとして送る」は true） */
  function choose({ name, entries }, { makeCwd } = {}) {
    gen++;
    if (typeof makeCwd === 'boolean') s.makeCwd = makeCwd;
    Object.assign(s, { phase: 'ready', name, entries, dest: '', defaultDest: '', plan: null, error: '', result: null, uploadId: null, overwrite: false });
    s.summary = summarize(entries, s.excludes);
    changed();
    return check();
  }

  function setExcludes(list) {
    s.excludes = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
    if (!s.entries.length) return changed();
    s.summary = summarize(s.entries, s.excludes);
    changed();
    return check();
  }

  function setMakeCwd(v) {
    s.makeCwd = Boolean(v);
    changed();
  }

  function setDest(v) {
    s.dest = String(v ?? '').trim();
    s.plan = null;
    return check();
  }

  async function send({ overwrite = false } = {}) {
    if (!s.summary?.files || s.phase === 'sending') return;
    const my = ++gen;
    s.files = s.summary.included.map((e) => ({ path: e.path, size: e.file.size, mtime: e.file.lastModified, file: e.file }));
    s.received = s.files.map(() => 0);
    s.overwrite = overwrite;
    s.sessionId = session();
    s.error = '';
    s.phase = 'sending';
    changed();
    await run(my);
  }

  /** uploadStart（続きの位置を取り直す）→ 断片 → uploadFinish。切れたら paused で止まる */
  async function run(my) {
    try {
      const r = await cmd('uploadStart', {
        name: s.name, dest: s.plan?.dest || s.dest || undefined, overwrite: s.overwrite,
        files: s.files.map(({ path, size, mtime }) => ({ path, size, mtime })),
      });
      if (my !== gen) {
        // 応答を待つ間に中断された。置き場にできた途中のものを捨てる
        if (cancelled === my && r.uploadId) cmd('uploadCancel', { uploadId: r.uploadId }).catch(() => {});
        return;
      }
      if (r.needsConfirm) {
        // 送り先の様子が変わった（その間に誰かが作った）。確認からやり直す
        s.plan = r; s.dest = r.dest; s.phase = 'ready';
        return changed();
      }
      s.uploadId = r.uploadId;
      s.received = r.received.slice();
      changed();
      for (let pass = 0; ; pass++) {
        const jobs = [];
        s.files.forEach((f, i) => { for (let off = s.received[i]; off < f.size; off += CHUNK_BYTES) jobs.push({ i, off }); });
        if (!jobs.length) break;
        if (pass > 3) throw new Error(t('upload.stalled'));
        let k = 0, stop = false;
        await Promise.all(Array.from({ length: Math.min(IN_FLIGHT, jobs.length) }, async () => {
          while (k < jobs.length && my === gen && !stop) {
            const { i, off } = jobs[k++];
            const f = s.files[i];
            let data;
            try { data = await readChunk(f.file.slice(off, Math.min(off + CHUNK_BYTES, f.size))); }
            catch { stop = true; throw Object.assign(new Error(t('upload.readFailed', { path: f.path })), { local: true }); }
            if (my !== gen) return;
            s.current = f.path;
            // 1 つ失敗したら、ほかの投げ手も次を取らない（切れたなら続きは uploadStart からやり直す）
            const res = await cmd('uploadChunk', { uploadId: s.uploadId, file: i, offset: off, data }).catch((e) => { stop = true; throw e; });
            if (my !== gen) return;
            s.received[i] = res.received;
            changed();
          }
        }));
        if (my !== gen) return;
      }
      const done = await cmd('uploadFinish', { uploadId: s.uploadId });
      if (my !== gen) return;
      if (done.needsConfirm) { s.plan = done; s.dest = done.dest; s.phase = 'ready'; return changed(); }
      const applied = await onDone(done.dest, s.sessionId, { makeCwd: s.makeCwd }).catch(() => 'other');
      s.result = { ...done, applied };
      s.phase = 'done';
      s.uploadId = null;
      changed();
    } catch (e) {
      if (my !== gen) return;
      if (!e.local && !connected()) { s.phase = 'paused'; return changed(); }
      s.phase = 'error';
      s.error = e.message;
      changed();
    }
  }

  /** つながり直した（client.mjs が ready で呼ぶ）。止まっていれば続きから */
  function online() {
    if (s.phase !== 'paused') return;
    s.phase = 'sending';
    changed();
    run(++gen);
  }

  /** 送信をやめる（置いた途中のものも捨てる） */
  async function cancel() {
    const id = s.uploadId;
    cancelled = gen;
    gen++;
    s.uploadId = null;
    s.phase = s.entries.length ? 'ready' : 'empty';
    changed();
    if (id) await cmd('uploadCancel', { uploadId: id }).catch(() => {});
    if (s.entries.length) check();
  }

  function reset() {
    gen++;
    Object.assign(s, { phase: 'empty', name: '', entries: [], summary: null, dest: '', plan: null, planError: '', error: '', result: null, uploadId: null, files: [], received: [], makeCwd: true });
    changed();
  }

  return {
    state: s, progress, choose, setExcludes, setDest, setMakeCwd, send, online, cancel, reset,
    get busy() { return s.phase === 'sending' || s.phase === 'paused'; },
  };
}

export const FOLDER = 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z';
const FOLDER_ADD = 'M12 11v5M9.5 13.5h5';

export function glyph(...paths) {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) svg.append(svgEl('path', { d }));
  return svg;
}

/** 手元の OS のフォルダーのダイアログを出す（押した操作の中で呼ぶ）。選んだら up.choose */
export function pickFolder(up, opts) {
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.multiple = true;
  input.hidden = true;
  input.onchange = () => {
    const picked = entriesFromFileList(input.files);
    input.remove();
    if (picked.entries.length) up.choose(picked, opts);
  };
  input.addEventListener('cancel', () => input.remove());
  // 面を描き直しても選んだ結果を受け取れるよう、面の外に置く
  document.body.append(input);
  input.click();
}

// 訳文の中に要素を差し込む（語順は言語で違うので、差し込む位置は訳文に任せる）
const SLOT = '\u0000';
const slot = (text, node) => text.split(SLOT).flatMap((x, i) => (i ? [node, x] : [x]));

function button(text, cls, onClick) {
  const b = el('button', `btn${cls ? ` ${cls}` : ''}`, text);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

/**
 * 「フォルダーを送る」の流れを box に描く。進み具合だけが変わったときは数字だけ差し替える（押しているボタンを消さない）。
 * @param {HTMLElement} box
 * @param {ReturnType<typeof createFolderUpload>} up
 * @param {object} o
 * @param {() => Array<{value:string,time?:number}>} o.recent 最近の作業フォルダー（送り先の候補）
 * @param {() => void} o.close 面を閉じる
 */
export function renderUpload(box, up, { recent, close }) {
  const s = up.state;
  const view = box._fu;
  // 送る前の面は、除外・一覧が変わったときだけ描き直す（送り先を打っている途中・下見の結果だけなら状態の行だけ）
  const sig = s.phase === 'ready' || s.phase === 'error' ? JSON.stringify([s.name, s.excludes, s.summary?.files, s.summary?.bytes, s.entries.length]) : '';
  if (view && view.phase === s.phase && view.sig === sig && view.update) return view.update();
  const refocus = box.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
  box.replaceChildren();
  box._fu = { phase: s.phase, sig };
  box.dataset.phase = s.phase;

  const picker = () => pickFolder(up);
  const pickAction = () => {
    const b = el('button', 'caction');
    b.type = 'button';
    b.append(glyph(FOLDER, FOLDER_ADD), el('span', null, t('upload.choose')));
    b.onclick = picker;
    return b;
  };
  const summaryBlock = () => {
    const sum = el('div', 'fu-sum');
    const head = el('div', 'fu-head');
    head.append(el('span', 'fu-name', s.name), el('span', 'fu-where', t('upload.thisPc')));
    const nums = el('div', 'fu-num', sizeLine(s.summary.files, s.summary.bytes));
    if (s.summary.skippedFiles) nums.append(el('span', 'fu-skip', t('upload.skipped', { count: s.summary.skippedFiles, files: fmt.number(s.summary.skippedFiles), size: formatBytes(s.summary.skippedBytes) })));
    sum.append(head, nums);
    return sum;
  };

  if (s.phase === 'empty') {
    box.append(el('p', 'cnote fu-lead', t('upload.lead')), pickAction(), el('p', 'cnote', t('upload.defaultDest')));
    return;
  }

  if (s.phase === 'ready' || s.phase === 'error') {
    box.append(summaryBlock());
    // 除外（札。× で外す、打って足す）
    box.append(el('div', 'fu-lab', t('upload.excludes')));
    const tags = el('div', 'fu-tags');
    for (const x of s.excludes) {
      const tag = el('span', 'fu-tag', x);
      const rm = el('button', null, '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', t('upload.removeExclude', { name: x }));
      rm.onclick = () => up.setExcludes(s.excludes.filter((y) => y !== x));
      tag.append(rm);
      tags.append(tag);
    }
    const add = el('input', 'fu-tagin');
    add.dataset.key = 'exclude';
    add.placeholder = t('upload.addExclude');
    add.setAttribute('aria-label', t('upload.addExcludeLabel'));
    add.autocomplete = 'off'; add.spellcheck = false;
    add.addEventListener('keydown', (e) => {
      if (isComposingKey(e)) return;
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const v = add.value.trim();
        if (v) up.setExcludes([...s.excludes, v]);
      } else if (e.key === 'Backspace' && !add.value && s.excludes.length) up.setExcludes(s.excludes.slice(0, -1));
    });
    tags.append(add);
    box.append(tags);
    if (s.summary.large) box.append(el('p', 'cnote fu-warn', t('upload.large')));

    // 送り先（combo。候補は既定の送り先と最近の作業フォルダー）
    box.append(el('div', 'fu-lab', t('upload.dest')));
    const options = () => {
      const seen = new Set();
      const out = [];
      const push = (o) => { if (o.value && !seen.has(o.value)) { seen.add(o.value); out.push(o); } };
      if (s.plan?.root) push({ value: `${s.plan.root}${s.plan.root.includes('\\') ? '\\' : '/'}${s.name}`, hint: t('upload.destDefault') });
      for (const r of recent() ?? []) push({ value: r.value, hint: r.time ? fmt.relative(r.time) : '' });
      return out;
    };
    const dest = createCombo({ cls: 'mono fu-dest', ariaLabel: t('upload.dest'), value: s.dest, options, onCommit: (v) => up.setDest(v) });
    box.append(dest.root);
    const status = el('div', 'fu-status');
    box.append(status);
    // 送ったフォルダーを作業フォルダーにする（既定で入。切れば送り先を知らせるだけ）
    const mk = el('label', 'fu-cwd');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.dataset.key = 'makeCwd';
    cb.checked = s.makeCwd;
    cb.onchange = () => up.setMakeCwd(cb.checked);
    mk.append(cb, el('span', null, t('upload.makeCwd')));
    box.append(mk);
    const err = el('p', 'cerr');
    err.setAttribute('role', 'alert');
    box.append(err);
    const go = el('div', 'fu-go');
    box.append(go);
    const paint = () => {
      box._fu.confirm?.remove();
      box._fu.confirm = null;
      dest.set(s.dest);
      err.textContent = s.phase === 'error' ? s.error : s.planError;
      status.replaceChildren();
      go.replaceChildren();
      const again = button(t('upload.rechoose'), '', picker);
      if (s.checking && !s.plan) { status.append(el('p', 'cnote', t('upload.checking'))); go.append(again); return; }
      const plan = s.plan;
      if (!plan) { go.append(again); return; }
      if (!plan.needsConfirm) {
        status.append(el('p', 'cnote', plan.exists ? t('upload.intoEmpty') : t('upload.newFolder')));
        const b = button(s.phase === 'error' ? t('upload.retry') : t('upload.send'), 'btn-primary', () => up.send({ overwrite: plan.exists }));
        b.disabled = !s.summary.files;
        go.append(again, b);
        return;
      }
      // 既にあるフォルダーへ入れる。上書きする件数と名前（折りたたみ）を見せ、確かめてから送る
      const box2 = el('div', 'fu-confirm');
      box2.setAttribute('role', 'group');
      // パスは等幅で（和文の書体だと \ が ¥ に見える）
      const head = el('b');
      head.append(...slot(plan.empty ? t('upload.confirmOutside', { dest: SLOT }) : t('upload.confirmExists', { dest: SLOT }), el('code', 'fu-path', plan.dest)));
      box2.append(head);
      if (!plan.empty) box2.append(el('div', null, plan.conflicts ? t('upload.confirmOverwrite', { count: plan.conflicts, files: fmt.number(plan.conflicts) }) : t('upload.confirmNoOverlap')));
      if (plan.conflicts) {
        const det = el('details');
        det.append(el('summary', null, t('upload.overwriteList', { count: plan.conflicts, files: fmt.number(plan.conflicts) })));
        const more = plan.conflicts - plan.sample.length;
        det.append(el('code', null, plan.sample.join(' · ') + (more > 0 ? ` · ${t('upload.andMore', { count: more, files: fmt.number(more) })}` : '')));
        box2.append(det);
      }
      const acts = el('div', 'fu-go');
      acts.append(button(t('upload.changeDest'), '', () => dest.root.querySelector('input').focus()),
        button(t('upload.overwriteSend'), 'btn-primary', () => up.send({ overwrite: true })));
      box2.append(acts);
      box.insertBefore(box2, go);
      box._fu.confirm = box2;
    };
    box._fu.update = paint;
    paint();
    if (refocus) box.querySelector(`[data-key="${refocus}"]`)?.focus();
    return;
  }

  if (s.phase === 'sending' || s.phase === 'paused') {
    const prog = el('div', 'fu-prog');
    const title = el('div', null);
    const name = el('span', 'fu-name', s.name);
    title.append(...slot(s.phase === 'paused' ? t('upload.pausedTitle', { name: SLOT }) : t('upload.sendingTitle', { name: SLOT }), name));
    const track = el('div', 'fu-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-label', t('upload.progressLabel'));
    const bar = el('i');
    track.append(bar);
    const num = el('div', 'fu-num');
    const cur = el('div', 'fu-cur');
    prog.append(title, track, num);
    if (s.phase === 'paused') {
      const note = el('p', 'cnote fu-paused');
      note.setAttribute('role', 'status');
      note.append(el('b', null, t('upload.lost')), t('upload.resumeSoon'));
      prog.append(note);
      track.classList.add('paused');
    } else prog.append(cur);
    const go = el('div', 'fu-go');
    go.append(button(s.phase === 'paused' ? t('upload.stopSending') : t('upload.stop'), 'btn-quiet', () => up.cancel()));
    prog.append(go);
    box.append(prog);
    box._fu.update = () => {
      const p = up.progress();
      const pct = p.bytes ? Math.min(100, Math.floor(p.sentBytes / p.bytes * 100)) : p.files ? Math.floor(p.doneFiles / p.files * 100) : 0;
      bar.style.width = `${pct}%`;
      track.setAttribute('aria-valuenow', String(pct));
      num.textContent = progressLine(p);
      cur.textContent = s.current;
      cur.title = s.current;
    };
    box._fu.update();
    return;
  }

  if (s.phase === 'done') {
    const r = s.result;
    const done = el('div', 'fu-done');
    done.append(el('div', 'fu-ok', `✓ ${t('upload.done')} · ${sizeLine(r.files, r.bytes)}`));
    // i18n-dynamic: upload.applied.
    const line = el('p', 'cnote');
    line.append(...slot(t(`upload.applied.${r.applied}`, { dest: SLOT }), el('code', 'fu-path', r.dest)));
    line.title = r.dest;
    done.append(line);
    const go = el('div', 'fu-go');
    go.append(button(t('upload.close'), '', () => { up.reset(); close(); }));
    done.append(go);
    box.append(done);
  }
}

/**
 * フォルダーをドロップしたときの問い。'send' | 'attach' | null（やめる）を返す。
 * @param {{ name: string, files: number, bytes: number, excludes: string[] }} info
 */
export function askDroppedFolder(info, doc = document) {
  return new Promise((resolve) => {
    const dlg = el('dialog', 'fu-drop');
    dlg.setAttribute('aria-label', t('upload.drop.label'));
    const q = el('div', 'fu-q');
    const name = el('b', 'fu-name', info.name);
    q.append(...slot(t('upload.drop.question', { name: SLOT }), name));
    const sub = el('p', 'cnote fu-sub', info.excludes.length
      ? t('upload.drop.summaryExcluding', { summary: sizeLine(info.files, info.bytes), excludes: fmt.list(info.excludes) })
      : sizeLine(info.files, info.bytes));
    const acts = el('div', 'fu-go fu-acts');
    const finish = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    const send = button(t('upload.drop.send'), 'btn-primary', () => finish('send'));
    acts.append(send, button(t('upload.drop.attach'), 'btn-quiet', () => finish('attach')), button(t('upload.drop.cancel'), '', () => finish(null)));
    dlg.append(q, sub, acts, el('p', 'cnote fu-sub', t('upload.drop.attachNote')));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    doc.body.append(dlg);
    dlg.showModal();
    send.focus();
  });
}
