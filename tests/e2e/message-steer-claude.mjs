import { checkSteer } from './steer-shared.mjs';
export const name = 'message-steer-claude';
export const title = '実際のClaudeが作業途中に追加メッセージを受け取る';
export const serverEnv = { AGENT_HOST_BACKENDS: 'claude' };
export default (t, ctx) => checkSteer(t, ctx, 'claude');
