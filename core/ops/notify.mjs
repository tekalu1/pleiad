// notify.*: 通知の設定（設定 › 通知。ADR 0086）。画面と AI が同じ本体を通る（core/server.mjs の opsNotify）。
// 返すのは変えた値だけ。スマホの一覧（remoteDevices）は human-only（ADR 0094 のリモートのペアリング）なので、AI への返り値に混ぜない。
// 画面の WS コマンドは、返したあとに設定 › 通知の材料（notifyStatus）を自分で返す。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

const D = (id, key) => `agent:ops.notify.${id}.${key}`;

export const notifyOps = [
  defineOp({
    id: 'notify.setPc',
    summary: 'agent:ops.notify.setPc.summary',
    risk: 'write',
    riskReason: 'Turns the desktop notifications of this PC on or off per kind (done, needs a reply, failed). It only changes what is shown to the user; approval cards still wait in the conversation (ADR 0094)',
    input: z.object({
      done: z.boolean().optional().describe(D('setPc', 'done')),
      reply: z.boolean().optional().describe(D('setPc', 'reply')),
      failed: z.boolean().optional().describe(D('setPc', 'failed')),
    }),
    output: z.object({ done: z.boolean(), reply: z.boolean(), failed: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['notify', 'pc'] } },
    legacyCommand: 'setNotifyPc',
    handler: (ctx, patch) => ctx.notify.setPc(patch),
  }),

  defineOp({
    id: 'notify.setDevice',
    summary: 'agent:ops.notify.setDevice.summary',
    risk: 'write',
    riskReason: 'Mutes or unmutes notifications to one paired phone. It neither pairs nor revokes a device and does not reveal the device list (that stays human-only, ADR 0094)',
    input: z.object({
      id: z.string().min(1).max(200).describe(D('setDevice', 'id')),
      muted: z.boolean().describe(D('setDevice', 'muted')),
    }),
    output: z.object({ id: z.string(), muted: z.boolean() }),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['notify', 'device'], positional: ['id', 'muted'] } },
    legacyCommand: 'setNotifyDevice',
    handler: (ctx, { id, muted }) => ctx.notify.setDevice(id, muted),
  }),
];
