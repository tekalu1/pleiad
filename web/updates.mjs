import { renderMarkdown } from './render.mjs';
import { fmt, t } from './i18n.mjs';

// i18n-dynamic: updates.phase.
const PHASES = ['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'installing', 'error', 'unavailable'];
export function setupUpdates({ page, open, lock, flush }) {
  const $ = id => document.getElementById(id), bridge = window.plyDesktop;
  let info, state, busy = false, installing = false, confirming = false, shownNotice = null, failure = '';
  const deferred = new Set();
  function paint(value) {
    state = value;
    const applying = installing || state.phase === 'installing';
    const downloading = state.phase === 'downloading';
    const progressing = applying || downloading;
    const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, Math.round(state.progress))) : null;
    const stage = applying ? (state.phase === 'installing' ? t('updates.stage.installing') : t('updates.stage.saving'))
      : progress === null ? t('updates.stage.downloading') : t('updates.stage.downloadingPercent', { percent: progress });
    lock(applying);
    $('appVersion').textContent = `Pleiad ${state.version || info?.version || ''}`;
    $('updateStatus').textContent = t(`updates.phase.${PHASES.includes(state.phase) ? state.phase : 'idle'}`) + (state.target ? ` · ${state.target}` : '');
    if (progressing) $('updateStatus').textContent = stage;
    $('updateHint').textContent = applying ? t('updates.hint.applying')
      : downloading ? t('updates.hint.downloading')
      : !state.enabled ? (bridge?.update ? t('updates.hint.noAutoUpdate') : t('updates.hint.browser'))
      : '';
    // リモートの窓: 版はホストが配る画面のもの（release-info.json）。手元のアプリの更新はローカルの窓で（docs/remote.md §7.3）
    if (window.plyRemote && !bridge?.update) {
      $('updateStatus').textContent = t('remote.updateStatus');
      $('updateHint').textContent = t('remote.updateOnHost');
    }
    $('updateHint').hidden = !$('updateHint').textContent;
    $('updateLastChecked').hidden = !state.lastChecked;
    $('updateLastChecked').textContent = state.lastChecked ? t('updates.lastChecked', { when: fmt.dateTime(state.lastChecked) }) : '';
    // 操作の失敗は、あとから届く状態の知らせ（定期の確認など）で消さない。次の操作を始めるまで残す
    $('updateError').textContent = failure || state.error || '';
    for (const id of ['updateProgress', 'updatePromptProgress']) {
      const bar = $(id);
      bar.hidden = !progressing;
      bar.setAttribute('aria-label', applying ? stage : t('settings.updates.downloadProgress'));
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
    $('checkUpdate').textContent = state.phase === 'error' ? t('updates.retry') : t('settings.updates.check');
    $('downloadUpdate').hidden = state.phase !== 'available';
    $('downloadUpdate').disabled = working;
    if (state.phase !== 'downloaded') confirming = false;
    $('installUpdate').hidden = state.phase !== 'downloaded' || confirming || applying;
    $('installUpdate').disabled = working;
    $('updateConfirm').hidden = !confirming;
    $('confirmInstallUpdate').disabled = $('cancelInstallUpdate').disabled = working;
    $('settings').classList.toggle('has-update', ['available', 'downloaded'].includes(state.phase));
    $('settings').title = ['available', 'downloaded'].includes(state.phase) ? t('updates.settingsHasUpdate') : t('app.settings');
    let alreadyShown = false;
    try { alreadyShown = sessionStorage.getItem('ply-update-notice') === state.version; } catch {}
    const show = state.notice && (shownNotice === state.version || !alreadyShown);
    $('updateNotice').hidden = !show;
    if (show) { shownNotice = state.version; try { sessionStorage.setItem('ply-update-notice', state.version); } catch {} }
    $('updateNoticeText').textContent = t('updates.updated', { version: state.version });
    const key = `${state.target}:${state.phase}`;
    let postponed = deferred.has(key);
    try { postponed ||= sessionStorage.getItem(`ply-update-deferred:${key}`) === 'yes'; } catch {}
    const ready = state.phase === 'downloaded';
    $('updatePrompt').hidden = !state.enabled || !state.target || (!progressing && (postponed || (!ready && !(state.phase === 'available' && !state.autoDownload))));
    $('updatePromptText').textContent = progressing ? `Pleiad ${state.target} · ${stage}`
      : ready ? t('updates.promptReady', { target: state.target }) : t('updates.promptAvailable', { target: state.target });
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
    if (!response.ok) throw new Error(t('updates.notesFailed'));
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
