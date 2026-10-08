// プロフィールを選ぶメニューの中身（docs/inapp-browser.md「プロフィール」）。どこからでも呼べる部品で、web/context-menu.mjs の項目の形を返す。
// Chrome タブの道具の列への差し込みは呼び出し側が受け持つ。エージェントが切り替えた会話の行（renderChromeProfileLine）もここ
import { el } from './dom.mjs';
import { t as translate } from './i18n.mjs';
import { parseProfileKey, profileKey, noteOf, browserLabel, profileLabel } from './chrome-profile-model.mjs';

/**
 * プロフィールを選ぶメニューの中身（web/context-menu.mjs の項目: label・note・radio・checked・disabled・head・sep・onClick）。
 * ブラウザーが 2 つ以上あればブラウザーごとに見出しを付け、メモは項目の下の弱い字（note）に出す。
 * @param {object} o
 * @param {{ browser: string, dir: string, name: string }[]} o.profiles  ops の browser.listProfiles の profiles
 * @param {{ browser: string, dir: string, note: string }[]} [o.notes]   設定の chromeProfileNotes
 * @param {{ browser: string, dir: string } | string | null} [o.current] 会話の今のプロフィール（'chrome:Default' の形でもよい）
 * @param {'operating' | 'waiting' | 'human' | null} [o.busy] 切り替えられない理由（ops の browser.listProfiles の busy）。あれば項目を押せなくし、先頭に理由を出す
 * @param {(profile: { browser: string, dir: string }) => void} o.onPick   選んだとき（ops の browser.useProfile を呼ぶ）
 * @param {(() => void) | null} [o.onManage]  「プロフィールを管理…」（設定 › ブラウザーを開く）。無ければ出さない
 * @param {(key: string, vars?: object) => string} [o.t]
 */
export function profileMenuItems({ profiles = [], notes = [], current = null, busy = null, onPick, onManage = null, t = translate }) {
  const now = typeof current === 'string' ? parseProfileKey(current) : current;
  const nowKey = now ? profileKey(now) : null;
  const items = [];
  if (busy) items.push({ head: t(`chromeProfiles.busy.${busy}`), wrap: true });
  const browsers = [...new Set(profiles.map(p => p.browser))];
  for (const browser of browsers) {
    if (browsers.length > 1) items.push({ head: browserLabel(browser) });
    for (const p of profiles.filter(row => row.browser === browser)) {
      const ref = { browser: p.browser, dir: p.dir };
      const note = noteOf(notes, ref) || p.note || '';
      items.push({ label: profileLabel(p, profiles), radio: true, checked: profileKey(ref) === nowKey, ...(note ? { note } : {}), ...(busy ? { disabled: true } : {}),
        onClick: () => onPick?.(ref) });
    }
  }
  if (!profiles.length) items.push({ label: t('chromeProfiles.none'), disabled: true });
  if (onManage) items.push({ sep: true }, { label: t('chromeProfiles.manage'), onClick: onManage });
  return items;
}

/** エージェントがプロフィールを切り替えた会話の行（present kind: 'chromeProfile'。chromeProfile: { browser, dir, name, agent }）。「Claude が『仕事』に切り替えました」 */
export function renderChromeProfileLine(ev, { t = translate } = {}) {
  const p = ev?.chromeProfile ?? {};
  const row = el('div', 'cc-line');
  row.append(el('span', 'cc-line-t', t('chromeProfiles.switched', { agent: p.agent || t('chromeProfiles.agent'), name: p.name || p.dir || '' })));
  return row;
}
