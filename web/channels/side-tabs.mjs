// 脇の Chats / Channels の 2 タブ（docs/design-system.md「脇の Chats / Channels」、ADR 0092）。
// 切り替えは html.side-channels（脇）と body.channels（メインの #channelsView）の付け外し。選んだ側は覚える。
// 札の点（.tab-dot.mark = あなた待ち / .tab-dot.unread = 未読）は setDot() で付ける（W1 が数える）。
const KEY = 'agent-host-side-tab';
const TABS = ['chats', 'channels'];

export function createSideTabs({ onChange = () => {} } = {}) {
  const root = document.documentElement;
  const nav = document.getElementById('sideTabs');
  const buttons = { chats: document.getElementById('tabChats'), channels: document.getElementById('tabChannels') };
  const side = document.getElementById('channelsSide');
  const view = document.getElementById('channelsView');
  // 会話の頭・筋・入力欄。Channels を見ている間はキーボードと読み上げを届かせない（設定の画面と同じ手。web/onboarding.mjs）
  const covered = () => [...(document.querySelector('body > main')?.children ?? [])].filter((n) => n.matches('.top, #logFrame, .composer'));
  let tab = root.classList.contains('side-channels') ? 'channels' : 'chats';

  function paint() {
    const on = tab === 'channels';
    root.classList.toggle('side-channels', on);
    document.body.classList.toggle('channels', on);
    for (const [name, button] of Object.entries(buttons)) {
      button.setAttribute('aria-selected', String(name === tab));
      button.tabIndex = name === tab ? 0 : -1;
    }
    if (side) side.hidden = !on;
    for (const node of covered()) node.inert = on;
    if (view) view.inert = !on;
  }

  function set(next, { focus = false } = {}) {
    if (!TABS.includes(next)) return;
    const changed = next !== tab;
    tab = next;
    paint();
    if (changed) {
      try { localStorage.setItem(KEY, tab); } catch { /* 覚えられなくても切り替わる */ }
      onChange(tab);
    }
    if (focus) buttons[tab].focus();
  }

  for (const [name, button] of Object.entries(buttons)) button.addEventListener('click', () => set(name));
  // タブは ←→ で移る（roving tabindex）
  nav.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.indexOf(tab);
    set(e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS.at(-1) : TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length], { focus: true });
  });
  // 新しい会話・会話を開く・設定は Chats の側の操作。Channels を見ていたら Chats へ戻す
  document.getElementById('newSession')?.addEventListener('click', () => set('chats'), true);
  paint();

  return {
    get tab() { return tab; },
    set,
    /** 札の点。kind は 'mark'（あなた待ち）| 'unread'（未読）| null（消す） */
    setDot(name, kind) {
      const dot = buttons[name]?.querySelector('.tab-dot');
      if (!dot) return;
      dot.hidden = !kind;
      dot.classList.toggle('mark', kind === 'mark');
      dot.classList.toggle('unread', kind === 'unread');
    },
  };
}
