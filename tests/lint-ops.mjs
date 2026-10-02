#!/usr/bin/env node
/* ==================== 操作の一覧の載せ忘れの lint ====================
   操作の一覧（core/ops/）に載せ忘れた機能を落とす（docs/design.md「操作の一覧」、ADR 0080）。i18n の lint と同じ「下がる一方の基準（ラチェット）」の形。

     node tests/lint-ops.mjs [--update-baseline]

   検査すること（基準は tests/ops-baseline.json）:
   1. WS のコマンドの網羅。core/protocol.mjs の COMMANDS の各名前は、(a) どれかの操作の legacyCommand か、
      (b) 基準の commands に「理由の種類」付きで載っている。
        ui-internal       画面の内部（下書き・既読・watch・ピッカー）。外へ出す意味が無い
        stream            断片の送信・screencast。1 回の呼び出しで済まない
        human-only        承認モード・秘密・アカウント・リモートのペアリングなど。agent には出さない（ADR 0081）
        host-screen-only  サーバーのある PC の画面からだけ（OS で開く。ADR 0010）
        gateway           操作の一覧への入口そのもの（invoke）
        todo              未移行。操作として定義する候補。**件数（todoMax）は増やせない**
      操作へ移したコマンドが基準に残っていたら失敗（消す）。COMMANDS に無い名前が基準にあっても失敗。
      todo の件数が todoMax より減ったら「todoMax を下げてください」で失敗（--update-baseline で下げる）。基準は下がる一方にする。
   2. 設定の網羅。prefs.json に書くキー（setPref の受け付けるキーと、savePref・setPref の呼び出しのリテラル）は、
      設定の一覧（defineSetting の key または prefKeys）にあるか、基準の prefKeys（未移行）に載っている。
      未移行の側に新しいキーを足せない。設定へ移したキーが基準に残っていたら失敗（消す）。
   3. 自己診断（npm test でも回す）。 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE_FILE = path.join(ROOT, 'tests', 'ops-baseline.json');
export const KINDS = ['ui-internal', 'stream', 'human-only', 'host-screen-only', 'gateway', 'todo'];

/* ==================== prefs のキーの静的な走査 ==================== */

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const quotedWords = (text) => [...text.matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)].map((m) => m[1]);

