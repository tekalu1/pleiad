// 出ている承認・質問のカードの名簿（web/client.mjs の openCards）。ほかで片付いたときに畳むために持つ。
// 同じ承認のカードが 2 か所に出ることがある（ホストの子の承認は、依頼元の会話と作業の窓の詳細の両方。docs/remote.md §4.5）ので、
// id ごとにカードの集合で持つ。畳むときは集合の全部を畳み、外れた（DOM から消えた・答え終えた）カードだけを集合から外す。
// entry: { el, sending(), fold(how), setOnline?(online) }

export function createCardRoll() {
  const cards = new Map();   // permission id → Set<entry>
  const of = (id) => [...(cards.get(id) ?? [])];
  return {
    has: (id) => cards.has(id),
    of,
    ids: () => [...cards.keys()],
    add(id, entry) {
      if (!cards.has(id)) cards.set(id, new Set());
      cards.get(id).add(entry);
    },
    /** その承認のカードのどれかが、この窓で答えを送っている最中か */
    sending: (id) => of(id).some((entry) => entry.sending()),
    /** 名簿から外して、その承認のカードを全部畳む */
    fold(id, how) {
      const list = of(id);
      cards.delete(id);
      for (const entry of list) entry.fold(how);
    },
    /** 外れたカード（DOM から消えた・答え終えた）だけを集合から外す。集合が空になった id は行ごと外す */
    prune() {
      for (const [id, set] of cards) {
        for (const entry of set) if (!entry.el.isConnected || entry.el.classList?.contains("done")) set.delete(entry);
        if (!set.size) cards.delete(id);
      }
    },
  };
}
