// Claude のアカウントの認可を Pleiad から回す（core/claude-login.mjs）。本物の Claude Code もネットワークも使わない。
// 出力の読み取り（ANSI・OSC 8・折り返し）、トークンを伏せること、疑似端末の偽物での進み方（URL → コード → 完了 / 失敗 / 時間切れ / 取り消し）、
// 使用量の設定フォルダの env を確かめる。node-pty が読めれば、偽の CLI（tests/lib/fake-claude-login.mjs）を本物の疑似端末でも回す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripAnsi, findAuthUrl, findToken, redactSecrets, outputTail, normalizeCode, loginEnv, createClaudeLogin, ptySpawner, loadPty, pipeSpawner,
} from '../../core/claude-login.mjs';
import { usageEnv, readClaudeAccountsUsage, NEEDS_USAGE_LOGIN } from '../../core/backends/claude-usage.mjs';

export const name = 'claude-login';
export const title = 'Claude のアカウントの認可: 出力の読み取り・トークンを伏せる・疑似端末での進み方・使用量の設定フォルダ';

const FAKE_CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'fake-claude-login.mjs');
const TOKEN = 'sk-ant-oat01-' + 'Ab3_-'.repeat(18) + 'xyz';
const URL_ = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=c5pB1vM5&code_challenge_method=S256&state=IrIZK6KP';
// tests/lib/fake-claude-login.mjs が出すものと同じ（あちらは読み込むと CLI として動き出すので、ここに写す）
const FAKE_TOKEN = 'sk-ant-oat01-' + 'Zq9_'.repeat(20) + 'end';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(pred, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return false;
}

/** 疑似端末の偽物。テストから出力を流し込み、書かれた入力を見る */
function fakePty() {
  const procs = [];
  const spawn = (argv, args, opts) => {
    const p = { argv, args, opts, written: [], killed: false, dataFns: [], exitFns: [] };
    p.api = {
      onData: fn => p.dataFns.push(fn), onExit: fn => p.exitFns.push(fn),
      write: s => p.written.push(s), kill: () => { p.killed = true; },
    };
    p.emit = s => p.dataFns.forEach(fn => fn(s));
    p.exit = code => p.exitFns.forEach(fn => fn({ code }));
    procs.push(p);
    return p.api;
  };
  return { spawn, procs, last: () => procs.at(-1) };
}

