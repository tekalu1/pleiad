// Interactive documents always have an opaque sandbox origin. Never add
// allow-same-origin: the surrounding app carries authenticated cookies.
const CDNS = ['cdnjs.cloudflare.com', 'esm.sh', 'cdn.jsdelivr.net', 'unpkg.com',
  'fonts.googleapis.com', 'fonts.gstatic.com', 'fonts.bunny.net'].map(h => `https://${h}`).join(' ');
export const VISUALIZE_CSP = `default-src 'none'; script-src 'unsafe-inline' ${CDNS}; style-src 'unsafe-inline' ${CDNS}; img-src data: blob:; font-src data: ${CDNS}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
const BASE = `
:root{color-scheme:light dark;--background:light-dark(#fff,#1b1c23);--foreground:light-dark(#1c2247,#e4e5ef);--muted:light-dark(#f4f5f9,#292b35);--muted-foreground:light-dark(#6b7299,#a9afc9);--border:light-dark(#c9cee0,#4e536e);--card:var(--muted);--card-foreground:var(--foreground);--popover:var(--background);--popover-foreground:var(--foreground);--primary:light-dark(#3a499e,#aab8ff);--primary-foreground:var(--background);--secondary:var(--muted);--secondary-foreground:var(--foreground);--accent:var(--muted);--accent-foreground:var(--foreground);--input:var(--border);--ring:var(--primary);--radius:10px;--font-sans:system-ui,sans-serif;--font-mono:ui-monospace,monospace;--font-size-base:14px;--viz-series-1:light-dark(#3a499e,#aab8ff);--viz-series-2:light-dark(#16725e,#77ceb3);--viz-series-3:light-dark(#a15516,#efb16f);--viz-series-4:light-dark(#964477,#e99dcc);--viz-series-5:light-dark(#436b90,#98c7f2);--viz-series-6:light-dark(#746717,#d9cd7a)}
/* スクロールバーは本体（style.css）と同じ。溝と端の矢印は出さず、丸いつまみだけ。色は tokens.css の --surface-thumb / --surface-thumb-hover。
   Chromium は scrollbar-color があると ::-webkit-scrollbar を無視するので、標準の指定は持たないブラウザーにだけ当てる */::-webkit-scrollbar{width:10px;height:10px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:light-dark(#c9cbd2,#35373f);background-clip:padding-box;border:2px solid transparent;border-radius:999px}::-webkit-scrollbar-thumb:hover{background-color:light-dark(#acaeb7,#4a4c54)}::-webkit-scrollbar-button{display:none}@supports not selector(::-webkit-scrollbar){html{scrollbar-color:light-dark(#c9cbd2,#35373f) transparent}}*{box-sizing:border-box}body{margin:0;padding:16px;font:14px/1.5 var(--font-sans);color:var(--foreground);background:var(--background);overflow-wrap:anywhere}svg,canvas,img{max-width:100%}button,input,select{font:inherit}button,select,input{color:var(--foreground);accent-color:var(--primary)}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.card{background:var(--card);padding:16px;border-radius:var(--radius)}.btn{background:var(--muted);color:var(--foreground);border:1px solid var(--border);border-radius:6px;padding:6px 12px}.row,.flex{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.grid{display:grid;gap:16px}.stack{display:flex;flex-direction:column;gap:12px}.muted{color:var(--muted-foreground)}.tooltip{background:var(--popover);color:var(--popover-foreground);padding:6px 10px;border-radius:6px}
`;
const RESIZE = `<script>(()=>{let queued=false;const report=()=>{if(queued)return;queued=true;requestAnimationFrame(()=>{queued=false;parent.postMessage({type:'ply-visualize-height',height:Math.ceil(document.body.getBoundingClientRect().height)},'*')})};new ResizeObserver(report).observe(document.body);addEventListener('load',report);report()})()</script>`;

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', event => {
  if (event.data?.type !== 'ply-visualize-height' || !Number.isFinite(event.data.height)) return;
  // No commands or arbitrary styles cross this boundary: only bounded height,
  // and only from a currently mounted visualization's own WindowProxy.
  for (const frame of document.querySelectorAll('iframe.visualize-frame:not(.visualize-fill)')) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.min(900, Math.max(120, event.data.height))}px`;
  }
});

export function visualizationDocument(content, { theme = '' } = {}) {
  const scheme = ['light', 'dark'].includes(theme) ? `:root{color-scheme:${theme}}` : '';
  // Place policy before ALL model content, even full documents with an existing
  // head, scripts or meta refresh. Nothing from the model enters the parent DOM.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUALIZE_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${BASE}${scheme}</style></head><body>${String(content)}${RESIZE}</body></html>`;
}

/** Scripts run, but in an opaque origin with no referrer or device permissions.
 * Shared by visualizations and the HTML file preview. */
export function isolateFrame(frame) {
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
  return frame;
}

// fill: the frame gets its height from the container (the preview panel), so the
// iframe's own height report is ignored instead of clamping it to 900px.
export function visualizationFrame(content, title, { fill = false } = {}) {
  const frame = document.createElement('iframe');
  frame.className = fill ? 'visualize-frame visualize-fill' : 'visualize-frame';
  isolateFrame(frame);
  frame.title = title || '可視化';
  frame.srcdoc = visualizationDocument(content, { theme: document.documentElement?.dataset?.theme });
  return frame;
}

/** 元のファイル名を使う。無ければタイトルから作り、保存先で困る文字は落とす */
export function visualizationFileName({ path, title }) {
  const base = String(path ?? '').split(/[\\/]/).pop() ?? '';
  if (/\.html?$/i.test(base)) return base;
  // 保存先で困る記号（92 は円記号／バックスラッシュ）と制御文字を落とす
  const banned = '/:*?"<>|';
  const safe = [...String(title ?? '')]
    .filter(c => c >= ' ' && c.codePointAt(0) !== 92 && !banned.includes(c)).join('').trim();
  return `${safe || '可視化'}.html`;
}

/**
 * 保存するのは会話に残っている内容。ホスト上のファイルを取りに行かない
 * （消えていても、書き換わっていても、見えているものが手元に落ちる）。
 * 表示と同じ包み（CSP・基礎スタイル）を付けるので、単体で開いても同じに見える。
 * 配色は焼き込まず、開いた環境のライト／ダークに従う。
 */
export function visualizationBlobUrl(content) {
  return URL.createObjectURL(new Blob([visualizationDocument(content)], { type: 'text/html;charset=utf-8' }));
}

/** 会話にはいくつも並ぶので、URL は押したときだけ作って手放す */
export function downloadVisualization({ path, title, content }) {
  const url = visualizationBlobUrl(content);
  const link = document.createElement('a');
  link.href = url; link.download = visualizationFileName({ path, title });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
