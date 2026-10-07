import { renderMarkdown } from './render.mjs';
import { fmt, t } from './i18n.mjs';
import { runMark } from './arc.mjs';
import { el } from './dom.mjs';
import { warnMark, workRows, workCounts, handoverWaits, interruptProgress } from './interrupt.mjs';

// i18n-dynamic: updates.phase.
const PHASES = ['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'installing', 'error', 'unavailable'];
// 確認の段に並べる作業の行の上限。越えた分は「ほか N 件」
const WORK_ROWS = 6;
// 「中断して更新」で全部のターンが終わるのを待つ上限（ADR 0036）
const STOP_WAIT_MS = 30000;
// 訳文の {{mark}} を三角に置き換えるための印（私用領域の 1 文字）
const MARK = '\u{E000}';
// switchUi: 切り替えを待つ表示（web/switch-notice.mjs）。待っている間の設定のページの字・⚙ の点・「更新しました」を出さない・止めたもの。
// handoverNotes: 無停止の更新の確認の段に足す注意（内蔵ブラウザーのタブを開いている・コンピューターの操作中）の有無を返す
export function setupUpdates({ page, open, lock, flush, cmd, work: currentWork = () => null, sessionName = id => id, agentName = id => id, switchUi = null, handoverNotes = () => ({}) }) {
  const $ = id => document.getElementById(id), bridge = window.plyDesktop;
  let info, state, busy = false, installing = false, confirming = false, shownNotice = null, failure = '';
  // 確認の段で見せた実行中の作業（running の戻り）。中断の進み { done, total } は押した後だけ
  let confirmWork = null, stopping = null;
  const deferred = new Set();
  function paint(value) {
    state = value;
    const applying = installing || state.phase === 'installing';
    const downloading = state.phase === 'downloading';
    const progressing = applying || downloading;
    const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(100, Math.round(state.progress))) : null;
    const stage = stopping ? t('updates.interrupting', { done: stopping.done, total: stopping.total })
      : applying ? (state.phase === 'installing' ? t('updates.stage.installing') : t('updates.stage.saving'))
      : progress === null ? t('updates.stage.downloading') : t('updates.stage.downloadingPercent', { percent: progress });
    lock(applying);
    $('appVersion').textContent = `Pleiad ${state.version || info?.version || ''}`;
    $('updateStatus').textContent = t(`updates.phase.${PHASES.includes(state.phase) ? state.phase : 'idle'}`) + (state.target ? ` · ${state.target}` : '');
    // Microsoft Store の版は Store が更新する（docs/microsoft-store.md「自動更新」）
    if (state.store) $('updateStatus').textContent = t('updates.store.status');
    if (progressing) $('updateStatus').textContent = stage;
    $('updateHint').textContent = applying ? t('updates.hint.applying')
      : downloading ? t('updates.hint.downloading')
      : state.store ? t('updates.store.hint')
      : !state.enabled ? (bridge?.update ? t('updates.hint.noAutoUpdate') : t('updates.hint.browser'))
      : '';
    // 新しい版への切り替えを待っている間は、窓（新しい版）とサーバー（動いている版）がずれる。字とヒントで言う
    const waiting = switchUi?.page();
    if (waiting) { $('updateStatus').textContent = waiting.status; $('updateHint').textContent = waiting.hint; }
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
    paintConfirmWork();
    const hasUpdate = ['available', 'downloaded'].includes(state.phase) || Boolean(switchUi?.pending);
    $('settings').classList.toggle('has-update', hasUpdate);
    $('settings').title = hasUpdate ? t('updates.settingsHasUpdate') : t('app.settings');
    let alreadyShown = false;
    try { alreadyShown = sessionStorage.getItem('ply-update-notice') === state.version; } catch {}
    // 切り替えが済むまでは出さない（サーバーはまだ前の版。待ち・失敗の間は switchUi が知らせる）
    const show = state.notice && !switchUi?.holdsNotice && (shownNotice === state.version || !alreadyShown);
    $('updateNotice').hidden = !show;
    const stopped = show ? switchUi?.stoppedText() ?? '' : '';
    $('updateNoticeStopped').hidden = !stopped;
    $('updateNoticeStopped').textContent = stopped;
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
    paintPromptWork();
  }
  /** 脇の更新の知らせに「実行中 N 件・承認待ち M 件」。止まる作業があることを押す前に知らせる */
  function paintPromptWork() {
    const line = $('updatePromptWork');
    if (!state) { line.hidden = true; return; }
    const progressing = installing || ['installing', 'downloading'].includes(state.phase);
    const { running, waiting } = workCounts(currentWork());
    const parts = [running && t('updates.promptRunning', { count: running }), waiting && t('updates.promptWaiting', { count: waiting })].filter(Boolean);
    line.hidden = progressing || !parts.length;
    line.textContent = parts.join(t('updates.promptJoin'));
  }
  /** 確認の段: 止まる作業の一覧（名前・実行中/承認待ち・エージェント）と、中断した会話がどう残るかの 1 行 */
  function paintConfirmWork() {
    // 無停止の更新（state.handover。ADR 0151）では作業を止めないので、止まる作業を並べない
    const rows = confirming && !state?.handover ? workRows(confirmWork) : [];
    const stops = confirming && !state?.handover && (confirmWork?.count ?? 0) > 0;
    // 無停止の更新: 作業は止まらないことを 1 行で。保持役に載らない作業（待つもの）があれば、その数も。
    // 内蔵ブラウザーのタブ・コンピューターの操作があるときだけ、開き直しの注意も
    const waits = confirming && state?.handover ? handoverWaits(confirmWork) : 0;
    const running = confirming && state?.handover ? Math.max(workRows(confirmWork).length || (confirmWork?.count ?? 0), waits) : 0;
    $('updateHandoverWork').hidden = !running;
    if (running) $('updateHandoverWork').textContent = t('updates.handoverWork', { count: running });
    $('updateHandoverWait').hidden = !waits;
    if (waits) $('updateHandoverWait').textContent = t('updates.handoverWait', { count: waits });
    $('updateHandoverBrowser').hidden = !(confirming && state?.handover && handoverNotes().browser);
    $('updateWork').hidden = !rows.length;
    $('updateWorkAfter').hidden = !stops;
    $('confirmInstallUpdate').textContent = stops ? t('updates.interruptInstall') : t('settings.updates.confirmInstall');
    if (!confirming) return;
    const list = $('updateWorkList');
    list.replaceChildren(...rows.slice(0, WORK_ROWS).map(row => {
      const line = el('div', 'update-work-row');
      const waiting = row.state === 'waiting';
      const mark = waiting ? el('span', 'update-work-dia', '◆') : runMark(t('updates.workRunningOnly'));
      if (waiting) mark.setAttribute('aria-hidden', 'true');
      line.append(mark, el('span', 'update-work-name', sessionName(row.sessionId)),
        el('span', 'update-work-state' + (waiting ? ' mark' : ''), waiting ? t('updates.workWaiting')
          : row.backend ? t('updates.workRunning', { agent: agentName(row.backend) }) : t('updates.workRunningOnly')));
      return line;
    }));
    if (rows.length > WORK_ROWS) list.append(el('div', 'update-work-more', t('updates.workMore', { count: rows.length - WORK_ROWS })));
    // 「中断した会話は再起動後に ⚠ で残り…」。訳文の {{mark}} の位置に三角を置く
    const [before, after = ''] = t('updates.workAfter', { mark: MARK }).split(MARK);
    $('updateWorkAfter').replaceChildren(before, warnMark(t('interrupt.markName')), after);
  }
  /**
   * 「中断して更新」: 全部を reason update で中断し、running の count が 0 になるまで「作業を中断しています… N / M」を出して待つ。
   * 30 秒で止まらなければ理由を出してやめる（更新は準備済みのまま）。確認の段で作業を見せていなければ中断しない
   * （見せていない作業は止めない。後の flush が今までどおり断る）
   */
  async function stopWork() {
    if (!cmd || state?.handover || !((confirmWork?.count ?? 0) > 0)) return;
    const first = await cmd('running').catch(() => null);
    if (!first || !(first.count > 0)) return;
    const rows = workRows(first).length;
    const total = rows || first.count;
    // 行で数えるとき、行が消えてもサブエージェントなどが残っていれば最後の 1 件は済ませない
    const remaining = (w) => (!(w.count > 0) ? 0 : rows ? Math.max(workRows(w).length, 1) : w.count);
    stopping = interruptProgress(total, remaining(first));
    paint(state);
    try {
      await cmd('abort', { reason: 'update' });
      const until = Date.now() + STOP_WAIT_MS;
      for (;;) {
        const now = await cmd('running').catch(() => null);
        if (now) {
          stopping = interruptProgress(total, remaining(now), stopping.done);
          paint(state);
          if (!(now.count > 0)) return;
        }
        if (Date.now() > until) throw new Error(t('updates.interruptTimeout'));
        await new Promise(r => setTimeout(r, 400));
        // 待つ間に始まったターン（別のタブ・端末からの送信、委譲の完了の届け、送信待ち）も止める。
        // 中断は何度送っても同じ（止め始めたものには何もしない。理由も最初のまま）
        await cmd('abort', { reason: 'update' }).catch(() => {});
      }
    } finally { stopping = null; }
  }
  async function action(name, value) {
    if (busy) return;
    busy = true; failure = ''; if (state) paint(state);
    try {
      if (name === 'install') { confirming = false; installing = true; paint(state); await stopWork(); paint(state); await flush({ handover: Boolean(state?.handover) }); }
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
  $('installUpdate').onclick = async () => {
    confirming = true; confirmWork = currentWork(); paint(state); $('updateConfirmTitle').focus();
    // 止まる作業を並べる（実行中でも断らない。ADR 0036）。放送を待たずに今の分を取り直す
    const now = cmd ? await cmd('running').catch(() => null) : null;
    if (now) confirmWork = now;
    if (confirming) paint(state);
  };
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
  return {
    /** この画面で更新を進めている（作業を中断している・保存している・入れている）。その間は「更新で中断した会話」を出さない */
    get applying() { return installing || Boolean(stopping) || state?.phase === 'installing'; },
    /** 切り替えを待つ表示の状態が変わった（web/switch-notice.mjs）。字・⚙ の点・「更新しました」を描き直す */
    refresh() { if (state) paint(state); },
    /** running が変わった（client.mjs の applyRunning）。脇の件数と、開いている確認の段の一覧を合わせる */
    workChanged() {
      if (!state) return;
      paintPromptWork();
      if (confirming && !busy && !installing) { confirmWork = currentWork() ?? confirmWork; paintConfirmWork(); }
    },
  };
}
