// 24×24 の共通線画。文字列の描画と DOM の描画で同じパスを使う。
export const COPY_PATHS = ['M10 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z', 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2'];
export const copyIcon = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${COPY_PATHS.map(d => `<path d="${d}"/>`).join('')}</svg>`;
export const checkIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
export const downloadIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M8 12l4 4 4-4M5 19h14"/></svg>';
export const trashIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
export const closeIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
export const backIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
// 会話とプレビューの並び。開く・広げる・並べて戻すで、同じ枠の中の仕切りを動かす
export const openInBrowserIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/></svg>';
export const sidePanelIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M14 5v14"/></svg>';
export const expandIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
export const collapseIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10h-6V4M4 14h6v6M14 10l6-6M10 14l-6 6"/></svg>';
export const folderIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
export const fileIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h10l6 6v10H4z"/><path d="M14 4v6h6"/></svg>';
// プレビューのツリーの見出し: 開いているファイルを表示（照準）・すべて折りたたむ（上下から閉じる）
export const locateIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.6"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/></svg>';
export const collapseAllIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg>';
// ファイルの操作メニュー（⋯）。点は太めの線で打つ
export const moreIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h.01M12 12h.01M19 12h.01" stroke-width="2.6"/></svg>';
// バックグラウンドの入口: 裏のコマンド・端末の絵（ターミナルの >_）
export const TERMINAL_PATHS = ['M4 5h16v14H4z', 'M7.5 10l2.5 2.5-2.5 2.5', 'M12.5 15h4'];
// git の動き（docs/design-system.md「git の動き」）: ブランチ・コミット・PR・会話のこの場所へ・›
export const branchIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.75" cy="5.4" r="2.4"/><circle cx="6.75" cy="18.6" r="2.4"/><circle cx="17.25" cy="8.1" r="2.4"/><path d="M6.75 7.8v8.4M17.25 10.5c0 3.3-2.4 4.35-5.4 4.8-2.85.45-5.1 1.05-5.1 2.1"/></svg>';
export const commitIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.6"/><path d="M2.25 12h6.15M15.6 12h6.15"/></svg>';
export const prIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.75" cy="5.4" r="2.4"/><circle cx="6.75" cy="18.6" r="2.4"/><circle cx="17.25" cy="18.6" r="2.4"/><path d="M6.75 7.8v8.4M17.25 16.2v-5.85c0-1.95-1.2-3.15-3.15-3.15h-1.8M14.4 4.65 12 7.05l2.4 2.4"/></svg>';
export const jumpIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.75 5.25v6a3 3 0 0 1-3 3H5.25M9.75 9l-4.5 5.25 4.5 5.25"/></svg>';
export const chevRightIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
// worktree（ADR 0089）: 退避（箱）・リンク・鍵・元へ戻す
export const archiveIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 5h17v4h-17zM5 9v10h14V9M10 13h4"/></svg>';
export const linkIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>';
export const lockIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
export const undoIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>';
