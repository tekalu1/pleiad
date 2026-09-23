// サーバーのある PC で「エクスプローラーで表示」「ブラウザーで開く」を実行する（docs/mockups/file-actions.html §5）。
//
// 判定はサーバー（core/server.mjs の revealPath / openPath）、実行は OS 側。ここに来るのは、許可範囲の中にあると
// 確かめ、実体を解決した後の絶対パスだけ。それでも次を守る:
//   - シェルを通さない（cmd /c start は & ^ % を含むパスでコマンドが注入される）。引数はそのまま 1 つで渡す
//   - 「開く」は HTML だけ。既定のアプリで開くと .bat .lnk などはそのまま実行されてしまう
//   - 起動するプログラムは絶対パスで指す（作業ディレクトリに置かれた explorer.exe を拾わない）
//   - 短い時間に何度も呼ばせない（AI の出力経由で画面を操作させる類の誤用にも強くする）
// デスクトップ版（Electron）では本体の shell.showItemInFolder / shell.openPath に頼む（desktop/file-bridge.cjs）。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { t } from './i18n.mjs';

export const OPENABLE = /\.html?$/i;

/**
 * 接続が「サーバーのある PC の画面」から来たか。ループバックからで、中継（プロキシ）を通っていないもの。
 * 判定はここ 1 か所（遠隔の接続を足すときもここを直す）
 */
export function isLocalRequest(req) {
  const address = String(req?.socket?.remoteAddress ?? '');
  const loopback = address === '::1' || /^(?:::ffff:)?127\./.test(address);
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-real-ip'].some(h => req?.headers?.[h]);
  return loopback && !forwarded;
}

/**
 * 起動する内容を組み立てる（起動はしない。テストはここを見る）。
 * @param {'reveal'|'open'} action reveal はファイルを選んだ状態でフォルダーを開く（フォルダーはその中を開く）。open は HTML を既定のブラウザーで
 * @returns {{ command:string, args:string[], options:object }}
 */
export function launchPlan(action, file, { directory = false, platform = process.platform, env = process.env } = {}) {
  if (typeof file !== 'string' || !file || /[\u0000-\u001f"]/.test(file)) throw new Error(t('files.invalidPath'));
  if (action === 'open' && (directory || !OPENABLE.test(file))) throw new Error(t('files.htmlOnly'));
  if (action !== 'open' && action !== 'reveal') throw new Error('unknown action');
  const detached = { detached: true, stdio: 'ignore', shell: false, windowsHide: false };
  if (platform === 'win32') {
    const target = file.replaceAll('/', '\\');
    const explorer = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe');
    // explorer.exe は引数を自分で読む。Node に引用させると "/select,C:\a b\c" の形になり、空白を含むパスで
    // 別のフォルダー（ドキュメント等）が開く。verbatim で /select,"…" の形のまま渡す（" は Windows のパスに入らない）。
    // HTML は explorer.exe にファイルを渡すと関連付け（既定のブラウザー）で開く。cmd も rundll32 も通さない
    const arg = action === 'reveal' && !directory ? `/select,"${target}"` : `"${target}"`;
    return { command: explorer, args: [arg], options: { ...detached, windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') {
    // file は絶対パス（/ 始まり）なので、オプションとして読まれることはない
    return { command: '/usr/bin/open', args: action === 'reveal' && !directory ? ['-R', file] : [file], options: detached };
  }
  // Linux などは選択状態にできない。ファイルならそのフォルダーを開く
  const target = action === 'reveal' && !directory ? path.dirname(file) : file;
  return { command: 'xdg-open', args: [target], options: detached };
}

/**
 * 起動する。explorer.exe は成功しても終了コード 1 を返すことがあるので、終了コードでは失敗と判定しない
 * （起動できなかったときだけ失敗）。子は切り離して待たない。
 */
export function launch(plan, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(plan.command, plan.args, plan.options); }
    catch (error) { reject(new Error(t('files.launchFailed', { reason: error.code ?? error.message }))); return; }
    child.once('error', error => reject(new Error(t('files.launchFailed', { reason: error.code ?? error.message }))));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** 短い時間に何度も呼ばせない。limit 回 / windowMs を超えたら断る */
export function createRateLimit({ limit = 5, windowMs = 10_000, now = () => Date.now() } = {}) {
  const times = [];
  return () => {
    const t = now();
    while (times.length && t - times[0] > windowMs) times.shift();
    if (times.length >= limit) return false;
    times.push(t);
    return true;
  };
}

const BRIDGE_ERRORS = { 'invalid-path': () => t('files.invalidPath'), 'not-found': () => t('files.notFound'),
  'not-file': () => t('files.notFileOrFolder'), 'html-only': () => t('files.htmlOnly') };
/** 本体（desktop/file-bridge.cjs）が返した失敗の文言 */
export function bridgeError({ code, detail } = {}) {
  if (Object.hasOwn(BRIDGE_ERRORS, code)) return BRIDGE_ERRORS[code]();
  return t('files.openFailed', { reason: String(detail || code || 'unknown').slice(0, 200) });
}

/**
 * main プロセス（Electron）に頼む実行器。port は utilityProcess の process.parentPort。
 * main 側（desktop/file-bridge.cjs）は { type:'os-open', id, action, path, directory } を受けて { type:'os-open', id, ok, code?, detail? } を返す。
 * 本体は画面の言語を知らないので、失敗は code（BRIDGE_ERRORS のキー）で返り、文言はここで辞書から引く
 */
export function parentPortOpener(port, { timeoutMs = 10_000 } = {}) {
  const waiting = new Map();
  let seq = 0;
  port.on('message', event => {
    const data = event?.data ?? event;
    if (data?.type !== 'os-open' || !waiting.has(data.id)) return;
    const { resolve, reject, timer } = waiting.get(data.id);
    waiting.delete(data.id); clearTimeout(timer);
    if (data.ok) resolve(); else reject(new Error(bridgeError(data)));
  });
  return (action, file, { directory = false } = {}) => new Promise((resolve, reject) => {
    const id = `o${++seq}`;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(t('files.noResponse'))); }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    port.postMessage({ type: 'os-open', id, action, path: file, directory });
  });
}

/**
 * 起動の形に合う実行器 (action, file, { directory }) => Promise。
 * AGENT_HOST_OS_OPEN=dry は起動せずに成功する（テスト用。実際に窓を開かない）
 */
export function defaultOpener({ env = process.env, parentPort = process.parentPort } = {}) {
  if (env.AGENT_HOST_OS_OPEN === 'dry') return async () => {};
  if (parentPort) return parentPortOpener(parentPort);
  return (action, file, options) => launch(launchPlan(action, file, options));
}
