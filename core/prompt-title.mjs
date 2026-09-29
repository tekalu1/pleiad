// 会話の題を、最初の人の発言の本文から作る。本文は Markdown で、文中に添付の印（`[添付] パス`）を持つので、そのままは題にならない
// （`# 見出し`・`**太字**`・改行・パスが題に入ってしまう）。バックエンドが題を持たない会話（最初の発言が題）と、
// バックエンドが本文そのものを題として返す会話（Claude の firstPrompt・Codex の preview・Antigravity の最初の発言）に使う。
// 人が付けた題（customTitle・保存済みの title）には通さない。
import { ATTACHMENT_LINE } from '../web/timeline.mjs';

const TITLE_LIMIT = 80;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// 行の途中・1 行に潰れた本文の中の印（前が空白か先頭で、後ろにパスが続くもの）
const INLINE_MARK = /(?:^|\s)\[(?:添付|Attachment)\]\s+\S/;

const baseName = (path) => String(path ?? '').trim().split(/[\\/]/).filter(Boolean).at(-1) ?? '';

/** 行頭の記号（見出し・引用・箇条書き・番号）と、インラインの区切り（強調・コード・リンク・画像）を外す */
function plainLine(line) {
  let s = line.trim();
  for (let prev = null; prev !== s;) {
    prev = s;
    s = s.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^[-*+]\s+/, '').replace(/^\d{1,9}[.)]\s+/, '').trim();
  }
  return s
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/(?<![\w*])\*\*(.+?)\*\*(?![\w*])/g, '$1')
    .replace(/(?<!\w)__(.+?)__(?!\w)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

/**
 * 本文から題を作る（80 字まで）。コードブロックの中と添付の印の行は使わない。印より後ろは、題にする字が既にあれば切る
 * （1 行に潰れた本文の印以降はパスと本文の続き）。添付だけの発言は最初の添付のファイル名。何も残らなければ ''
 */
export function promptTitle(text, { limit = TITLE_LIMIT } = {}) {
  const parts = [];
  let firstAttachment = '';
  let fence = null;
  scan: for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const f = FENCE.exec(raw);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      continue;
    }
    if (f) { fence = f[1]; continue; }
    const mark = ATTACHMENT_LINE.exec(raw.trim());
    if (mark) {
      firstAttachment ||= baseName(mark[1]);
      if (parts.length) break scan;
      continue;
    }
    const inline = INLINE_MARK.exec(raw);
    if (inline) {
      firstAttachment ||= baseName(/\[(?:添付|Attachment)\]\s+(\S+)/.exec(raw)?.[1]);
      const head = plainLine(raw.slice(0, inline.index));
      if (head) parts.push(head);
      if (parts.length) break scan;
      continue;
    }
    const s = plainLine(raw);
    if (s) parts.push(s);
  }
  const title = parts.join(' ').replace(/\s+/g, ' ').trim();
  return [...(title || firstAttachment)].slice(0, limit).join('');
}

/** LLM に渡す本文用: 添付の印の行を、パスではなくファイル名の括弧に替える（パスで字数を使わず、パスがそのまま題にならない） */
export function textForTitleModel(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => {
    const mark = ATTACHMENT_LINE.exec(line.trim());
    return mark ? `[${baseName(mark[1])}]` : line;
  }).join('\n');
}
