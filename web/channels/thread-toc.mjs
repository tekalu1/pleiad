// スレッドの目次（右パネル。Chats の「目次と会話内検索」の、スレッドの投稿版）。
// 根の投稿と返信を時間順に並べ、検索の語で絞る。押すと、そのスレッドの投稿へ送って一瞬だけ強調する。
// 右パネルは web/file-preview.mjs の openPanel（ファイルのプレビューと同じ枠。幅・Esc・狭い画面の全面表示を共有する）。
import { el } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { authorInfo, whenText } from './post.mjs';

const KEY = 'thread-toc';
const clean = (text) => String(text ?? '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#-]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * @param {object} o
 * @param {object} o.host
 * @param {() => object[]} o.posts  今のスレッドの投稿（根が先頭）
 * @param {() => object} o.ctx  authorInfo の入れ物（bots・sessionTitle）
 * @param {(post: object) => void} o.go  投稿へ送る
 */
export function createThreadToc({ host, posts, ctx, go }) {
  const root = el('div', 'th-toc');
  const field = el('input', 'th-toc-search');
  field.type = 'search';
  field.placeholder = t('channels:thread.toc.search');
  field.setAttribute('aria-label', t('channels:thread.toc.search'));
  const list = el('div', 'th-toc-list');
  list.setAttribute('role', 'list');
  root.append(field, list);

  const rows = () => {
    const q = field.value.trim().toLowerCase();
    return posts().filter((p) => !p.deletedAt && p.author?.kind !== 'system')
      .map((p) => ({ p, text: clean(p.text) || (p.presents?.length ? t('channels:thread.toc.present') : '') }))
      .filter((r) => r.text && (!q || r.text.toLowerCase().includes(q)));
  };
  function paint() {
    const items = rows();
    const nodes = items.map(({ p, text }) => {
      const info = authorInfo(p.author, ctx());
      const b = el('button', 'th-toc-row');
      b.type = 'button';
      b.dataset.postId = p.id;
      b.title = text;
      b.append(el('span', 'th-toc-av', info.avatar), el('span', 'th-toc-name', info.name), el('span', 'th-toc-text', text), el('small', null, whenText(p.at)));
      b.onclick = () => go(p);
      return b;
    });
    if (!nodes.length) nodes.push(el('p', 'th-toc-empty', field.value.trim() ? t('channels:thread.toc.noMatch') : t('channels:thread.toc.empty')));
    list.replaceChildren(...nodes);
  }
  field.addEventListener('input', paint);

  let opened = false;
  return {
    toggle(button) {
      if (opened && host.filePreview.panelOpen(KEY)) { host.filePreview.close(); return; }
      opened = true;
      button.setAttribute('aria-expanded', 'true');
      paint();
      host.filePreview.openPanel({
        key: KEY, title: t('channels:thread.toc.title'), body: root, label: t('channels:thread.toc.title'), element: button, width: 0,
        onClose: () => { opened = false; button.setAttribute('aria-expanded', 'false'); },
      });
      requestAnimationFrame(() => field.focus({ preventScroll: true }));
    },
    /** 投稿が増えた・変わった。開いている間だけ描き直す */
    refresh() { if (opened && host.filePreview.panelOpen(KEY)) paint(); },
    close() { if (opened && host.filePreview.panelOpen(KEY)) host.filePreview.close(); },
  };
}