export default async function (t) {
  // ---- 出力の読み取り
  // 2026-09-23 に node-pty の下で見た `claude auth login` の出力そのままの形（OSC 8 のハイパーリンク付き）
  const observed = `\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;claude\x07\x1b[?25hOpening browser to sign in…\r\nIf the browser didn't open, visit: \x1b[94m\x1b]8;id=41360-1;${URL_}\x1b\\${URL_}\x1b[m\x1b]8;;\x1b\\\r\nPaste code here if prompted > `;
  t.ok('OSC 8 のハイパーリンクを外して URL を 1 つだけ読む', findAuthUrl(observed) === URL_, findAuthUrl(observed));
  t.ok('制御文字を落とすと本文だけが残る', stripAnsi(observed).includes('Paste code here if prompted >') && !stripAnsi(observed).includes('\x1b'));
  const wrappedUrl = `Browser didn't open? Use the url below to sign in:\r\n\r\n\x1b[94m${URL_.match(/.{1,70}/g).join('\x1b[m\r\n\x1b[94m')}\x1b[m\r\n\r\nPaste code here if prompted > `;
  t.ok('折り返された URL を行をまたいでつなげる', findAuthUrl(wrappedUrl) === URL_, findAuthUrl(wrappedUrl));
  const positioned = `${URL_.slice(0, 100)}\x1b[5;1H${URL_.slice(100)}\x1b[7;1HPaste code here if prompted >`;
  t.ok('カーソル位置の指定で折り返されていてもつなげる', findAuthUrl(positioned) === URL_);
  t.ok('認可以外の URL は拾わない', findAuthUrl('see https://code.claude.com/docs/en/setup for help') === null);
  t.ok('次の行の文章は URL につなげない', findAuthUrl(`${URL_}\r\nPaste code here`) === URL_);

  const tokenOut = `\r\n\x1b[32m✓ created\x1b[39m\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[33m${TOKEN.slice(0, 40)}\r\n${TOKEN.slice(40)}\x1b[39m\r\n\r\nStore this token securely.`;
  t.ok('折り返されたトークンをつなげて読む', findToken(tokenOut) === TOKEN, findToken(tokenOut));
  t.ok('枠線（│）の中のトークンも読む', findToken(`│ ${TOKEN.slice(0, 30)} │\r\n│ ${TOKEN.slice(30)} │\r\n`) === TOKEN);
  t.ok('1 行のトークン', findToken(`token: ${TOKEN}\n`) === TOKEN);
  t.ok('再描画で一部だけ出たものより、全体を採る', findToken(`${TOKEN.slice(0, 30)}\x1b[2K\r${TOKEN}\r\n`) === TOKEN);
  t.ok('トークンが無ければ null', findToken('Paste code here if prompted >') === null && findToken('sk-ant-short') === null);

  // ---- 伏せる
  t.ok('出力からトークンを伏せる', !redactSecrets(`bad ${TOKEN} x`).includes('sk-ant-') && redactSecrets(`bad ${TOKEN}`).includes('[トークン]'));
  t.ok('貼ったコードも伏せる', redactSecrets('invalid code abcd#efgh', ['abcd#efgh']) === 'invalid code [伏せ字]');
  const tail = outputTail(`${observed}\r\nOAuth error: ${TOKEN} rejected\r\n`);
  t.ok('失敗の末尾は制御文字・URL・トークンを含まない', tail.includes('OAuth error') && !tail.includes('sk-ant-') && !tail.includes('https://') && !tail.includes('\x1b'), tail);
  t.ok('コードの前後の空白は落とす', normalizeCode('  abc#def \n') === 'abc#def');
  let bad = null; try { normalizeCode('abc\ndef'); } catch (e) { bad = e; }
  t.ok('改行を含むコードは断る（別の入力を送らせない）', Boolean(bad));

  // ---- env
  const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: 'sk-api', CLAUDE_CONFIG_DIR: '/shared', CLAUDECODE: '1' };
  const env = loginEnv(base, { configDir: '/data/claude-usage/acct-1' });
  t.ok('ログインの env から会話用のトークン・API キーを外す', !env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY && !env.CLAUDECODE && env.PATH === '/bin');
  t.ok('ログインは指定した設定フォルダで回す', env.CLAUDE_CONFIG_DIR === '/data/claude-usage/acct-1');
  t.ok('CLI 自身にはブラウザーを開かせない（BROWSER を存在しないパスに）', typeof env.BROWSER === 'string' && env.BROWSER.includes('ply-no-browser'));
  t.ok('base は書き換えない', base.CLAUDE_CODE_OAUTH_TOKEN === TOKEN && base.CLAUDE_CONFIG_DIR === '/shared');
  const uenv = usageEnv(base, { configDir: '/data/claude-usage/acct-1' });
  t.ok('使用量はアカウントの設定フォルダで読み、会話用のトークンは渡さない', uenv.CLAUDE_CONFIG_DIR === '/data/claude-usage/acct-1' && !('CLAUDE_CODE_OAUTH_TOKEN' in uenv));
  const plainEnv = usageEnv({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/shared' }, {});
  t.ok('ログイン中のアカウントの使用量は今までどおり（設定フォルダを変えない）', plainEnv.CLAUDE_CONFIG_DIR === '/shared' && !plainEnv.CLAUDE_CODE_OAUTH_TOKEN);

  // ---- 使用量の並べ方
  const reads = [];
  const read = async ({ configDir, token } = {}) => {
    reads.push({ configDir: configDir ?? null, token: token ?? null });
    if (configDir === '/u/broken') throw new Error(`denied ${TOKEN}`);
    return { plan: configDir ? 'max' : 'pro', windows: [{ label: '5時間', usedPercent: 10 }] };
  };
  const single = await readClaudeAccountsUsage({ accounts: [], read });
  t.ok('登録が無ければ今までどおりログイン中の値だけ', single.plan === 'pro' && !single.accounts && reads.length === 1);
  reads.length = 0;
  const many = await readClaudeAccountsUsage({ read, accounts: [
    { id: 'a1', name: '仕事用', configDir: '/u/a1', usageLogin: true },
    { id: 'a2', name: '個人用', configDir: '/u/a2', usageLogin: false },
    { id: 'a3', name: '壊れた', configDir: '/u/broken', usageLogin: true }] });
  t.ok('アカウントごとに見出しを付けて並べる', many.accounts.map(a => a.label).join() === 'ログイン中のアカウント,仕事用,個人用,壊れた');
  t.ok('認可済みのアカウントはその設定フォルダで読む（トークンは使わない）', reads.some(r => r.configDir === '/u/a1') && reads.every(r => r.token === null) && many.accounts[1].plan === 'max');
  t.ok('未認可のアカウントは読みに行かず、認可を促す', !reads.some(r => r.configDir === '/u/a2') && many.accounts[2].needsUsageLogin === true
    && many.accounts[2].message === NEEDS_USAGE_LOGIN && many.accounts[2].accountId === 'a2');
  t.ok('取れなかったアカウントは理由と「やり直す」を出し、トークンは伏せる', many.accounts[3].reauth === true && !many.accounts[3].message.includes(TOKEN));

  // ---- セッション（疑似端末の偽物）
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-login-'));
  try {
    const events = [];
    const saved = [];
    const marked = [];
    const opened = [];
    const pty = fakePty();
    const login = createClaudeLogin({
      command: () => ['/bin/claude'], emit: e => events.push(e), spawn: pty.spawn,
      saveToken: async o => { saved.push(o); return { id: o.accountId ?? 'acct-new' }; },
      usageDir: id => path.join(dir, 'claude-usage', id), markUsageLogin: async id => { marked.push(id); },
      scratchDir: path.join(dir, 'tmp'), openExternal: url => opened.push(url), env: base,
    });
    const of = id => events.filter(e => e.loginId === id);

    // setup-token（新規）
    const { loginId: a } = login.start({ kind: 'setup-token', name: '仕事用', open: true });
    const pa = pty.last();
    t.ok('setup-token を起動する', pa.args.join(' ') === 'setup-token' && pa.opts.env.CLAUDE_CONFIG_DIR.startsWith(path.join(dir, 'tmp')) && !pa.opts.env.CLAUDE_CODE_OAUTH_TOKEN);
    const scratch = pa.opts.env.CLAUDE_CONFIG_DIR;
    pa.emit(observed.slice(0, 120));
    t.ok('URL が揃うまでは知らせない', of(a).length === 0);
    pa.emit(observed.slice(120));
    t.ok('URL を知らせ、続けてコードを待つ', of(a).map(e => e.phase).join() === 'url,code' && of(a)[0].url === URL_);
    t.ok('open なら既定のブラウザーで開くよう頼む', opened.length === 1 && opened[0] === URL_);
    let early = null; try { login.submitCode('login-nope', 'x'); } catch (e) { early = e; }
    t.ok('終わった・知らない認可にはコードを送れない', Boolean(early));
    login.submitCode(a, ' abc#def ');
    await sleep(200);
    t.ok('コードと Enter を分けて書く', pa.written.join('|') === 'abc#def|\r');
    t.ok('確認中を知らせる', of(a).at(-1).phase === 'verifying');
    // 失敗の文面とともにもう一度聞かれた
    pa.emit('abc#def\r\n\x1b[31mOAuth error: Invalid code abc#def\x1b[39m\r\nPaste code here if prompted > ');
    const retry = of(a).at(-1);
    t.ok('受け付けられなかったらもう一度コードを待ち、理由を添える（コードは伏せる）', retry.phase === 'code' && retry.message.includes('Invalid code') && !retry.message.includes('abc#def'));
    login.submitCode(a, 'good#code');
    await sleep(200);
    pa.emit('good#code\r\n');
    t.ok('入力欄がコードを表示し直すだけでは失敗にしない', of(a).at(-1).phase === 'verifying');
    pa.emit(tokenOut.slice(0, 120));
    pa.emit(tokenOut.slice(120));
    t.ok('トークンが揃うまで少し待つ', saved.length === 0);
    await until(() => of(a).some(e => e.phase === 'done'), 3000);
    t.ok('トークンを読んで保存する（新規は名前で）', saved.length === 1 && saved[0].token === TOKEN && saved[0].name === '仕事用' && !saved[0].accountId);
    t.ok('完了を知らせ、作ったアカウントの id を返す', of(a).at(-1).phase === 'done' && of(a).at(-1).accountId === 'acct-new');
    t.ok('終わったら（自分で終わらなければ少し待って）CLI を止める', await until(() => pa.killed, 3000));
    t.ok('どのイベントにもトークンを載せない', !JSON.stringify(events).includes('sk-ant-'));
    await sleep(300);
    t.ok('使い捨ての設定フォルダを消す', await fs.access(scratch).then(() => false, () => true));

    // setup-token: トークンを出さずに終わった
    const { loginId: b } = login.start({ kind: 'setup-token', accountId: 'acct-1', name: '個人用' });
    const pb = pty.last();
    pb.emit(observed);
    pb.emit('\r\nOAuth error: request failed with status 400 (code abc#def)\r\n');
    pb.exit(1);
    const failed = of(b).at(-1);
    t.ok('トークン無しで終わったら失敗を知らせる（終了コードと末尾、トークンは伏せる）', failed.phase === 'error' && failed.message.includes('終了コード 1') && failed.message.includes('status 400') && !failed.message.includes('sk-ant-'), JSON.stringify(failed));

    // usage-login
    const { loginId: c } = login.start({ kind: 'usage-login', accountId: 'acct-1' });
    const pc = pty.last();
    t.ok('使用量の認可は auth login をアカウントの設定フォルダで回す', pc.args.join(' ') === 'auth login --claudeai'
      && pc.opts.env.CLAUDE_CONFIG_DIR === path.join(dir, 'claude-usage', 'acct-1') && !pc.opts.env.CLAUDE_CODE_OAUTH_TOKEN && !pc.opts.env.ANTHROPIC_API_KEY);
    t.ok('設定フォルダを作る', await fs.stat(path.join(dir, 'claude-usage', 'acct-1')).then(s => s.isDirectory(), () => false));
    t.ok('open でなければブラウザーを開かない', (pc.emit(observed), opened.length === 1));
    login.submitCode(c, 'ok#code');
    pc.emit('\r\nLogin successful.\r\n');
    pc.exit(0);
    await until(() => of(c).some(e => e.phase === 'done'));
    t.ok('終了コード 0 で認可済みの印を付ける', marked.join() === 'acct-1' && of(c).at(-1).phase === 'done');

    // usage-login: 成功を出したまま終わらない
    const { loginId: c2 } = login.start({ kind: 'usage-login', accountId: 'acct-2' });
    const pc2 = pty.last();
    pc2.emit(observed); login.submitCode(c2, 'ok#code'); pc2.emit('\r\nLogin successful.\r\n');
    t.ok('成功の表示だけではすぐには完了にしない（終了を待つ）', !of(c2).some(e => e.phase === 'done'));

    // 取り消し・1 つだけ
    const { loginId: d } = login.start({ kind: 'usage-login', accountId: 'acct-3' });
    t.ok('新しく始めると前のものは取り消す', of(c2).at(-1).phase === 'cancelled' && pc2.killed);
    login.cancel(d);
    t.ok('取り消すと CLI を止めて知らせる', of(d).at(-1).phase === 'cancelled' && pty.last().killed);
    let gone = null; try { login.submitCode(d, 'x'); } catch (e) { gone = e; }
    t.ok('取り消したものにはコードを送れない', Boolean(gone));
    login.start({ kind: 'usage-login', accountId: 'acct-4' });
    const p4 = pty.last();
    login.cancelAccount('acct-4');
    t.ok('アカウントを消すと、その認可を止める', p4.killed && login.active().length === 0);

    // 起動できない
    let noKind = null; try { login.start({ kind: 'other' }); } catch (e) { noKind = e; }
    t.ok('知らない種類は断る', Boolean(noKind));
    const noCli = createClaudeLogin({ command: () => null, emit: () => {}, spawn: pty.spawn, scratchDir: dir, usageDir: () => dir });
    let missing = null; try { noCli.start({ kind: 'setup-token', name: 'x' }); } catch (e) { missing = e; }
    t.ok('Claude Code が無ければ理由を返す', missing?.message.includes('Claude Code'));
    const noPty = createClaudeLogin({ command: () => ['/bin/claude'], emit: () => {}, spawn: null, pipe: pty.spawn, scratchDir: dir, usageDir: id => path.join(dir, id) });
    let noTty = null; try { noPty.start({ kind: 'setup-token', name: 'x' }); } catch (e) { noTty = e; }
    t.ok('疑似端末が無いと setup-token は手動の貼り付けへ案内する', noTty?.message.includes('claude setup-token') && noTty.message.includes('貼り付け'));
    const before = pty.procs.length;
    noPty.start({ kind: 'usage-login', accountId: 'acct-5' });
    t.ok('疑似端末が無くても使用量の認可はパイプで回す', pty.procs.length === before + 1);
    noPty.cancelAll();

    // 時間切れ
    const quick = createClaudeLogin({ command: () => ['/bin/claude'], emit: e => events.push(e), spawn: pty.spawn, timeoutMs: 50,
      scratchDir: path.join(dir, 'tmp'), usageDir: id => path.join(dir, id) });
    const { loginId: q } = quick.start({ kind: 'setup-token', name: 'x' });
    await until(() => of(q).some(e => e.phase === 'error'), 2000);
    t.ok('時間切れで止めて知らせる', of(q).at(-1)?.phase === 'error' && of(q).at(-1).message.includes('時間切れ') && pty.last().killed);

    // ---- 本物の疑似端末（node-pty）で偽の CLI を回す
    const realPty = loadPty();
    if (!realPty) t.note('node-pty を読めないので、本物の疑似端末での確認はとばす');
    for (const [label, spawner] of [['疑似端末', realPty ? ptySpawner(realPty) : null], ['パイプ', pipeSpawner()]]) {
      if (!spawner) continue;
      const log = path.join(dir, `fake-${label}.log`);
      const realEvents = [];
      const realSaved = [];
      const real = createClaudeLogin({
        command: () => [process.execPath, FAKE_CLI], emit: e => realEvents.push(e), spawn: spawner,
        saveToken: async o => { realSaved.push(o.token); return { id: 'acct-real' }; },
        usageDir: id => path.join(dir, 'claude-usage', id), markUsageLogin: async () => {},
        scratchDir: path.join(dir, 'tmp'), env: { ...process.env, FAKE_CLAUDE_LOG: log, CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
      });
      const kinds = label === 'パイプ' ? ['usage-login'] : ['setup-token', 'usage-login'];
      for (const kind of kinds) {
        const { loginId } = real.start({ kind, ...(kind === 'setup-token' ? { name: 'real' } : { accountId: 'acct-real' }) });
        const mine = () => realEvents.filter(e => e.loginId === loginId);
        const asked = await until(() => mine().some(e => e.phase === 'code'), 20_000);
        t.ok(`${label}: ${kind} の URL とコード待ちを読む`, asked && mine().find(e => e.phase === 'url')?.url?.startsWith('https://claude.com/cai/oauth/authorize?code=true'), JSON.stringify(mine()));
        if (!asked) { real.cancelAll(); continue; }
        real.submitCode(loginId, 'bad');
        const retried = await until(() => mine().filter(e => e.phase === 'code').length >= 2, 10_000);
        t.ok(`${label}: ${kind} で受け付けられなかったコードを知らせる`, retried && mine().filter(e => e.phase === 'code').at(-1).message?.includes('Invalid code'), JSON.stringify(mine().at(-1)));
        real.submitCode(loginId, 'good#1');
        const done = await until(() => mine().some(e => ['done', 'error'].includes(e.phase)), 20_000);
        t.ok(`${label}: ${kind} を最後まで進める`, done && mine().at(-1).phase === 'done', JSON.stringify(mine().at(-1)));
      }
      if (kinds.includes('setup-token')) {
        t.ok(`${label}: 折り返されたトークンをそのまま保存する`, realSaved.length === 1 && realSaved[0] === FAKE_TOKEN, realSaved[0]?.length);
        t.ok(`${label}: イベントにトークンを載せない`, !JSON.stringify(realEvents).includes('sk-ant-'));
      }
      const seen = (await fs.readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
      t.ok(`${label}: CLI に会話用のトークン・API キーを渡さず、BROWSER を差し替える`, seen.length === kinds.length && seen.every(s => !s.hasOauthToken && !s.hasApiKey && s.browser?.includes('ply-no-browser')));
      t.ok(`${label}: 使用量の認可はアカウントの設定フォルダに資格情報を残す`, await fs.access(path.join(dir, 'claude-usage', 'acct-real', '.credentials.json')).then(() => true, () => false));
      await fs.rm(path.join(dir, 'claude-usage', 'acct-real'), { recursive: true, force: true });
    }
  } finally {
    await sleep(300);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}
