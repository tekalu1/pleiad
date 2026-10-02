// 権限の配線（束縛した会話の承認モード → policy → registry.invoke）をサーバー越しに確かめる検査用の操作（tests/unit/ops-control.mjs）。
// fake バックエンドを有効にしたとき（AGENT_HOST_BACKENDS=fake。テスト）だけ core/ops/index.mjs が載せる。実際の利用では出ない。
import { z } from 'zod';
import { defineOp } from './registry.mjs';

export const probeOps = [
  // 関所を緩める側の操作の代役。承認なしのモードの会話では通り、承認が要る会話では NEEDS_APPROVAL、束縛されない呼び出しでは NEEDS_UI
  defineOp({
    id: 'probe.guarded',
    summary: 'agent:ops.probe.guarded.summary',
    risk: 'guarded',
    input: z.object({}),
    confirm: () => 'probe',
    surfaces: { ui: true, mcp: 'catalog', cli: { path: ['probe', 'guarded'] } },
    handler: () => ({ done: true }),
  }),
  // human-only の代役。画面（人間）だけが呼べ、agent の一覧・list_ops には出ない
  defineOp({
    id: 'probe.humanOnly',
    summary: 'agent:ops.probe.humanOnly.summary',
    risk: 'human-only',
    input: z.object({}),
    surfaces: { ui: true, mcp: false, cli: false },
    handler: () => ({ done: true }),
  }),
];
