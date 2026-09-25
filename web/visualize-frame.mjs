// Interactive documents always have an opaque sandbox origin. Never add
// allow-same-origin: the surrounding app carries authenticated cookies.
import { t } from './i18n.mjs';
import { visualizationDocument } from './visualize-document.mjs';
export { VISUALIZE_CSP, visualizationDocument } from './visualize-document.mjs';

if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('message', event => {
  if (event.data?.type !== 'ply-visualize-height' || !Number.isFinite(event.data.height)) return;
  // No commands or arbitrary styles cross this boundary: only bounded height,
  // and only from a currently mounted visualization's own WindowProxy.
  for (const frame of document.querySelectorAll('iframe.visualize-frame:not(.visualize-fill)')) {
    if (frame.contentWindow !== event.source) continue;
    frame.style.height = `${Math.min(900, Math.max(120, event.data.height))}px`;
  }
});

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
  frame.title = title || t('timeline.present.kind.visualization');
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
  return `${safe || t('timeline.present.kind.visualization')}.html`;
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
