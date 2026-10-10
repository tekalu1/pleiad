// ply_computer のツールの定義（docs/computer-use.md「ツール（第 1 段階）」）。
// 形は Claude Desktop（Windows）と API の computer_toolset_20260801 のメンバー名・引数にそろえる。説明は会話の言語（agent 名前空間）。
import { agentT } from '../i18n.mjs';

const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const pair = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const DIRECTIONS = ['up', 'down', 'left', 'right'];

/** 引数（title は含まない）。required は title のほかに必須のもの */
const SPECS = {
  request_access: { props: { apps: { type: 'array', items: str, minItems: 1 }, reason: str }, required: ['apps', 'reason'] },
  list_granted_applications: { props: {}, required: [] },
  screenshot: { props: { display: { ...int, minimum: 1 } }, required: [] },
  zoom: { props: { region: { type: 'array', items: num, minItems: 4, maxItems: 4 }, scale: { ...num, exclusiveMinimum: 0, maximum: 1 } }, required: ['region'] },
  switch_display: { props: { display: { ...int, minimum: 1 } }, required: ['display'] },
  cursor_position: { props: {}, required: [] },
  mouse_move: { props: { coordinate: pair }, required: ['coordinate'] },
  left_click: { props: { coordinate: pair, text: str }, required: [] },
  right_click: { props: { coordinate: pair, text: str }, required: [] },
  middle_click: { props: { coordinate: pair, text: str }, required: [] },
  double_click: { props: { coordinate: pair, text: str }, required: [] },
  triple_click: { props: { coordinate: pair, text: str }, required: [] },
  left_click_drag: { props: { start_coordinate: pair, coordinate: pair }, required: ['coordinate'] },
  left_mouse_down: { props: { coordinate: pair }, required: [] },
  left_mouse_up: { props: { coordinate: pair }, required: [] },
  scroll: { props: { coordinate: pair, scroll_direction: { type: 'string', enum: DIRECTIONS }, scroll_amount: { ...int, minimum: 1 } }, required: ['coordinate', 'scroll_direction', 'scroll_amount'] },
  type: { props: { text: str }, required: ['text'] },
  key: { props: { text: str, repeat: { ...int, minimum: 1 } }, required: ['text'] },
  hold_key: { props: { text: str, duration: { ...num, exclusiveMinimum: 0, maximum: 10 } }, required: ['text', 'duration'] },
  wait: { props: { duration: { ...num, exclusiveMinimum: 0, maximum: 10 } }, required: ['duration'] },
  wait_until: { props: { until: { ...str, maxLength: 500 }, timeout: { ...num, exclusiveMinimum: 0, maximum: 30 } }, required: [] },
  open_application: { props: { app: str }, required: ['app'] },
};

/**
 * computer_batch に入れられる動作（request_access・list_granted_applications・computer_batch は入れられない）。
 * wait_until も入れない（1 回で最長 30 秒＋聞く時間になり、まとめると Antigravity の 1 回 3 分の上限に収まらない）
 */
export const BATCHABLE = Object.keys(SPECS).filter(n => !['request_access', 'list_granted_applications', 'wait_until'].includes(n));
export const MAX_BATCH = 20;
export const MAX_SECONDS = 10;
/** wait_until の timeout（秒）の既定と上限 */
export const UNTIL_DEFAULT_SECONDS = 15;
export const UNTIL_MAX_SECONDS = 30;
/** wait_until の最後の問いが締め切りを越えて続ける最長（決定モデルの 1 回の往復の上限と、撮る時間） */
export const UNTIL_GRACE_MS = 8000;
/** wait_until の timeout（秒）。省略なら既定、上限を超えたら上限。数でない・0 以下は null（invalid） */
export function untilSeconds(timeout) {
  if (timeout === undefined || timeout === null) return UNTIL_DEFAULT_SECONDS;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) return null;
  return Math.min(timeout, UNTIL_MAX_SECONDS);
}

/** ロックを取るツール（撮影と入力。wait・cursor_position・request_access・list_granted_applications は取らない。wait_until は画面を撮るので取る） */
export const LOCKING = new Set(['screenshot', 'zoom', 'switch_display', 'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait_until', 'open_application', 'computer_batch']);

const batchItem = () => {
  const props = { action: { type: 'string', enum: BATCHABLE } };
  for (const n of BATCHABLE) Object.assign(props, SPECS[n].props);
  // 全部のツールが title を求めるので、動作ごとに付けてくる呼び出しを失敗にしない（中身は使わない）
  return { type: 'object', properties: { ...props, title: str }, required: ['action'], additionalProperties: false };
};
const batchActions = { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: MAX_BATCH };
const BATCH_SPEC = { props: { actions: batchActions }, required: ['actions'] };

export const COMPUTER_TOOL_NAMES = [...Object.keys(SPECS), 'computer_batch'];

// macOS で説明を差し替えるツール（⌘ を使える。ADR 0173 §4）
const MAC_DESCRIPTIONS = new Set(['left_click', 'right_click', 'key', 'open_application', 'request_access']);

