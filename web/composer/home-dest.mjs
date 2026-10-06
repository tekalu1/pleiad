// 一時チャットの新しい会話の宛先のチップ（ADR 9101・docs/design-system.md「一時チャットの流れ」）。
// まだ送っていない会話の入力欄にだけ出る。「bot なし」（既定）は今までどおり AI と直接話す会話、bot を選ぶと最初の送信は一時チャットの
// 実体のチャンネルへの投稿（channels.post の to）になり、その bot との一時チャットのスレッドが始まる。送った後の会話では選べない。
//
// createHomeDest({ anchor, t, invoke, showMenu, visible, onChange }) → { chip, bot, reset(), paint(), botsChanged() }
//   anchor   … このボタンの後ろに置く（Chats の入力欄の添付の ＋）
//   visible  … () => boolean。まだ送っていない会話か
//   onChange … 選び直した（送信の字の案内などを描き直す）
import { el } from '../dom.mjs';
import { botIcon } from '../channels/bot-icon.mjs';

export function createHomeDest({ anchor, t, invoke, showMenu, visible = () => false, onChange = () => {} }) {
  const chip = el('button', 'chip dest');
  chip.type = 'button';
  chip.id = 'chatDest';
  chip.hidden = true;
  chip.setAttribute('aria-haspopup', 'menu');
  anchor.after(chip);

  let bots = null;      // 読んだ bot の一覧（null = まだ読んでいない）
  let loading = null;
  let chosen = null;    // 選んだ bot の id（null = bot なし）

  async function load() {
    if (loading) return loading;
    loading = invoke('bots.list', {}).then((r) => { bots = r?.bots ?? []; }).catch(() => { bots ??= []; }).finally(() => { loading = null; paint(); });
    return loading;
  }
  const botOf = () => (chosen && bots?.find((b) => b.id === chosen)) || null;

  function paint() {
    const on = visible() && Boolean(bots?.length);
    if (visible() && bots === null) load();
    if (chosen && bots && !botOf()) chosen = null;   // 消えた bot
    chip.hidden = !on;
    if (!on) return;
    const bot = botOf();
    chip.replaceChildren();
    if (bot) chip.append(botIcon(bot, 'av xs'), el('span', 'v', bot.name));
    else chip.append(el('span', 'v', t('channels:homeDest.none')));
    chip.append(el('span', 'cv', '▾'));
    const label = bot ? t('channels:homeDest.label', { name: bot.name }) : t('channels:homeDest.noneLabel');
    chip.title = label;
    chip.setAttribute('aria-label', label);
    chip.classList.toggle('chosen', Boolean(bot));
  }

  chip.onclick = () => {
    const bot = botOf();
    const pick = (id) => { chosen = id; paint(); onChange(); };
    const items = [
      { label: t('channels:homeDest.none'), hint: t('channels:homeDest.noneHint'), checked: !bot, onClick: () => pick(null) },
      { head: t('channels:homeDest.bots') },
      ...(bots ?? []).map((b) => ({ label: b.name, checked: bot?.id === b.id, onClick: () => pick(b.id) })),
    ];
    const r = chip.getBoundingClientRect();
    showMenu(r.left, r.top - 4, items, t('channels:homeDest.title'));
  };

  return {
    chip,
    /** 選んでいる bot（bot なしなら null） */
    get bot() { return visible() ? botOf() : null; },
    /** 会話を移った・送った: bot なしに戻す */
    reset() { chosen = null; paint(); },
    paint,
    /** bot が増えた・変わった・消えた */
    botsChanged() { if (bots !== null) { bots = null; } paint(); },
  };
}
