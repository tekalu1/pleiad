import { isComposingKey } from './keyboard.mjs';
import { t } from './i18n.mjs';

const pages = [['setup', 'setupTab', 'setupPanel'], ['usage', 'usageTab', 'usagePanel'], ['delegation', 'delegationTab', 'delegationPanel'], ['appearance', 'appearanceTab', 'appearancePanel'], ['context', 'openContext', 'contextPanel'], ['remote', 'remoteTab', 'remotePanel'], ['updates', 'updatesTab', 'updatesPanel']];

// A failed status check is not evidence that the account is unconfigured.
export function shouldShowOnboarding(status, auth) {
  if (!status.seen && !status.setupComplete) return true;
  return status.agents.length === 0 || status.agents.every(agent => {
    const account = auth.get(agent.id);
    return !agent.installed || account?.supported === true && account.loggedIn === false && !account.pending;
  });
}

/**
 * folderBrowser はブラウザー版の「フォルダーを選ぶ…」の簡易ブラウザー（web/composer-controls.mjs。入力欄の面と同じ部品）
 */
export function setupOnboarding({ cmd, refreshAuth, getAuth, authLogin, authUrlBox, begin, folderBrowser }) {
  const $ = id => document.getElementById(id);
  const welcome = $('onboardingDialog');
  let status = null, selected = '', checked = false, locked = false;
  // 初回の案内で選んだ作業ディレクトリ。選ぶまでは前に決めたもの、無ければホーム（docs/desktop-onboarding.md）
  let chosenCwd = '';
  const currentCwd = () => chosenCwd || status?.cwd || status?.homeDir || '';
  const error = message => { $('onboardingError').textContent = message; };
  const isOpen = () => document.body.classList.contains('settings');
  // 別のページへ移ったら本文を先頭に戻す（前のページの位置のまま途中から始まらないように）。同じページを押し直したときは動かさない
  let shown = null;
  function page(active = 'setup') {
    for (const [name, button, panel] of pages) {
      $(panel).hidden = name !== active;
      $(button).setAttribute('aria-pressed', String(name === active));
      if (name === active) $('settingsPageTitle').textContent = $(button).textContent;
    }
    if (active !== shown) { shown = active; const content = document.querySelector('.settings-content'); if (content) content.scrollTop = 0; }
  }
  // 設定は画面全体。脇の一覧がメニューに、会話がページに入れ替わる。
  // 会話は伏せずにページで覆う（style.css「設定の画面」）ので、キーボードと読み上げが覆った会話へ届かないよう inert にする
  // main の直下だけを見る（文書全体を探すと長い会話ではそれだけで重い）。要素は作り直さないので一度拾えば足りる
  let coveredNodes;
  const covered = () => coveredNodes ??= [...(document.querySelector('body > main')?.children ?? [])].filter(n => n.matches('.top, #log, .composer'));
  function open(active = 'setup') {
    if (welcome.open) return;
    page(active);
    document.body.classList.add('settings');
    for (const node of covered()) node.inert = true;
    $('settingsNav').querySelector('[aria-pressed=true]')?.focus();
  }
  function close() {
    if (locked || !isOpen()) return;
    document.body.classList.remove('settings');
    for (const node of covered()) node.inert = false;
    $('settings').focus();
  }
  // 更新の適用中は途中で再起動するので、会話へ戻る道を塞ぐ
  function lock(value) {
    locked = value;
    $('backToChat').disabled = value;
    $('settingsNav').inert = value;
  }
  // 一覧は radiogroup。行にログインボタンが入るので行自体は button にできない。
  // 代わりに矢印で選び、Tab では群ごと飛ばす（選択中の行だけ tabindex=0）
  function move(agents, step) {
    const index = agents.findIndex(a => a.id === selected);
    selected = agents[(Math.max(index, 0) + step + agents.length) % agents.length].id;
    paint({ focus: true });
  }

  function paint({ focus = false } = {}) {
    const agents = status?.agents || [], auth = getAuth();
    if (!selected) selected = agents.find(a => a.installed && auth.get(a.id)?.loggedIn)?.id || status?.backend || agents[0]?.id || '';

    const list = $('onboardingAgentList');
    if (list) {
      // 行は毎回作り直す。押した行ごと消えるので、居場所が一覧の中にあったら選択中の行へ戻す。
      // 戻さないと body に落ち、そのあと矢印キーが効かない
      const keepFocus = focus || list.contains(document.activeElement);
      list.replaceChildren(...agents.map(agent => {
        const row = document.createElement('div');
        row.className = 'onboarding-agent-item';
        row.setAttribute('role', 'radio');
        const isSelected = selected === agent.id;
        row.setAttribute('aria-checked', String(isSelected));
        row.tabIndex = isSelected ? 0 : -1;
        row.onclick = () => { selected = agent.id; paint(); };
        row.onkeydown = event => {
          if (isComposingKey(event)) return;
          if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); selected = agent.id; return paint({ focus: true }); }
          const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
          if (!step || agents.length < 2) return;
          event.preventDefault();
          move(agents, step);
        };

        const info = document.createElement('div');
        info.className = 'agent-info';
        const name = document.createElement('span');
        name.className = 'agent-name';
        name.textContent = agent.label;
        const desc = document.createElement('span');
        desc.className = 'agent-desc';
        desc.textContent = agent.description || '';
        info.append(name, desc);

        const stateEl = document.createElement('div');
        stateEl.className = 'agent-state';

        const st = auth.get(agent.id);
        if (agent.installed === false) {
          if (agent.installUrl) {
            const link = document.createElement('a');
            link.className = 'btn';
            link.textContent = t('settings.agents.install');
            link.href = agent.installUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.onclick = e => e.stopPropagation();
            stateEl.append(link);
          } else {
            stateEl.textContent = t('settings.agents.notInstalled');
          }
        } else if (st?.loggedIn) {
          stateEl.textContent = st.account || t('settings.agents.loggedIn');
        } else if (st?.pending) {
          stateEl.textContent = t('settings.agents.loginPending');
        } else if (globalThis.window?.plyRemote) {
          // リモートの窓: ログインの戻り先はホストの PC なので、ここからは始めない（docs/remote.md §7.3）
          stateEl.textContent = t('remote.loginOnHostShort');
          stateEl.title = t('remote.loginOnHost');
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn';
          btn.textContent = t('settings.agents.signIn');
          btn.onclick = e => {
            e.stopPropagation();
            if (authLogin) authLogin(agent);
          };
          stateEl.append(btn);
        }

        row.append(info, stateEl);
        return row;
      }));
      if (keepFocus) list.querySelector('[aria-checked=true]')?.focus();
    }

    // ログインの URL と手貼りの欄。ダイアログは modal なので、設定画面に出しても届かない
    const box = authUrlBox?.(selected);
    $('onboardingAuth')?.replaceChildren(...(box ? [box] : []));

    const agent = agents.find(a => a.id === selected), st = auth.get(selected) ?? {};
    const ready = agent?.installed && st.loggedIn;
    $('completeSetup').disabled = !ready;
    error(ready ? ''
      : agent?.installed === false ? t('onboarding.installHint')
      : st.pending ? t('onboarding.waitingLogin')
      : t('onboarding.signInHint'));
  }
  async function refresh() {
    status = await cmd('onboardingStatus');
    paintCwd();
    if (!checked) {
      checked = true;
      if (shouldShowOnboarding(status, getAuth())) {
        try { await cmd('onboardingSeen'); status.seen = true; }
        catch (e) { $('setupError').textContent = t('onboarding.seenFailed', { error: e.message }); }
        close();
        welcome.showModal();
      }
    }
    paint();
  }
  $('closeOnboarding').onclick = () => welcome.close();
  $('setupTab').onclick = () => page();
  $('appearanceTab').onclick = () => page('appearance');
  $('backToChat').onclick = () => close();
  // Esc でも会話へ戻る。重なった dialog と、combo・メニューが既に受け取った Esc は横取りしない
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || isComposingKey(event) || !isOpen()) return;
    if (document.querySelector('dialog[open]')) return;
    close();
  });
  welcome.addEventListener('click', event => {
    if (event.target !== welcome) return;
    const r = welcome.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) welcome.close();
  });
  $('refreshAgents').onclick = async () => {
    $('refreshAgents').disabled = true; $('setupError').textContent = '';
    try { await refreshAuth(); }
    catch (e) { $('setupError').textContent = e.message; }
    finally { $('refreshAgents').disabled = false; }
  };
  $('completeSetup').onclick = async () => {
    $('completeSetup').disabled = true;
    try {
      status = { ...status, ...await cmd('completeSetup', { backend: selected, ...(currentCwd() ? { cwd: currentCwd() } : {}) }) };
      await begin({ backend: status.backend, cwd: status.cwd }, '');
      welcome.close();
      $('prompt').focus();
    } catch (e) { error(e.message); }
    finally { $('completeSetup').disabled = false; }
  };
  // ---- 作業ディレクトリ。フルパスを出し、ホームなら弱い字の「ホーム」を添える。変えるのは「フォルダーを選ぶ…」
  const trimEnd = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase();
  const samePath = (a, b) => trimEnd(a) === trimEnd(b);
  function paintCwd() {
    const cwd = currentCwd();
    const home = Boolean(status?.homeDir) && samePath(cwd, status.homeDir);
    const tag = document.createElement('span');
    tag.className = 'onboarding-cwd-home';
    tag.textContent = t('dialog.onboarding.cwdHome');
    $('onboardingCwdPath').replaceChildren(document.createTextNode(cwd), ...(home ? [' ', tag] : []));
    $('onboardingCwdPath').title = cwd;
  }
  const cwdError = $('onboardingCwdError');
  const browseBox = $('onboardingBrowse');
  const useCwd = (value) => {
    const v = String(value ?? '').trim();
    if (!v) return;
    chosenCwd = v;
    browseBox.hidden = true;
    browseBox.replaceChildren();
    cwdError.textContent = '';
    paintCwd();
    $('onboardingCwdChoose').focus();
  };
  const browse = folderBrowser?.({ cmd, box: browseBox, err: cwdError, onChoose: useCwd, closed: () => !welcome.open });
  $('onboardingCwdChoose').onclick = async () => {
    cwdError.textContent = '';
    // デスクトップ版は OS のダイアログ。ブラウザー版（リモートの窓も）は簡易ブラウザーを案内の中に開く。開いていれば閉じる
    if (globalThis.window?.plyDesktop?.chooseFolder) {
      const picked = await window.plyDesktop.chooseFolder().catch(() => null);
      const path = typeof picked === 'string' ? picked : picked?.path ?? picked?.[0];
      if (path) useCwd(path);
      return;
    }
    if (!browseBox.hidden) { browseBox.hidden = true; browseBox.replaceChildren(); return; }
    browse?.(currentCwd());
  };
  welcome.addEventListener('close', () => { browseBox.hidden = true; browseBox.replaceChildren(); cwdError.textContent = ''; });

  page();
  return { open, close, isOpen, lock, refresh, paint, page };
}
