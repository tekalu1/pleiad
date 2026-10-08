// 委譲カードの直下に出す、子の Chrome の窓の短い行。
/** 窓を閉じると相手の作業が途中で終わるか。引き継ぎ中（人が操作している）= 'human'、人への依頼を待っている = 'waiting'、なければ null */
export const closeRiskOf = ({ state, waiting } = {}) => state === 'paused' ? 'human' : waiting === true ? 'waiting' : null;

/**
 * 窓を閉じる前の確かめ。引き継ぎ中・依頼を待っている窓だけ、押した場所の下に「やめる / 閉じる」を出す。それ以外は確かめずに run する。
 * showMenu の見出しに確認文を渡す形は、会話を消す前の確かめ（web/client.mjs の confirmDeleteSession）と同じ。
 */
export function confirmCloseWindow({ risk, run, showMenu, anchor, t }) {
  if (!risk || !showMenu) return run();
  const rect = anchor?.getBoundingClientRect?.() ?? { left: 0, bottom: 0 };
  const text = risk === 'human' ? t('taskChrome.confirmHuman') : t('taskChrome.confirmWaiting');
  showMenu(rect.left, rect.bottom + 4, [
    { label: t('pending.cancel'), onClick: () => anchor?.focus?.() },
    { label: t('taskChrome.confirmClose'), onClick: run },
  ], { text, wrap: true });
}

export function paintTaskChrome(card, row, { el, open, close, busy = () => false, t }) {
  let line = card.querySelector(':scope > .tc-task-chrome');
  if (!row?.windows) { line?.remove(); return; }
  // i18n-dynamic: ui:taskChrome.
  const word = key => t(`taskChrome.${key}`);
  if (!line) {
    line = el('div', 'tc-task-chrome');
    card.querySelector(':scope > .tc-details')?.after(line);
  }
  const view = el('button', 'tc-task-chrome-view', word('view'));
  view.type = 'button';
  view.onclick = () => open(row.sessionId);
  const dismiss = el('button', 'tc-task-chrome-close', '×');
  dismiss.type = 'button';
  dismiss.title = word('close');
  dismiss.setAttribute('aria-label', word('close'));
  dismiss.disabled = busy(row.sessionId) === true;   // 閉じている間は押せない（二重に送らない）
  dismiss.onclick = () => close(row, dismiss);
  line.replaceChildren(el('span', 'tc-task-chrome-mark', 'Chrome'), el('span', 'tc-task-chrome-profile', row.profileName || row.profile?.dir || word('unknown')),
    el('span', 'tc-task-chrome-state', ['running', 'paused', 'stopped', 'idle'].includes(row.state) ? word(row.state) : word('idle')), view, dismiss);
}
