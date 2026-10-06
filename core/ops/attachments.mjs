// attachments.*: 貼り付けた HTML の画像を、ホストが取りに行って添付の置き場へ置く（core/image-import.mjs、docs/adr/0141）。
// 画面（人の貼り付け）だけが呼ぶ。外へ取りに行く口なので MCP・CLI には出さない（AI に任意の URL を取りに行かせない）。
// リモートの窓・モバイル・ブラウザー版の画面も同じ WS の口で使える（画面の fetch は CORS で読めず、Electron の main はリモートでは使えない）。
import { z } from 'zod';
import { defineOp, OpError } from './registry.mjs';

const D = (id, key) => `agent:ops.attachments.${id}.${key}`;

export const attachmentOps = [
  defineOp({
    id: 'attachments.importImage',
    summary: 'agent:ops.attachments.importImage.summary',
    risk: 'write',
    riskReason: 'Only the paste in the screen calls it (not on MCP or the CLI). It puts one image from a public https address into the attachment folder and touches no conversation, setting or working folder. The guards are in core/image-import.mjs (ADR 0141)',
    input: z.object({
      url: z.string().min(1).max(8192).describe(D('importImage', 'url')),
      sessionId: z.string().max(200).nullable().optional().describe(D('importImage', 'sessionId')),
      name: z.string().max(200).optional().describe(D('importImage', 'name')),
      importId: z.string().min(1).max(100).optional().describe(D('importImage', 'importId')),
    }),
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'attachImport',
    handler: async (ctx, { url, sessionId, name, importId }) => {
      try { return await ctx.attachments.importImage({ url, sessionId: sessionId ?? null, name: name ?? '', importId: importId ?? null }); }
      catch (e) {
        if (e?.name === 'ImportFailed') throw new OpError('INVALID', e.message, { reason: e.code });
        throw e;
      }
    },
  }),
  defineOp({
    id: 'attachments.cancelImport',
    summary: 'agent:ops.attachments.cancelImport.summary',
    risk: 'write',
    riskReason: 'Only stops an import that is still being fetched. It touches no file in the attachment folder',
    input: z.object({ importId: z.string().min(1).max(100).describe(D('cancelImport', 'importId')) }),
    surfaces: { ui: true, mcp: false, cli: false },
    legacyCommand: 'attachImportCancel',
    handler: (ctx, { importId }) => ({ cancelled: ctx.attachments.cancelImport(importId) }),
  }),
];
