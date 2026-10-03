#!/usr/bin/env node
/* ==================== 操作の一覧の載せ忘れの lint ====================
   操作の一覧（core/ops/）に載せ忘れた機能を落とす（docs/design.md「操作の一覧」、ADR 0080）。i18n の lint と同じ「下がる一方の基準（ラチェット）」の形。

     node tests/lint-ops.mjs [--update-baseline]

   検査すること（基準は tests/ops-baseline.json）:
   1. WS のコマンドの網羅。core/protocol.mjs の COMMANDS の各名前は、(a) どれかの操作の legacyCommand か、
      (b) 基準の commands に「理由の種類」付きで載っている。
        ui-internal       画面の内部（下書き・既読・watch・ピッカー）。外へ出す意味が無い
        stream            断片の送信・screencast。1 回の呼び出しで済まない
        human-only        core/ops/policy.mjs の HUMAN_ONLY の 5 つ（承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリング）だけ。agent には出さない（ADR 0094）
        host-screen-only  サーバーのある PC の画面からだけ（OS で開く。ADR 0010）
        gateway           操作の一覧への入口そのもの（invoke）
        todo              未移行。操作として定義する候補。**件数（todoMax）は増やせない**
      操作へ移したコマンドが基準に残っていたら失敗（消す）。COMMANDS に無い名前が基準にあっても失敗。
      todo の件数が todoMax より減ったら「todoMax を下げてください」で失敗（--update-baseline で下げる）。基準は下がる一方にする。
   2. 設定の網羅。prefs.json に書くキー（savePref・setPref の呼び出しのリテラル）は、設定の一覧（defineSetting の key または prefKeys）にある。
      画面の WS コマンド setPref は設定の一覧から作る（settings.set の legacyCommand）ので、キーの一覧を手で持たない。
   3. store.setPref を一覧の外から呼んでいない。prefs.json へ書く出口は core/server.mjs の savePref（設定の一覧の writes と、既定の記憶だけが通る）に
      絞り、それ以外の store.setPref( の呼び出しは、同じ行に `ops-allow-setpref: 理由` の印を付けたものだけ。印の数（setPrefAllowed）は増やせない。
   4. human-only は 5 つに限る（ADR 0094）。基準の human-only・操作の risk: human-only（検査用の probe.* を除く）・設定の risk: human-only は、
      core/ops/policy.mjs の HUMAN_ONLY にあるものだけ。逆に HUMAN_ONLY にあるものは human-only のまま（todo や write にしない）。
   5. 自己診断（npm test でも回す）。 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HUMAN_ONLY_COMMANDS, HUMAN_ONLY_SETTINGS } from '../core/ops/policy.mjs';

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

/** core/ の中で prefs.json に書いているキー。savePref('x'・setPref('x' のリテラル。 */
export function scanPrefKeys(root = ROOT) {
  const keys = new Set();
  for (const file of walk(path.join(root, 'core'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\b(?:savePref|setPref)\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]/g)) keys.add(m[1]);
  }
  return [...keys].sort();
}

/** core/ の中の `store.setPref(` の呼び出し。印（ops-allow-setpref）が同じ行にあるものは allowed */
export function scanSetPrefCalls(root = ROOT) {
  const calls = [];
  for (const file of walk(path.join(root, 'core'))) {
    readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/\bstore\.setPref\(/.test(line)) calls.push({ file: path.relative(root, file).replace(/\\/g, '/'), line: i + 1, allowed: line.includes('ops-allow-setpref') });
    });
  }
  return calls;
}

/* ==================== 検査 ==================== */

/**
 * @param baseline  tests/ops-baseline.json の中身
 * @param commands  COMMANDS（Set）
 * @param registry  操作の一覧（createRegistry の結果）
 * @param prefKeys  scanPrefKeys() の結果
 * @param setPrefCalls scanSetPrefCalls() の結果
 * @param humanOnly  human-only にしてよいもの { commands, settings }（既定は core/ops/policy.mjs の HUMAN_ONLY）
 */
