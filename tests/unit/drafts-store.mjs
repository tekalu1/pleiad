// 入力欄の書きかけのサーバーの写し（core/drafts.mjs・drafts.*。ADR 9101 の F35）: 保存・読む・空で消す・古い写しで上書きしない・画面の道具だけ。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDrafts } from '../../core/drafts.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'drafts-store';
export const title = '入力欄の書きかけのサーバーの写し: 保存・読む・空で消す・古い写しで上書きしない・画面の道具だけ';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'drafts-store-'));
  const drafts = createDrafts({ dataDir: tmp });
  try {
    t.ok('無ければ null', drafts.load({ key: 'thread:c_1:p_1' }) === null);
    drafts.save({ key: 'thread:c_1:p_1', text: '書きかけ', at: 100 });
    t.ok('保存した本文と時刻を読める', drafts.load({ key: 'thread:c_1:p_1' })?.text === '書きかけ' && drafts.load({ key: 'thread:c_1:p_1' }).at === 100);
    t.ok('古い写しでは上書きしない', drafts.save({ key: 'thread:c_1:p_1', text: '古い', at: 50 }).saved === false && drafts.load({ key: 'thread:c_1:p_1' }).text === '書きかけ');
    drafts.save({ key: 'thread:c_1:p_1', text: '続き', at: 200 });
    t.ok('新しい写しで上書きする', drafts.load({ key: 'thread:c_1:p_1' }).text === '続き');
    drafts.save({ key: 'thread:c_1:p_1', text: '  ', at: 300 });
    t.ok('空にすると消える', drafts.load({ key: 'thread:c_1:p_1' }) === null);
    const deps = { locale: 'ja', drafts, audit: () => {} };
    const human = { by: 'human', via: 'ui', local: true };
    const saved = await registry.invoke(human, 'drafts.save', { key: 'k_1', text: 'あいう' }, deps);
    const loaded = await registry.invoke(human, 'drafts.load', { key: 'k_1' }, deps);
    t.ok('drafts.save・load は画面から使える', saved.ok && loaded.ok && loaded.result.text === 'あいう', JSON.stringify([saved, loaded]));
    const ai = await registry.invoke({ by: 'agent', via: 'cli', sessionId: 's1' }, 'drafts.load', { key: 'k_1' }, deps);
    t.ok('AI からは使えない（画面の道具）', !ai.ok);
    t.ok('MCP・CLI に出さない', ['drafts.save', 'drafts.load'].every((id) => registry.get(id).surfaces.mcp === false && !registry.get(id).surfaces.cli));
  } finally {
    drafts.close();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
