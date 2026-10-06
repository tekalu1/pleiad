// メインの面の切り替え（会話の面 / Channels の面 #channelsView）。脇の札はやめた（脇は 1 つで、並べ方を切り替える。docs/design-system.md「脇」）。
// 面は開いたもので決まる: 会話を開けば会話の面、チャンネル・スレッド・bot のページを開けば Channels の面。切り替えは body.channels の付け外しで、
// 最後の面は覚える（再読み込みで同じ面に戻す。場所は web/view-address.mjs）。札の点の口（setDot）は残すが何もしない。
const KEY = 'agent-host-side-tab';
const TABS = ['chats', 'channels'];

export function createSideTabs({ onChange = () => {} } = {}) {
  const root = document.documentElement;
  const side = document.getElementById('channelsSide');
  const view = document.getElementById('channelsView');
  // 会話の頭・筋・入力欄。Channels を見ている間はキーボードと読み上げを届かせない（設定の画面と同じ手。web/onboarding.mjs）
  const covered = () => [...(document.querySelector('body > main')?.children ?? [])].filter((n) => n.matches('.top, #logFrame, .composer'));
  let tab = 'chats';
  try { if (localStorage.getItem(KEY) === 'channels') tab = 'channels'; } catch { /* 覚えていなければ会話の面 */ }

  function paint() {
    const on = tab === 'channels';
    root.classList.remove('side-channels');
    document.body.classList.toggle('channels', on);
    if (side) side.hidden = true;
    for (const node of covered()) node.inert = on;
    if (view) view.inert = !on;
  }

  function set(next) {
    if (!TABS.includes(next)) return;
    const changed = next !== tab;
    tab = next;
    paint();
    if (changed) {
      try { localStorage.setItem(KEY, tab); } catch { /* 覚えられなくても切り替わる */ }
      onChange(tab);
    }
  }

  // 新しい会話・会話を開く・設定は Chats の側の操作。Channels を見ていたら Chats へ戻す
  document.getElementById('newSession')?.addEventListener('click', () => set('chats'), true);
  paint();

  return {
    get tab() { return tab; },
    set,
    /** 札の点（札をやめたので何もしない。あなた待ち・未読は脇の行と通知の一覧が示す） */
    setDot() {},
  };
}
