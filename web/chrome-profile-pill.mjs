// 右パネル「Claude の Chrome」の固定タブの道具の列に置く、プロフィールの選択 pill（docs/inapp-browser.md「プロフィール」、ADR 0148 第 10 段）。
// .cp-profile-slot へ差し込み、今のプロフィールの名前（メモがあれば弱い字）を出す。
// 押すと web/chrome-profile-menu.mjs の profileMenuItems でメニューを出し、選ぶと browser.useProfile を呼ぶ。
import { el } from './dom.mjs';
import { t as translate } from './i18n.mjs';
import { notify } from './file-actions.mjs';
import { profileMenuItems } from './chrome-profile-menu.mjs';
import { noteOf, profileLabel } from './chrome-profile-model.mjs';

const CHROME_ICON_SVG = '<svg class="i cp-profile-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6"/><path d="M12 8.4h8.4M9 13.8l-4.2 7.2M15 13.8l-4.2-7.2"/></svg>';
const CHEV_ICON_SVG = '<svg class="i chev cp-profile-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

/**
 * プロフィール選択の pill とメニューを管理する。
 * @param {object} options
 * @param {HTMLElement} options.slot 差し込み口（.cp-profile-slot）
 * @param {(command: string, args: object) => Promise<any>} options.cmd WS 通信
 * @param {(x: number, y: number, items: any[], title: string, opts?: object) => void} options.showMenu コンテキストメニュー表示
 * @param {() => string | null} options.getSessionId 今の会話の id
 * @param {() => object} [options.getPrefs] 設定
 * @param {() => object} [options.getHostCaps] ホストの能力
 * @param {() => void} [options.openSettings] 設定 › ブラウザーを開く
 * @param {() => boolean} [options.canUseProfile] プロフィール選択が可能かどうかの追加判定
 * @param {(ref: { browser: string, dir: string }) => void} [options.onPick] プロフィール選択時コールバック
 * @param {(key: string, vars?: object) => string} [options.t]
 */
