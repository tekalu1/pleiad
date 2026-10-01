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
  open_application: { props: { app: str }, required: ['app'] },
};

/** computer_batch に入れられる動作（request_access・list_granted_applications・computer_batch は入れられない） */
export const BATCHABLE = Object.keys(SPECS).filter(n => !['request_access', 'list_granted_applications'].includes(n));
export const MAX_BATCH = 20;
export const MAX_SECONDS = 10;

/** ロックを取るツール（撮影と入力。wait・cursor_position・request_access・list_granted_applications は取らない） */
export const LOCKING = new Set(['screenshot', 'zoom', 'switch_display', 'mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'open_application', 'computer_batch']);

const batchItem = () => {
  const props = { action: { type: 'string', enum: BATCHABLE } };
  for (const n of BATCHABLE) Object.assign(props, SPECS[n].props);
  return { type: 'object', properties: props, required: ['action'] };
};

export const COMPUTER_TOOL_NAMES = [...Object.keys(SPECS), 'computer_batch'];

/** ツールの定義。名前と引数（inputSchema）は言語に依らず、説明だけ会話の言語。title は全部のツールにあり、スキーマでは必須 */
export function computerTools(locale) {
  // i18n-dynamic: agent:computer.tools.
  const title = { type: 'string', description: agentT(locale, 'computer.title') };
  const one = (name, spec) => ({ name, description: agentT(locale, `computer.tools.${name}`),
    inputSchema: { type: 'object', properties: { title, ...spec.props }, required: ['title', ...spec.required] } });
  return [
    ...Object.entries(SPECS).map(([name, spec]) => one(name, spec)),
    one('computer_batch', { props: { actions: { type: 'array', items: batchItem(), minItems: 1, maxItems: MAX_BATCH } }, required: ['actions'] }),
  ];
}
