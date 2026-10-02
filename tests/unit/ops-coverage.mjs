// 操作の一覧の載せ忘れを落とす lint（tests/lint-ops.mjs。T1 WS のコマンドの網羅・T2 prefs のキーの網羅）と、その自己診断。
import { z } from 'zod';
import { COMMANDS } from '../../core/protocol.mjs';
import { registry } from '../../core/ops/index.mjs';
import { createRegistry, defineOp, defineSetting } from '../../core/ops/registry.mjs';
import { KINDS, checkCoverage, formatBaseline, readBaseline, scanPrefKeys, scanSetPrefCalls, shrinkBaseline } from '../lint-ops.mjs';

export const name = 'ops-coverage';
export const title = '操作の一覧の載せ忘れ: WS のコマンド・prefs のキーの網羅と、store.setPref を一覧の外から呼んでいないこと（ラチェット）';

const op = (id, legacyCommand) => defineOp({ id, summary: `agent:ops.${id}.summary`, risk: 'read', input: z.object({}), output: z.object({}), surfaces: { ui: true, mcp: false, cli: false }, legacyCommand, handler: () => ({}) });
const setting = (key, prefKeys) => defineSetting({ key, summary: `agent:settings.${key}`, risk: 'read', schema: z.string(), default: '', read: () => '', write: () => {}, ...(prefKeys ? { prefKeys } : {}) });
const rules = (problems) => problems.map((p) => p.rule).sort().join(',');

