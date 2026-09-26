// Pleiad の指示（設定 › コンテキストの「指示」のカード。docs/context-runtime.md「Pleiad の指示」、ADR 0026）。
// 指示ファイル・Skills・外部 MCP の担当（ADR 0014）によらず、ply_agents を持つ会話（Claude Code・Codex）へ毎ターン入れる。
// 入れる経路は ADR 0023 のまま: core/server.mjs の runTurn が ply_agents の instructions の後ろに足し、Claude は append、
// Codex は developerInstructions で受け取る。保存は prefs.json の plyInstructions（すべての場所に共通。場所ごとには持たない）。
//
// 項目は 3 種類:
//   - 既定（delegate: 委譲の進め方 / child: 委譲した会話では任せない）。Pleiad が最初から入れている。編集でき、編集していなければ
//     文面は辞書（agent:guide.*）から会話の言語で引く（Pleiad の更新で新しい文面になる）。編集したら保存した文のまま（「既定に戻す」で戻る）。
//   - 委譲と連動（route: 委譲の振り分けの使い方）。ply_delegate の約束なので編集・スイッチは無く、委譲先の自動選択が有効なときだけ入る。
//     並びはいつも最後。保存もしない。
//   - 自分で足したもの（u-…）。名前・本文・入れる会話（すべて／依頼元だけ／委譲された会話だけ）・エージェント（Claude Code・Codex）。
//
// 保存の形 { items: [{ id, on, name?, body?, target?, agents? }] }（並びが入る順）。既定の項目は編集したときだけ name などを持つ。
// plyInstructions が無い間は、前の版の addedContext（{ delegation: false } で委譲の指示を切っていた）から作る（既定の 2 項目のスイッチに写す）。
import crypto from 'node:crypto';
import { z } from 'zod';
import { agentT, t } from './i18n.mjs';
import { estimateTokens } from '../web/token-estimate.mjs';

export const TARGETS = ['all', 'parent', 'child'];
export const AGENTS = ['claude', 'codex'];
const BUILTIN = { delegate: { target: 'parent' }, child: { target: 'child' } };
const LINKED = 'route';
const MAX_ITEMS = 50, MAX_BODY = 32 * 1024, MAX_NAME = 80;

// i18n-dynamic: agent:guide.names.
const builtinName = (locale, id) => agentT(locale, `guide.names.${id}`);
function builtinBody(locale, id) {
  if (id === 'delegate') return [`- ${agentT(locale, 'guide.delegate')}`, `- ${agentT(locale, 'guide.main')}`].join('\n');
  if (id === 'child') return agentT(locale, 'guide.child');
  return `- ${agentT(locale, 'guide.route')}`;
}
const isBuiltin = id => Object.hasOwn(BUILTIN, id);
const edited = item => ['name', 'body', 'target', 'agents'].some(k => item[k] !== undefined);

const agentsSchema = z.array(z.enum(AGENTS)).min(1).max(AGENTS.length);
const storedSchema = z.object({
  id: z.string().regex(/^(?:delegate|child|u-[a-z0-9]{4,32})$/),
  on: z.boolean().optional(),
  name: z.string().trim().min(1).max(MAX_NAME).optional(),
  body: z.string().min(1).max(MAX_BODY).optional(),
  target: z.enum(TARGETS).optional(),
  agents: agentsSchema.optional(),
});

/** 既定の並び（前の版の委譲の指示のスイッチ on を既定の 2 項目に写す） */
const defaults = (on = true) => [{ id: 'delegate', on }, { id: 'child', on }];

/**
 * 保存された値（prefs.json の plyInstructions）を読む。壊れた項目は落とし、既定の項目が欠けていれば足す。
 * legacy は前の版の addedContext。plyInstructions が無いときだけ使う
 */
