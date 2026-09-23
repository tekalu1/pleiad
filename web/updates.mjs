import { renderMarkdown } from './render.mjs';
import { fmt, t } from './i18n.mjs';
export function setupUpdates({ page, open, lock, flush }) {
  const $ = id => document.getElementById(id), bridge = window.plyDesktop;
  let info, state, busy = false, installing = false, confirming = false, shownNotice = null, failure = '';
  const deferred = new Set();
  const phases = { idle: '更新を確認できます', checking: '更新を確認しています…', current: '最新バージョンです', available: '新しいバージョンがあります', downloading: 'ダウンロード中', downloaded: '再起動すると更新を適用できます', installing: '更新を準備しています…', error: '更新を取得できませんでした', unavailable: '自動更新は配布版のデスクトップアプリで利用できます' };
  function paint(value) {
    state = value;
    const applying = installing || state.phase === 'installing';
    const downloading = state.phase === 'downloading';
    const progressing = applying || downloading;
    const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, Math.round(state.progress))) : null;
    const stage = applying ? (state.phase === 'installing' ? '更新を適用する準備をしています…' : '会話と下書きを保存しています…')
      : `ダウンロード中${progress === null ? '…' : ` · ${progress}%`}`;
    lock(applying);
    $('appVersion').textContent = `Pleiad ${state.version || info?.version || ''}`;
    $('updateStatus').textContent = (phases[state.phase] || phases.idle) + (state.target ? ` · ${state.target}` : '');
    if (progressing) $('updateStatus').textContent = stage;
    $('updateHint').textContent = applying ? '保存と更新の準備が終わるまでお待ちください。Pleiadが終了した後、更新を適用して自動で起動し直します。'
      : downloading ? 'このまま作業を続けられます。準備ができたらお知らせします。'
      : !state.enabled ? (bridge?.update ? 'この評価版は自動更新に対応していません。新しいインストーラーで更新してください。' : 'ブラウザー版では更新履歴を確認できます。')
      : '';
    // リモートの窓: 版はホストが配る画面のもの（release-info.json）。手元のアプリの更新はローカルの窓で（docs/remote.md §7.3）
    if (window.plyRemote && !bridge?.update) {
      $('updateStatus').textContent = t('remote.updateStatus');
      $('updateHint').textContent = t('remote.updateOnHost');
    }
    $('updateHint').hidden = !$('updateHint').textContent;
    $('updateLastChecked').hidden = !state.lastChecked;
    $('updateLastChecked').textContent = state.lastChecked ? `最終確認：${fmt.dateTime(state.lastChecked)}` : '';
    // 操作の失敗は、あとから届く状態の知らせ（定期の確認など）で消さない。次の操作を始めるまで残す
    $('updateError').textContent = failure || state.error || '';
    for (const id of ['updateProgress', 'updatePromptProgress']) {
      const bar = $(id);
      bar.hidden = !progressing;
      bar.setAttribute('aria-label', applying ? stage : 'ダウンロードの進捗');
      if (downloading && !applying && progress !== null) bar.value = progress;
      else bar.removeAttribute('value');
    }
    // 更新情報のリリースノートは markdown。信用しない入力として render.mjs で安全な HTML にする
    $('updateNotes').innerHTML = renderMarkdown(state.notes || '');
    $('updateNotes').hidden = !state.notes;
    $('updateBeta').checked = state.channel === 'beta';
    $('updateAutomatic').checked = state.autoDownload === true;
    $('updateCheckAutomatic').checked = state.autoCheck !== false;
    $('updatePreferences').hidden = !state.enabled;
    const working = busy || ['checking', 'downloading', 'installing'].includes(state.phase);
    $('updateBeta').disabled = $('updateAutomatic').disabled = $('updateCheckAutomatic').disabled = working || state.phase === 'downloaded';
    $('checkUpdate').hidden = !state.enabled || ['available', 'downloading', 'installing'].includes(state.phase);
    $('checkUpdate').disabled = working;
    $('checkUpdate').textContent = state.phase === 'error' ? '再試行' : '更新を確認';
    $('downloadUpdate').hidden = state.phase !== 'available';
    $('downloadUpdate').disabled = working;
    if (state.phase !== 'downloaded') confirming = false;
    $('installUpdate').hidden = state.phase !== 'downloaded' || confirming || applying;
    $('installUpdate').disabled = working;
    $('updateConfirm').hidden = !confirming;
    $('confirmInstallUpdate').disabled = $('cancelInstallUpdate').disabled = working;
    $('settings').classList.toggle('has-update', ['available', 'downloaded'].includes(state.phase));
    $('settings').title = ['available', 'downloaded'].includes(state.phase) ? '設定・更新があります' : '設定';
    let alreadyShown = false;
    try { alreadyShown = sessionStorage.getItem('ply-update-notice') === state.version; } catch {}
    const show = state.notice && (shownNotice === state.version || !alreadyShown);
    $('updateNotice').hidden = !show;
    if (show) { shownNotice = state.version; try { sessionStorage.setItem('ply-update-notice', state.version); } catch {} }
    $('updateNoticeText').textContent = `Pleiad ${state.version} に更新しました`;
    const key = `${state.target}:${state.phase}`;
    let postponed = deferred.has(key);
    try { postponed ||= sessionStorage.getItem(`ply-update-deferred:${key}`) === 'yes'; } catch {}
    const ready = state.phase === 'downloaded';
    $('updatePrompt').hidden = !state.enabled || !state.target || (!progressing && (postponed || (!ready && !(state.phase === 'available' && !state.autoDownload))));
    $('updatePromptText').textContent = progressing ? `Pleiad ${state.target} · ${stage}`
      : ready ? `Pleiad ${state.target} の更新準備ができました` : `Pleiad ${state.target} を利用できます`;
    $('viewAvailableUpdate').hidden = applying;
    $('deferUpdate').hidden = progressing;
  }
  async function action(name, value) {
    if (busy) return;
    busy = true; failure = ''; if (state) paint(state);
    try {
      if (name === 'install') { confirming = false; installing = true; paint(state); await flush(); }
      paint(await bridge.update(name, value));
    } catch (e) {
      // Electron は invoke の失敗に「Error invoking remote method …」を前置きする。利用者に要るのは本文だけ
      failure = String(e.message).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
      $('updateError').textContent = failure;
    }
    finally { busy = false; installing = false; if (state) paint(state); }
  }
  $('updatesTab').onclick = () => page('updates');
  $('checkUpdate').onclick = () => action('check');
  $('downloadUpdate').onclick = () => action('download');
  $('installUpdate').onclick = () => { confirming = true; paint(state); $('updateConfirmTitle').focus(); };
  $('confirmInstallUpdate').onclick = () => action('install');
  $('cancelInstallUpdate').onclick = () => { confirming = false; paint(state); $('installUpdate').focus(); };
  $('viewAvailableUpdate').onclick = () => { $('onboardingDialog').close(); open('updates'); };
  $('deferUpdate').onclick = () => {
    const key = `${state.target}:${state.phase}`; deferred.add(key);
    try { sessionStorage.setItem(`ply-update-deferred:${key}`, 'yes'); } catch {}
    paint(state); $('settings').focus();
  };
  const preferences = () => action('preferences', { channel: $('updateBeta').checked ? 'beta' : 'stable', autoDownload: $('updateAutomatic').checked, autoCheck: $('updateCheckAutomatic').checked });
  $('updateBeta').onchange = preferences; $('updateAutomatic').onchange = preferences;
  $('updateCheckAutomatic').onchange = preferences;
  $('dismissUpdateNotice').onclick = () => action('dismiss');
  $('viewUpdateNotes').onclick = () => {
    $('onboardingDialog').close();
    open('updates'); action('dismiss');
  };
  bridge?.onUpdate?.(paint);
  (async () => {
    const response = await fetch('./release-info.json');
    if (!response.ok) throw new Error('リリースノートを読み込めませんでした。');
    info = await response.json();
    for (const release of info.releases) {
      const details = document.createElement('details'); details.open = release.version === info.version;
      const summary = document.createElement('summary'); summary.textContent = `${release.version} · ${release.date} · ${release.title}`; details.append(summary);
      for (const section of release.sections) {
        const h = document.createElement('h4'); h.textContent = section.title;
        const ul = document.createElement('ul');
        for (const item of section.items) { const li = document.createElement('li'); li.textContent = item; ul.append(li); }
        details.append(h, ul);
      }
      $('releaseHistory').append(details);
    }
    paint(bridge?.update ? await bridge.update('status') : { version: info.version, phase: 'unavailable', enabled: false });
  })().catch(e => { $('updateError').textContent = e.message; });
}
