// 委譲カードの直下に出す、子の Chrome の窓の短い行。
export function paintTaskChrome(card, row, { el, open, close, t }) {
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
  dismiss.onclick = () => close(row.sessionId);
  line.replaceChildren(el('span', 'tc-task-chrome-mark', 'Chrome'), el('span', 'tc-task-chrome-profile', row.profileName || row.profile?.dir || word('unknown')),
    el('span', 'tc-task-chrome-state', ['running', 'paused', 'stopped', 'idle'].includes(row.state) ? word(row.state) : word('idle')), view, dismiss);
}
