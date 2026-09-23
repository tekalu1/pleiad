import { checkSteer } from './steer-shared.mjs';
export const name = 'message-steer';
export const title = '実際のCodexが作業途中に追加メッセージを受け取る';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };
export default (t, ctx) => checkSteer(t, ctx, 'codex');
