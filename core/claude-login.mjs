// Claude のアカウントの認可を Pleiad から行う（設定の「Claude のアカウント」）。
//
// 2 種類:
//   setup-token  `claude setup-token` を回し、表示された長期トークン（sk-ant-oat01-…）をアカウントの秘密へ直接しまう。
//                会話はこのトークンを CLAUDE_CODE_OAUTH_TOKEN で使う（core/claude-accounts.mjs）。
//   usage-login  アカウントごとの設定フォルダ（<data>/claude-usage/<id>）を CLAUDE_CONFIG_DIR にして `claude auth login` を回す。
//                setup-token のトークンは scope が user:inference だけで使用量を読めないため、使用量の読み取りだけに使う。
//
// `claude setup-token` は端末（TTY）が無いと何も出さずに止まる（2026-09-23 確認）ので、疑似端末（node-pty）の下で動かす。
// CLI は認可 URL と `Paste code here if prompted >` を出して、ブラウザーに表示されたコードを待つ。
// CLI 自身にはブラウザーを開かせない（BROWSER を存在しないパスにする。CLI は BROWSER を尊重し、開けなければ URL を出すだけ）。
// URL は Pleiad が開き、コードは画面で受け取って疑似端末へ書く。
//
// トークンは画面にも返さず、ログ・エラーメッセージからは伏せる。疑似端末の生成は差し替えられる（テストは偽物を使う）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { createRequire } from 'node:module';
import { t } from './i18n.mjs';

export const LOGIN_KINDS = new Set(['setup-token', 'usage-login']);
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const MAX_BUFFER = 256 * 1024;
const TOKEN_SETTLE_MS = 800;
const SUCCESS_EXIT_WAIT_MS = 5_000;

// ---------------------------------------------------------------- 出力の読み取り

/**
 * 端末の制御文字を落とした本文にする。OSC（ハイパーリンク `ESC]8;;URL ESC\` やウィンドウ題名）は中身ごと消す。
 * カーソルの移動（CSI … H / f、行の移動）は改行として扱う（ConPTY は折り返しや再描画を位置指定で出すことがある）。
 */
export function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')              // OSC … BEL / ST
    .replace(/\x1b\[[0-?]*[ -/]*[HfABEF]/g, '\n')                    // カーソル位置・行の移動
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')                          // そのほかの CSI（色・消去など）
    .replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, '')                         // DCS など
    .replace(/\x1b[@-Z\\-_]/g, '')                                    // 2 文字の ESC
    .replace(/\r\n/g, '\n')
    // 行の中の \r は行頭へ戻って書き直すもの。あとから書いた分を採る
    .split('\n').map(line => { const parts = line.split('\r').filter(Boolean); return parts.length ? parts.at(-1) : ''; }).join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

const URL_CHARS = /^[A-Za-z0-9%&=?._~:/+#@!$'()*,;[\]-]+$/;
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;
// 枠線（Ink の Box）や行頭・行末の空白は、折り返された続きの行を拾うときに取り除く
const trimFrame = line => line.replace(/^[\s│┃║|]+|[\s│┃║|]+$/g, '');

/** start から始まる値を、続く行が値の文字だけでできている間は折り返しとみなしてつなげる */
function joinWrapped(text, start, chars) {
  const lines = text.slice(start).split('\n');
  let value = (lines[0].match(/^\S+/) ?? [''])[0];
  // 1 行目の値のあとに別の文字があれば、折り返してはいない
  if (trimFrame(lines[0].slice(value.length))) return value;
  for (const line of lines.slice(1)) {
    const next = trimFrame(line);
    if (!next || !chars.test(next)) break;
    value += next;
  }
  return value;
}

/** 認可 URL（…/oauth/authorize?…）。無ければ null */
export function findAuthUrl(text) {
  const plain = stripAnsi(text);
  const re = /https:\/\/\S+/g;
  for (let m; (m = re.exec(plain));) {
    const url = joinWrapped(plain, m.index, URL_CHARS).replace(/[)>.,;'"\]]+$/, '');
    if (/\/oauth\/authorize\?/.test(url) && URL_CHARS.test(url)) return url;
  }
  return null;
}

/**
 * setup-token が表示したトークン。無ければ null。
 * 端末の再描画で一部だけが出ることもあるので、見つかったうちいちばん長いものを採る
 */
export function findToken(text) {
  const plain = stripAnsi(text);
  let best = null;
  const re = /sk-ant-[A-Za-z0-9_-]+/g;
  for (let m; (m = re.exec(plain));) {
    const token = joinWrapped(plain, m.index, TOKEN_CHARS).match(/^sk-ant-[A-Za-z0-9_-]+/)?.[0];
    if (token && token.length >= 20 && (!best || token.length > best.length)) best = token;
  }
  return best;
}

const PASTE_PROMPT = /paste\s+(?:the\s+)?(?:authentication\s+|authorization\s+)?code/gi;
export function countPastePrompts(text) { return (stripAnsi(text).match(PASTE_PROMPT) ?? []).length; }
const REJECTED = /\b(?:error|invalid|failed|expired|denied)\b/i;
const SUCCESS = /login successful|logged in (?:as|successfully)|successfully (?:logged|signed) in/i;

/** 文字列からトークン（sk-ant-…）と、渡された秘密（貼ったコードなど）を伏せる */
export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '').replace(/sk-ant-[A-Za-z0-9_-]+/g, t('claude.redacted.token'));
  for (const secret of secrets) if (secret && secret.length >= 4) s = s.split(secret).join(t('claude.redacted.secret'));
  return s;
}