export default async function (t) {
  // ---- 実物: 今のリポジトリが基準を満たす
  const baseline = readBaseline();
  const prefKeys = scanPrefKeys();
  const setPrefCalls = scanSetPrefCalls();
  const problems = checkCoverage({ baseline, commands: COMMANDS, registry, prefKeys, setPrefCalls });
  t.ok('T1・T2 今の WS のコマンドが操作の一覧か除外表に載り、prefs のキーが設定の一覧にあり、store.setPref を一覧の外から呼んでいない', problems.length === 0, problems.map((p) => `${p.rule}: ${p.message}`).join(' / '));
  t.ok('prefs の全キーが設定の一覧にあり、基準に未移行のキーの欄が無い（0 件）', prefKeys.every((k) => registry.settings.some((x) => x.prefKeys.includes(k))) && !('prefKeys' in baseline), prefKeys.join(' '));
  t.ok('setPref の WS コマンドは settings.set の legacyCommand（設定の一覧から作る）で、除外表に無い', registry.get('settings.set')?.legacyCommand === 'setPref' && !('setPref' in baseline.commands));
  t.ok('store.setPref を直に呼ぶ箇所はすべて印（ops-allow-setpref）つきで、savePref の出口が 1 つある', setPrefCalls.length > 0 && setPrefCalls.every((c) => c.allowed)
    && setPrefCalls.some((c) => c.file === 'core/server.mjs' && c.allowed), JSON.stringify(setPrefCalls));
  t.ok('設定の一覧の書ける設定は、読むだけにしたものを除いて全部（addedContext は前の版の名残で読むだけ）', registry.settings.filter((x) => x.readOnly).map((x) => x.key).join(',') === 'addedContext');
  t.ok('除外表の理由の種類が決められたものだけ', Object.values(baseline.commands).every((k) => KINDS.includes(k)));
  t.ok('invoke は gateway として載っている', baseline.commands.invoke === 'gateway');
  t.ok('human-only の除外表に承認モード・承認の応答・秘密・リモートのペアリングがある',
    ['setMode', 'resolvePermission', 'saveClaudeAccount', 'setDelegationRoutingKey', 'compatEndpointSave', 'remotePairingApprove'].every((n) => baseline.commands[n] === 'human-only'));
  t.ok('走査が既知の prefs のキーを拾う（走査の規則が壊れていない）',
    ['computerUse', 'autoCompaction', 'delegationRouting', 'plyInstructions', 'claudeAccount', 'mode', 'model', 'backend'].every((k) => prefKeys.includes(k)), prefKeys.join(' '));
  t.ok('基準の書き出しを読み戻せる', JSON.stringify(JSON.parse(formatBaseline(baseline))) === JSON.stringify(baseline));

  // ---- 自己診断: 仮の基準と仮のレジストリで、落とすべきものを落とす
  const commands = new Set(['a', 'b', 'c']);
  const good = { _comment: '', commands: { a: 'todo', b: 'ui-internal', c: 'human-only' }, todoMax: 1, setPrefAllowed: 1 };
  const call = (allowed, file = 'core/x.mjs') => ({ file, line: 1, allowed });
  const empty = createRegistry();
  const check = (b, { cmds = commands, reg = empty, keys = [], calls = [call(true)] } = {}) => rules(checkCoverage({ baseline: b, commands: cmds, registry: reg, prefKeys: keys, setPrefCalls: calls }));
  t.ok('自己診断: 揃っていれば通る', check(good) === '');
  t.ok('自己診断: 新しい WS のコマンドを載せ忘れると落ちる', check(good, { cmds: new Set([...commands, 'd']) }) === 'unlisted-command');
  t.ok('自己診断: 新しいコマンドを todo で足しても、todoMax が増えない限り通らない', check({ ...good, commands: { ...good.commands, d: 'todo' } }, { cmds: new Set([...commands, 'd']) }) === 'todo-grew');
  t.ok('自己診断: 操作へ移したコマンドが除外表に残っていると落ちる', check(good, { reg: createRegistry({ ops: [op('x.a', 'a')] }) }) === 'migrated-still-listed');
  t.ok('自己診断: 操作を定義したコマンドは除外表に無くてよい', check({ ...good, commands: { b: 'ui-internal', c: 'human-only' }, todoMax: 0 }, { reg: createRegistry({ ops: [op('x.a', 'a')] }) }) === '');
  t.ok('自己診断: COMMANDS に無い名前が除外表にあると落ちる', check({ ...good, commands: { ...good.commands, z: 'ui-internal' } }) === 'stale-command');
  t.ok('自己診断: todo が減ったら todoMax を下げさせる', check({ ...good, commands: { ...good.commands, a: 'stream' } }) === 'todo-shrank');
  t.ok('自己診断: 理由の種類が不正だと落ちる', check({ ...good, commands: { ...good.commands, b: 'misc' } }) === 'bad-kind');
  t.ok('自己診断: 設定の一覧に無い prefs のキーで落ちる', check(good, { keys: ['p', 'q'], reg: createRegistry({ settings: [setting('p')] }) }) === 'unlisted-pref');
  t.ok('自己診断: 設定の key で覆える', check(good, { keys: ['p'], reg: createRegistry({ settings: [setting('p')] }) }) === '');
  t.ok('自己診断: 設定の prefKeys で覆える', check(good, { keys: ['p'], reg: createRegistry({ settings: [setting('compaction.auto', ['p'])] }) }) === '');
  t.ok('自己診断: store.setPref を印なしで呼ぶと落ちる', check(good, { calls: [call(true), call(false, 'core/y.mjs')] }) === 'setpref-outside');
  t.ok('自己診断: 印の数が上限を超えると落ちる', check(good, { calls: [call(true), call(true)] }) === 'setpref-allowed-grew');
  t.ok('自己診断: 印が減ったら上限を下げさせる', check(good, { calls: [] }) === 'setpref-allowed-shrank');

  const shrunk = shrinkBaseline({ baseline: { ...good, commands: { ...good.commands, z: 'todo' }, todoMax: 2, setPrefAllowed: 3 }, commands, registry: createRegistry({ ops: [op('x.a', 'a')] }), setPrefCalls: [call(true)] });
  t.ok('自己診断: --update-baseline は縮めるだけ（移行済み・消えたものを外し、todoMax と setPrefAllowed を下げる）',
    JSON.stringify(shrunk.commands) === JSON.stringify({ b: 'ui-internal', c: 'human-only' }) && shrunk.todoMax === 0 && shrunk.setPrefAllowed === 1, JSON.stringify(shrunk));
  const grown = shrinkBaseline({ baseline: good, commands: new Set([...commands, 'd']), registry: empty, setPrefCalls: [call(true), call(true), call(true)] });
  t.ok('自己診断: --update-baseline は足さない', !('d' in grown.commands) && grown.todoMax === 1 && grown.setPrefAllowed === 1);
}
