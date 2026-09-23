import { checkVisualize } from './visualize-shared.mjs';
export const name = 'visualize-codex';
export const title = 'Codex renders Visualize references without a presentation MCP';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };
export default (t, ctx) => checkVisualize(t, ctx, 'codex');