/** 失敗したときに見せる、出力の末尾（制御文字を落とし、秘密を伏せる） */
export function outputTail(raw, secrets = [], max = 300) {
  const lines = stripAnsi(raw).split('\n').map(l => l.trim()).filter(Boolean)
    // URL・入力待ちの文・貼ったコードの折り返し表示（端末のエコー）は理由にならないので落とす
    .filter(l => !/https:\/\//.test(l) && !/paste\s+code/i.test(l) && !secrets.includes(l));
  const tail = redactSecrets(lines.slice(-3).join(' / '), secrets);
  return tail.length > max ? '…' + tail.slice(-max) : tail;
}

/** 貼られたコード。空白・改行が混じるものは断る（改行を混ぜて別の入力を送らせない） */
export function normalizeCode(value) {
  const code = String(value ?? '').trim();
  if (!code) throw new Error(t('claude.login.pasteCode'));
  if (!/^[\x21-\x7e]{1,2048}$/.test(code)) throw new Error(t('claude.login.badCode'));
  return code;
}

// ---------------------------------------------------------------- 起動

/**
 * ログインの子プロセスの env。会話用のトークン・API キーは渡さない（そちらが優先されて別のアカウントになる）。
 * CLI 自身にはブラウザーを開かせない（存在しないパスを BROWSER にする）。
 */
export function loginEnv(base = process.env, { configDir, noBrowser } = {}) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CONFIG_DIR'].includes(key.toUpperCase())) delete env[key];
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  env.BROWSER = noBrowser ?? path.join(os.tmpdir(), 'ply-no-browser', 'open-nothing');
  return env;
}

/** Windows の .cmd / .bat は cmd.exe 経由でしか起動できない */
function commandLine(argv, args) {
  const [command, ...prefix] = argv;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    const quote = v => { if (/["%\r\n]/.test(v)) throw new Error(t('cli.badArgument')); return `"${v}"`; };
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[command, ...prefix, ...args].map(quote).join(' ')}"`] };
  }
  return { file: command, args: [...prefix, ...args] };
}

let ptyModule;
/** node-pty を読む（入っていない・ビルドできていない環境では null） */
export function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  try { ptyModule = createRequire(import.meta.url)('node-pty'); }
  catch { ptyModule = null; }
  return ptyModule;
}

/**
 * 疑似端末で起動する。返すのは { onData, onExit, write, kill } だけの薄い形（テストの偽物と同じ形）。
 * 幅は十分に広くして、URL やトークンが折り返されにくいようにする（折り返されても findAuthUrl / findToken がつなげる）。
 */
export function ptySpawner(pty = loadPty()) {
  if (!pty) return null;
  return (argv, args, { env, cwd }) => {
    const { file, args: fullArgs } = commandLine(argv, args);
    const p = pty.spawn(file, fullArgs, { name: 'xterm-256color', cols: 1000, rows: 50, cwd, env });
    // 終わったあとに kill すると、Windows では node-pty の補助プロセスが AttachConsole failed で落ちる（害は無いが騒がしい）
    let exited = false;
    p.onExit(() => { exited = true; });
    return {
      pid: p.pid,
      onData: fn => p.onData(fn),
      onExit: fn => p.onExit(({ exitCode, signal }) => fn({ code: exitCode, signal })),
      write: data => { if (!exited) try { p.write(data); } catch {} },
      kill: () => { if (exited) return; exited = true; try { p.kill(); } catch {} },
    };
  };
}

