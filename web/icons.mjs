// 24×24 の共通線画。文字列の描画と DOM の描画で同じパスを使う。
export const COPY_PATHS = ['M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'];
export const copyIcon = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${COPY_PATHS.map(d => `<path d="${d}"/>`).join('')}</svg>`;
export const checkIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
export const downloadIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M8 12l4 4 4-4M5 19h14"/></svg>';
export const trashIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
export const closeIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
export const backIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
// 会話とプレビューの並び。開く・広げる・並べて戻すで、同じ枠の中の仕切りを動かす
export const sidePanelIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M14 5v14"/></svg>';
export const expandIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
export const collapseIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6"/></svg>';
export const folderIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
export const fileIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>';
// ファイルの操作メニュー（⋯）。点は太めの線で打つ
export const moreIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="2.6"/></svg>';
