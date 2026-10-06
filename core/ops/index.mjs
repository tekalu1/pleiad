// 既定のレジストリ。操作を足したら、領域のファイルに書いてここで集める（集め忘れは tests/unit/ops-coverage.mjs が落とす）。
// 設定は `export const settings = [defineSetting(…)]` で出し、ここで集める（今は settings.mjs に置く。持ち主のモジュールへ移していく）。
import { createRegistry } from './registry.mjs';
import { appOps } from './app.mjs';
import { sessionOps } from './sessions.mjs';
import { conversationOps } from './conversations.mjs';
import { agentOps } from './agents.mjs';
import { resumeOps } from './resume.mjs';
import { statusOps } from './statuses.mjs';
import { settingOps, settings } from './settings.mjs';
import { delegationOps } from './delegation.mjs';
import { worktreeOps } from './worktrees.mjs';
import { notifyOps } from './notify.mjs';
import { hookOps } from './hooks.mjs';
import { compatOps } from './compat.mjs';
import { computerOps } from './computer.mjs';
import { mcpOps } from './mcp.mjs';
import { contextOps } from './context.mjs';
import { remoteOps } from './remote.mjs';
import { probeOps } from './probe.mjs';
import { gitOps } from './git.mjs';
import { shellOps } from './shell.mjs';
import { sessionWorkOps } from './session-work.mjs';
import { fileOps } from './files.mjs';
import { attachmentOps } from './attachments.mjs';
import { channelOps } from './channels.mjs';
import { botOps } from './bots.mjs';
import { memoryOps } from './memory.mjs';
import { brainOps } from './brain.mjs';
import { routineOps } from './routines.mjs';

// 権限の配線を確かめる検査用の操作は、fake バックエンドを有効にしたとき（テスト）だけ載せる
const withProbe = String(process.env.AGENT_HOST_BACKENDS ?? '').split(',').map((s) => s.trim()).includes('fake');

export const registry = createRegistry({
  ops: [...appOps, ...sessionOps, ...resumeOps, ...conversationOps, ...agentOps, ...statusOps, ...settingOps, ...delegationOps,
    ...worktreeOps, ...notifyOps, ...hookOps, ...compatOps, ...computerOps, ...mcpOps, ...contextOps, ...remoteOps,
    ...gitOps, ...shellOps, ...sessionWorkOps, ...fileOps, ...attachmentOps, ...channelOps, ...botOps, ...memoryOps, ...brainOps, ...routineOps, ...(withProbe ? probeOps : [])],
  settings: [...settings],
});

export { createRegistry, defineOp, defineSetting, OpError } from './registry.mjs';