/** 疑似端末が無いときの代わり（パイプ）。`claude auth login` はこれでも URL とコード待ちを出す（2026-09-23 確認） */
export function pipeSpawner() {
  return (argv, args, { env, cwd }) => {
    const { file, args: fullArgs } = commandLine(argv, args);
    const child = spawnChild(file, fullArgs, { env, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const dataFns = [], exitFns = [];
    let exited = false;
    const data = chunk => { for (const fn of dataFns) fn(String(chunk)); };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.on('error', e => { if (exited) return; exited = true; for (const fn of exitFns) fn({ code: null, error: e }); });
    child.on('exit', (code, signal) => { if (exited) return; exited = true; for (const fn of exitFns) fn({ code, signal }); });
    return {
      pid: child.pid,
      onData: fn => dataFns.push(fn),
      onExit: fn => exitFns.push(fn),
      write: s => { try { child.stdin.write(s.replace(/\r$/, '\n')); } catch {} },
      kill: () => {
        if (exited) return;
        if (process.platform === 'win32' && child.pid) spawnChild('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        else try { child.kill('SIGTERM'); } catch {}
      },
    };
  };
}

// ---------------------------------------------------------------- セッション

/**
 * @param {object} o
 * @param {() => string[] | null} o.command   Claude Code の argv（cli-installation の cliCommand('claude')）
 * @param {(event: object) => void} o.emit     画面へ送る { phase: url|code|verifying|done|error|cancelled, ... }
 * @param {(o: { accountId?: string, name?: string, token: string }) => Promise<{ id: string }>} o.saveToken
 * @param {(accountId: string) => string} o.usageDir         使用量用の設定フォルダ
 * @param {(accountId: string) => Promise<void>} o.markUsageLogin
 * @param {string} o.scratchDir   setup-token を回す使い捨ての設定フォルダの置き場
 * @param {Function} [o.spawn]    疑似端末の生成（既定は node-pty。無ければパイプ）
 * @param {(url: string) => void} [o.openExternal]
 */
export function createClaudeLogin({ command, emit, saveToken, usageDir, markUsageLogin, scratchDir, spawn, pipe = pipeSpawner(),
  openExternal = () => {}, timeoutMs = LOGIN_TIMEOUT_MS, env: baseEnv = process.env } = {}) {
  const sessions = new Map();
  const pickSpawner = kind => {
    const pty = spawn === undefined ? ptySpawner() : spawn;
    if (pty) return pty;
    // setup-token は TTY が無いと止まるので、パイプでは代われない
    if (kind === 'usage-login') return pipe;
    return null;
  };

  function finish(s, event) {
    if (s.ended) return;
    s.ended = true;
    clearTimeout(s.timer); clearTimeout(s.settle); clearTimeout(s.exitWait);
    sessions.delete(s.id);
    // 済んだときは自分で終わるのを少し待つ（終わりかけを kill すると Windows で node-pty の補助が騒ぐ）。取り消し・失敗はすぐ止める
    if (event.phase === 'done') setTimeout(() => s.proc?.kill(), 1500).unref?.();
    else s.proc?.kill();
    if (s.scratch) fs.rm(s.scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }, () => {});
    send(s, event);
  }
  function send(s, event) {
    emit({ type: 'claudeLogin', loginId: s.id, kind: s.kind, accountId: s.accountId ?? null, ...event });
  }
  function fail(s, message) {
    finish(s, { phase: 'error', message: redactSecrets(message, s.codes) });
  }

  async function complete(s) {
    if (s.ended || s.completing) return;
    s.completing = true;
    clearTimeout(s.timer); clearTimeout(s.settle); clearTimeout(s.exitWait);
    try {
      if (s.kind === 'setup-token') {
        const token = findToken(s.raw);
        if (!token) throw new Error(t('claude.login.tokenUnreadable'));
        const saved = await saveToken({ accountId: s.accountId, name: s.name, token });
        s.accountId = saved.id;
      } else {
        await markUsageLogin(s.accountId);
      }
      finish(s, { phase: 'done' });
    } catch (e) {
      fail(s, t('claude.login.saveFailed', { message: e?.message ?? e }));
    }
  }

  function onData(s, chunk) {
    if (s.ended || s.completing) return;
    s.raw += chunk;
    if (s.raw.length > MAX_BUFFER) s.raw = s.raw.slice(-MAX_BUFFER);
    if (!s.url) {
      const url = findAuthUrl(s.raw);
      if (url) {
        s.url = url;
        send(s, { phase: 'url', url });
        if (s.open) { try { openExternal(url); } catch {} }
      }
    }
    if (s.url && !s.codeAsked && countPastePrompts(s.raw) > 0) {
      s.codeAsked = true; s.waitingCode = true;
      send(s, { phase: 'code' });
    } else if (s.submitted && !s.waitingCode && countPastePrompts(s.raw.slice(s.submittedAt)) > 0 && REJECTED.test(stripAnsi(s.raw.slice(s.submittedAt)))) {
      // コードを送ったあとに失敗の文面とともにもう一度聞かれた＝受け付けられなかった
      // （送ったコードを入力欄が表示し直すだけでは、失敗の文面が無いので数えない）
      const tail = outputTail(s.raw.slice(s.submittedAt), s.codes, 160);
      s.waitingCode = true; s.submittedAt = s.raw.length;
      send(s, { phase: 'code', message: tail ? t('claude.login.codeRejectedDetail', { detail: tail }) : t('claude.login.codeRejected') });
    }
    if (s.kind === 'setup-token' && findToken(s.raw)) {
      // 折り返しの続きが届くまで少し待ってから読む
      clearTimeout(s.settle);
      s.settle = setTimeout(() => complete(s), TOKEN_SETTLE_MS);
    }
    if (s.kind === 'usage-login' && s.submitted && !s.exitWait && SUCCESS.test(stripAnsi(s.raw.slice(s.submittedAt)))) {
      // 成功を表示したあと終わらないときは、少し待って閉じる
      s.exitWait = setTimeout(() => complete(s), SUCCESS_EXIT_WAIT_MS);
    }
  }

  function onExit(s, { code, error }) {
    if (s.ended || s.completing) return;
    if (s.kind === 'setup-token' && findToken(s.raw)) return void complete(s);
    if (s.kind === 'usage-login' && code === 0 && s.url) return void complete(s);
    const tail = outputTail(s.raw, s.codes);
    const exitCode = code ?? t('claude.login.unknownCode');
    const why = error ? t('claude.login.launchFailed', { message: error.message })
      : tail ? t('claude.login.exitedDetail', { code: exitCode, detail: tail }) : t('claude.login.exited', { code: exitCode });
    fail(s, why);
  }

  function cancelWhere(pred) {
    for (const s of [...sessions.values()]) if (pred(s)) finish(s, { phase: 'cancelled' });
  }

  return {
    /**
     * 始める。同じアカウント（新規の setup-token は名前ごと）の進行中のものは取り消してから始める。
     * @returns {{ loginId: string }}
     */
    start({ kind, accountId, name, open = false } = {}) {
      if (!LOGIN_KINDS.has(kind)) throw new Error(t('claude.login.badKind'));
      if (kind === 'usage-login' && !accountId) throw new Error(t('claude.login.accountRequired'));
      const argv = command();
      if (!argv) throw new Error(t('claude.login.notInstalled'));
      const spawner = pickSpawner(kind);
      if (!spawner) throw new Error(t('claude.login.noPty'));
      // 一度に 1 つだけ（コードの貼り付け先を取り違えないように）
      cancelWhere(() => true);

      const id = 'login-' + crypto.randomBytes(8).toString('hex');
      const s = { id, kind, accountId: accountId || null, name, open, raw: '', url: null, codeAsked: false, submitted: 0, submittedAt: 0, codes: [], ended: false };
      let configDir;
      if (kind === 'usage-login') configDir = usageDir(accountId);
      else configDir = s.scratch = path.join(scratchDir, id);
      fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
      const env = loginEnv(baseEnv, { configDir });
      const args = kind === 'setup-token' ? ['setup-token'] : ['auth', 'login', '--claudeai'];
      try { s.proc = spawner(argv, args, { env, cwd: configDir }); }
      catch (e) {
        if (s.scratch) fs.rmSync(s.scratch, { recursive: true, force: true });
        throw new Error(t('claude.login.launchFailed', { message: e?.message ?? e }));
      }
      sessions.set(id, s);
      s.proc.onData(chunk => onData(s, String(chunk)));
      s.proc.onExit(e => onExit(s, e ?? {}));
      s.timer = setTimeout(() => fail(s, t('claude.login.timeout')), timeoutMs);
      s.timer.unref?.();
      return { loginId: id };
    },
    /** ブラウザーに表示されたコードを CLI へ渡す */
    submitCode(loginId, value) {
      const s = sessions.get(loginId);
      if (!s) throw new Error(t('claude.login.ended'));
      if (!s.url) throw new Error(t('claude.login.notReady'));
      const code = normalizeCode(value);
      s.codes.push(code);
      s.submitted++; s.submittedAt = s.raw.length; s.waitingCode = false;
      s.proc.write(code);
      // 貼り付けと Enter を分けて送る（まとめると貼り付けの一部として扱う入力欄がある）
      setTimeout(() => { if (!s.ended) s.proc.write('\r'); }, 150);
      send(s, { phase: 'verifying' });
      return {};
    },
    cancel(loginId) {
      const s = sessions.get(loginId);
      if (s) finish(s, { phase: 'cancelled' });
      return {};
    },
    /** アカウントを消すとき・終了するとき */
    cancelAccount(accountId) { cancelWhere(s => s.accountId === accountId); },
    cancelAll() { cancelWhere(() => true); },
    active() { return [...sessions.values()].map(s => ({ loginId: s.id, kind: s.kind, accountId: s.accountId, url: s.url, waitingCode: Boolean(s.waitingCode) })); },
  };
}
