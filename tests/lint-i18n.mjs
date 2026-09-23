#!/usr/bin/env node
/* ==================== 翻訳漏れの lint ====================
   多言語対応（docs/design.md「多言語対応」）の漏れを機械的に落とす。依存なし・Node 20+。

     node tests/lint-i18n.mjs [--update-baseline [--moved]] [--json] [--selftest]

   検査すること:
   1. 直書きの日本語（ラチェット）。web/・core/・desktop/ のコードに残る、日本語（ひらがな・カタカナ・漢字）を含む
      文字列リテラル・テンプレートリテラル・HTML のテキストと title / aria-label / placeholder / alt・CSS の content: を数える。
      数える単位は「リテラルの 1 行」（複数行のテンプレートは日本語を含む行ごとに 1 件）。コメントは数えない。
      ファイルごとの件数を tests/i18n-baseline.json と比べ、増えた・基準に無いファイルに出た → 失敗。
      減った → 「基準を下げてください」で失敗（--update-baseline で下げる）。基準は下がる一方にする。
      除外: console.* の引数（ログは訳さない）、web/emoji.mjs（検索語の辞書）、core/backends/fake.mjs（テスト用の応答）、
            web/locales/（辞書そのもの）、`// i18n-ignore: 理由` の印がある行（行末か、直前の行にコメントだけで）。理由の無い印は失敗。
   2. 辞書の揃い。全言語・全名前空間で同じキー。複数形は言語ごとに Intl.PluralRules の分類の接尾辞（_one / _other …）が揃う。
   3. 差し込みの一致。同じキーの {{name}} の集合が全言語で同じ。
   4. 未訳。ja 以外の値に日本語が入っている、または ja と同じ値のまま → 失敗。
      固有名などは tests/i18n-allow.json の sameAsJa に「名前空間:キー」で許す。文字（\p{L}）を含まない値は数えない。
   5. キーの存在と未使用。コード中の静的な t('キー') と data-i18n* 属性のキーが ja にあること。
      名前空間を書かないキーは置き場で決まる: web/ → ui、core/ → server、desktop/ → desktop。
      ほかの名前空間は 'agent:キー' のように書く。辞書にあってどこからも使われないキーも失敗。
      組み立てるキーは、同じファイルに `// i18n-dynamic: 接頭辞` の印を書けば、その接頭辞で始まるキーを使用済みとみなす。
   6. 自己診断（--selftest。npm test でも回す）。

   npm test からは tests/unit/i18n-lint.mjs が lintRepo() と selftest() を直接呼ぶ。 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'i18n-baseline.json');
export const ALLOW_FILE = path.join(ROOT, 'tests', 'i18n-allow.json');
export const LOCALES_DIR = path.join(ROOT, 'web', 'locales');

/* 検査する範囲。拡張子で読み方が決まる */
const SCAN_DIRS = ['web', 'core', 'desktop'];
const JS_EXT = new Set(['.mjs', '.js', '.cjs']);
const EXT = new Set([...JS_EXT, '.html', '.css']);
/* 日本語を数えない場所（理由は冒頭） */
const EXCLUDE = [/^web\/emoji\.mjs$/, /^core\/backends\/fake\.mjs$/, /^web\/locales\//];
/* 名前空間を書かないキーの既定 */
const DEFAULT_NS = [[/^web\//, 'ui'], [/^core\//, 'server'], [/^desktop\//, 'desktop']];

export const JP = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const IGNORE_MARK = /i18n-ignore\b(?:\s*:\s*(.*?))?\s*(?:\*\/|-->)?\s*$/;
const DYNAMIC_MARK = /i18n-dynamic\s*:\s*([\w.:-]+)/g;
const PLURAL = /_(zero|one|two|few|many|other)$/;

/* ==================== JavaScript の字句 ====================
   文字列・テンプレート・コメント・正規表現を区別するだけの簡易な字句解析。構文木は作らない。
   返すもの:
     literals: [{ line, startLine, text, console }]  日本語の有無に関係なく、リテラルの 1 行ごと
     comments: [{ line, text }]                    コメントの 1 行ごと
     calls:    [{ line, callee, arg }]             t('…') のように、関数呼び出しの最初の引数が静的な文字列のもの */
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

export function scanJs(text, lineOffset = 0) {
  const literals = [], comments = [], calls = [];
  const n = text.length;
  let i = 0, line = 1 + lineOffset;
  const stack = [];          // '(' { console } | '{' | '${' { rec }
  let consoleDepth = 0;
  const hist = [];           // 直近の意味のある字句（console.log( と t( の判定用）
  const push = (tok) => { hist.push(tok); if (hist.length > 4) hist.shift(); };
  const last = () => hist[hist.length - 1] ?? '';
  let pendingCall = null;    // 直前が t( なら { callee, line }

  function regexAllowed() {
    const p = last();
    if (!p) return true;
    if (p.startsWith('id:')) return REGEX_AFTER_WORD.has(p.slice(3));
    if (p === 'lit' || p === ')' || p === ']') return false;
    return REGEX_AFTER.has(p[p.length - 1]);
  }

  /* リテラルの記録。行ごとの本文を集め、閉じたときに literals へ出す */
  const openRec = (kind) => ({ kind, startLine: line, lines: new Map(), console: consoleDepth > 0, raw: '' });
  const addChar = (rec, ch) => { rec.lines.set(line, (rec.lines.get(line) ?? '') + ch); rec.raw += ch; };
  const closeRec = (rec) => {
    for (const [ln, body] of rec.lines) literals.push({ line: ln, startLine: rec.startLine, text: body, console: rec.console, kind: rec.kind });
    if (!rec.lines.size) literals.push({ line: rec.startLine, startLine: rec.startLine, text: '', console: rec.console, kind: rec.kind });
    if (pendingCall && pendingCall.first) {
      if (!(rec.kind === 'template' && rec.hasExpr)) calls.push({ line: rec.startLine, callee: pendingCall.callee, arg: rec.raw });
    }
    pendingCall = null;
    push('lit');
  };

  /* テンプレートの中身を読む。${ に出会ったら式へ戻るので false、閉じたら true */
  function readTemplate(rec) {
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') { addChar(rec, text.slice(i, i + 2)); if (text[i + 1] === '\n') line++; i += 2; continue; }
      if (ch === '`') { i++; closeRec(rec); return true; }
      if (ch === '$' && text[i + 1] === '{') { i += 2; rec.hasExpr = true; stack.push({ k: '${', rec }); push('('); return false; }
      if (ch === '\n') { line++; i++; continue; }
      addChar(rec, ch); i++;
    }
    closeRec(rec);
    return true;
  }

  while (i < n) {
    const ch = text[i], nx = text[i + 1];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\uFEFF') { i++; continue; }
    // コメント
    if (ch === '/' && nx === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push({ line, text: text.slice(i + 2, stop) });
      i = stop; continue;
    }
    if (ch === '/' && nx === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const body = text.slice(i + 2, end === -1 ? n : end);
      body.split('\n').forEach((part, k) => comments.push({ line: line + k, text: part }));
      line += body.split('\n').length - 1;
      i = stop; continue;
    }
    // 文字列
    if (ch === '"' || ch === "'") {
      const rec = openRec('string');
      i++;
      while (i < n && text[i] !== ch) {
        if (text[i] === '\\') { addChar(rec, text.slice(i, i + 2)); if (text[i + 1] === '\n') line++; i += 2; continue; }
        if (text[i] === '\n') break;   // 閉じ忘れ。行で打ち切る
        addChar(rec, text[i]); i++;
      }
      i++;
      closeRec(rec); continue;
    }
    if (ch === '`') {
      i++;
      readTemplate(openRec('template'));
      continue;
    }
    // 正規表現（中の日本語は表示する文ではないので数えない）
    if (ch === '/' && regexAllowed()) {
      i++;
      let inClass = false;
      while (i < n && text[i] !== '\n') {
        const c = text[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(text[i])) i++;
      push('lit'); pendingCall = null; continue;
    }
    // 名前
    if (/[\p{L}_$]/u.test(ch)) {
      let j = i + 1;
      while (j < n && /[\p{L}\p{N}_$]/u.test(text[j])) j++;
      push('id:' + text.slice(i, j));
      i = j; pendingCall = null; continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(nx ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      i = j; push('lit'); pendingCall = null; continue;
    }
    // 括弧
    if (ch === '(') {
      const h = hist.slice(-3);
      const isConsole = h.length === 3 && h[0] === 'id:console' && h[1] === '.' && h[2].startsWith('id:');
      const callee = last().startsWith('id:') ? last().slice(3) : null;
      const member = hist[hist.length - 2] === '.';
      // agentT(会話の言語, '…')。キーは 2 つ目の引数（名前空間の既定は agent）。最初の , でキーを待つ
      stack.push({ k: '(', console: isConsole, ...(callee === 'agentT' && !member ? { agentT: true } : {}) });
      if (isConsole) consoleDepth++;
      push('(');
      i++;
      // t('…') と i18n.t('…')。ほかの名前の t は数えない
      pendingCall = callee === 't' ? { callee: member ? '.t' : 't', first: true } : null;
      continue;
    }
    if (ch === ')') {
      const top = stack[stack.length - 1];
      if (top?.k === '(') { stack.pop(); if (top.console) consoleDepth--; }
      push(')'); i++; pendingCall = null; continue;
    }
    if (ch === '{') { stack.push({ k: '{' }); push('{'); i++; pendingCall = null; continue; }
    if (ch === '}') {
      const top = stack.pop();
      i++;
      if (top?.k === '${') { readTemplate(top.rec); continue; }
      push('}'); pendingCall = null; continue;
    }
    // そのほかの記号。?.( は呼び出しとして読み飛ばし、?. は . と同じに扱う
    if (ch === '?' && nx === '.' && text[i + 2] === '(') { i += 2; continue; }
    if (ch === '?' && nx === '.' && !/[0-9]/.test(text[i + 2] ?? '')) { push('.'); i += 2; continue; }
    const top = stack[stack.length - 1];
    if (ch === ',' && top?.agentT) { delete top.agentT; push(ch); i++; pendingCall = { callee: 'agentT', first: true }; continue; }
    push(ch); i++; pendingCall = null;
  }
  return { literals, comments, calls };
}

/* ==================== CSS ==================== */
export function scanCss(text, lineOffset = 0) {
  const comments = [], literals = [];
  // コメントを同じ長さの空白に置き換える（改行は残して行番号を保つ）
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (m, at) => {
    const startLine = lineOffset + 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0);
    m.slice(2, -2).split('\n').forEach((part, k) => comments.push({ line: startLine + k, text: part }));
    return m.replace(/[^\n]/g, ' ');
  });
  for (const m of code.matchAll(/(?<![\w-])content\s*:\s*([^;}]*)/g)) {
    const at = m.index + m[0].length - m[1].length;
    for (const s of m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
      const pos = at + s.index;
      literals.push({ line: lineOffset + 1 + (code.slice(0, pos).match(/\n/g)?.length ?? 0), text: s[1] ?? s[2], console: false, kind: 'css' });
    }
  }
  for (const l of literals) l.startLine = l.line;
  return { literals, comments, calls: [] };
}

/* ==================== HTML ==================== */
const HTML_ATTRS = new Set(['title', 'aria-label', 'placeholder', 'alt']);

export function scanHtml(text) {
  const literals = [], comments = [], calls = [], keys = [];
  const lineAt = (pos) => 1 + (text.slice(0, pos).match(/\n/g)?.length ?? 0);
  const textRun = (from, to) => {
    const chunk = text.slice(from, to);
    let ln = lineAt(from);
    for (const part of chunk.split('\n')) {
      if (part.trim()) literals.push({ line: ln, startLine: ln, text: part.trim(), console: false, kind: 'html' });
      ln++;
    }
  };
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) { textRun(i, text.length); break; }
    textRun(i, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const stop = end === -1 ? text.length : end;
      text.slice(lt + 4, stop).split('\n').forEach((part, k) => comments.push({ line: lineAt(lt) + k, text: part }));
      i = end === -1 ? text.length : end + 3; continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt === -1) break;
    const tag = text.slice(lt, gt + 1);
    const name = /^<\/?\s*([\w-]+)/.exec(tag)?.[1]?.toLowerCase() ?? '';
    for (const a of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const attr = a[1].toLowerCase(), value = a[2] ?? a[3];
      const ln = lineAt(lt + a.index);
      if (HTML_ATTRS.has(attr)) literals.push({ line: ln, startLine: ln, text: value, console: false, kind: 'attr' });
      if (/^data-i18n(-[\w-]+)?$/.test(attr)) keys.push({ line: ln, key: value });
    }
    i = gt + 1;
    if ((name === 'script' || name === 'style') && !tag.startsWith('</')) {
      const close = text.toLowerCase().indexOf(`</${name}`, i);
      const end = close === -1 ? text.length : close;
      const body = text.slice(i, end);
      const isJs = name === 'script' && !/type\s*=\s*["'](?!module|text\/javascript)/i.test(tag);
      if (name === 'style' || isJs) {
        const r = name === 'style' ? scanCss(body, lineAt(i) - 1) : scanJs(body, lineAt(i) - 1);
        literals.push(...r.literals); comments.push(...r.comments); calls.push(...r.calls);
      }
      i = end;
    }
  }
  return { literals, comments, calls, keys };
}