export function normalizePlyInstructions(raw, legacy = null) {
  if (!raw || !Array.isArray(raw.items)) return defaults(legacy?.delegation !== false);
  const out = [], seen = new Set();
  for (const value of raw.items.slice(0, MAX_ITEMS)) {
    const parsed = storedSchema.safeParse(value);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    const v = parsed.data;
    // 自分で足したものは全部の項目がそろっていること
    if (!isBuiltin(v.id) && (!v.name || !v.body || !v.target || !v.agents)) continue;
    seen.add(v.id);
    out.push({ ...v, on: v.on !== false });
  }
  for (const [i, item] of defaults().entries()) if (!seen.has(item.id)) out.splice(Math.min(i, out.length), 0, item);
  return out;
}

/** 画面と実行時に使う形。既定の項目は編集していなければ辞書の文（locale の言語）。委譲と連動の項目を最後に足す */
export function resolvePlyInstructions(list, locale) {
  const items = list.map(item => {
    if (!isBuiltin(item.id)) return { id: item.id, tag: null, modified: false, name: item.name, body: item.body, target: item.target, agents: [...item.agents], on: item.on };
    return { id: item.id, tag: 'default', modified: edited(item), name: item.name ?? builtinName(locale, item.id), body: item.body ?? builtinBody(locale, item.id),
      target: item.target ?? BUILTIN[item.id].target, agents: item.agents ? [...item.agents] : [...AGENTS], on: item.on };
  });
  items.push({ id: LINKED, tag: 'linked', modified: false, name: builtinName(locale, LINKED), body: builtinBody(locale, LINKED), target: 'parent', agents: [...AGENTS], on: true });
  return items;
}

/** 入れる文。見出し（名前）と本文 */
export const itemText = (locale, item) => `${agentT(locale, 'guide.heading', { name: item.name })}\n${item.body}`;

/**
 * このターンに入れる Pleiad の指示。ply_agents を持たないバックエンド（antigravity）では null（記録もしない）。
 * 項目ごとに { id, name, target, inserted, text? , reason? }。入れない理由:
 *   off（スイッチで切った）/ target（入れる会話が違う）/ agent（このエージェントは選んでいない）/
 *   readOnly（読み取り・計画モードの依頼元。ply_delegate を受け付けないので委譲の項目は入れない）/ routingOff（委譲先の自動選択が無効）
 * 子の会話は読み取りのモードでも「さらに委譲しない」を入れる（害が無く、委譲できないことと食い違わない）
 * agent は backend の種類（claude / codex）。それ以外（fake など）はどのエージェントの項目も入れる
 */
export function turnInstructions({ list, locale, child, routing, supported, canDelegate, agent = null }) {
  if (!supported) return null;
  return resolvePlyInstructions(list, locale).map(item => {
    const base = { id: item.id, name: item.name, target: item.target };
    const skip = reason => ({ ...base, inserted: false, reason });
    if (item.id === LINKED && !routing) return skip('routingOff');
    if (!item.on) return skip('off');
    if ((item.target === 'parent' && child) || (item.target === 'child' && !child)) return skip('target');
    if (agent && AGENTS.includes(agent) && !item.agents.includes(agent)) return skip('agent');
    if (!child && !canDelegate && (item.id === 'delegate' || item.id === LINKED)) return skip('readOnly');
    return { ...base, inserted: true, text: itemText(locale, item) };
  });
}

/** ply_agents の instructions の後ろに足す。入れないときは元のまま（同じバイト列にしてプロンプトのキャッシュを外さない） */
export function withAdded(instructions, items) {
  const texts = (items ?? []).map(i => i?.text).filter(Boolean);
  return texts.length ? [instructions, ...texts].filter(Boolean).join('\n\n') : instructions;
}

/** 見出しの型。名前の位置に NAME_SLOT を置く（画面のシートが、打っている名前で同じ数え方をするため） */
export const NAME_SLOT = '\u0001';
/**
 * 設定の画面に返す形（文は画面の言語）。tokens は項目ごと（見出しを含む。実際に入る文の長さ）、total は今入りうるもの
 * （スイッチが入っているもの。連動は振り分けが有効なとき）の合計。heading は見出しの型
 */
