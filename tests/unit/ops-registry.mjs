// 操作の一覧（core/ops/registry.mjs）の仕組み: 定義の検査・関所（invoke）の順序・権限の配線・伏せ字・JSON Schema。
// 実際の操作の一覧の中身（snapshot・辞書・主体ごとの見え方）は ops-surface.mjs。
import { z } from 'zod';
import { createRegistry, defineOp, defineSetting, inputJsonSchema, maskOutput, OpError, MASK } from '../../core/ops/registry.mjs';
import { backend as claude } from '../../core/backends/claude.mjs';
import { backend as codex } from '../../core/backends/codex.mjs';

export const name = 'ops-registry';
export const title = '操作の一覧: 定義の検査・関所の順序・権限の配線・伏せ字';

const base = (id, extra = {}) => ({
  id, summary: `agent:ops.${id}.summary`, risk: 'read', input: z.object({}), output: z.object({}),
  surfaces: { ui: true, mcp: 'catalog', cli: true }, handler: () => ({}), ...extra,
});
const throws = (fn) => { try { fn(); return null; } catch (e) { return String(e.message); } };

export default async function (t) {
  // ---- defineOp の検査
  t.ok('正しい定義は通り、input は strict になる', (() => { const op = defineOp(base('t.ok')); return op.kind === 'op' && op.scope === 'global' && op.modeGate === true && op.input.safeParse({ x: 1 }).success === false; })());
  const bad = [
    ['id が <領域>.<動詞> でない', base('nodot')],
    ['summary のキーが id と合わない', base('t.a', { summary: 'agent:ops.t.b.summary' })],
    ['秘密の出力をAIに公開できない', base('t.a', { humanSecretOutput: true })],
    ['risk が不正', base('t.a', { risk: 'admin' })],
    ['input が z.object でない', base('t.a', { input: z.string() })],
    ['read に output が無い', base('t.a', { output: undefined })],
    ['write に riskReason が無い', base('t.a', { risk: 'write', riskReason: ' ' })],
    ['guarded に confirm が無い', base('t.a', { risk: 'guarded' })],
    ['riskOf があるのに confirm が無い', base('t.a', { risk: 'write', riskReason: 'x', riskOf: () => 'guarded' })],
    ['handler が無い', base('t.a', { handler: undefined })],
    ['surfaces.ui が無い', base('t.a', { surfaces: { mcp: false, cli: false } })],
    ['surfaces.mcp が不正', base('t.a', { surfaces: { ui: true, mcp: 'yes', cli: false } })],
    ['human-only を MCP に出す', base('t.a', { risk: 'human-only', surfaces: { ui: true, mcp: 'catalog', cli: false } })],
    ['human-only を CLI に出す', base('t.a', { risk: 'human-only', surfaces: { ui: true, mcp: false, cli: true } })],
    ['scope が不正', base('t.a', { scope: 'all' })],
  ];
  for (const [label, def] of bad) t.ok(`defineOp は断る: ${label}`, throws(() => defineOp(def)) !== null);
  t.ok('human-only は画面だけなら定義できる', throws(() => defineOp(base('t.h', { risk: 'human-only', surfaces: { ui: true, mcp: false, cli: false } }))) === null);

  // ---- defineSetting の検査
  const setting = (key, extra = {}) => ({ key, summary: `agent:settings.${key}`, risk: 'read', schema: z.string(), default: '', read: () => '', write: () => {}, ...extra });
  t.ok('defineSetting: 正しい定義は通り、prefKeys の既定は key', defineSetting(setting('linkOpen')).prefKeys[0] === 'linkOpen');
  t.ok('defineSetting: prefKeys を [] にできる（prefs 以外に保存するもの）', defineSetting(setting('hooks.owner', { prefKeys: [] })).prefKeys.length === 0);
  for (const [label, def] of [
    ['key が不正', setting('Bad-Key')], ['summary が合わない', setting('a', { summary: 'agent:settings.b' })], ['schema が無い', setting('a', { schema: null })],
    ['default が無い', (() => { const s = setting('a'); delete s.default; return s; })()], ['write に riskReason が無い', setting('a', { risk: 'write' })],
  ]) t.ok(`defineSetting は断る: ${label}`, throws(() => defineSetting(def)) !== null);

  // ---- レジストリの集め方
  const noop = defineOp(base('t.noop'));
  t.ok('同じ id は断る', throws(() => createRegistry({ ops: [noop, noop] })) !== null);
  t.ok('同じ legacyCommand は断る', throws(() => createRegistry({ ops: [defineOp(base('t.a', { legacyCommand: 'x' })), defineOp(base('t.b', { legacyCommand: 'x' }))] })) !== null);
  t.ok('defineOp を通していないものは断る', throws(() => createRegistry({ ops: [{ id: 'x.y' }] })) !== null);

  // ---- 関所
  const calls = [];
  const ops = [
    defineOp(base('t.read', { output: z.object({ n: z.number() }), input: z.object({ n: z.number().int().describe('agent:ops.errors.NOT_FOUND') }), handler: (ctx, { n }) => { calls.push(ctx.actor); return { n }; } })),
    defineOp(base('t.write', { risk: 'write', riskReason: '題の変更は履歴に残り、いつでも戻せる', handler: () => ({ done: true }) })),
    defineOp(base('t.guarded', { risk: 'guarded', confirm: () => 'x', handler: () => ({ done: true }) })),
    defineOp(base('t.secret', { risk: 'human-only', surfaces: { ui: true, mcp: false, cli: false }, handler: () => ({ done: true }) })),
    defineOp(base('t.screen', { hostScreenOnly: true, handler: () => ({ opened: true }) })),
    defineOp(base('t.ui', { surfaces: { ui: true, mcp: false, cli: false }, handler: () => ({}) })),
    defineOp(base('t.cliOnly', { surfaces: { ui: false, mcp: false, cli: true }, handler: () => ({}) })),
    defineOp(base('t.raise', { risk: 'write', riskReason: '狭める向きは write', input: z.object({ widen: z.boolean() }), confirm: () => 'x', riskOf: (ctx, { widen }) => (widen ? 'guarded' : 'write'), handler: () => ({ done: true }) })),
    defineOp(base('t.lower', { risk: 'guarded', confirm: () => 'x', riskOf: () => 'read', handler: () => ({ done: true }) })),
    defineOp(base('t.fail', { handler: () => { throw new OpError('GONE', 'もう無い'); } })),
    defineOp(base('t.boom', { handler: () => { throw new Error('想定外'); } })),
    defineOp(base('t.mask', { output: z.object({}), handler: () => ({ name: 'x', token: 'tok-123', hasToken: true, nested: [{ apiKey: 'k', authorization: '' }] }) })),
  ];
  const reg = createRegistry({ ops });
  const human = { by: 'human', via: 'ui', local: true };
  const remote = { by: 'human', via: 'ui', local: false };
  const mcp = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
  const MODES = { bypass: claude.modes().bypass, plan: claude.modes().plan, ask: claude.modes().default, codexFull: codex.modes().full };
  const modeOf = async (sessionId) => MODES[sessionId];
  const audits = [];
  const deps = { locale: 'ja', modeOf, audit: (e) => audits.push(e) };
  const run = (p, id, args) => reg.invoke(p, id, args, deps);

  const r1 = await run(human, 't.read', { n: 3 });
  t.ok('human の read は通り、actor が handler へ渡る', r1.ok && r1.result.n === 3 && calls[0].by === 'human' && calls[0].via === 'ui' && !('sessionId' in calls[0]));
  t.ok('read は audit に残さない', audits.length === 0);

  const unknown = await run(human, 't.nothing', {});
  t.ok('無い操作は NOT_FOUND', !unknown.ok && unknown.code === 'NOT_FOUND');
  const hid = await run(mcp('bypass'), 't.secret', {});
  t.ok('human-only を agent が呼ぶと、無い操作と同じ NOT_FOUND（在ることを明かさない）', !hid.ok && hid.code === 'NOT_FOUND' && hid.error.replace('t.secret', 'X') === unknown.error.replace('t.nothing', 'X'));
  t.ok('human は human-only を呼べる', (await run(human, 't.secret', {})).ok);
  t.ok('MCP に出していない操作は agent から NOT_FOUND', (await run(mcp('bypass'), 't.ui', {})).code === 'NOT_FOUND');
  t.ok('CLI だけの操作は画面と MCP から NOT_FOUND', (await run(human, 't.cliOnly', {})).code === 'NOT_FOUND' && (await run(mcp('bypass'), 't.cliOnly', {})).code === 'NOT_FOUND');
  t.ok('CLI から CLI だけの操作を呼べる', (await run({ by: 'agent', via: 'cli' }, 't.cliOnly', {})).ok);
  t.ok('id が文字列でないと NOT_FOUND（落ちない）', (await run(human, undefined, {})).code === 'NOT_FOUND' && (await run(human, { a: 1 }, {})).code === 'NOT_FOUND');

  t.ok('hostScreenOnly は local の人間だけ', (await run(human, 't.screen', {})).ok
    && (await run(remote, 't.screen', {})).code === 'HOST_SCREEN_ONLY'
    && (await run(mcp('bypass'), 't.screen', {})).code === 'HOST_SCREEN_ONLY');

  const inv = await run(human, 't.read', { n: 1.5, extra: 1 });
  t.ok('INVALID は issues（path・code・message）を返す', !inv.ok && inv.code === 'INVALID' && inv.issues.length >= 2 && inv.issues.every((i) => 'path' in i && i.code && i.message), JSON.stringify(inv.issues));
  t.ok('未知のキーも INVALID（strict）', inv.issues.some((i) => i.code === 'unrecognized_keys'));
  t.ok('INVALID は権限より先（中身を検査してから判定する）', (await run(mcp(undefined), 't.guarded', { x: 1 })).code === 'INVALID');
  t.ok('args が無くても {} として検査する', (await run(human, 't.write', undefined)).ok);

  // 権限の配線
  t.ok('agent（会話あり・plan）の write は READ_ONLY_MODE', (await run(mcp('plan'), 't.write', {})).code === 'READ_ONLY_MODE');
  t.ok('agent（会話あり・ask）の write は通る', (await run(mcp('ask'), 't.write', {})).ok);
  t.ok('agent（会話なし）の write は通る', (await run({ by: 'agent', via: 'cli' }, 't.write', {})).ok);
  const ng = await run({ by: 'agent', via: 'cli' }, 't.guarded', {});
  t.ok('agent（会話なし）の guarded は NEEDS_UI（decision: deny）', !ng.ok && ng.code === 'NEEDS_UI' && ng.decision === 'deny');
  t.ok('mcp-stdio も会話なしとして NEEDS_UI', (await run({ by: 'agent', via: 'mcp-stdio' }, 't.guarded', {})).code === 'NEEDS_UI');
  const needs = await run(mcp('ask'), 't.guarded', {});
  t.ok('agent（ask の会話）の guarded は NEEDS_APPROVAL（decision: ask。承認カードは段階 2）', !needs.ok && needs.code === 'NEEDS_APPROVAL' && needs.decision === 'ask');
  t.ok('agent（Codex の full＝sandbox で閉じた never）の guarded も NEEDS_APPROVAL', (await run(mcp('codexFull'), 't.guarded', {})).code === 'NEEDS_APPROVAL');
  t.ok('agent（plan）の guarded は READ_ONLY_MODE', (await run(mcp('plan'), 't.guarded', {})).code === 'READ_ONLY_MODE');
  audits.length = 0;
  const through = await run(mcp('bypass'), 't.guarded', {});
  t.ok('agent（bypass の会話）の guarded は通り、記録が残る', through.ok && through.decision === 'allow'
    && audits.length === 1 && audits[0].op === 't.guarded' && audits[0].risk === 'guarded' && audits[0].reason === 'mode-never-full'
    && audits[0].actor.by === 'agent' && audits[0].actor.via === 'mcp' && audits[0].actor.sessionId === 'bypass', JSON.stringify(audits));
  t.ok('記録に引数を入れない（秘密が混ざりうる）', !('args' in audits[0]));
  t.ok('human の write も audit に渡る', (await run(human, 't.write', {})).ok && audits.at(-1).op === 't.write' && audits.at(-1).actor.by === 'human');

  // riskOf は上げるだけ
  t.ok('riskOf が上げた操作は、広げる向きだけ guarded として扱う', (await run(mcp('ask'), 't.raise', { widen: true })).code === 'NEEDS_APPROVAL' && (await run(mcp('ask'), 't.raise', { widen: false })).ok);
  t.ok('riskOf が guarded から read へ下げても guarded のまま', (await run({ by: 'agent', via: 'cli' }, 't.lower', {})).code === 'NEEDS_UI');
  let invalidRisk = null;
  try { await createRegistry({ ops: [defineOp(base('t.bogus', { risk: 'write', riskReason: 'x', confirm: () => 'x', riskOf: () => 'admin', handler: () => ({}) }))] }).invoke(human, 't.bogus', {}, deps); } catch (e) { invalidRisk = e; }
  t.ok('riskOf の戻りが不正なら投げる（黙って通さない）', invalidRisk !== null);

  // audit が落ちたら実行しない
  let ran = false;
  const guardReg = createRegistry({ ops: [defineOp(base('t.w', { risk: 'write', riskReason: 'x', handler: () => { ran = true; return {}; } }))] });
  let audited = null;
  try { await guardReg.invoke(human, 't.w', {}, { audit: () => { throw new Error('disk full'); } }); } catch (e) { audited = e; }
  t.ok('記録に失敗したら handler を実行しない（閉じる側に倒す）', audited?.message === 'disk full' && !ran);

  // 失敗の形
  const f = await run(human, 't.fail', {});
  t.ok('handler の OpError は code 付きの失敗になる', !f.ok && f.code === 'GONE' && f.error === 'もう無い');
  let boom = null;
  try { await run(human, 't.boom', {}); } catch (e) { boom = e; }
  t.ok('想定外の例外はそのまま投げる（握りつぶさない）', boom?.message === '想定外');
  t.ok('失敗の文は locale の言語', (await reg.invoke(human, 't.zzz', {}, { locale: 'en' })).error.includes('No such operation') && (await reg.invoke(human, 't.zzz', {}, { locale: 'ja' })).error.includes('ありません'));

  // 伏せ字
  const m = (await run(human, 't.mask', {})).result;
  t.ok('秘密らしい名前の欄の文字列を伏せる（入れ子・配列も）', m.token === MASK && m.nested[0].apiKey === MASK, JSON.stringify(m));
  t.ok('真偽・空の文字列・普通の欄は残す', m.hasToken === true && m.nested[0].authorization === '' && m.name === 'x');
  t.ok('maskOutput は null・数・配列を壊さない', maskOutput(null) === null && maskOutput(5) === 5 && JSON.stringify(maskOutput([1, { tokens: 3 }])) === '[1,{"tokens":3}]');

  // 一覧
  const ids = (p) => reg.list(p).map((o) => o.id).sort();
  t.ok('list: human は画面に出す操作（human-only も）', ids(human).includes('t.secret') && ids(human).includes('t.ui') && !ids(human).includes('t.cliOnly'));
  t.ok('list: MCP の agent は human-only と MCP に出さないものを見ない', !ids(mcp('bypass')).includes('t.secret') && !ids(mcp('bypass')).includes('t.ui') && ids(mcp('bypass')).includes('t.guarded'));
  t.ok('list: CLI の agent は CLI に出すものだけ', ids({ by: 'agent', via: 'cli' }).includes('t.cliOnly') && !ids({ by: 'agent', via: 'cli' }).includes('t.ui'));

  // JSON Schema と説明の言語
  const schema = inputJsonSchema(reg.get('t.read'));
  t.ok('input は JSON Schema になり、additionalProperties: false', schema.type === 'object' && schema.additionalProperties === false && schema.properties.n.type === 'integer');
  t.ok('説明は辞書キーのまま取れる', schema.properties.n.description === 'agent:ops.errors.NOT_FOUND');
  t.ok('locale を渡すと説明を言語で引く', inputJsonSchema(reg.get('t.read'), 'en').properties.n.description.includes('No such operation') && inputJsonSchema(reg.get('t.read'), 'ja').properties.n.description.includes('ありません'));
  t.ok('変換できない入力は投げる', throws(() => inputJsonSchema(defineOp(base('t.date', { input: z.object({ at: z.date() }) })))) !== null);
}
