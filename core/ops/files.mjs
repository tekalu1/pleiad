// files.*: このホストのフォルダーの中身（作業ディレクトリを選ぶ簡易ブラウザー・添付の「ホストから」と同じ本体。core/list-dirs.mjs。ADR 0096）。
// 名前と大きさ・更新時刻だけを返し、ファイルの中身は読まない。画面（人）には今までの形を返し（uiHandler）、AI・CLI には並びを limit / cursor で区切って返す。
import { z } from 'zod';
import { defineOp } from './registry.mjs';
import { pageOf, PAGE_MAX } from './host.mjs';
import { cwdFor, run } from './redact.mjs';

const D = (id, key) => `agent:ops.files.${id}.${key}`;

export const fileOps = [
  defineOp({
    id: 'files.listDirs',
    summary: 'agent:ops.files.listDirs.summary',
    risk: 'read',
    input: z.object({
      path: z.string().max(8192).nullable().optional().describe(D('listDirs', 'path')),
      files: z.boolean().optional().describe(D('listDirs', 'files')),
      limit: z.number().int().min(1).max(PAGE_MAX).optional().describe(D('listDirs', 'limit')),
      cursor: z.string().max(400).optional().describe(D('listDirs', 'cursor')),
    }),
    output: z.object({ path: z.string(), parent: z.string().nullable() }).passthrough(),
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['files', 'dirs'], positional: ['path'] } },
    legacyCommand: 'listDirs',
    uiHandler: (ctx, { path, files }) => ctx.files.listDirs(path, { files: files === true }),
    // AI は path を省けば自分の会話の作業ディレクトリ。フォルダーを先に、ファイルを後に並べて区切る
    handler: (ctx, { path, files, limit, cursor }) => run(ctx, async () => {
      const got = await ctx.files.listDirs(await cwdFor(ctx, path), { files: files === true });
      const rows = [...got.dirs.map((name) => ({ name, type: 'dir' })), ...(got.files ?? []).map((f) => ({ ...f, type: 'file' }))];
      const page = pageOf(ctx, rows, { limit, cursor });
      return { path: got.path, parent: got.parent, roots: got.roots ?? [], total: page.total, entries: page.items, next: page.next, truncated: got.truncated === true };
    }),
  }),
];
