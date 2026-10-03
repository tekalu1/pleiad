// 入力欄の `!`（シェルの行）で、人が打ったコマンドをホストのシェルで走らせる（ADR 0054、docs/multi-backend.md「シェルの行」）。
// Claude と fake はここで走らせ、結果を次の発言と一緒にエージェントへ渡す（core/shell-runs.mjs）。Codex は app-server が走らせる。
//
// - シェル: AGENT_HOST_SHELL があればそれ。Windows は Git Bash（CLI の `!` の既定と同じ bash）、無ければ PowerShell。
//   ほかの OS は $SHELL、無ければ /bin/sh
// - 標準入力は渡さない（閉じる）。対話が要るコマンドは入力を待たずに終わるか、止めるまで止まっている
// - 上限の時間を過ぎたら、子のプロセスごと止める
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { classifySystemMessages } from './system-messages.mjs';

/** 出力を貯める上限（stdout・stderr それぞれ）。越えた分は捨て、truncated を立てる */
export const OUTPUT_LIMIT = 256 * 1024;

const argsFor = (file, command) => {
  const base = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if (base === 'powershell' || base === 'pwsh') return ['-NoProfile', '-NonInteractive', '-Command', command];
  if (base === 'cmd') return ['/d', '/s', '/c', command];
  return ['-c', command];
};

/** 走らせるシェル。{ file, name } か、見つからなければ null */
export function hostShell(env = process.env) {
  if (env.AGENT_HOST_SHELL) return { file: env.AGENT_HOST_SHELL, name: path.basename(env.AGENT_HOST_SHELL).replace(/\.exe$/i, '') };
  if (process.platform === 'win32') {
    const bash = [env.CLAUDE_CODE_GIT_BASH_PATH, 'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe'].filter(Boolean).find(p => fs.existsSync(p));
    if (bash) return { file: bash, name: 'bash' };
    const root = env.SystemRoot || 'C:/Windows';
    return { file: path.join(root, 'System32/WindowsPowerShell/v1.0/powershell.exe'), name: 'powershell' };
  }
  const file = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : '/bin/sh';
  return { file, name: path.basename(file) };
}

/**
 * コマンドを 1 回走らせる。
 * @returns Promise<{ exitCode, signal, stdout, stderr, durationMs, timedOut, stopped, truncated, startError? }>
 *   exitCode は分からなければ null（止めた・上限・起動できない）
 */
export function runHostShell({ command, cwd, timeoutMs, signal, onOutput = () => {}, env = process.env }) {
  return new Promise(resolve => {
    const started = Date.now();
    const out = { stdout: '', stderr: '' };
    let truncated = false, timedOut = false, stopped = false, done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      resolve({ exitCode: null, signal: null, ...out, durationMs: Date.now() - started, timedOut, stopped, truncated, ...r });
    };
    if (signal?.aborted) { stopped = true; finish({}); return; }
    const shell = hostShell(env);
    let child;
    try {
      child = spawn(shell.file, argsFor(shell.file, command), {
        cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { finish({ startError: String(e?.message ?? e) }); return; }
    const kill = () => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      else if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    const onAbort = () => { stopped = true; kill(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (text) => {
        const room = OUTPUT_LIMIT - out[stream].length;
        if (room <= 0) { truncated = true; return; }
        const piece = text.length > room ? text.slice(0, room) : text;
        if (piece.length < text.length) truncated = true;
        out[stream] += piece;
        onOutput(stream, piece);
      });
    }
    child.on('error', e => finish({ startError: String(e?.message ?? e) }));
    child.on('close', (code, sig) => finish(stopped || timedOut ? {} : { exitCode: code, signal: sig ?? null }));
  });
}

/**
 * エージェントへ渡す 2 行（Claude の CLI の `!` と同じ形。core/system-messages.mjs が同じ形で読む）。
 * 終了コードは CLI の形に入らないので、ここにも入れない（会話の記録の shellExits に控える）
 */
export function shellLines({ command, stdout, stderr }) {
  return [
    `<bash-input>${command}</bash-input>`,
    `<bash-stdout>${stdout ?? ''}</bash-stdout><bash-stderr>${stderr ?? ''}</bash-stderr>`,
  ];
}

/**
 * 履歴の `!` の行（kind: 'shell'）と、Pleiad が走らせた結果を照らす鍵。履歴で読んだときと同じ形に揃えてから取る
 * （classifySystemMessages を通す。改行・色の指定・末尾の空白の扱いがずれない）
 */
export function shellKey({ command, stdout, stderr }) {
  const [shell] = classifySystemMessages(shellLines({ command, stdout, stderr }).map(text => ({ role: 'user', text })));
  return messageShellKey(shell);
}

/** 読んだ履歴の kind: 'shell' の発言の鍵 */
export function messageShellKey(m) {
  return crypto.createHash('sha256').update(JSON.stringify([m?.command ?? '', m?.stdout ?? null, m?.stderr ?? null])).digest('hex').slice(0, 32);
}