export function setupChromeProfilePill({
  slot,
  cmd,
  showMenu,
  getSessionId,
  getPrefs = () => ({}),
  getHostCaps = () => null,
  openSettings = null,
  canUseProfile = null,
  onPick = null,
  t = translate,
} = {}) {
  let profiles = null;   // [{ browser, dir, name, note }] | null
  let current = null;    // { browser, dir } | null
  let busy = null;       // 'operating' | 'waiting' | 'human' | null
  let button = null;
  let nameEl = null;
  let noteEl = null;
  let open = false;
  let loading = false;
  let loadSeq = 0;

  function hide() {
    profiles = null;
    current = null;
    busy = null;
    button = null;
    nameEl = null;
    noteEl = null;
    slot?.replaceChildren?.();
  }

  function activeProfile() {
    if (!profiles?.length) return null;
    if (current) {
      const found = profiles.find(p => p.browser === current.browser && p.dir === current.dir);
      if (found) return found;
    }
    const prefs = getPrefs?.() ?? {};
    const want = prefs.chromeNewProfile;
    if (want) {
      const found = profiles.find(p => p.browser === want.browser && p.dir === want.dir);
      if (found) return found;
    }
    return profiles[0] ?? null;
  }

  function paint() {
    if (!slot) return;
    if (!profiles?.length) {
      hide();
      return;
    }

    const profile = activeProfile();
    const label = profile ? profileLabel(profile, profiles) : (current?.dir || 'Chrome');
    const prefs = getPrefs?.() ?? {};
    const notes = Array.isArray(prefs.chromeProfileNotes) ? prefs.chromeProfileNotes : [];
    const note = profile ? (noteOf(notes, profile) || profile.note || '') : '';

    if (!button) {
      button = el('button', 'btn cp-profile-btn pf');
      button.type = 'button';
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');

      const iconWrap = el('span', 'cp-profile-icon-wrap');
      iconWrap.innerHTML = CHROME_ICON_SVG;

      const textWrap = el('span', 'cp-profile-text t');
      nameEl = el('span', 'cp-profile-name');
      noteEl = el('span', 'cp-profile-note weak');
      textWrap.append(nameEl, noteEl);

      const chevWrap = el('span', 'cp-profile-chev-wrap');
      chevWrap.innerHTML = CHEV_ICON_SVG;

      button.append(iconWrap, textWrap, chevWrap);

      button.onclick = () => {
        if (!button) return;
        const r = button.getBoundingClientRect?.() ?? { left: 0, bottom: 0 };
        open = true;
        button.setAttribute('aria-expanded', 'true');

        const items = profileMenuItems({
          profiles: profiles ?? [],
          notes: (getPrefs?.() ?? {}).chromeProfileNotes ?? [],
          current,
          busy,
          onPick: async (ref) => {
            const id = getSessionId?.();
            if (!id) return;
            try {
              const res = await cmd('invoke', {
                op: 'browser.useProfile',
                args: { sessionId: id, browser: ref.browser, profile: ref.dir },
              });
              if (res && res.dir) {
                current = { browser: res.browser, dir: res.dir };
              } else {
                current = { browser: ref.browser, dir: ref.dir };
              }
              paint();
              onPick?.(ref);
            } catch (error) {
              notify?.(error?.message || t('chromeProfiles.switchFailed'));
            }
          },
          onManage: openSettings ? () => openSettings() : null,
          t,
        });

        const menuTitle = t('browser.chromeWindow.profileActions') || t('browser.chromeWindow.panel');
        showMenu?.(r.left, r.bottom + 4, items, menuTitle, {
          onClose: () => {
            open = false;
            button?.setAttribute?.('aria-expanded', 'false');
          },
        });
      };

      slot.replaceChildren(button);
    }

    if (nameEl) nameEl.textContent = label;
    if (noteEl) {
      noteEl.textContent = note;
      noteEl.hidden = !note;
    }

    const fullTitle = note ? `${label} (${note})` : label;
    if (busy) {
      button.dataset.busy = busy;
      button.setAttribute('aria-disabled', 'true');
      const busyReason = t(`chromeProfiles.busy.${busy}`);
      button.title = busyReason || fullTitle;
      button.setAttribute('aria-label', `${fullTitle} · ${busyReason || busy}`);
    } else {
      delete button.dataset.busy;
      button.removeAttribute('aria-disabled');
      button.title = fullTitle;
      button.setAttribute('aria-label', fullTitle);
    }
    button.setAttribute('aria-expanded', String(open));
  }

  async function load({ force = false } = {}) {
    const seq = ++loadSeq;
    const id = getSessionId?.();
    if (!id) {
      hide();
      return;
    }

    const caps = getHostCaps?.();
    if (caps && caps.chromeBrowser === false && caps.chromeWindow === false) {
      hide();
      return;
    }

    if (canUseProfile && !canUseProfile()) {
      hide();
      return;
    }

    loading = true;
    try {
      const res = await cmd('invoke', { op: 'browser.listProfiles', args: { sessionId: id } });
      if (seq !== loadSeq) return;
      if (!res || !Array.isArray(res.profiles)) {
        hide();
        return;
      }
      profiles = res.profiles;
      current = res.current ?? null;
      busy = res.busy ?? null;
      paint();
    } catch {
      if (seq !== loadSeq) return;
      hide();
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  return {
    refresh(opts) { return load(opts); },
    updateProfile(profile) {
      if (profile && typeof profile === 'object') {
        current = { browser: profile.browser, dir: profile.dir };
        paint();
      }
      return load();
    },
    onProfileEvent(ev) {
      const id = getSessionId?.();
      if (!id || ev?.sessionId !== id) return;
      if (ev?.profile) {
        current = { browser: ev.profile.browser, dir: ev.profile.dir };
        paint();
      }
      return load();
    },
    onStateChange() { return load(); },
    hide,
    get element() { return button; },
    get current() { return current; },
    get profiles() { return profiles; },
    get busy() { return busy; },
  };
}
