// ホストとして常駐する（docs/remote.md §6.3）。リモートが有効な間、窓を閉じてもサーバーを続けてトレイに残し、
// 選んだ規則でスリープを防ぐ。設定と状態はサーバーが持ち、parentPort の { type: 'resident', state } で届く
// （core/remote/resident.mjs の residentSignal）。main.cjs からは createResident と、窓の close での keepOnClose() だけを使う。
//
//   state = { remote, keepRunning, sleep: 'working'|'always'|'off', working, running, waiting, devices, relay, locale }
//
// スリープ: 'working' はターンが走っているか承認待ちがある間だけ、'always' はリモートが有効な間ずっと
// powerSaveBlocker.start('prevent-app-suspension')。画面は消えてよい。リモートが無効なら何もしない。
const fs = require('node:fs');
const path = require('node:path');

/** スリープを防ぐべきか */
function sleepWanted(state) {
  if (!state?.remote) return false;
  if (state.sleep === 'always') return true;
  if (state.sleep === 'off') return false;
  return Boolean(state.working);
}

/** 窓を閉じてもホストを続けるか（トレイに残す） */
function keepRunning(state) {
  return Boolean(state?.remote && state.keepRunning);
}

// 文言は web/locales/<言語>/desktop.json。main には i18next を載せないので、差し込み（{{name}}）だけの小さな引き当て
const dictionaries = new Map();
function dictionary(lang) {
  if (!dictionaries.has(lang)) {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'locales', lang, 'desktop.json'), 'utf8')); } catch {}
    dictionaries.set(lang, data);
  }
  return dictionaries.get(lang);
}
function translator(lang) {
  const pick = (dict, key) => key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
  return (key, vars = {}) => {
    const text = pick(dictionary(lang), key) ?? pick(dictionary('en'), key) ?? key;
    return String(text).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ''));
  };
}

/**
 * @param deps.Tray / deps.Menu / deps.powerSaveBlocker  Electron のもの（試験では差し替える）
 * @param deps.icon      トレイのアイコンのパス
 * @param deps.getWindow ローカルの窓
 * @param deps.quit      「終了」。main の closeSafely（実行中なら今と同じ確認）
 */
function createResident({ Tray, Menu, powerSaveBlocker, icon, getWindow, quit, platform = process.platform }) {
  let state = null, tray = null, blocker = null;

  function show() {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show(); window.focus();
  }

  function menu() {
    const t = translator(state?.locale === 'ja' ? 'ja' : 'en');
    // i18n-dynamic: resident.relay.
    const relay = t(`resident.relay.${state?.relay ?? 'disabled'}`);
    const summary = t('resident.summary', { relay, devices: state?.devices ?? 0, running: state?.running ?? 0 });
    return {
      tooltip: `Pleiad · ${summary}`,
      menu: Menu.buildFromTemplate([
        { label: summary, enabled: false },
        { type: 'separator' },
        { label: t('resident.open'), click: show },
        { label: t('resident.quit'), click: () => { show(); quit(); } },
      ]),
    };
  }

  function paintTray() {
    if (!keepRunning(state)) {
      if (!tray) return;
      tray.destroy(); tray = null;
      // トレイだけが入口だった（窓を閉じていた）なら、窓を出し直す。出さないと Pleiad に戻る道が無い
      const window = getWindow();
      if (window && !window.isDestroyed() && !window.isVisible()) show();
      return;
    }
    if (!tray) {
      tray = new Tray(icon);
      // Windows・Linux はアイコンを押すと開く。macOS はメニューを出す（メニューバーの作法）
      if (platform !== 'darwin') tray.on('click', show);
    }
    const { tooltip, menu: contextMenu } = menu();
    tray.setToolTip(tooltip);
    tray.setContextMenu(contextMenu);
  }

  function paintSleep() {
    const want = sleepWanted(state);
    if (want && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!want && blocker !== null) {
      if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      blocker = null;
    }
  }

  return {
    update(next) {
      state = next && typeof next === 'object' ? next : null;
      paintTray();
      paintSleep();
    },
    /** 窓の close で呼ぶ。true なら窓を隠すだけにする */
    keepOnClose: () => keepRunning(state),
    show,
    /** 状態（試験用） */
    get blocking() { return blocker !== null; },
    get hasTray() { return tray !== null; },
    dispose() {
      tray?.destroy(); tray = null;
      if (blocker !== null && powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker);
      blocker = null;
    },
  };
}

/** main.cjs からの取り付け。worker の知らせを受け、macOS の Dock を押したときにも窓を出す */
function attachResident({ app, worker, ...deps }) {
  const { Tray, Menu, powerSaveBlocker } = require('electron');
  const resident = createResident({ Tray, Menu, powerSaveBlocker, ...deps });
  worker.on('message', message => { if (message?.type === 'resident') resident.update(message.state); });
  app.on('activate', () => resident.show());
  app.on('will-quit', () => resident.dispose());
  return resident;
}

module.exports = { createResident, attachResident, sleepWanted, keepRunning };
