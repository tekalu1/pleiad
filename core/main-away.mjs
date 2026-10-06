// main が居ない間（更新の約 50 秒・付け直しまで）の、サーバー側の扱いの共通部分（段階 1 の 1-5。docs/zero-downtime-update/design.md §7.2）。
// 機能ごとの扱いは、頼む側のモジュールが持つ（口の層は居ない間の送信を溜めずに捨てるだけ。core/main-link.mjs）:
//   secret       core/secret-store.mjs の parentPortCipher（待たせる・上限 5 分・復号した値を持つ）
//   computer use core/computer-use/driver.mjs の onAway・lock.mjs の stopAll（Esc と同じに止める）
//   内蔵ブラウザー core/agent-browser.mjs（中継の URL・タブの写しをサーバーが持ち、戻った main が同じ値で立て直す）
//   screencast   core/browser-screencast.mjs（見ている端末へ ended('away')）
//   os-open      core/os-open.mjs（居ない間は OS に直に頼む）
//   openExternal ここの createExternalOpener（居ない間は OS の既定のブラウザーで開く）
// ここは、main が居る・居ないの出来事（away・back）と、main-leaving（これから離れる）を 1 か所で受けて配る。
// utilityProcess の口（切れても戻らない。resumable でない）では何も起きない（既定の起動は変わらない）。
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * @param mainPort main への口（core/main-port.mjs）
 * @returns { onAway(cb), onBack(cb({ first })), onStay(cb), leaving, holdsGrace(), connects }
 *   away: 口が切れた。back: つながった（first は、このサーバーで最初のつながり。付け直しではない）。stay: main-leaving の後に main が取りやめた（main-leaving-cancel）。
 *   leaving: main-leaving を受けて、まだ戻っていない（reason を持つ）。holdsGrace は、画面が居ない間の猶予（AGENT_HOST_GRACE_MS）を数えない間
 */
export function createMainAway({ mainPort }) {
  const listeners = { away: new Set(), back: new Set(), stay: new Set() };
  let leaving = null, connects = 0;
  const fire = (set, ...args) => { for (const cb of [...set]) { try { cb(...args); } catch (e) { console.error('main-away:', String(e?.message ?? e)); } } };
  if (mainPort.resumable) {
    mainPort.on('message', event => {
      const data = event?.data ?? event;
      if (data?.type === 'main-leaving') leaving = { reason: typeof data.reason === 'string' ? data.reason : null, at: Date.now() };
      // 更新を取りやめた（main は居続ける）。猶予を数える状態に戻す
      else if (data?.type === 'main-leaving-cancel' && leaving) { leaving = null; fire(listeners.stay); }
    });
    mainPort.on('disconnect', () => fire(listeners.away));
    mainPort.on('connect', () => {
      const first = connects++ === 0;
      leaving = null;
      fire(listeners.back, { first });
    });
  }
  const on = set => cb => { set.add(cb); return () => set.delete(cb); };
  return {
    onAway: on(listeners.away),
    onBack: on(listeners.back),
    onStay: on(listeners.stay),
    get leaving() { return leaving; },
    get connects() { return connects; },
    /** main が「これから離れる」と言って、まだ戻っていない間。画面の猶予（hostAway）を数えない（main が居ないのは更新のためで、人が離れたのではない） */
    holdsGrace: () => leaving !== null,
  };
}

/** 既定のブラウザーで開いてよい URL か（desktop/secret-bridge.cjs の openableAuthUrl と同じ範囲: https と、ループバックの http） */
export function openableUrl(url) {
  try {
    const u = new URL(url);
    if (u.username || u.password) return null;
    if (u.protocol === 'https:') return u.href;
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return u.href;
  } catch { /* 開かない */ }
  return null;
}

/**
 * URL を OS の既定のブラウザーで開く内容を組み立てる（起動はしない）。シェルを通さず、起動するプログラムは絶対パスで指す
 * （core/os-open.mjs の launchPlan と同じ考え方）。引数の URL は URL として解釈し直した href（" を含まない）
 */
export function urlLaunchPlan(url, { platform = process.platform, env = process.env } = {}) {
  const href = openableUrl(url);
  if (!href) throw new Error('unopenable url');
  const detached = { detached: true, stdio: 'ignore', shell: false, windowsHide: false };
  if (platform === 'win32') {
    const explorer = path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'explorer.exe');
    return { command: explorer, args: [`"${href}"`], options: { ...detached, windowsVerbatimArguments: true } };
  }
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [href], options: detached };
  return { command: 'xdg-open', args: [href], options: detached };
}

/**
 * OAuth の同意画面などを開く（claudeLogin・mcpOAuth の openExternal）。main が居れば main の shell に頼み（今のとおり）、
 * main の下の起動（hosted）で main が居ない間は、サーバーが OS の既定のブラウザーで開く。main の下でない起動（npm start）は何もしない
 * （画面の URL から人が開く）。spawn は差し替えられる（テスト）
 */
export function createExternalOpener({ mainPort, spawnImpl = spawn, log = () => {} }) {
  return url => {
    if (mainPort.postMessage({ type: 'open-external', url })) return true;
    if (!mainPort.hosted) return false;
    try {
      const plan = urlLaunchPlan(url);
      const child = spawnImpl(plan.command, plan.args, plan.options);
      child.once?.('error', error => log(`open-external failed: ${error?.message ?? error}`));
      child.unref?.();
      return true;
    } catch (error) {
      log(`open-external failed: ${error?.message ?? error}`);
      return false;
    }
  };
}
