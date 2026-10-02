// sessions.search（core/ops/sessions.mjs）を WS の invoke 越しに通す。fake バックエンドと種のデータ置き場で、LLM もネットワークも要らない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { seedSearchData } from '../lib/search-seed.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'sessions-search-op';
export const title = 'sessions.search: invoke で本文まで探せる・委譲の子と期間と発言者の絞り込み・壊れた入力は INVALID・口の出し方';

export default async function (t) {
  const op = registry.get('sessions.search');
  t.ok('read の操作で、画面・MCP（直に）・CLI（sessions search の位置引数 query）に出す',
    op?.risk === 'read' && op.surfaces.ui === true && op.surfaces.mcp === 'direct'
    && op.surfaces.cli.path.join(' ') === 'sessions search' && op.surfaces.cli.positional === 'query');

  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-sessions-search-')));
  const dataDir = path.join(scratch, 'data');
  seedSearchData(dataDir, path.join(scratch, 'cwd'));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir, timeoutMs: 30_000 });
  const c = await open({ port: server.port, token: server.token });
  const search = (args) => c.cmd('invoke', { op: 'sessions.search', args });
  const settled = async (args) => {
    // 裏の読み込みが終わるまで（partial が false になるまで）待つ
    for (let i = 0; i < 100; i++) { const r = await search(args); if (!r.partial) return r; await new Promise((res) => setTimeout(res, 100)); }
    throw new Error('partial のまま');
  };
  try {
    const gw = await settled({ query: 'gateway' });
    const ids = gw.sessions.map((s) => s.sessionId);
    t.ok('本文の語で当たる（題に無い会話も）', ids.includes('ss-paid') && ids.includes('ss-gateway'), ids.join());
    t.ok('委譲の子は既定で含めない', !ids.includes('ss-price'), ids.join());
    const hit = gw.sessions.find((s) => s.sessionId === 'ss-paid');
    t.ok('抜粋は誰の発言か・飛び先の uuid・一致の範囲を持つ', ['user', 'assistant'].includes(hit.hits[0].role) && hit.hits[0].uuid.startsWith('claude:n:')
      && hit.hits[0].ranges.length > 0 && hit.hits[0].excerpt.slice(...hit.hits[0].ranges[0]).toLowerCase() === 'gateway' && hit.hitCount >= 2, JSON.stringify(hit.hits[0]));

    const withKids = await search({ query: 'gateway', filters: { includeDelegated: true } });
    const kid = withKids.sessions.find((s) => s.sessionId === 'ss-price');
    t.ok('includeDelegated で委譲の子が出て、依頼元の会話の id を持つ', kid?.parentSessionId === 'ss-paid', JSON.stringify(kid));

    const mine = await search({ query: 'gateway', filters: { speaker: 'user' } });
    t.ok('speaker: user で自分の発言だけに当てる', mine.sessions.every((s) => s.hits.every((h) => h.role === 'user')) && mine.sessions.length > 0, JSON.stringify(mine.sessions.map((s) => s.sessionId)));

    t.ok('ツールの入力は既定で対象外・includeToolInputs で当たる',
      (await search({ query: 'createLogger' })).total === 0 && (await search({ query: 'createLogger', filters: { includeToolInputs: true } })).sessions[0]?.hits[0].role === 'tool');

    const recent = await search({ query: '', filters: { since: Date.now() - 3 * 86_400_000 }, sort: 'recent' });
    t.ok('語が空でも期間で絞れる（40 日前の会話は出ない）・新しい順', recent.total > 0 && !recent.sessions.some((s) => s.sessionId === 'ss-nightly')
      && recent.sessions.every((s, i, a) => i === 0 || a[i - 1].lastModified >= s.lastModified), recent.sessions.map((s) => s.sessionId).join());
    t.ok('NFKC: 全角の ＣＩ に ci で当たる', (await search({ query: 'ci' })).sessions.some((s) => s.sessionId === 'ss-nightly'));
    t.ok('場所はフォルダー名だけ（パスの途中の語では当たらない）', (await search({ query: 'cwd' })).total === 0 && (await search({ query: 'vtc-web' })).total > 0);

    const bad = await search({ query: Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ') }).catch((e) => e);
    t.ok('語が多すぎるときは INVALID（落ちない）', bad.code === 'INVALID', `${bad.code} ${bad.message}`);
    const badCursor = await search({ query: 'a', cursor: '!!' }).catch((e) => e);
    t.ok('壊れた cursor は INVALID', badCursor.code === 'INVALID', `${badCursor.code}`);
    const unknown = await search({ query: 'a', filters: { surprise: 1 } }).catch((e) => e);
    t.ok('未知の絞り込みは INVALID と issues', unknown.code === 'INVALID' && Array.isArray(unknown.issues), JSON.stringify(unknown.issues));
    t.ok('失敗の後も接続は生きている', (await search({ query: 'gateway' })).total === gw.total);
  } finally {
    c.close();
    await server.stop();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
