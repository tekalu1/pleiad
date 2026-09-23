import { t } from './i18n.mjs';

// i18n-dynamic: outbox.status.
const STATUSES = ['queued', 'sending', 'paused', 'failed', 'unknown'];
const statusLabel = (status) => (STATUSES.includes(status) ? t(`outbox.status.${status}`) : status);

// 送信待ちが何を待っているか（core/message-queue.mjs の waiting）
function queuedLabel(wait) {
  if (wait?.reason === 'turn') return t('outbox.waitTurn');
  if (wait?.reason === 'order') return t('outbox.waitOrder');
  return statusLabel('queued');
}

export function renderOutbox(root, messages, action) {
  root.replaceChildren();
  for (const item of messages.filter(m => !['sent', 'cancelled'].includes(m.status))) {
    const row = document.createElement('div');
    row.className = 'outbox-message';
    const text = document.createElement('div');
    text.className = 'outbox-text';
    text.textContent = item.args.prompt;
    const status = document.createElement('div');
    status.className = 'outbox-status';
    status.textContent = item.status === 'queued' ? queuedLabel(item.waiting) : statusLabel(item.status);
    row.append(text, status);
    if (item.error) {
      const error = document.createElement('div');
      error.className = 'outbox-status';
      error.textContent = item.error;
      row.append(error);
    }
    if (item.status === 'unknown') {
      const hint = document.createElement('div');
      hint.className = 'outbox-status';
      hint.textContent = t('outbox.unknownHint');
      row.append(hint);
    }
    for (const [name, label] of item.status === 'sending' ? [] : [
      ...(item.status !== 'queued' ? [['retry', t('outbox.retry')]] : []), ['cancel', t('outbox.cancel')],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn';
      button.textContent = label;
      button.onclick = async () => {
        button.disabled = true;
        try { await action(item.id, name); }
        catch (e) { status.textContent = e.message; button.disabled = false; }
      };
      row.append(button);
    }
    root.append(row);
  }
  root.hidden = !root.children.length;
}