/** ツールの定義。名前と引数（inputSchema）は言語に依らず、説明だけ会話の言語。title は全部のツールにあり、スキーマでは必須 */
export function computerTools(locale, platform = process.platform) {
  // i18n-dynamic: agent:computer.tools.
  // i18n-dynamic: agent:computer.toolsMac.
  const title = { type: 'string', description: agentT(locale, 'computer.title') };
  const one = (name, spec) => ({ name, description: agentT(locale, platform === 'darwin' && MAC_DESCRIPTIONS.has(name) ? `computer.toolsMac.${name}` : `computer.tools.${name}`),
    inputSchema: { type: 'object', properties: { title, ...spec.props }, required: ['title', ...spec.required], additionalProperties: false } });
  return [
    ...Object.entries(SPECS).map(([name, spec]) => one(name, spec)),
    one('computer_batch', { props: { actions: { ...batchActions, items: batchItem() } }, required: ['actions'] }),
  ];
}

/** 値が schema の形か。違えば、期待する形の名前（computer.invalidArgs.expected.<名前>）を返す。合えば null */
function expectedOf(schema, value, key) {
  if (schema.enum) return schema.enum.includes(value) ? null : 'enum';
  switch (schema.type) {
    case 'string': return typeof value === 'string' ? null : 'string';
    case 'integer': return Number.isInteger(value) ? null : 'integer';
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? null : 'number';
    case 'array': {
      const name = key === 'actions' ? 'actions' : schema.items === num ? (schema.maxItems === 4 ? 'region' : 'pair') : 'strings';
      if (!Array.isArray(value)) return name;
      if (schema.minItems !== undefined && value.length < schema.minItems) return name;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) return name;
      const item = schema.items;
      const ok = v => (item.type === 'object' ? Boolean(v) && typeof v === 'object' && !Array.isArray(v) : !expectedOf(item, v, ''));
      return value.every(ok) ? null : name;
    }
    default: return null;
  }
}

/**
 * ツールの引数の検査（呼ぶ側のモデルが MCP のスキーマで弾かれるとは限らないので、サーバーで必ずする）。
 * 知らない引数・足りない必須の引数・型の違い（数を文字列で渡す等。黙って直さない）を { kind, … } の一覧で返す。無ければ空。
 * null は渡さなかったのと同じ。batchItem は computer_batch の 1 要素（action を許す）
 */
export function argProblems(name, args, { batchItem: inBatch = false } = {}) {
  const spec = name === 'computer_batch' ? BATCH_SPEC : SPECS[name];
  if (!spec || !args || typeof args !== 'object' || Array.isArray(args)) return [];
  const known = new Set(['title', ...Object.keys(spec.props), ...(inBatch ? ['action'] : [])]);
  const problems = [];
  const unknown = Object.keys(args).filter(k => !known.has(k));
  if (unknown.length) problems.push({ kind: 'unknown', args: unknown, allowed: Object.keys(spec.props) });
  for (const key of spec.required) if (args[key] === undefined || args[key] === null) problems.push({ kind: 'missing', arg: key });
  for (const [key, schema] of Object.entries(spec.props)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const expected = expectedOf(schema, value, key);
    if (expected) problems.push({ kind: 'type', arg: key, expected, value, ...(schema.enum ? { values: schema.enum } : {}) });
  }
  return problems;
}

/** 正しい呼び方の例（title を除く引数。誤りの文に付けて、スキーマを見ていない呼び出しも 1 回で直せるようにする。argProblems を通る形に保つ） */
const CLICK_EXAMPLE = { coordinate: [412, 238] };
const EXAMPLES = {
  request_access: { apps: ['Notepad'], reason: 'Edit a document' },
  list_granted_applications: {},
  screenshot: { display: 1 },
  zoom: { region: [0, 0, 400, 300] },
  switch_display: { display: 1 },
  cursor_position: {},
  mouse_move: CLICK_EXAMPLE,
  left_click: CLICK_EXAMPLE,
  right_click: CLICK_EXAMPLE,
  middle_click: CLICK_EXAMPLE,
  double_click: CLICK_EXAMPLE,
  triple_click: CLICK_EXAMPLE,
  left_click_drag: { start_coordinate: [100, 100], coordinate: [300, 200] },
  left_mouse_down: CLICK_EXAMPLE,
  left_mouse_up: CLICK_EXAMPLE,
  scroll: { coordinate: [700, 400], scroll_direction: 'down', scroll_amount: 3 },
  type: { text: 'hello' },
  key: { text: 'ctrl+s' },
  hold_key: { text: 'shift', duration: 2 },
  wait: { duration: 2 },
  wait_until: { until: 'The page has finished loading', timeout: 15 },
  open_application: { app: 'notepad' },
  computer_batch: { actions: [{ action: 'left_click', coordinate: [412, 238] }, { action: 'key', text: 'Return' }] },
};
export const argExample = name => EXAMPLES[name] ?? null;

/** 別の引数名で座標・範囲を渡してきたときに、正しい形を教える（computer.invalidArgs.hint.<名前>） */
const COORDINATE_ALIASES = new Set(['x', 'y', 'pos', 'position', 'point', 'xy', 'coords', 'coordinates', 'start_x', 'start_y', 'from', 'to', 'end_x', 'end_y']);
const REGION_ALIASES = new Set(['x', 'y', 'x1', 'y1', 'x2', 'y2', 'x0', 'y0', 'left', 'top', 'right', 'bottom', 'width', 'height', 'rect', 'box', 'bbox', 'area', 'coordinate', 'coordinates']);
export function argHint(name, unknown) {
  const has = set => unknown.some(k => set.has(String(k).toLowerCase()));
  if (name === 'zoom') return has(REGION_ALIASES) ? 'region' : null;
  const spec = SPECS[name];
  return spec && 'coordinate' in spec.props && has(COORDINATE_ALIASES) ? 'coordinate' : null;
}
