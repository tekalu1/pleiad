// Claude のアカウント切り替えを server の配線で通す。fake バックエンドは Claude と同じく oauthToken を受け取り、
// "whoami" でその指紋を返す（トークンそのものは出さない）。LLM は呼ばない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer, ROOT } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';

export const name = 'server-claude-accounts';
export const title = 'Claude のアカウント: 登録・トークンの持ち主の照合・会話ごとの選択・分岐と委譲での引き継ぎ・削除したら止める';

const TOKEN = 'sk-ant-oat01-' + 'W'.repeat(48);
const fingerprint = token => `account:${crypto.createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
const lastText = history => [...history.messages].reverse().find(m => m.role === 'assistant')?.text ?? '';
const prompt = (name, args) => 'ply:' + JSON.stringify({ name, arguments: args });

const TOKEN_OFFLINE = 'sk-ant-oat01-' + 'X'.repeat(48);
const ORG_TOKEN = '22222222-1111-4000-8000-00000000000a';
const ORG_USAGE = '11111111-2222-4000-8000-00000000000b';

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-accounts-server-'));
  // トークンの持ち主の確認は偽の API へ。ログイン中のアカウント（CLAUDE_CONFIG_DIR/.claude.json）も使い捨ての場所に置く
  const api = await startFakeAnthropicApi({ [TOKEN]: ORG_TOKEN, [TOKEN_OFFLINE]: 'fail' });
  const cliDir = path.join(scratch, 'cli-config');
  await fs.mkdir(cliDir, { recursive: true });
  await fs.writeFile(path.join(cliDir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG_TOKEN, emailAddress: 'logged-in@example.com' } }));
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_ANTHROPIC_API: api.url, CLAUDE_CONFIG_DIR: cliDir }, dataDir: scratch });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const row = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  const registry = async () => JSON.parse(await fs.readFile(path.join(scratch, 'claude-accounts.json'), 'utf8')).accounts;
  try {
    t.ok('最初は何も登録していない', (await c.cmd('claudeAccounts')).accounts.length === 0);
    // 何も登録していない人には今と同じ動き
    const { sessionId: plain } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('未選択の会話にはトークンを渡さない', lastText(await c.cmd('loadSession', { sessionId: plain })) === 'account:none');
    t.ok('一覧の行はログイン中のアカウント（空）', (await row(plain)).claudeAccount === '');

    const saved = await c.cmd('saveClaudeAccount', { name: '仕事用', token: TOKEN });
    t.ok('追加の応答にトークンを載せない', saved.id && !JSON.stringify(saved).includes(TOKEN) && saved.accounts[0].hasToken === true);
    const work = saved.id;

    // ---- トークンの持ち主（貼り付けて保存したとき）
    t.ok('保存したらトークンの組織を確かめる（GET /v1/models?limit=1 を OAuth で）', api.requests.length === 1 && api.requests[0].method === 'GET'
      && api.requests[0].url === '/v1/models?limit=1' && api.requests[0].headers['anthropic-beta'] === 'oauth-2025-04-20');
    t.ok('確かめた組織を一覧のファイルに記録する', (await registry()).find(a => a.id === work)?.tokenOrg === ORG_TOKEN);
    t.ok('使用量の認可が無ければ照合は unknown', saved.accounts[0].tokenCheck?.status === 'unknown');
    // 使用量の認可が済んだ（CLI の設定フォルダに別のアカウント）
    const usageDir = path.join(scratch, 'claude-usage', work);
    await fs.mkdir(usageDir, { recursive: true });
    await fs.writeFile(path.join(usageDir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: ORG_USAGE, emailAddress: 'work@example.com' } }));
    await fs.writeFile(path.join(usageDir, 'ply-usage-login.json'), '{}');
    const checked = (await c.cmd('claudeAccounts')).accounts.find(a => a.id === work).tokenCheck;
    t.ok('使用量の認可と別のアカウントのトークンは mismatch（ログイン中のアカウントのもの）', checked.status === 'mismatch' && checked.ownerLoggedIn === true
      && checked.ownerEmail === 'logged-in@example.com' && checked.expectedEmail === 'work@example.com', JSON.stringify(checked));
    t.ok('記録済みなら一覧を引いても確かめ直さない', api.requests.length === 1);
    const offline = await c.cmd('saveClaudeAccount', { name: '確認できない', token: TOKEN_OFFLINE });
    t.ok('持ち主を確かめられなくても保存する', offline.id && offline.accounts.find(a => a.id === offline.id)?.hasToken === true
      && offline.accounts.find(a => a.id === offline.id).tokenCheck.status === 'unknown');
    t.ok('確かめられなければ記録しない', !('tokenOrg' in (await registry()).find(a => a.id === offline.id)));
    await c.cmd('deleteClaudeAccount', { id: offline.id });
    await fs.rm(usageDir, { recursive: true, force: true });

    await c.cmd('setTurnSettings', { sessionId: plain, account: 'nope' }).then(
      () => t.ok('登録していないアカウントは選べない', false), e => t.ok('登録していないアカウントは選べない', e.message.includes('登録されていません')));

    const next = await c.cmd('setTurnSettings', { sessionId: plain, account: work });
    t.ok('選択は次のターンの予約になる', next?.account === work && (await row(plain)).claudeAccount === '');
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('次のターンから選んだアカウントのトークンで走る', lastText(await c.cmd('loadSession', { sessionId: plain })) === fingerprint(TOKEN));
    const applied = await row(plain);
    t.ok('走ったら会話に確定し、予約は消える', applied.claudeAccount === work && applied.nextSettings === null);
    await c.runTurn({ sessionId: plain, prompt: 'whoami' });
    t.ok('以後のターンも同じアカウント', lastText(await c.cmd('loadSession', { sessionId: plain })) === fingerprint(TOKEN));

    // 分岐した子は親のアカウントを継ぐ
    const forked = await c.cmd('fork', { sessionId: plain });
    t.ok('分岐した会話は親のアカウントを継ぐ', (await row(forked.sessionId)).claudeAccount === work);
    await c.runTurn({ sessionId: forked.sessionId, prompt: 'whoami' });
    t.ok('分岐した会話も同じトークンで走る', lastText(await c.cmd('loadSession', { sessionId: forked.sessionId })) === fingerprint(TOKEN));

    // 引き継いで作る新しい会話も
    const { sessionId: sibling } = await c.cmd('newSession', { sourceSessionId: plain, cwd: ROOT });
    t.ok('引き継いで作る新しい会話も同じアカウント', (await row(sibling)).claudeAccount === work);
    // 引き継ぎ元の無い新しい会話は、前回選んだアカウントで始まる
    const { sessionId: fresh } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('新しい会話は前回選んだアカウントで始まる', (await row(fresh)).claudeAccount === work);

    // 委譲した子の会話も親のアカウントを継ぐ
    await c.runTurn({ sessionId: plain, prompt: prompt('ply_delegate', { backend: 'fake', task: 'whoami' }) });
    let task;
    for (let i = 0; i < 600 && !(task = (await c.cmd('agentTasks')).find(r => r.parentSessionId === plain && r.notification === 'sent')); i++) await sleep(50);
    t.ok('委譲した子の会話は親のアカウントで走る', task?.result === fingerprint(TOKEN), task ? `${task.status} ${task.result}` : 'no task');
    t.ok('委譲した子の会話にもアカウントが残る', task && (await row(task.sessionId)).claudeAccount === work);

    // ログイン中のアカウントへ戻す
    await c.cmd('setTurnSettings', { sessionId: sibling, account: '' });
    t.ok('ログイン中のアカウントへ戻す予約', (await row(sibling)).nextSettings?.account === '');
    await c.runTurn({ sessionId: sibling, prompt: 'whoami' });
    t.ok('戻したらトークンを渡さない', lastText(await c.cmd('loadSession', { sessionId: sibling })) === 'account:none' && (await row(sibling)).claudeAccount === '');
    const { sessionId: freshLogin } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('ログイン中へ戻した後の新しい会話はログイン中のアカウント', ((await row(freshLogin)).claudeAccount ?? '') === '');
    await c.cmd('setTurnSettings', { sessionId: freshLogin, account: work });

    // 名前の変更は選択に影響しない
    await c.cmd('saveClaudeAccount', { id: work, name: '仕事' });
    t.ok('名前を変えても一覧に残る', (await c.cmd('claudeAccounts')).accounts[0].name === '仕事');

    // 削除したら黙って別のアカウントで走らせない
    await c.cmd('deleteClaudeAccount', { id: work });
    let refused = null;
    await c.runTurn({ sessionId: forked.sessionId, prompt: 'whoami' }).catch(e => { refused = e; });
    t.ok('削除したアカウントを選んでいる会話は送信を止める', refused?.message.includes('削除されています'), refused?.message);
    const { sessionId: afterDelete } = await c.cmd('newSession', { backend: 'fake', cwd: ROOT });
    t.ok('前回のアカウントを消したら、新しい会話はログイン中のアカウント', ((await row(afterDelete)).claudeAccount ?? '') === '');
    t.ok('止めた会話は何も走らせていない', lastText(await c.cmd('loadSession', { sessionId: forked.sessionId })) === fingerprint(TOKEN));
    await c.cmd('suggestTitle', { sessionId: forked.sessionId }).then(
      () => t.ok('タイトル生成も別のアカウントへ落とさない', false),
      e => t.ok('タイトル生成も別のアカウントへ落とさない', e.message.includes('削除されています')));

    const files = await Promise.all(['claude-accounts.json', 'sessions.json'].map(f => fs.readFile(path.join(scratch, f), 'utf8').catch(() => '')));
    t.ok('一覧・会話の記録にトークンを書かない', files.every(text => !text.includes(TOKEN)));
    t.ok('サーバーのログにトークンを出さない', !server.tail(200).includes(TOKEN) && !server.tail(200).includes(TOKEN_OFFLINE));
    t.ok('サーバーのログに組織・メールアドレスを出さない', !server.tail(200).includes(ORG_TOKEN) && !server.tail(200).includes('@example.com'));
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
