// ply_control: Pleiad の中の会話に渡す HTTP の MCP（ADR 0081）。会話ごとに Bearer のトークンを開き、
// そのトークンは会話に束縛される（owner() がその会話の id を返す）。呼び出しは registry.invoke の主体 { by: 'agent', via: 'mcp', sessionId } で通り、
// その会話の承認モードで権限が決まる（ADR 0082）。同じトークンは、会話のシェルへ渡す環境変数（PLEIAD_CONTROL_TOKEN）で CLI も同じ会話に束縛する。
import { agentT } from '../../i18n.mjs';
import { createMcpBridge } from '../../mcp-bridge.mjs';
import { CONTROL_SERVER, mcpTools, callMcpTool } from './mcp.mjs';

export const CONTROL_MCP_PATH = '/mcp/control';
export { CONTROL_SERVER };

/** ツールの説明に使う文。会話の言語（agent 名前空間）。pleiad mcp には GET /api/ops の texts で渡す */
export const controlTexts = (locale) => ({
  instructions: agentT(locale, 'ops.control.instructions'),
  listOps: agentT(locale, 'ops.control.listOps'),
  listOpsId: agentT(locale, 'ops.control.listOpsId'),
  callOp: agentT(locale, 'ops.control.callOp'),
  callOpOp: agentT(locale, 'ops.control.callOpOp'),
  callOpArgs: agentT(locale, 'ops.control.callOpArgs'),
  notFound: agentT(locale, 'ops.errors.NOT_FOUND', { id: '{{id}}' }),
});

/** エージェントに渡す指示（3〜4 行）。会話の指示欄に足す（initialize の instructions には入れない。二重にしない） */
export const controlInstructions = (locale) => agentT(locale, 'ops.control.instructions');

const listPrincipal = { by: 'agent', via: 'mcp' };

/**
 * @param registry 操作の一覧（core/ops/index.mjs）
 * @param depsFor  (locale) => registry.invoke に渡す依存（server.mjs が作る。modeOf・audit を含む）
 */
export function createControlBridge({ registry, depsFor }) {
  return createMcpBridge({
    path: CONTROL_MCP_PATH,
    serverName: CONTROL_SERVER,
    tools: (locale) => mcpTools({ catalog: registry.describe(listPrincipal, locale), texts: controlTexts(locale) }),
    call: async (binding, name, args, { locale }) => {
      // 会話の id がまだ決まっていないとき owner() は投げる。束縛なしの主体として通さない（読み取りの会話の書き込みを断れなくなる）
      const principal = { ...listPrincipal, sessionId: await binding.owner() };
      return callMcpTool({ catalog: registry.describe(principal, locale), texts: controlTexts(locale), name, args,
        invoke: (id, input) => registry.invoke(principal, id, input, depsFor(locale)) });
    },
  });
}
