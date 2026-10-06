// 貼り付けた HTML の画像を取り込む（docs/adr/0141、docs/design-system.md「入力欄の編集欄」）。入力欄（Chats・Channels）が共有する。
//   - data: の画像: その場でファイルにして、今のファイルの添付（断片送り）へ
//   - https の画像: ホスト（core）が取りに行く（WS の attachImport。画面の fetch は CORS で読めず、Electron の main はリモート・モバイルで使えない）。
//     取りに行く間は貼った位置に「取り込み中」の札（取得元のホスト名つき。取りやめられる）。取れたら画像の札に替わる。
//     取れなかった札は黙って消える（失敗の札・知らせ・読み上げは出さない）。同時に取りに行くのは 3 枚まで
//   - 読み上げは、貼った 1 回につき「画像 N 件を取り込んでいます」と、終わったときの「画像 N 件を取り込みました」だけ（取れなかった件には触れない）
// 札の出し入れ・送れない間の扱い・下書きへの積み方は、ホスト側（web/client.mjs・web/channels/ch-attachments.mjs）が持つ送信中の一覧（uploads）に載せて使い回す。
import { randomId } from './dom.mjs';
import { t } from './i18n.mjs';

export const IMPORT_CONCURRENCY = 3;
const NAME_MAX = 60;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };

/** data: の画像 → File。読めなければ null */
export function dataUriToFile(src, name) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i.exec(String(src));
  if (!m) return null;
  let bytes;
  try { bytes = Uint8Array.from(atob(m[2].replace(/\s+/g, '')), (c) => c.charCodeAt(0)); } catch { return null; }
  if (!bytes.length) return null;
  const mime = m[1].toLowerCase();
  return new File([bytes], `${name}.${EXT[mime] ?? 'png'}`, { type: mime });
}

/** 取得元の表示（ホスト名） */
export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

let live = null;
/** 画面外の読み上げ（role=status）。1 か所を使い回す */
function announce(text) {
  if (!live) {
    live = document.createElement('div');
    live.className = 'visually-hidden';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.append(live);
  }
  live.textContent = '';
  // 同じ文が続いても読み直されるよう、一度空にしてから入れる
  setTimeout(() => { live.textContent = text; }, 30);
}

/**
 * @param {object} h ホストが渡すもの
 * @param {Function} h.cmd WS のコマンド
 * @param {() => object} h.editor 入力欄の編集欄（createMarkdownEditor の戻り）
 * @param {(base: object) => object} h.entry 1 件を、ホストの送信中の一覧（uploads）に入れて返す。base は { id, name, size, file?, import?: { url, host } }
 * @param {(u: object) => string|null} h.bucketOf 置き場の分け先（会話の id・チャンネルの id）
 * @param {(u: object) => Promise<boolean>} h.uploadFile data: の画像を、ファイルの添付として送る（ホストの runUpload。届いたら true）
 * @param {(u: object, r: object) => Promise<void>} h.finished 取れた（r は { path, bytes, kind, mime, name }）。添付に加えて札をパスの札に替える
 * @param {(u: object) => void} h.dropped 札が外れた。一覧から外して描き直す
 * @param {() => void} [h.registered] 1 回の貼り付けの分を一覧に入れ終えた（入口の件数を描き直す）
 */
export function createPasteImages(h) {
  let active = 0;
  const waiting = [];
  let fileChain = Promise.resolve();

  // 順番待ち: { u, run, skip }。やめたものは待ちから外し（取りに行かない）、skip で 1 回の貼り付けの数から外す
  const pump = () => {
    while (active < IMPORT_CONCURRENCY && waiting.length) { const job = waiting.shift(); active++; job.run().finally(() => { active--; pump(); }); }
  };

  /** 札を何も残さずに外す。失敗の札・知らせは出さない */
  async function vanish(u) {
    u.gone = true;
    await h.editor().forgetPending(u.id);
    h.dropped(u);
  }

  /**
   * 利用者がやめた（札を外した・元に戻した）。順番待ちなら待ちから外して取りに行かず、取りに行っている途中なら切る。
   * ホストへは、どの段階でも「やめる」を送る（取れて置いたあとに届けば、ホストが置いたファイルを消す）。札はすでに無い
   */
  function cancel(u) {
    if (u.gone || u.done) return;
    u.cancelled = true;
    u.gone = true;
    const i = waiting.findIndex((job) => job.u === u);
    if (i >= 0) waiting.splice(i, 1)[0].skip();
    if (u.import) h.cmd('attachImportCancel', { importId: u.id }).catch(() => {});
    h.editor().forgetPending(u.id).then(() => h.dropped(u));
  }

  async function runImport(u, batch) {
    if (u.cancelled || u.gone) return settle(batch, false);   // 待っている間にやめられた
    let r = null;
    try {
      r = await h.cmd('attachImport', { url: u.import.url, sessionId: h.bucketOf(u) ?? null, name: u.name, importId: u.id });
    } catch { /* 取れなかった。理由は出さない */ }
    if (u.cancelled || u.gone) return settle(batch, false);
    if (!r?.path) { await vanish(u); return settle(batch, false); }
    u.done = true;
    try { await h.finished(u, r); } catch { /* 下書きへ積めなかった: 札はそのまま残る（取れてはいる） */ }
    return settle(batch, true);
  }

  async function runFile(u, batch) {
    let ok = false;
    try { ok = await h.uploadFile(u); } catch { /* ホストの runUpload が札に出す */ }
    u.done = true;
    settle(batch, ok === true);
  }

  function settle(batch, ok) {
    if (ok) batch.ok++;
    if (--batch.left === 0 && batch.ok > 0) announce(t('chat.paste.doneLive', { count: batch.ok }));
  }

  return {
    /**
     * 貼った HTML の画像を取り込み始める。画像ごとの仮の ID（札の pid）を返す（札にしないものは null）。
     * 札が欄に入ってから始める（返した後の同じ tick の外で）。取れた・取れなかった・やめたは、札の方で決まる
     */
    start(images) {
      const batch = { left: 0, ok: 0 };
      const jobs = [];
      const pids = images.map((img, i) => {
        const name = (img.alt || '').trim().slice(0, NAME_MAX) || t('chat.paste.imageName', { n: i + 1 });
        if (img.kind === 'data') {
          const file = dataUriToFile(img.src, name);
          if (!file) return null;
          const u = h.entry({ id: randomId(), name: file.name, size: file.size, file });
          jobs.push(() => { fileChain = fileChain.then(() => runFile(u, batch)); });
          batch.left++;
          return u.id;
        }
        const u = h.entry({ id: randomId(), name, size: 0, import: { url: img.src, host: hostOf(img.src) } });
        jobs.push(() => { waiting.push({ u, run: () => runImport(u, batch), skip: () => settle(batch, false) }); pump(); });
        batch.left++;
        return u.id;
      });
      if (batch.left) {
        h.registered?.();
        announce(t('chat.paste.startedLive', { count: batch.left }));
        queueMicrotask(() => { for (const job of jobs) job(); });
      }
      return pids;
    },
    cancel,
  };
}
