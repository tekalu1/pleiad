// 「見直しを頼む」（ADR 0056「③ 見直しを頼む」、docs/design.md「指示の量」）。LLM は呼ばない
//   - 下書きの文: 対象（パスとトークン数）・量と目安・見つかった所・見直し方・確かめてから変える。ファイルの本文は入れない
//   - 主要操作にするか（目安を超えたか、気になる所があるか）
//   - サーバー越し: 同じ作業場所に未送信の新しい会話ができて下書きが入り、送られていない・設定は元の会話から引き継ぐ
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reviewDraft, reviewUrged, findingCount } from '../../web/context-review.mjs';
import { instructionAmount } from '../../web/instruction-amount.mjs';
import { t } from '../../web/i18n.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'context-review';
export const title = '見直しを頼む: 依頼文の下書きと、下書き入りの未送信の新しい会話';

export default async function (tt) {
  const rows = [{ path: '/home/example/.claude/CLAUDE.md', scope: 'user', tokens: 3500 }, { path: '/work/app/AGENTS.md', scope: 'directory', tokens: 7200 }];
  const over = instructionAmount({ rows, parts: [], budget: 5000 });
  const findings = {
    duplicates: [{ score: 0.8, sides: [{ path: '/home/example/.claude/CLAUDE.md', line: 3, segments: [{ text: 'BODY_SECRET_TEXT', common: true }] },
      { path: '/work/app/AGENTS.md', line: 12, segments: [{ text: 'BODY_SECRET_TEXT', common: true }] }] }],
    missing: [{ path: '/work/app/AGENTS.md', line: 40, target: 'tests/unit/old.mjs', from: 'repo' }],
    more: { duplicates: 0, missing: 2 },
  };
  const text = reviewDraft({ rows, amount: over, findings });
  const lines = text.split('\n');
  tt.ok('対象のファイルをパスとトークン数で並べる', lines.includes(t('sessionContext.review.draft.file', { path: '/home/example/.claude/CLAUDE.md', n: '3,500' }))
    && lines.includes(t('sessionContext.review.draft.file', { path: '/work/app/AGENTS.md', n: '7,200' })), text);
  tt.ok('量と目安（超えていれば何倍か）', lines.includes(t('sessionContext.review.draft.amountOver', { own: '10,700', budget: '5,000', ratio: '2.1' })), text);
  tt.ok('見つかった所: 重複の 2 か所と行、無いパスと行、出しきれない分の数',
    lines.includes(t('sessionContext.review.draft.duplicate', { a: '/home/example/.claude/CLAUDE.md', lineA: 3, b: '/work/app/AGENTS.md', lineB: 12 }))
    && lines.includes(t('sessionContext.review.draft.missing', { file: '/work/app/AGENTS.md', line: 40, target: 'tests/unit/old.mjs' }))
    && lines.includes(t('sessionContext.review.draft.more', { count: 2 })), text);
  const steps = ['how', 'howLead', 'step1', 'step2', 'step3', 'step4'].map(k => t(`sessionContext.review.draft.${k}`));
  tt.ok('見直し方は 4 段の順（直す → 塞ぐ → 知らせる → 書く）で、最後に差分を見せて確認を取る', lines.join('\n').includes(steps.join('\n'))
    && lines.at(-1) === t('sessionContext.review.draft.confirm'), text);
  tt.ok('ファイルの本文（重複の引用）は入れない', !text.includes('BODY_SECRET_TEXT'));
  const calm = reviewDraft({ rows: rows.slice(0, 1), amount: instructionAmount({ rows: rows.slice(0, 1), budget: 5000 }), findings: { duplicates: [], missing: [], more: {} } });
  tt.ok('目安の内で気になる所が無ければ、量は目安との比べだけで「見つかった所」は書かない',
    calm.includes(t('sessionContext.review.draft.amount', { own: '3,500', budget: '5,000' })) && !calm.split('\n').includes(t('sessionContext.review.draft.found')), calm);
  tt.ok('主要操作にするのは、目安を超えたか気になる所があるとき', reviewUrged(over, null) && reviewUrged(instructionAmount({ rows: rows.slice(0, 1) }), findings)
    && !reviewUrged(instructionAmount({ rows: rows.slice(0, 1) }), { duplicates: [], missing: [] }) && findingCount(findings) === 4);

  // ---- サーバー越し
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-review-')));
  const cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data');
  let host, client;
  try {
    await fs.mkdir(cwd, { recursive: true });
    host = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open(host);
    const row = async id => (await client.cmd('listSessions')).find(s => s.id === id);
    const source = await client.cmd('newSession', { cwd, backend: 'fake' });
    await client.cmd('setTurnSettings', { sessionId: source.sessionId, backend: 'fake', model: 'fast' });
    const made = await client.cmd('newSession', { sourceSessionId: source.sessionId, cwd, draft: text });
    const r = await row(made.sessionId);
    const loaded = await client.cmd('loadSession', { sessionId: made.sessionId });
    tt.ok('同じ作業場所に未送信の新しい会話ができ、下書きが入っている', made.sessionId !== source.sessionId && r?.unsent === true && r.hasDraft === true
      && r.cwd === cwd && loaded.draft?.text === text && loaded.draft.attached.length === 0, JSON.stringify(r));
    tt.ok('送られていない（発言が無い）', (loaded.messages ?? []).length === 0);
    tt.ok('エージェントとモデルは元の会話から引き継ぐ', r.backend === 'fake' && (r.nextSettings?.model ?? r.model) === 'fast', JSON.stringify({ model: r.model, next: r.nextSettings }));
    const refused = await client.cmd('newSession', { cwd, backend: 'fake', draft: 42 }).then(() => false, () => true);
    tt.ok('文字列でない下書きは断る', refused);
  } finally {
    client?.close();
    await host?.stop?.();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
