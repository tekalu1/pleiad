// 委譲カードの直下に出す、子の Chrome の窓の短い行。
const words = {
  ja: { view: 'Chrome の窓を見る', close: '子の Chrome の窓を閉じる', unknown: 'プロフィール未確認', running: '作業中', paused: '引き継ぎ中', stopped: '停止中', idle: '待機中' },
  en: { view: 'View Chrome window', close: "Close child's Chrome window", unknown: 'Profile unknown', running: 'Working', paused: 'Handed over', stopped: 'Stopped', idle: 'Idle' },
};

export function paintTaskChrome(card, row, { el, open, close, lang = 'ja' }) {
  let line = card.querySelector(':scope > .tc-task-chrome');
  if (!row?.windows) { line?.remove(); return; }
  const w = words[lang === 'en' ? 'en' : 'ja'];
  if (!line) {
    line = el('div', 'tc-task-chrome');
    card.querySelector(':scope > .tc-details')?.after(line);
  }
  const view = el('button', 'tc-task-chrome-view', w.view);
  view.type = 'button';
  view.onclick = () => open(row.sessionId);
  const dismiss = el('button', 'tc-task-chrome-close', '×');
  dismiss.type = 'button';
  dismiss.title = w.close;
  dismiss.setAttribute('aria-label', w.close);
  dismiss.onclick = () => close(row.sessionId);
  line.replaceChildren(el('span', 'tc-task-chrome-mark', 'Chrome'), el('span', 'tc-task-chrome-profile', row.profileName || row.profile?.dir || w.unknown),
    el('span', 'tc-task-chrome-state', w[row.state] || row.state || w.idle), view, dismiss);
}