export function screenState(list, locale, { routing = true } = {}) {
  const items = resolvePlyInstructions(list, locale).map(item => ({ ...item, tokens: estimateTokens(itemText(locale, item)) }));
  const total = items.filter(i => i.on && (i.id !== LINKED || routing)).reduce((n, i) => n + i.tokens, 0);
  return { items, total, routing, heading: agentT(locale, 'guide.heading', { name: NAME_SLOT }) };
}

const saveSchema = z.object({
  action: z.literal('save'), id: z.string().optional(),
  name: z.string().trim().min(1).max(MAX_NAME), body: z.string().trim().min(1).max(MAX_BODY),
  target: z.enum(TARGETS), agents: agentsSchema,
}).strict();
const actionSchema = z.discriminatedUnion('action', [
  saveSchema,
  z.object({ action: z.literal('toggle'), id: z.string(), on: z.boolean() }).strict(),
  z.object({ action: z.literal('delete'), id: z.string() }).strict(),
  z.object({ action: z.literal('reset'), id: z.string() }).strict(),
  z.object({ action: z.literal('order'), ids: z.array(z.string()).max(MAX_ITEMS) }).strict(),
]);

/**
 * 1 つ変えた新しい並びを返す（元の list は変えない）。locale は既定の項目の編集を「既定と同じか」で比べる言語（画面の言語）。
 *   save   { id?, name, body, target, agents }  id が無ければ足す（連動の項目の前 = 最後）。既定の項目は既定と同じ値なら編集扱いにしない
 *   toggle { id, on } / delete { id }（自分で足したものだけ）/ reset { id }（既定の項目だけ）/ order { ids }（保存した項目の並べ替え）
 */
export function changePlyInstructions(list, args, locale) {
  const parsed = actionSchema.safeParse(args ?? {});
  if (!parsed.success) throw new Error(t('plyInstructions.invalid'));
  const a = parsed.data, next = list.map(item => ({ ...item }));
  const at = id => { const i = next.findIndex(item => item.id === id); if (i < 0) throw new Error(t('plyInstructions.notFound')); return i; };
  if (a.action === 'save') {
    const value = { name: a.name, body: a.body, target: a.target, agents: AGENTS.filter(x => a.agents.includes(x)) };
    if (!a.id) {
      if (next.length >= MAX_ITEMS) throw new Error(t('plyInstructions.tooMany', { count: MAX_ITEMS }));
      next.push({ id: `u-${crypto.randomBytes(6).toString('hex')}`, on: true, ...value });
    } else {
      const i = at(a.id), item = next[i];
      if (!isBuiltin(item.id)) next[i] = { ...item, ...value };
      else {
        const plain = { id: item.id, on: item.on };
        const same = value.name === builtinName(locale, item.id) && value.body === builtinBody(locale, item.id).trim()
          && value.target === BUILTIN[item.id].target && value.agents.length === AGENTS.length;
        next[i] = same ? plain : { ...plain, ...value };
      }
    }
  } else if (a.action === 'toggle') next[at(a.id)].on = a.on;
  else if (a.action === 'delete') {
    if (isBuiltin(a.id)) throw new Error(t('plyInstructions.builtinDelete'));
    next.splice(at(a.id), 1);
  } else if (a.action === 'reset') {
    if (!isBuiltin(a.id)) throw new Error(t('plyInstructions.notFound'));
    const i = at(a.id);
    next[i] = { id: next[i].id, on: next[i].on };
  } else {
    const ids = a.ids.filter(id => id !== LINKED);
    if (ids.length !== next.length || new Set(ids).size !== ids.length || ids.some(id => !next.some(item => item.id === id))) throw new Error(t('plyInstructions.invalid'));
    return ids.map(id => next.find(item => item.id === id));
  }
  return next;
}
