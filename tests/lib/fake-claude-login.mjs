// `claude setup-token` / `claude auth login` の偽物（core/claude-login.mjs のテスト用）。本物の CLI もネットワークも使わない。
//
// 本物（2026-09-23 に観察した範囲）に似せて、ANSI の色・OSC 8 のハイパーリンク・折り返し（\r\n）付きで認可 URL を出し、
// `Paste code here if prompted >` でコードを待つ。
//   コード "bad"  … エラーを出してもう一度聞く
//   コード "exit" … 終了コード 1 で終わる
//   それ以外      … setup-token はトークンを 2 行に折り返して出す（FAKE_CLAUDE_LINGER=1 なら終わらずに待ち続ける）。
//                   auth login は CLAUDE_CONFIG_DIR/.credentials.json（FAKE_CLAUDE_ORG があれば .claude.json も）を書いて終了コード 0
// FAKE_CLAUDE_LOG があれば、受け取った env の要点（トークンの有無・CLAUDE_CONFIG_DIR・BROWSER）を JSON で書く。
import fs from 'node:fs';
import path from 'node:path';

export const FAKE_TOKEN = 'sk-ant-oat01-' + 'Zq9_'.repeat(20) + 'end';
const [, , ...args] = process.argv;
const kind = args[0] === 'setup-token' ? 'setup-token' : args[0] === 'auth' && args[1] === 'login' ? 'usage-login' : null;
const out = s => process.stdout.write(s);

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    kind, args, hasOauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN), hasApiKey: Boolean(process.env.ANTHROPIC_API_KEY),
    configDir: process.env.CLAUDE_CONFIG_DIR ?? null, browser: process.env.BROWSER ?? null,
  }) + '\n');
}
if (!kind) { out('unknown command\n'); process.exit(2); }

const scope = kind === 'setup-token' ? 'user%3Ainference' : 'org%3Acreate_api_key+user%3Aprofile+user%3Ainference';
const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-fake&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=${scope}&code_challenge=abcDEF123_-xyz&code_challenge_method=S256&state=STATE_fake-123`;
// 80 桁で折り返し、色とハイパーリンクで包む（本物の PTY 出力に似せる）
const wrapped = url.match(/.{1,80}/g).join('\r\n');
out('\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25h');
out(kind === 'setup-token' ? '\x1b[1mSet up a long-lived token\x1b[22m\r\n\r\n' : 'Opening browser to sign in…\r\n');
out(`Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b[94m\x1b]8;id=1;${url}\x1b\\${wrapped}\x1b[m\x1b]8;;\x1b\\\r\n\r\n`);
const prompt = () => out('Paste code here if prompted > ');
prompt();

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  const lines = buffer.split(/\r\n|\r|\n/);
  buffer = lines.pop();
  for (const line of lines) handle(line.trim());
});

function handle(code) {
  if (!code) return;
  if (code === 'bad') { out('\r\n\x1b[31mOAuth error: Invalid code\x1b[39m\r\n'); prompt(); return; }
  if (code === 'exit') { out('\r\nOAuth error: request failed with status 400\r\n'); process.exit(1); }
  if (kind === 'setup-token') {
    out('\r\n\x1b[32m✓ Long-lived authentication token created successfully!\x1b[39m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n');
    out(`\x1b[33m${FAKE_TOKEN.slice(0, 50)}\r\n${FAKE_TOKEN.slice(50)}\x1b[39m\r\n\r\nStore this token securely. You won't be able to see it again.\r\n`);
    if (process.env.FAKE_CLAUDE_LINGER === '1') { out('Press Enter to continue…'); return; }
    process.exit(0);
  }
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir) fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-access', scopes: ['user:profile'] } }));
  // 本物は認可したアカウントを CLAUDE_CONFIG_DIR/.claude.json の oauthAccount に書く（FAKE_CLAUDE_ORG があれば真似る）
  if (dir && process.env.FAKE_CLAUDE_ORG) {
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: process.env.FAKE_CLAUDE_ORG, emailAddress: process.env.FAKE_CLAUDE_EMAIL ?? 'fake@example.com' } }));
  }
  out('\r\nLogin successful.\r\n');
  process.exit(0);
}
