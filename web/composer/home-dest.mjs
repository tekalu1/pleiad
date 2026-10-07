// Chats の未送信の宛先。表示と選択はモデルの面（composer-controls.mjs）で共通に扱う。
// 送る前だけ bot を選べる。送った後は会話の宛先に固定される（ADR 0157）。
export function createHomeDest({ invoke, visible = () => false, onChange = () => {} }) {
  let bots = null;
  let loading = null;
  let chosen = null;

  async function load() {
    if (loading) return loading;
    loading = invoke('bots.list', {}).then((r) => {
      bots = (r?.bots ?? []).filter((b) => !b.plain);
    }).catch(() => { bots ??= []; }).finally(() => {
      loading = null;
      onChange();
    });
    return loading;
  }
  const botOf = () => chosen && bots?.find((b) => b.id === chosen) || null;
  function paint() {
    if (visible() && bots === null) void load();
    if (chosen && bots && !botOf()) chosen = null;
  }
  return {
    get bot() { return visible() ? botOf() : null; },
    get bots() { return bots ?? []; },
    get selected() { return visible() ? chosen : null; },
    choose(id) {
      if (!visible()) return;
      const next = id && bots?.some((b) => b.id === id) ? id : null;
      if (next === chosen) return;
      chosen = next;
      onChange();
    },
    reset() { chosen = null; paint(); onChange(); },
    paint,
    botsChanged() { bots = null; paint(); },
  };
}
