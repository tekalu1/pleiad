import { checkVisualize } from './visualize-shared.mjs';
export const name = 'visualize-claude';
export const title = 'Claude renders Visualize references without a presentation MCP';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude' };
export default (t, ctx) => checkVisualize(t, ctx, 'claude');
