// スレッドの見出し（.th-top）。左に「# チャンネル名 › スレッドの題」、右に Chats の頭と同じ入口（目次・git・内蔵ブラウザー）と閉じる ✕。
// 左にチャンネルの流れが見えている間（split）はチャンネル名を出さず「› スレッドの題」だけ（CSS が .deck[data-deck] で出し分ける）。
// 入口は右パネルの道具: 目次はスレッドの投稿の一覧（thread-toc.mjs）、git は bot の会話の作業場所の git（既存の ply-git-open）、
// 内蔵ブラウザーは右パネルのブラウザー。どれも bot の会話（そのスレッドで最後に動いた bot）を基準にする。
import { el, svgEl } from '../dom.mjs';
import { t } from '../i18n.mjs';
import { closeIcon, branchIcon } from '../icons.mjs';

const TOC_PATH = 'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1';
const GLOBE_PATHS = ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9s1.3-6.5 3.9-9z'];

const svgButton = (cls, label, paths) => {
  const b = el('button', `btn btn-icon ${cls}`);
  b.type = 'button';
  b.title = label;
  b.setAttribute('aria-label', label);
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  for (const d of paths) svg.append(svgEl('path', { d }));
  b.append(svg);
  return b;
};

/**
 * @param {object} o
 * @param {object} o.host  web/channels/index.mjs の host（cmd・filePreview・browser・openSidebar）
 * @param {() => void} o.onClose  ✕
 * @param {() => void} o.onBack  チャンネル名（流れに戻る）
 * @param {(button: HTMLElement) => void} o.onToc  目次
 */
export function createThreadHead({ host, onClose, onBack, onToc }) {
  const head = el('header', 'th-top');

  // 脇を閉じている間の入口（流れの見出しの #chOpenSidebar と同じ働き。スレッドだけが見えているときだけ出す。CSS）
  const side = el('button', 'btn btn-icon side-toggle th-side');
  side.type = 'button';
  side.id = 'chThreadOpenSidebar';
  side.title = t('app.openSidebarTitle');
  side.setAttribute('aria-label', t('app.openSidebarTitle'));
  const sideSvg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  sideSvg.append(svgEl('rect', { x: 3, y: 4, width: 18, height: 16, rx: 4 }), svgEl('path', { d: 'M9.5 4v16' }));
  side.append(sideSvg);
  side.onclick = () => host.openSidebar?.();

  const crumb = el('div', 'th-crumb');
  const chan = el('button', 'th-chan');
  chan.type = 'button';
  const sep = el('span', 'th-sep', '›');
  sep.setAttribute('aria-hidden', 'true');
  const title = el('h2', 'th-title');
  title.id = 'chThreadTitle';
  crumb.append(chan, sep, title);
  chan.onclick = onBack;

  const toc = svgButton('th-toc', t('channels:thread.entry.toc'), [TOC_PATH]);
  toc.setAttribute('aria-expanded', 'false');
  toc.onclick = () => onToc(toc);

  const git = el('button', 'btn btn-icon th-git');
  git.type = 'button';
  git.hidden = true;
  git.innerHTML = branchIcon;
  git.onclick = () => {
    if (!sessionId) return;
    // 右パネルの git（web/git-panel.mjs）。会話を指して開く既存の入口（委譲のカードの「変更」と同じ）
    git.dispatchEvent(new CustomEvent('ply-git-open', { bubbles: true, detail: { sessionId } }));
  };

  const browser = svgButton('th-browser', t('channels:thread.entry.browser'), GLOBE_PATHS);
  browser.setAttribute('aria-pressed', 'false');
  browser.hidden = !host.browser;
  browser.onclick = () => {
    const preview = host.filePreview;
    if (preview.browserOpen()) preview.close(false);
    else { preview.openBrowser(browser); host.browser?.open(); }
    paintBrowser();
  };
  const paintBrowser = () => {
    const open = Boolean(host.filePreview?.browserOpen?.());
    browser.setAttribute('aria-pressed', String(open));
    browser.classList.toggle('on', open);
  };

  const close = el('button', 'btn btn-icon th-close');
  close.type = 'button';
  close.title = t('channels:thread.close');
  close.setAttribute('aria-label', t('channels:thread.close'));
  close.innerHTML = closeIcon;
  close.onclick = onClose;

  const entries = el('div', 'th-entries');
  entries.append(toc, git, browser);
  head.append(side, crumb, entries, close);

  // 右パネルの開閉に合わせて、押されている印・git の「開いている」を合わせる
  new MutationObserver(() => { paintBrowser(); paintGit(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  let sessionId = null, ticket = 0, gitData = null;
  function paintGit() {
    git.hidden = !gitData;
    if (!gitData) return;
    const dirty = gitData.dirty > 0;
    const label = dirty ? t('git.entryChanged') : t('git.entry');
    git.title = label;
    git.setAttribute('aria-label', label);
    const dot = git.querySelector('.entry-dot');
    if (dirty && !dot) { const mark = el('span', 'entry-dot'); mark.setAttribute('aria-hidden', 'true'); git.append(mark); }
    else if (!dirty && dot) dot.remove();
  }

  return {
    el: head,
    tocButton: toc,
    setTitle({ channel, title: text }) {
      chan.replaceChildren(el('span', 'th-hash', '#'), document.createTextNode(channel ?? ''));
      chan.title = t('channels:thread.back', { name: channel ?? '' });
      chan.setAttribute('aria-label', t('channels:thread.back', { name: channel ?? '' }));
      title.textContent = text || t('channels:thread.untitled');
      title.title = text || '';
    },
    /** git の入口は、作業場所が git のときだけ出す（Chats の頭と同じ）。会話が変わったときと、ターンが終わったときに取り直す */
    async setSession(id, { force = false } = {}) {
      if (id === sessionId && !force) return;
      if (id !== sessionId) { gitData = null; paintGit(); }
      sessionId = id;
      if (!id) return;
      const mine = ++ticket;
      const res = await host.cmd('gitStatus', { sessionId: id, fresh: force }).catch(() => null);
      if (mine !== ticket) return;
      gitData = res?.git ?? null;
      paintGit();
    },
    paintBrowser,
  };
}
