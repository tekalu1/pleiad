// 「見直しを頼む」の下書き（ADR 0056「③ 見直しを頼む」、docs/design.md「指示の量」）。DOM を使わない。
// 利用者が読んで直してから送る文なので、画面の言語（ui の辞書）で組み立てる。ファイルの本文は入れない（パスとトークン数だけ）
import { t, fmt } from './i18n.mjs';

/** 気になる所の件数（出しきれなかった分も数える） */
export const findingCount = f => (f ? (f.duplicates?.length ?? 0) + (f.missing?.length ?? 0) + (f.more?.duplicates ?? 0) + (f.more?.missing ?? 0) : 0);

/** 主要操作の見た目にするか: 自分で書いた分が目安を超えたか、気になる所が 1 件以上ある */
export const reviewUrged = (amount, findings) => Boolean(amount?.ratio) || findingCount(findings) > 0;

/**
 * rows: 対象の指示ファイル（{ path, tokens }。量の面で数えた行）。amount: web/instruction-amount.mjs の戻り。
 * findings: contextFindings の戻り（無ければ null）。戻り: 入力欄に入れる文
 */
export function reviewDraft({ rows = [], amount, findings = null }) {
  const n = v => fmt.number(Number(v) || 0);
  const lines = [t('sessionContext.review.draft.lead'), '', t('sessionContext.review.draft.files')];
  for (const row of rows) lines.push(t('sessionContext.review.draft.file', { path: row.path, n: n(row.tokens) }));
  lines.push(amount?.ratio
    ? t('sessionContext.review.draft.amountOver', { own: n(amount.own), budget: n(amount.budget), ratio: fmt.number(amount.ratio, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
    : t('sessionContext.review.draft.amount', { own: n(amount?.own), budget: n(amount?.budget) }));
  const duplicates = findings?.duplicates ?? [], missing = findings?.missing ?? [];
  const more = (findings?.more?.duplicates ?? 0) + (findings?.more?.missing ?? 0);
  if (duplicates.length || missing.length || more) {
    lines.push('', t('sessionContext.review.draft.found'));
    for (const d of duplicates) {
      const [a, b] = d.sides;
      lines.push(t('sessionContext.review.draft.duplicate', { a: a.path, lineA: a.line, b: b.path, lineB: b.line }));
    }
    for (const m of missing) lines.push(t('sessionContext.review.draft.missing', { file: m.path, line: m.line, target: m.target }));
    if (more) lines.push(t('sessionContext.review.draft.more', { count: more }));
  }
  lines.push('', t('sessionContext.review.draft.how'), t('sessionContext.review.draft.howLead'),
    t('sessionContext.review.draft.step1'), t('sessionContext.review.draft.step2'), t('sessionContext.review.draft.step3'), t('sessionContext.review.draft.step4'),
    '', t('sessionContext.review.draft.confirm'));
  return lines.join('\n');
}
