// Claude のアカウントの認可を server の配線で通す（claudeLoginStart / claudeLoginCode / claudeLoginCancel と claudeLogin イベント）。
// Claude Code の代わりに偽の CLI（tests/lib/fake-claude-login.mjs）を AGENT_HOST_CLAUDE_BIN で渡す。本物のログインもネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { loadPty } from '../../core/claude-login.mjs';
import { startFakeAnthropicApi } from '../lib/fake-anthropic-api.mjs';

export const name = 'server-claude-login';
export const title = 'Claude のアカウントの認可: Pleiad からトークンを発行して保存・持ち主の記録と照合・使用量の認可・削除で設定フォルダも消す';

const FAKE_CLI = path.join(ROOT, 'tests', 'lib', 'fake-claude-login.mjs');
const FAKE_TOKEN = 'sk-ant-oat01-' + 'Zq9_'.repeat(20) + 'end';
const ORG_PERSONAL = '22222222-3333-4000-8000-00000000000c';
const ORG_WORK = '11111111-4444-4000-8000-00000000000d';

export default async function (t) {
  if (!loadPty()) { t.skip('node-pty を読めない（setup-token は疑似端末が要る）'); return; }
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-login-server-'));
  const log = path.join(scratch, 'fake-cli.log');
  // トークンの持ち主の確認は偽の API へ。発行されたトークンは「個人用」の組織、使用量の認可は「仕事用」の組織（2026-09-23 の事故の形）
  const api = await startFakeAnthropicApi({ [FAKE_TOKEN]: ORG_PERSONAL });
  const server = await startServer({ dataDir: scratch, env: {
    AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_CLAUDE_BIN: `"${process.execPath}" "${FAKE_CLI}"`, FAKE_CLAUDE_LOG: log,
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-from-parent-shell-should-not-leak',
    AGENT_HOST_ANTHROPIC_API: api.url, CLAUDE_CONFIG_DIR: path.join(scratch, 'cli-config'),
    FAKE_CLAUDE_ORG: ORG_WORK, FAKE_CLAUDE_EMAIL: 'work@example.com',
  } });
  const c = await open({ port: server.port, token: server.token });
  const logins = from => c.since(from).filter(e => e.type === 'claudeLogin');
  const phase = (loginId, p, from) => c.waitFor(e => e.type === 'claudeLogin' && e.loginId === loginId && e.phase === p, { ms: 30_000, from });
  try {
    let refused = null;
    await c.cmd('claudeLoginStart', { kind: 'setup-token', name: '  ' }).catch(e => { refused = e; });
    t.ok('表示名が無ければ始めない', refused?.message.includes('表示名'));
    refused = null;
    await c.cmd('claudeLoginStart', { kind: 'usage-login', accountId: 'acct-nope' }).catch(e => { refused = e; });
    t.ok('登録していないアカウントの認可は始めない', refused?.message.includes('登録されていません'));

    // ---- トークンの発行（新規）
    const m0 = c.mark();
    const { loginId: a } = await c.cmd('claudeLoginStart', { kind: 'setup-token', name: '仕事用' });
    const url = await phase(a, 'url', m0);
    t.ok('認可 URL を知らせる', url.url.startsWith('https://claude.com/cai/oauth/authorize?') && url.sessionId === null);
    await phase(a, 'code', m0);
    const m1 = c.mark();
    await c.cmd('claudeLoginCode', { loginId: a, code: 'bad' });
    const retry = await c.waitFor(e => e.type === 'claudeLogin' && e.loginId === a && e.phase === 'code' && e.message, { ms: 30_000, from: m1 });
    t.ok('受け付けられなかったコードを知らせる', retry.message.includes('Invalid code'));
    await c.cmd('claudeLoginCode', { loginId: a, code: 'good#1' });
    const done = await phase(a, 'done', m1);
    t.ok('発行したら作ったアカウントの id を添えて完了を知らせる', /^acct-/.test(done.accountId ?? ''));
    const list = (await c.cmd('claudeAccounts')).accounts;
    const work = list.find(x => x.id === done.accountId);
    t.ok('トークンは登録済み・使用量はまだ', work?.name === '仕事用' && work.hasToken === true && work.usageLogin === false);
    const registry = JSON.parse(await fs.readFile(path.join(scratch, 'claude-accounts.json'), 'utf8')).accounts;
    t.ok('発行したトークンの組織を、完了を知らせる前に記録する', registry.find(x => x.id === work.id)?.tokenOrg === ORG_PERSONAL
      && api.requests.length === 1 && api.requests[0].headers.authorization === `Bearer ${FAKE_TOKEN}`);
    t.ok('使用量の認可の前は照合は unknown', work.tokenCheck?.status === 'unknown');
    t.ok('どのイベントにもトークンを載せない', !JSON.stringify(c.since(m0)).includes('sk-ant-'));
    t.ok('アカウント一覧が変わったことを知らせる', c.since(m0).some(e => e.type === 'claudeAccountsChanged'));

    // ---- 使用量の認可
    const m2 = c.mark();
    const { loginId: b } = await c.cmd('claudeLoginStart', { kind: 'usage-login', accountId: work.id });
    await phase(b, 'code', m2);
    await c.cmd('claudeLoginCode', { loginId: b, code: 'good#2' });
    await phase(b, 'done', m2);
    const after = (await c.cmd('claudeAccounts')).accounts.find(x => x.id === work.id);
    t.ok('使用量の認可が済んだことが一覧で分かる', after.usageLogin === true && after.hasToken === true);
    t.ok('使用量の認可と別のアカウントで発行したトークンは mismatch', after.tokenCheck?.status === 'mismatch' && after.tokenCheck.expectedEmail === 'work@example.com',
      JSON.stringify(after.tokenCheck));
    const usageDir = path.join(scratch, 'claude-usage', work.id);
    t.ok('資格情報はアカウントの設定フォルダに残る', await fs.access(path.join(usageDir, '.credentials.json')).then(() => true, () => false));

    const seen = (await fs.readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    t.ok('CLI に会話用のトークンを渡さない', seen.length >= 2 && seen.every(s => !s.hasOauthToken));
    t.ok('setup-token は使い捨ての設定フォルダで回し、使用量の認可はアカウントのフォルダで回す',
      seen[0].kind === 'setup-token' && seen[0].configDir.includes('claude-login-tmp')
      && seen.at(-1).kind === 'usage-login' && path.resolve(seen.at(-1).configDir) === path.resolve(usageDir));
    t.ok('使い捨ての設定フォルダは残さない', (await fs.readdir(path.join(scratch, 'claude-login-tmp')).catch(() => [])).length === 0);

    // ---- 取り消し
    const m3 = c.mark();
    const { loginId: d } = await c.cmd('claudeLoginStart', { kind: 'usage-login', accountId: work.id });
    await phase(d, 'code', m3);
    await c.cmd('claudeLoginCancel', { loginId: d });
    await phase(d, 'cancelled', m3);
    refused = null;
    await c.cmd('claudeLoginCode', { loginId: d, code: 'x' }).catch(e => { refused = e; });
    t.ok('取り消した認可にはコードを送れない', refused?.message.includes('終了しています'));
    t.ok('取り消しても認可済みの印は残る', (await c.cmd('claudeAccounts')).accounts.find(x => x.id === work.id).usageLogin === true);

    // ---- 削除
    await c.cmd('deleteClaudeAccount', { id: work.id });
    t.ok('削除すると使用量の設定フォルダも消える', await fs.access(usageDir).then(() => false, () => true));
    t.ok('サーバーのログにトークンを出さない', !server.tail(200).includes(FAKE_TOKEN));
    t.ok('記録したファイルの一覧にトークンを書かない', !(await fs.readFile(path.join(scratch, 'claude-accounts.json'), 'utf8')).includes('sk-ant-'));
    t.note(`イベント ${logins(0).length} 件`);
  } finally {
    c.close();
    await server.stop();
    await api.close();
    await fs.rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
