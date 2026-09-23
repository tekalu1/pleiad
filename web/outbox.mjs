const labels = {
  queued: '送信待ち', sending: 'AIへ送信中',
  paused: '送信を保留中', failed: '送信できませんでした', unknown: '送信結果を確認できません',
};

// 送信待ちが何を待っているか（core/message-queue.mjs の waiting）
function queuedLabel(wait) {
  if (wait?.reason === 'turn') return '送信待ち — 作業が終わると自動で送信';
  if (wait?.reason === 'order') return '送信待ち — 前のメッセージが送られてから送信';
  return labels.queued;
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
    status.textContent = item.status === 'queued' ? queuedLabel(item.waiting) : labels[item.status] ?? item.status;
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
      hint.textContent = '会話を確認してください。再送すると同じ指示が2回届くことがあります。';
      row.append(hint);
    }
    for (const [name, label] of item.status === 'sending' ? [] : [
      ...(item.status !== 'queued' ? [['retry', '再送する']] : []), ['cancel', '取り消す'],
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
