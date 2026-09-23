import { isComposingKey } from './keyboard.mjs';
import { t } from './i18n.mjs';

const pages = [['setup', 'setupTab', 'setupPanel'], ['usage', 'usageTab', 'usagePanel'], ['appearance', 'appearanceTab', 'appearancePanel'], ['context', 'openContext', 'contextPanel'], ['updates', 'updatesTab', 'updatesPanel']];

// A failed status check is not evidence that the account is unconfigured.
export function shouldShowOnboarding(status, auth) {
  if (!status.seen && !status.setupComplete) return true;
  return status.agents.length === 0 || status.agents.every(agent => {
    const account = auth.get(agent.id);
    return !agent.installed || account?.supported === true && account.loggedIn === false && !account.pending;
  });
}

export function setupOnboarding({ cmd, refreshAuth, getAuth, authLogin, authUrlBox, begin }) {
  const $ = id => document.getElementById(id);
  const welcome = $('onboardingDialog');
  let status = null, selected = '', checked = false, locked = false;
  const error = message => { $('onboardingError').textContent = message; };
  const isOpen = () => document.body.classList.contains('settings');
  function page(active = 'setup') {
    for (const [name, button, panel] of pages) {
      $(panel).hidden = name !== active;
      $(button).setAttribute('aria-pressed', String(name === active));
      if (name === active) $('settingsPageTitle').textContent = $(button).textContent;
    }
  }
  // 設定は画面全体。脇の一覧がメニューに、会話がページに入れ替わる
  function open(active = 'setup') {
    if (welcome.open) return;
    page(active);
    document.body.classList.add('settings');
    $('settingsNav').querySelector('[aria-pressed=true]')?.focus();
  }
  function close() {
    if (locked || !isOpen()) return;
    document.body.classList.remove('settings');
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
            link.textContent = 'インストール';
            link.href = agent.installUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            link.onclick = e => e.stopPropagation();
            stateEl.append(link);
          } else {
            stateEl.textContent = '未インストール';
          }
        } else if (st?.loggedIn) {
          stateEl.textContent = st.account || 'ログイン済み';
        } else if (st?.pending) {
          stateEl.textContent = 'ログインを待っている';
        } else if (globalThis.window?.plyRemote) {
          // リモートの窓: ログインの戻り先はホストの PC なので、ここからは始めない（docs/remote.md §7.3）
          stateEl.textContent = t('remote.loginOnHostShort');
          stateEl.title = t('remote.loginOnHost');
        } else {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn';
          btn.textContent = 'ログイン';
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
      : agent?.installed === false ? 'このエージェントをインストールし、設定から状態を再確認してください。'
      : st.pending ? 'ログインの完了を待っています。'
      : 'このエージェントにログインしてください。');
  }
  async function refresh() {
    status = await cmd('onboardingStatus');
    if (!checked) {
      checked = true;
      if (shouldShowOnboarding(status, getAuth())) {
        try { await cmd('onboardingSeen'); status.seen = true; }
        catch (e) { $('setupError').textContent = `初回表示の記録を保存できませんでした: ${e.message}`; }
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
      status = { ...status, ...await cmd('completeSetup', { backend: selected }) };
      await begin({ backend: status.backend, cwd: status.cwd }, '');
      welcome.close();
      $('prompt').focus();
    } catch (e) { error(e.message); }
    finally { $('completeSetup').disabled = false; }
  };
  page();
  return { open, close, isOpen, lock, refresh, paint, page };
}