/* ==================== 1 ファイル ==================== */
/** name は ROOT からの相対（/ 区切り）。日本語の件数・印の問題・使っているキーを返す */
export function scanFile(name, text) {
  const ext = path.extname(name);
  const r = ext === '.html' ? scanHtml(text) : ext === '.css' ? scanCss(text) : scanJs(text);
  const lines = text.split('\n');
  const problems = [];
  // i18n-ignore の印。行 → 理由
  const marks = new Map();
  for (const c of r.comments) {
    const m = IGNORE_MARK.exec(c.text);
    if (!m || !/i18n-ignore/.test(c.text)) continue;
    const reason = (m[1] ?? '').trim();
    if (!reason) problems.push({ rule: 'ignore-reason', file: name, line: c.line, message: 'i18n-ignore に理由が無い（`// i18n-ignore: 理由` と書く）' });
    marks.set(c.line, reason);
  }
  const onlyComment = (ln) => /^\s*(\/\/|\/\*|\*|<!--)/.test(lines[ln - 1] ?? '');
  const ignored = (ln) => marks.has(ln) || (marks.has(ln - 1) && onlyComment(ln - 1));
  const items = [];
  for (const l of r.literals) {
    if (!JP.test(l.text) || l.console) continue;
    if (ignored(l.line) || ignored(l.startLine)) continue;
    items.push({ file: name, line: l.line, text: l.text.trim().slice(0, 80) });
  }
  // 使っているキー
  const ns = DEFAULT_NS.find(([re]) => re.test(name))?.[1] ?? 'ui';
  const used = [];
  for (const c of r.calls) used.push({ file: name, line: c.line, ...splitKey(c.arg, c.callee === 'agentT' ? 'agent' : ns) });
  const attrKeys = r.keys ?? [];
  // JS の中の data-i18n*="…"（innerHTML で組む塊）と dataset.i18n* = '…'
  if (ext !== '.html') for (const l of r.literals) for (const m of l.text.matchAll(/data-i18n(?:-[\w-]+)?=\\?["']([\w.:-]+)\\?["']/g)) attrKeys.push({ line: l.line, key: m[1] });
  for (const m of text.matchAll(/\bdataset\.i18n\w*\s*=\s*(['"])([\w.:-]+)\1/g)) attrKeys.push({ line: 1 + (text.slice(0, m.index).match(/\n/g)?.length ?? 0), key: m[2] });
  for (const k of attrKeys) used.push({ file: name, line: k.line, ...splitKey(k.key, 'ui') });
  const dynamic = [];
  for (const c of r.comments) for (const m of c.text.matchAll(DYNAMIC_MARK)) dynamic.push(splitKey(m[1], ns));
  return { items, problems, used, dynamic };
}

/** 'ns:key' を分ける。名前空間が書かれていなければ既定 */
export function splitKey(raw, defaultNs) {
  const m = /^([\w-]+):(.+)$/.exec(raw);
  return m ? { ns: m[1], key: m[2] } : { ns: defaultNs, key: raw };
}

/* ==================== ラチェット ==================== */
/**
 * 件数を基準と比べる。counts / baseline は { file: 件数 }。
 * items はその時点の全件（増えた箇所を示すため）。added(file) は増えたと思われる行の集合を返す（無ければ null）
 */
export function checkBaseline(counts, baseline, items = [], added = () => null) {
  const problems = [];
  const files = new Set([...Object.keys(counts), ...Object.keys(baseline)]);
  for (const file of [...files].sort()) {
    const now = counts[file] ?? 0, base = baseline[file] ?? 0;
    if (now > base) {
      const mine = items.filter((it) => it.file === file);
      const lines = added(file);
      const hint = lines ? mine.filter((it) => lines.has(it.line)) : [];
      const shown = (hint.length ? hint : mine).slice(0, hint.length ? 50 : 20);
      problems.push({
        rule: 'hardcoded-japanese', file, line: shown[0]?.line ?? 0,
        message: `${file in baseline ? `直書きの日本語が増えた（${base} → ${now} 件）` : `基準に無いファイルに直書きの日本語がある（${now} 件）`}。` +
          '辞書（web/locales）に置いて t() で引く。どうしても直書きするなら `// i18n-ignore: 理由`',
        where: shown.map((it) => `${it.file}:${it.line}  ${it.text}`),
        whereNote: hint.length ? '変更した行' : mine.length > shown.length ? `このファイルの ${mine.length} 件のうち先頭 ${shown.length} 件（--json で全件）` : '',
      });
    } else if (now < base) {
      problems.push({ rule: 'baseline-stale', file, line: 0,
        message: `直書きの日本語が減った（${base} → ${now} 件）。基準を下げてください（node tests/lint-i18n.mjs --update-baseline）` });
    }
  }
  return problems;
}

/* ==================== 辞書 ==================== */
/** { lng: { ns: nested } } を { lng: { ns: { 'a.b': 値 } } } へ */
export function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const vars = (s) => new Set([...String(s).matchAll(/\{\{\s*([\w.]+)[^}]*\}\}/g)].map((m) => m[1]));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/** 平らな辞書（1 名前空間 1 言語）をキーの基に寄せる。{ base: { forms: { other: 値 } | null, value } } */
function groupPlurals(flat) {
  const out = {};
  for (const [k, v] of Object.entries(flat)) {
    const m = PLURAL.exec(k);
    if (m) {
      const base = k.slice(0, -m[0].length);
      out[base] ??= { forms: {} };
      (out[base].forms ??= {})[m[1]] = v;
    } else {
      out[k] ??= {};
      out[k].value = v;
    }
  }
  return out;
}

/**
 * 辞書を検査する。dicts は { lng: { ns: nested } }。ja が正本。
 * allow は { sameAsJa: ['ns:key', …] }
 */
export function checkDicts(dicts, allow = {}) {
  const problems = [];
  const lngs = Object.keys(dicts);
  const same = new Set(allow.sameAsJa ?? []);
  const where = (lng, ns) => `web/locales/${lng}/${ns}.json`;
  const nss = [...new Set(lngs.flatMap((l) => Object.keys(dicts[l])))].sort();
  for (const ns of nss) {
    const grouped = {};
    for (const lng of lngs) {
      if (!dicts[lng][ns]) { problems.push({ rule: 'dict-missing-file', file: where(lng, ns), line: 0, message: `名前空間 ${ns} の辞書が無い` }); continue; }
      grouped[lng] = groupPlurals(flatten(dicts[lng][ns]));
    }
    const bases = [...new Set(Object.values(grouped).flatMap((g) => Object.keys(g)))].sort();
    for (const base of bases) {
      const id = `${ns}:${base}`;
      for (const lng of Object.keys(grouped)) {
        const e = grouped[lng][base];
        if (!e) { problems.push({ rule: 'dict-missing-key', file: where(lng, ns), line: 0, message: `${id} が無い` }); continue; }
        const isPlural = Object.values(grouped).some((g) => g[base]?.forms);
        if (isPlural) {
          const need = new Intl.PluralRules(lng).resolvedOptions().pluralCategories;
          const have = Object.keys(e.forms ?? {});
          const missing = need.filter((c) => !have.includes(c)), extra = have.filter((c) => !need.includes(c));
          if (e.value !== undefined) problems.push({ rule: 'dict-plural', file: where(lng, ns), line: 0, message: `${id}: 複数形のキーと接尾辞の無いキーが混ざっている` });
          if (missing.length || extra.length) problems.push({ rule: 'dict-plural', file: where(lng, ns), line: 0,
            message: `${id}: ${lng} の複数形は ${need.map((c) => '_' + c).join(' ')}${missing.length ? `（足りない: ${missing.map((c) => '_' + c).join(' ')}）` : ''}${extra.length ? `（余分: ${extra.map((c) => '_' + c).join(' ')}）` : ''}` });
        }
      }
      // 差し込みと未訳は ja と比べる
      const ja = grouped.ja?.[base];
      if (!ja) continue;
      const jaValues = ja.forms ? Object.values(ja.forms) : [ja.value];
      const jaVars = new Set(jaValues.flatMap((v) => [...vars(v)]));
      for (const lng of Object.keys(grouped)) {
        if (lng === 'ja') continue;
        const e = grouped[lng][base];
        if (!e) continue;
        const values = e.forms ? Object.values(e.forms) : [e.value];
        const lv = new Set(values.flatMap((v) => [...vars(v)]));
        if (!sameSet(lv, jaVars)) problems.push({ rule: 'dict-interpolation', file: where(lng, ns), line: 0,
          message: `${id}: 差し込みが ja と違う（ja: ${[...jaVars].join(', ') || 'なし'} / ${lng}: ${[...lv].join(', ') || 'なし'}）` });
        for (const v of values) {
          if (typeof v !== 'string') { problems.push({ rule: 'dict-type', file: where(lng, ns), line: 0, message: `${id}: 値が文字列でない` }); continue; }
          if (JP.test(v)) problems.push({ rule: 'untranslated', file: where(lng, ns), line: 0, message: `${id}: ${lng} の値に日本語が入っている「${v}」` });
          else if (jaValues.includes(v) && /\p{L}/u.test(v.replace(/\{\{[^}]*\}\}/g, '')) && !same.has(id))
            problems.push({ rule: 'untranslated', file: where(lng, ns), line: 0, message: `${id}: ${lng} の値が ja と同じ「${v}」（固有名なら tests/i18n-allow.json の sameAsJa へ）` });
        }
      }
    }
  }
  return problems;
}

/** 使っているキーと辞書を突き合わせる。used は [{ file, line, ns, key }]、dynamic は [{ ns, key: 接頭辞 }] */
export function checkUsage(dicts, used, dynamic) {
  const problems = [];
  const ja = dicts.ja ?? {};
  const known = new Set();
  for (const [ns, tree] of Object.entries(ja)) for (const k of Object.keys(flatten(tree))) known.add(`${ns}:${k.replace(PLURAL, '')}`);
  for (const u of used) {
    const id = `${u.ns}:${u.key}`;
    if (!known.has(id)) problems.push({ rule: 'missing-key', file: u.file, line: u.line, message: `${id} が ja の辞書に無い` });
  }
  const usedIds = new Set(used.map((u) => `${u.ns}:${u.key}`));
  for (const id of [...known].sort()) {
    if (usedIds.has(id)) continue;
    if (dynamic.some((d) => id.startsWith(`${d.ns}:${d.key}`))) continue;
    const [ns, key] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    problems.push({ rule: 'unused-key', file: `web/locales/ja/${ns}.json`, line: 0, message: `${ns}:${key} はどこからも使われていない（組み立てるキーなら使う側に // i18n-dynamic: 接頭辞）` });
  }
  return problems;
}

/* ==================== リポジトリ全体 ==================== */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.has(path.extname(name))) out.push(p);
  }
  return out;
}

export function listFiles(root = ROOT) {
  return SCAN_DIRS.flatMap((d) => walk(path.join(root, d))).map((p) => path.relative(root, p).split(path.sep).join('/')).sort();
}

export function readDicts(dir = LOCALES_DIR) {
  const dicts = {};
  for (const lng of readdirSync(dir).filter((d) => statSync(path.join(dir, d)).isDirectory()).sort()) {
    dicts[lng] = {};
    for (const f of readdirSync(path.join(dir, lng)).filter((f) => f.endsWith('.json')))
      dicts[lng][f.slice(0, -5)] = JSON.parse(readFileSync(path.join(dir, lng, f), 'utf8'));
  }
  return dicts;
}

const readJson = (file, fallback) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;

/** 増えたと思われる行（作業ツリーの未コミットの変更、無ければ直前のコミット）。git が無ければ null */
function gitAdded(root) {
  const run = (args) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
  const parse = (diff) => {
    const out = new Map();
    let file = null;
    for (const l of (diff ?? '').split('\n')) {
      const f = /^\+\+\+ b\/(.*)$/.exec(l);
      if (f) { file = f[1]; out.set(file, out.get(file) ?? new Set()); continue; }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (h && file) for (let k = 0; k < Number(h[2] ?? 1); k++) out.get(file).add(Number(h[1]) + k);
    }
    return out;
  };
  let map = null;
  return (file) => {
    if (!map) {
      map = parse(run(['diff', '-U0', 'HEAD', '--', ...SCAN_DIRS]));
      for (const f of (run(['ls-files', '--others', '--exclude-standard', '--', ...SCAN_DIRS]) ?? '').split('\n').filter(Boolean)) map.set(f, null);
      if (!map.size) map = parse(run(['diff', '-U0', 'HEAD~1', 'HEAD', '--', ...SCAN_DIRS]));
    }
    if (!map.has(file)) return null;
    const lines = map.get(file);
    return lines ?? null;
  };
}

/** 全部の検査。problems が空なら合格 */
export function lintRepo({ root = ROOT, baselineFile = BASELINE_FILE, allowFile = ALLOW_FILE, localesDir = path.join(root, 'web', 'locales') } = {}) {
  const problems = [], items = [], used = [], dynamic = [];
  const counts = {};
  for (const name of listFiles(root)) {
    const r = scanFile(name, readFileSync(path.join(root, name), 'utf8'));
    used.push(...r.used); dynamic.push(...r.dynamic);
    problems.push(...r.problems);
    if (EXCLUDE.some((re) => re.test(name))) continue;
    if (r.items.length) counts[name] = r.items.length;
    items.push(...r.items);
  }
  const baseline = readJson(baselineFile, null);
  if (!baseline) problems.push({ rule: 'baseline-missing', file: path.relative(root, baselineFile), line: 0, message: '基準が無い（node tests/lint-i18n.mjs --update-baseline で作る）' });
  else problems.push(...checkBaseline(counts, baseline.files ?? {}, items, gitAdded(root)));
  const dicts = readDicts(localesDir);
  problems.push(...checkDicts(dicts, readJson(allowFile, {})));
  problems.push(...checkUsage(dicts, used, dynamic));
  return { problems, counts, items, total: Object.values(counts).reduce((a, b) => a + b, 0) };
}

/** 基準を書く。増えたファイルがあれば書かない（moved = コードを移しただけで合計が増えていないときは許す） */
export function updateBaseline({ root = ROOT, baselineFile = BASELINE_FILE, moved = false } = {}) {
  const { counts, total } = lintRepo({ root, baselineFile });
  const old = readJson(baselineFile, null);
  if (old) {
    const up = Object.entries(counts).filter(([f, c]) => c > (old.files?.[f] ?? 0));
    const oldTotal = Object.values(old.files ?? {}).reduce((a, b) => a + b, 0);
    if (up.length && !(moved && total <= oldTotal)) {
      return { ok: false, message: `基準は下げるだけ。増えたファイル: ${up.map(([f, c]) => `${f}（${old.files?.[f] ?? 0} → ${c}）`).join(', ')}` +
        (moved ? `（合計も ${oldTotal} → ${total} に増えている）` : '。コードを別のファイルへ移しただけで合計が増えていないなら --moved') };
    }
  }
  const files = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselineFile, JSON.stringify({
    about: 'tests/lint-i18n.mjs の基準。ファイルごとの直書きの日本語の件数。下げるだけ（node tests/lint-i18n.mjs --update-baseline）',
    total, files }, null, 2) + '\n');
  return { ok: true, message: `基準を書いた（合計 ${total} 件、${Object.keys(files).length} ファイル）` };
}

/* ==================== 自己診断 ==================== */
export function selftest(log = console.log) {
  const count = (name, text) => scanFile(name, text).items.length;
  const cases = [
    ['文字列の日本語を数え、コメントは数えない', () => count('web/a.mjs', "// 日本語のコメント\n/* 複数行の\n  コメント */\nconst a = '日本語';\nconst b = \"English\";") === 1],
    ['テンプレートは日本語を含む行ごと、式の中の文字列も数える', () => count('web/a.mjs', 'const a = `一行目\n二行目 ${x ? "内側" : `入れ子${y}の中`}\nthird`;') === 4],
    ['console.* の引数は数えない', () => count('web/a.mjs', "console.log('ログ', `x ${'中'}`);\nconsole.error?.('失敗');\nfoo('数える');") === 1],
    ['正規表現の中は数えない', () => count('web/a.mjs', "const re = /[ぁ-ん]+/u; const x = a / b / c; const s = '数える';") === 1],
    ['i18n-ignore（行末・直前行）で外せる', () => count('web/a.mjs', "const a = '外す'; // i18n-ignore: 固有名\n// i18n-ignore: 検索語\nconst b = '外す';\nconst c = '数える';") === 1],
    ['agentT(言語, キー) は 2 つ目の引数を agent のキーとして読む', () => {
      const used = scanFile('core/a.mjs', "agentT(locale, 'tasks.x', { n }); agentT(lng, 'server:y'); t('z', agentT(l, 'w'));").used.map((u) => `${u.ns}:${u.key}`).join(',');
      return used === 'agent:tasks.x,server:y,server:z,agent:w';
    }],
    ['理由の無い i18n-ignore は落ちる', () => scanFile('web/a.mjs', "const a = '外す'; // i18n-ignore").problems.some((p) => p.rule === 'ignore-reason')],
    ['HTML のテキストと属性を数え、コメントとほかの属性は数えない', () => count('web/a.html', '<!-- コメント -->\n<p title="題" data-x="値">本文</p>\n<input placeholder="入力" aria-label="欄" alt="絵">\n<script>const s = \'中\';</script>\n<style>.a::before{content:"既定"}</style>') === 7],
    ['CSS の content: を数え、コメントは数えない', () => count('web/a.css', '/* content:"注" */\n.a::before{content:"既定"}\n.b::after{content:"✓"}') === 1],
    ['t() と data-i18n のキーを拾い、名前空間の既定は置き場で決まる', () => {
      const r = scanFile('web/a.mjs', "t('a.b'); i18n.t(\"server:c\", { n }); x.innerHTML = '<p data-i18n=\"d.e\"></p>'; t(`f.${x}`); at('no');");
      const s = scanFile('core/a.mjs', "t('g');");
      return JSON.stringify(r.used.map((u) => `${u.ns}:${u.key}`)) === JSON.stringify(['ui:a.b', 'server:c', 'ui:d.e']) && s.used[0].ns === 'server';
    }],
    ['基準より増えたら落ち、基準に無いファイルも落ちる', () => {
      const p = checkBaseline({ 'web/a.mjs': 3, 'web/b.mjs': 1 }, { 'web/a.mjs': 2 });
      return p.filter((x) => x.rule === 'hardcoded-japanese').length === 2;
    }],
    ['基準より減ったら「基準を下げてください」で落ち、同じなら通る', () =>
      checkBaseline({ 'web/a.mjs': 1 }, { 'web/a.mjs': 2 }).some((x) => x.rule === 'baseline-stale' && /基準を下げて/.test(x.message)) &&
      checkBaseline({ 'web/a.mjs': 2 }, { 'web/a.mjs': 2 }).length === 0],
    ['増えた箇所を file:line で示す', () => {
      const p = checkBaseline({ 'web/a.mjs': 2 }, { 'web/a.mjs': 1 }, [{ file: 'web/a.mjs', line: 3, text: '古い' }, { file: 'web/a.mjs', line: 9, text: '新しい' }], () => new Set([9]));
      return p[0]?.where?.length === 1 && p[0].where[0].startsWith('web/a.mjs:9');
    }],
    ['en にキーが無いと落ちる', () => checkDicts({ ja: { ui: { a: 'あ', b: 'い' } }, en: { ui: { a: 'A' } } }).some((p) => p.rule === 'dict-missing-key' && /ui:b/.test(p.message))],
    ['複数形の接尾辞が言語の分類と揃わないと落ちる', () => {
      const bad = checkDicts({ ja: { ui: { n_other: '{{count}} 件' } }, en: { ui: { n_other: '{{count}} items' } } });
      const good = checkDicts({ ja: { ui: { n_other: '{{count}} 件' } }, en: { ui: { n_one: '{{count}} item', n_other: '{{count}} items' } } });
      return bad.some((p) => p.rule === 'dict-plural') && good.length === 0;
    }],
    ['差し込みの名前が違うと落ちる', () => checkDicts({ ja: { ui: { a: '{{name}} さん' } }, en: { ui: { a: 'Mr. {{nam}}' } } }).some((p) => p.rule === 'dict-interpolation')],
    ['en に日本語・ja と同じ値が残ると落ち、許可リストと文字の無い値は通る', () => {
      const p = checkDicts({ ja: { ui: { a: '保存', b: 'Pleiad', c: '{{a}} · {{b}}', d: 'MCP' } }, en: { ui: { a: '保存', b: 'Pleiad', c: '{{a}} · {{b}}', d: 'MCP' } } }, { sameAsJa: ['ui:d'] });
      return p.filter((x) => x.rule === 'untranslated').map((x) => x.message.split(':').slice(0, 2).join(':')).join(',') === 'ui:a,ui:b';
    }],
    ['使っているキーが無いと落ち、使われないキーも落ち、i18n-dynamic の接頭辞は通る', () => {
      const dicts = { ja: { ui: { a: 'あ', b: 'い', dyn: { x: 'う' } } } };
      const p = checkUsage(dicts, [{ file: 'web/a.mjs', line: 1, ns: 'ui', key: 'a' }, { file: 'web/a.mjs', line: 2, ns: 'ui', key: 'zz' }], [{ ns: 'ui', key: 'dyn.' }]);
      return p.some((x) => x.rule === 'missing-key' && /ui:zz/.test(x.message)) && p.some((x) => x.rule === 'unused-key' && /ui:b/.test(x.message)) && p.length === 2;
    }],
  ];
  let ok = true;
  for (const [name, check] of cases) {
    let pass;
    try { pass = check(); } catch (e) { pass = false; log(`        ${e.stack}`); }
    ok = ok && pass;
    log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }
  return ok ? 0 : 1;
}

/* ==================== 出力 ==================== */
export function report(result, { json = false, log = console.log } = {}) {
  const { problems } = result;
  if (json) { log(JSON.stringify({ problems, counts: result.counts, total: result.total, items: result.items }, null, 2)); return problems.length ? 1 : 0; }
  for (const p of problems) {
    log(`${p.file}${p.line ? ':' + p.line : ''}  [${p.rule}]  ${p.message}`);
    if (p.whereNote) log(`    ${p.whereNote}:`);
    for (const w of p.where ?? []) log(`    ${w}`);
  }
  log(problems.length ? `${problems.length} 件の問題（直書きの日本語は合計 ${result.total} 件）` : `問題なし（直書きの日本語は合計 ${result.total} 件、基準どおり）`);
  return problems.length ? 1 : 0;
}

/* import されたときは何もしない。直接実行されたときだけ引数を読む。 */
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`使い方: node tests/lint-i18n.mjs [--update-baseline [--moved]] [--json] [--selftest]

  翻訳漏れを検査する（直書きの日本語のラチェット・辞書の揃い・差し込み・未訳・キーの有無と未使用）。

    --update-baseline  直書きの日本語の件数の基準（tests/i18n-baseline.json）を今の件数に下げる。増えたファイルがあれば書かない
    --moved            --update-baseline と一緒に。コードを別のファイルへ移しただけ（合計が増えていない）なら増えたファイルも許す
    --json             問題・件数・全件を JSON で出す
    --selftest         内蔵のテストを走らせる`);
    process.exit(0);
  }
  if (argv.includes('--selftest')) process.exit(selftest());
  if (argv.includes('--update-baseline')) {
    const r = updateBaseline({ moved: argv.includes('--moved') });
    console.log(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  process.exit(report(lintRepo(), { json: argv.includes('--json') }));
}