export function checkCoverage({ baseline, commands, registry, prefKeys, setPrefCalls = [], humanOnly = { commands: HUMAN_ONLY_COMMANDS, settings: HUMAN_ONLY_SETTINGS } }) {
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
  for (const key of prefKeys) {
    if (!covered.has(key)) add('unlisted-pref', `prefs.json に書くキー ${key} が設定の一覧にない。そのモジュールに defineSetting を書く（除外はできない）`);
  }

  for (const c of setPrefCalls.filter((x) => !x.allowed)) add('setpref-outside', `${c.file}:${c.line} が store.setPref を直に呼んでいる。prefs への書き込みは savePref（core/server.mjs）を通し、設定の変更は設定の一覧（core/ops/settings.mjs の write）に書く`);
  const allowed = setPrefCalls.filter((x) => x.allowed).length;
  if (allowed > baseline.setPrefAllowed) add('setpref-allowed-grew', `ops-allow-setpref の印が ${allowed} か所で、上限 ${baseline.setPrefAllowed} を超えた。増やさず savePref を通す`);
  if (allowed < baseline.setPrefAllowed) add('setpref-allowed-shrank', `ops-allow-setpref の印が ${allowed} か所に減った。setPrefAllowed を ${allowed} に下げる（node tests/lint-ops.mjs --update-baseline）`);

  // human-only は 5 つに限る（ADR 0094）
  const outside = (what) => `${what} は human-only の 5 つ（core/ops/policy.mjs の HUMAN_ONLY）に当たらない。agent も使える操作として定義する（危険度は read・write・guarded から選ぶ）`;
  for (const [name, kind] of Object.entries(listed)) if (kind === 'human-only' && !legacy.has(name) && !humanOnly.commands.has(name)) add('human-only-outside', outside(`除外表の ${name}`));
  for (const op of registry.ops) {
    if (op.risk === 'human-only' && !op.id.startsWith('probe.') && !humanOnly.commands.has(op.legacyCommand)) add('human-only-outside', outside(`操作 ${op.id}`));
    if (op.legacyCommand && humanOnly.commands.has(op.legacyCommand) && op.risk !== 'human-only') add('human-only-missing', `操作 ${op.id}（${op.legacyCommand}）は human-only の 5 つに当たる。risk を human-only にする`);
  }
  for (const s of registry.settings) {
    if (s.risk === 'human-only' && !humanOnly.settings.has(s.key)) add('human-only-outside', outside(`設定 ${s.key}`));
    if (humanOnly.settings.has(s.key) && s.risk !== 'human-only') add('human-only-missing', `設定 ${s.key} は human-only の 5 つに当たる。risk を human-only にする`);
  }
  for (const name of humanOnly.commands) {
    if (commands.has(name) && !legacy.has(name) && listed[name] !== undefined && listed[name] !== 'human-only') add('human-only-missing', `${name} は human-only の 5 つに当たる。tests/ops-baseline.json で human-only にする（今は ${listed[name]}）`);
  }
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
  lines.push('  },', `  "todoMax": ${baseline.todoMax},`, `  "setPrefAllowed": ${baseline.setPrefAllowed}`, '}', '');
  return lines.join('\n');
}

/** 基準を縮める。移行済み・消えたものを外し、todoMax を今の件数まで下げる。足すことはしない。 */
export function shrinkBaseline({ baseline, commands, registry, setPrefCalls = [] }) {
  const legacy = registry.legacyCommands();
  const entries = Object.entries(baseline.commands).filter(([name]) => commands.has(name) && !legacy.has(name));
  return {
    ...baseline,
    commands: Object.fromEntries(entries),
    todoMax: Math.min(baseline.todoMax, entries.filter(([, k]) => k === 'todo').length),
    setPrefAllowed: Math.min(baseline.setPrefAllowed, setPrefCalls.filter((x) => x.allowed).length),
  };
}

async function main() {
  const { COMMANDS } = await import(pathToFileURL(path.join(ROOT, 'core', 'protocol.mjs')).href);
  const { registry } = await import(pathToFileURL(path.join(ROOT, 'core', 'ops', 'index.mjs')).href);
  const inputs = { baseline: readBaseline(), commands: COMMANDS, registry, prefKeys: scanPrefKeys(), setPrefCalls: scanSetPrefCalls() };
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
