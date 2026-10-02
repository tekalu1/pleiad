// 操作の一覧の載せ忘れを落とす lint（tests/lint-ops.mjs。T1 WS のコマンドの網羅・T2 prefs のキーの網羅）と、その自己診断。
import { z } from 'zod';
import { COMMANDS } from '../../core/protocol.mjs';
import { registry } from '../../core/ops/index.mjs';
import { createRegistry, defineOp, defineSetting } from '../../core/ops/registry.mjs';
import { KINDS, checkCoverage, formatBaseline, readBaseline, scanPrefKeys, setPrefCaseKeys, shrinkBaseline } from '../lint-ops.mjs';

export const name = 'ops-coverage';
export const title = '操作の一覧の載せ忘れ: WS のコマンドと prefs のキーの網羅（ラチェット）';

const op = (id, legacyCommand) => defineOp({ id, summary: `agent:ops.${id}.summary`, risk: 'read', input: z.object({}), output: z.object({}), surfaces: { ui: true, mcp: false, cli: false }, legacyCommand, handler: () => ({}) });
const setting = (key, prefKeys) => defineSetting({ key, summary: `agent:settings.${key}`, risk: 'read', schema: z.string(), default: '', read: () => '', write: () => {}, ...(prefKeys ? { prefKeys } : {}) });
const rules = (problems) => problems.map((p) => p.rule).sort().join(',');

export default async function (t) {
  // ---- 実物: 今のリポジトリが基準を満たす
  const baseline = readBaseline();
  const prefKeys = scanPrefKeys();
  const problems = checkCoverage({ baseline, commands: COMMANDS, registry, prefKeys });
  t.ok('T1・T2 今の WS のコマンドと prefs のキーが、操作の一覧か除外表に載っている', problems.length === 0, problems.map((p) => `${p.rule}: ${p.message}`).join(' / '));
  t.ok('除外表の理由の種類が決められたものだけ', Object.values(baseline.commands).every((k) => KINDS.includes(k)));
  t.ok('invoke は gateway として載っている', baseline.commands.invoke === 'gateway');
  t.ok('human-only の除外表に承認モード・承認の応答・秘密・リモートのペアリングがある',
    ['setMode', 'resolvePermission', 'saveClaudeAccount', 'setDelegationRoutingKey', 'compatEndpointSave', 'remotePairingApprove'].every((n) => baseline.commands[n] === 'human-only'));
  t.ok('走査が既知の prefs のキーを拾う（走査の規則が壊れていない）',
    ['locale', 'linkOpen', 'computerUse', 'instructionBudget', 'autoCompaction', 'browserProfiles', 'confirmAgentSites', 'mode', 'model', 'backend'].every((k) => prefKeys.includes(k)), prefKeys.join(' '));
  t.ok('基準の書き出しを読み戻せる', JSON.stringify(JSON.parse(formatBaseline(baseline))) === JSON.stringify(baseline));

  // ---- 自己診断: 仮の基準と仮のレジストリで、落とすべきものを落とす
  const commands = new Set(['a', 'b', 'c']);
  const good = { _comment: '', commands: { a: 'todo', b: 'ui-internal', c: 'human-only' }, todoMax: 1, prefKeys: ['p'] };
  const empty = createRegistry();
  const check = (b, { cmds = commands, reg = empty, keys = ['p'] } = {}) => rules(checkCoverage({ baseline: b, commands: cmds, registry: reg, prefKeys: keys }));
  t.ok('自己診断: 揃っていれば通る', check(good) === '');
  t.ok('自己診断: 新しい WS のコマンドを載せ忘れると落ちる', check(good, { cmds: new Set([...commands, 'd']) }) === 'unlisted-command');
  t.ok('自己診断: 新しいコマンドを todo で足しても、todoMax が増えない限り通らない', check({ ...good, commands: { ...good.commands, d: 'todo' } }, { cmds: new Set([...commands, 'd']) }) === 'todo-grew');
  t.ok('自己診断: 操作へ移したコマンドが除外表に残っていると落ちる', check(good, { reg: createRegistry({ ops: [op('x.a', 'a')] }) }) === 'migrated-still-listed');
  t.ok('自己診断: 操作を定義したコマンドは除外表に無くてよい', check({ ...good, commands: { b: 'ui-internal', c: 'human-only' }, todoMax: 0 }, { reg: createRegistry({ ops: [op('x.a', 'a')] }) }) === '');
  t.ok('自己診断: COMMANDS に無い名前が除外表にあると落ちる', check({ ...good, commands: { ...good.commands, z: 'ui-internal' } }) === 'stale-command');
  t.ok('自己診断: todo が減ったら todoMax を下げさせる', check({ ...good, commands: { ...good.commands, a: 'stream' } }) === 'todo-shrank');
  t.ok('自己診断: 理由の種類が不正だと落ちる', check({ ...good, commands: { ...good.commands, b: 'misc' } }) === 'bad-kind');
  t.ok('自己診断: 設定の一覧にも基準にも無い prefs のキーで落ちる', check(good, { keys: ['p', 'q'] }) === 'unlisted-pref');
  t.ok('自己診断: 設定へ移した prefs のキーが基準に残っていると落ちる', check(good, { reg: createRegistry({ settings: [setting('p')] }) }) === 'migrated-pref-still-listed');
  t.ok('自己診断: 設定の prefKeys で覆える', check({ ...good, prefKeys: [] }, { reg: createRegistry({ settings: [setting('compaction.auto', ['p'])] }) }) === '');
  t.ok('自己診断: prefs に書かれなくなったキーが基準に残っていると落ちる', check(good, { keys: [] }) === 'stale-pref');

  const shrunk = shrinkBaseline({ baseline: { ...good, commands: { ...good.commands, z: 'todo' }, todoMax: 2 }, commands, registry: createRegistry({ ops: [op('x.a', 'a')], settings: [setting('p')] }), prefKeys: ['p'] });
  t.ok('自己診断: --update-baseline は縮めるだけ（移行済み・消えたものを外し、todoMax を下げる）',
    JSON.stringify(shrunk.commands) === JSON.stringify({ b: 'ui-internal', c: 'human-only' }) && shrunk.todoMax === 0 && shrunk.prefKeys.length === 0, JSON.stringify(shrunk));
  const grown = shrinkBaseline({ baseline: good, commands: new Set([...commands, 'd']), registry: empty, prefKeys: ['p', 'q'] });
  t.ok('自己診断: --update-baseline は足さない', !('d' in grown.commands) && !grown.prefKeys.includes('q') && grown.todoMax === 1);

  const sample = `switch (c) {\n case "setPref": {\n if (key === "locale") {}\n if (['x1', "x2"].includes(key)) {}\n if (key !== "mode" && key !== 'model') {}\n }\n case "renameStatus": { if (key === 'nope') {} }\n}`;
  t.ok('自己診断: setPref の case の中だけから key のリテラルを拾う', [...setPrefCaseKeys(sample)].sort().join(',') === 'locale,mode,model,x1,x2', [...setPrefCaseKeys(sample)].join(','));
}
