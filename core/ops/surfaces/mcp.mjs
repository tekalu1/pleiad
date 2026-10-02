// MCP のツールの一覧の生成器。Pleiad の中の会話に渡す HTTP の ply_control（core/ops/surfaces/control.mjs）と、
// 外の AI 向けの stdio の `pleiad mcp`（bin/pleiad.mjs）が同じこの関数で作る（ADR 0083）。
// Node の組み込みだけで書く（CLI が読み込む。zod・i18n には依存しない）。説明の文は呼び出し側が texts で渡す。
//
// 直に出すツールは少数（surfaces.mcp が 'direct' の操作）。残りは list_ops（説明と入力の JSON Schema）と call_op で呼ぶ。
// 操作を足しても、直に出す印を付けない限りツールの量は変わらない（docs/design.md「操作の一覧」、ADR 0081）。
//
//   catalog  registry.describe の返り（GET /api/ops の ops）。その口に出す操作だけ
//   texts    { instructions, listOps, listOpsId, callOp, callOpOp, callOpArgs, notFound } 会話（または PC）の言語の文

export const CONTROL_SERVER = 'ply_control';
export const META_TOOLS = ['list_ops', 'call_op'];

const object = (properties, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

/** tools/list の中身。直に出す操作 → list_ops → call_op の順 */
export function mcpTools({ catalog, texts }) {
  const direct = catalog.filter((e) => e.mcp === 'direct' && e.tool).map((e) => ({ name: e.tool, description: e.summary, inputSchema: e.input }));
  return [
    ...direct,
    { name: 'list_ops', description: texts.listOps, inputSchema: object({ id: { type: 'string', description: texts.listOpsId } }) },
    { name: 'call_op', description: texts.callOp, inputSchema: object({ op: { type: 'string', description: texts.callOpOp }, args: { type: 'object', description: texts.callOpArgs } }, ['op']) },
  ];
}

const text = (value) => ({ text: JSON.stringify(value) });
/** invoke の失敗（{ ok: false, code, error, issues? }）を、モデルが読める 1 つの文にする。code で見分けられる */
const failure = (r) => ({ isError: true, ...text({ error: r.error, code: r.code, ...(r.issues ? { issues: r.issues } : {}) }) });

/**
 * tools/call。invoke(id, args) は { ok, result } か { ok: false, code, error, issues? } を返す（registry.invoke・POST /api/ops/:id と同じ形）。
 * 返りは { text, isError? }
 */
export async function callMcpTool({ catalog, texts, name, args, invoke }) {
  if (name === 'list_ops') {
    const id = args?.id;
    if (id === undefined) return text({ ops: catalog.map((e) => ({ id: e.id, summary: e.summary, risk: e.risk, ...(e.tool ? { tool: e.tool } : {}) })) });
    const entry = catalog.find((e) => e.id === id);
    if (!entry) return failure({ code: 'NOT_FOUND', error: String(texts.notFound ?? 'Not found: {{id}}').replace('{{id}}', String(id)) });
    return text({ id: entry.id, summary: entry.summary, risk: entry.risk, scope: entry.scope, ...(entry.tool ? { tool: entry.tool } : {}), input: entry.input });
  }
  if (name === 'call_op') {
    const r = await invoke(String(args?.op ?? ''), args?.args ?? {});
    return r.ok ? text(r.result) : failure(r);
  }
  const entry = catalog.find((e) => e.mcp === 'direct' && e.tool === name);
  if (!entry) return failure({ code: 'NOT_FOUND', error: String(texts.notFound ?? 'Not found: {{id}}').replace('{{id}}', String(name)) });
  const r = await invoke(entry.id, args ?? {});
  return r.ok ? text(r.result) : failure(r);
}
