// 読むだけの筋（作業の詳細）を作り直すときに、開いていた所を引き継ぐ（docs/design-system.md「バックグラウンド」）。
//
// 走っている子の詳細は、running の配信のたびに会話を最初から作り直す（web/client.mjs の refreshDetail）。
// 作り直すと、利用者が開いたツール行の詳細・ツールのまとまり・長文の畳みが全部閉じてしまうので、
// 作り直す前に開閉を控え、作り直した直後（画面に置く前）に同じ所へ戻す。画面に置く前なので開く動きは出ない。
//
// 所の見分け方: 発言の行（.mw の data-key）の中で、ツール行（.tc の data-id）の中ならその id、そうでなければ行そのものを持ち主にして、
// 種類（details・まとまり・畳み）ごとに出てくる順の番号で引く。同じ履歴から作り直す限り、同じ所は同じ持ち主の同じ番号になる。

const scopeOf = (node, scope) => {
  if (node.classList?.contains('mw') && node.dataset?.key) return `row:${node.dataset.key}`;
  if (node.classList?.contains('tc') && node.dataset?.id) return `tc:${node.dataset.id}`;
  return scope;
};

/** 開閉の状態を持つ部品を、持ち主と種類と番号で引ける形にして順に渡す。kind: details・bundle・fold */
function forEachStateful(root, visit) {
  const counts = new Map();
  const walk = (node, scope) => {
    scope = scopeOf(node, scope);
    if (scope) {
      const kind = node.tagName === 'DETAILS' ? 'details' : node.bundle ? 'bundle' : node.fold ? 'fold' : null;
      if (kind) {
        const id = `${scope}|${kind}`;
        const n = counts.get(id) ?? 0;
        counts.set(id, n + 1);
        visit(`${id}${n}`, kind, node);
      }
    }
    for (const child of node.children ?? []) walk(child, scope);
  };
  walk(root, null);
}

/**
 * 今の開閉の状態を控える。
 * @param {HTMLElement} root 読むだけの筋（.bg-thread）
 * @returns {Map<string, boolean | {expanded:boolean, k:number}>}
 */
export function captureViewState(root) {
  const state = new Map();
  if (!root) return state;
  forEachStateful(root, (key, kind, node) => {
    if (kind === 'details') state.set(key, node.hasAttribute('open'));
    else if (kind === 'bundle') state.set(key, node.bundle.viewState());
    else state.set(key, node.fold.isOpen());
  });
  return state;
}

/** 控えた開閉の状態を、作り直した筋へ動かさずに戻す。控えに無い所（新しく増えた所）は作ったままにする */
export function restoreViewState(root, state) {
  if (!root || !state?.size) return;
  forEachStateful(root, (key, kind, node) => {
    if (!state.has(key)) return;
    const was = state.get(key);
    if (kind === 'details') node.open = was;
    else if (kind === 'bundle') node.bundle.restoreView(was);
    else if (was && !node.fold.isOpen()) node.fold.open(false);
  });
}
