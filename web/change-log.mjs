// 会話の変更の記録（会話の記録の history。時刻・誰が・前 → 後・理由）。脇の会話の行の ⋯ / 右クリックの「変更の記録」から開く。
// 会話の中には設定の変化を知らせる行を出さない（ADR 0067）。「AI が変えた」ことだけは、ここと脇の行の小さな「AI」の印で辿れる。
// 行の組み立て（changeRows）は DOM に触れない（tests/unit/change-log.mjs から直接呼ぶ）。
import { el } from './dom.mjs';
import { t, fmt } from './i18n.mjs';
import { savedReason } from './saved-text.mjs';

// i18n-dynamic: changeLog.field.
// i18n-dynamic: changeLog.by.
/** 記録に出す項目（会話の設定として人が見分けられるもの）。context・parent は内部の記録なので出さない */
const FIELDS = ['status', 'title', 'cwd', 'mode', 'model', 'backend', 'effort'];

const known = (prefix, value) => {
  const key = `${prefix}.${value}`;
  const text = t(key);
  return text === key ? String(value ?? '') : text;
};
/** 誰が。human → あなた、ai・agent → AI（agent は操作の一覧からの変更。ADR 0081）、ply → Pleiad（知らない値は届いたまま） */
export const byText = (by) => known('changeLog.by', by);
const valueText = (v) => (v == null || v === '' ? t('changeLog.none') : String(v));

/** 記録を新しい順の行にする。行 = { at, field, label, from, to, by, byText, ai, reason } */
export function changeRows(changes) {
  return (changes ?? []).filter(c => FIELDS.includes(c?.field)).map(c => ({
    at: c.at, field: c.field, label: known('changeLog.field', c.field), from: valueText(c.from), to: valueText(c.to),
    by: c.by, byText: byText(c.by), ai: c.by === 'ai' || c.by === 'agent', reason: savedReason(c),
  })).reverse();
}

/** 脇の行の状態の語に添える「AI」の印の title（理由があれば添える） */
export const aiMarkTitle = (change) => {
  const reason = savedReason(change);
  return reason ? t('changeLog.aiTitleReason', { reason }) : t('changeLog.aiTitle');
};

let open = null;

/** 変更の記録の面。native の <dialog>（showModal）。Esc・閉じる・背後の押下で閉じ、閉じたら呼び出し元へフォーカスを戻す */
export function openChangeLog({ title, changes, anchor = null }) {
  open?.close();
  const dialog = el('dialog', 'cl-dialog');
  const titleId = `clTitle${Math.random().toString(36).slice(2, 8)}`;
  dialog.setAttribute('aria-labelledby', titleId);
  const inner = el('div', 'cl-in');
  const head = el('div', 'cl-head');
  const heading = el('h3', null, t('changeLog.title'));
  heading.id = titleId;
  const sub = el('span', 'cl-sub', title);
  const closeButton = el('button', 'btn btn-quiet cl-close');
  closeButton.type = 'button';
  closeButton.append(el('span', null, t('changeLog.close')), el('span', null, '×'));
  closeButton.lastChild.setAttribute('aria-hidden', 'true');
  const titles = el('div', 'cl-titles');
  titles.append(heading, sub);
  head.append(titles, closeButton);
  const body = el('div', 'cl-body');
  const rows = changeRows(changes);
  if (!rows.length) body.append(el('p', 'cl-empty', t('changeLog.empty')));
  for (const r of rows) {
    const row = el('div', `cl-row${r.ai ? ' ai' : ''}`);
    const line = el('div', 'cl-line');
    line.append(el('span', 'cl-when', fmt.dateTime(r.at)), el('b', 'cl-field', r.label), el('span', 'cl-by', r.byText));
    const change = el('div', 'cl-change');
    change.append(el('span', 'cl-from', r.from), el('span', 'cl-arrow', '→'), el('span', 'cl-to', r.to));
    row.append(line, change);
    if (r.reason) row.append(el('div', 'cl-reason', r.reason));
    body.append(row);
  }
  inner.append(el('div', 'cl-handle'), head, body);
  dialog.append(inner);
  const close = () => { if (dialog.open) dialog.close(); };
  closeButton.onclick = close;
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('close', () => {
    if (open?.dialog === dialog) open = null;
    dialog.remove();
    if (anchor?.isConnected) anchor.focus?.({ preventScroll: true });
  });
  document.body.append(dialog);
  dialog.showModal();
  closeButton.focus?.({ preventScroll: true });
  open = { dialog, close };
  return { dialog, close };
}