/** server.mjs の `case "setPref"` の中で、key について書いてあるリテラルを拾う（key === 'x'・[…].includes(key)・key !== 'x'）。 */
export function setPrefCaseKeys(serverSource) {
  const start = serverSource.search(/case ["']setPref["']\s*:/);
  if (start < 0) return null;
  const rest = serverSource.slice(start);
  const end = rest.search(/\n\s*case ["'](?!setPref)/);
  const body = end < 0 ? rest : rest.slice(0, end);
  const keys = new Set();
  for (const m of body.matchAll(/\bkey\s*[!=]==?\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) keys.add(m[1]);
  for (const m of body.matchAll(/\[([^\]]*)\]\s*\.includes\(\s*key\s*\)/g)) for (const w of quotedWords(m[1])) keys.add(w);
  return keys;
}

/** core/ の中で prefs.json に書いているキー。savePref('x'・setPref('x' のリテラル ＋ setPref の case の分。 */
export function scanPrefKeys(root = ROOT) {
  const keys = new Set();
  for (const file of walk(path.join(root, 'core'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:savePref|setPref)\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) keys.add(m[1]);
  }
  const server = setPrefCaseKeys(readFileSync(path.join(root, 'core', 'server.mjs'), 'utf8'));
  if (!server) throw new Error('lint-ops: core/server.mjs に case "setPref" が見つからない（走査の規則を直す）');
  for (const k of server) keys.add(k);
  return [...keys].sort();
}

/* ==================== 検査 ==================== */

/**
 * @param baseline  tests/ops-baseline.json の中身
 * @param commands  COMMANDS（Set）
 * @param registry  操作の一覧（createRegistry の結果）
 * @param prefKeys  scanPrefKeys() の結果
 */
export function checkCoverage({ baseline, commands, registry, prefKeys }) {
  const problems = [];
  const add = (rule, message) => problems.push({ rule, message });
  const legacy = registry.legacyCommands();
  const listed = baseline.commands ?? {};

  for (const name of commands) {
    if (legacy.has(name)) {
      if (name in listed) add('migrated-still-listed', `${name} は操作へ移したので、tests/ops-baseline.json の commands から消す（node tests/lint-ops.mjs --update-baseline）`);
      continue;
    }
    if (!(name in listed)) add('unlisted-command', `WS のコマンド ${name} が操作の一覧にも除外表にもない。core/ops/ に defineOp（legacyCommand: '${name}'）を書くか、ui-internal・stream・human-only・host-screen-only の理由で tests/ops-baseline.json に載せる（todo は増やせない）`);
  }
  for (const [name, kind] of Object.entries(listed)) {
    if (!commands.has(name)) add('stale-command', `除外表の ${name} は COMMANDS に無い。消す`);
    if (!KINDS.includes(kind)) add('bad-kind', `除外表の ${name} の理由の種類 ${JSON.stringify(kind)} が不正（${KINDS.join(' / ')}）`);
  }
  const todo = Object.values(listed).filter((k) => k === 'todo').length;
  if (todo > baseline.todoMax) add('todo-grew', `todo が ${todo} 件で、上限 ${baseline.todoMax} を超えた。増やさず、操作として定義するか理由の種類を付ける`);
  if (todo < baseline.todoMax) add('todo-shrank', `todo が ${todo} 件に減った。todoMax を ${todo} に下げる（node tests/lint-ops.mjs --update-baseline）`);

  const covered = new Set(registry.settings.flatMap((s) => s.prefKeys));
  const pending = new Set(baseline.prefKeys ?? []);
  for (const key of prefKeys) {
    if (covered.has(key)) {
      if (pending.has(key)) add('migrated-pref-still-listed', `prefs の ${key} は設定へ移したので、基準の prefKeys から消す`);
      continue;
    }
    if (!pending.has(key)) add('unlisted-pref', `prefs.json に書くキー ${key} が設定の一覧にない。そのモジュールに defineSetting を書く（基準の prefKeys には足せない）`);
  }
  for (const key of pending) if (!prefKeys.includes(key)) add('stale-pref', `基準の prefKeys の ${key} は prefs に書かれていない。消す`);
  return problems;
}

export function readBaseline(file = BASELINE_FILE) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 基準の書き出し。1 件 1 行にして、差分を読みやすくする。 */
export function formatBaseline(baseline) {
  const lines = ['{', `  "_comment": ${JSON.stringify(baseline._comment)},`, '  "commands": {'];
  const entries = Object.entries(baseline.commands);
  entries.forEach(([k, v], i) => lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)}${i < entries.length - 1 ? ',' : ''}`));
  lines.push('  },', `  "todoMax": ${baseline.todoMax},`, '  "prefKeys": [');
  baseline.prefKeys.forEach((k, i) => lines.push(`    ${JSON.stringify(k)}${i < baseline.prefKeys.length - 1 ? ',' : ''}`));
  lines.push('  ]', '}', '');
  return lines.join('\n');
}

/** 基準を縮める。移行済み・消えたものを外し、todoMax を今の件数まで下げる。足すことはしない。 */
export function shrinkBaseline({ baseline, commands, registry, prefKeys }) {
  const legacy = registry.legacyCommands();
  const entries = Object.entries(baseline.commands).filter(([name]) => commands.has(name) && !legacy.has(name));
  const covered = new Set(registry.settings.flatMap((s) => s.prefKeys));
  return {
    ...baseline,
    commands: Object.fromEntries(entries),
    todoMax: Math.min(baseline.todoMax, entries.filter(([, k]) => k === 'todo').length),
    prefKeys: baseline.prefKeys.filter((k) => prefKeys.includes(k) && !covered.has(k)),
  };
}

async function main() {
  const { COMMANDS } = await import(pathToFileURL(path.join(ROOT, 'core', 'protocol.mjs')).href);
  const { registry } = await import(pathToFileURL(path.join(ROOT, 'core', 'ops', 'index.mjs')).href);
  const inputs = { baseline: readBaseline(), commands: COMMANDS, registry, prefKeys: scanPrefKeys() };
  if (process.argv.includes('--update-baseline')) {
    writeFileSync(BASELINE_FILE, formatBaseline(shrinkBaseline(inputs)));
    console.log('tests/ops-baseline.json を縮めた（足すことはしない）。');
    return;
  }
  const problems = checkCoverage(inputs);
  for (const p of problems) console.log(`NG ${p.rule}: ${p.message}`);
  if (problems.length) process.exit(1);
  console.log('OK');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
