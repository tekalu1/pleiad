// git パネルの線画アイコン（24×24 の共通線画。web/icons.mjs と同じ作り）。
const make = (paths) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
export const refreshIcon = make('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.8h-4.8"/>');
export const chatIcon = make('<path d="M4.5 5.5h15v10.5H10l-5.5 4z"/><path d="M12 8.2v5M9.5 10.7h5"/>');
export const listIcon = make('<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.8" cy="6.5" r=".9"/><circle cx="4.8" cy="12" r=".9"/><circle cx="4.8" cy="17.5" r=".9"/>');
export const treeIcon = make('<path d="M4 5h7M7 5v13.5h4M7 12h4"/><path d="M14 12h6M14 18.5h6M14 5h6"/>');
export const upIcon = make('<path d="M12 19V5M6 11l6-6 6 6"/>');
export const downIcon = make('<path d="M12 5v14M6 13l6 6 6-6"/>');
export const prevChangeIcon = make('<path d="M5 4.5h14M12 20V9M7 13.5l5-5 5 5"/>');
export const nextChangeIcon = make('<path d="M5 19.5h14M12 4v11M7 10.5l5 5 5-5"/>');
export const inlineIcon = make('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M7 9h10M7 12.5h7M7 16h9"/>');
export const sideIcon = make('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M12 4v16M6.5 9h3M14.5 9h3M6.5 13h3M14.5 13h3"/>');
export const wrapIcon = make('<path d="M4 6h16M4 12h12.5a3 3 0 0 1 0 6H12M14 15.5 11.5 18l2.5 2.5M4 18h4"/>');
export const tagIcon = make('<path d="M3.5 11.6V4.5a1 1 0 0 1 1-1h7.1l9 9-8.1 8.1z"/><circle cx="8" cy="8" r="1.4"/>');
export const cloudIcon = make('<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/>');
export const flagIcon = make('<path d="M5.5 21V4M5.5 4.5h11l-2.3 4 2.3 4h-11"/>');
export const diffIcon = make('<path d="M8 4v7M4.5 7.5h7M12.5 18h7"/><path d="M19 5 5 19"/>');
export const graphTabIcon = make('<circle cx="7" cy="5.5" r="2.2"/><circle cx="7" cy="18.5" r="2.2"/><circle cx="17" cy="12" r="2.2"/><path d="M7 7.7v8.6M14.8 12H12a5 5 0 0 1-5-5"/>');
export const worktreeTabIcon = make('<path d="M2.5 12H8M19 5.5h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9M16.5 3 19.2 5.5 16.5 8M16.5 16l2.7 2.5-2.7 2.5"/>');
