import { renderMarkdown } from './render.mjs';
import { fileReference } from './file-reference.mjs';
import { VISUALIZE_CSP, isolateFrame } from './visualize-frame.mjs';

// Same policy as visualizations: inline scripts and the CDN allowlist only, no network access.
export const PREVIEW_CSP = VISUALIZE_CSP;

/** CSV/TSV with escaped quotes, delimiters and newlines inside quoted cells. */
export function parseTable(text, delimiter = ',', maxRows = 501, maxColumns = 100) {
  const rows = []; let row = [], cell = '', quoted = false, truncated = false;
  const pushCell = () => { if (row.length < maxColumns) row.push(cell); else truncated = true; cell = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' && (quoted || !cell)) {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && c === delimiter) pushCell();
    else if (!quoted && (c === '\n' || c === '\r')) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushCell(); rows.push(row); row = [];
      if (rows.length >= maxRows && i < text.length - 1) { truncated = true; break; }
    } else cell += c;
  }
  if (rows.length < maxRows && (cell || row.length)) { pushCell(); rows.push(row); }
  return { rows, truncated };
}

const dataUrl = file => `data:${file.mime};base64,${file.data}`;

/** Local `<script src>` becomes inline text (the file is read through the same
 * budget as other assets). Remote sources stay; the CSP allows only the CDN list.
 */
export async function inlineScripts(root, asset, omitted) {
  for (const script of root.querySelectorAll('script')) {
    const raw = script.getAttribute('src') ?? null;
    if (raw == null || !fileReference(raw)) continue;
    script.removeAttribute('src'); script.removeAttribute('integrity');
    try {
      const file = await asset(raw);
      if (file.kind !== 'text' || typeof file.text !== 'string' || file.size > 512 * 1024) throw new Error('script');
      // Serialized raw inside <script>: keep the text from closing its own element.
      script.textContent = file.text.replace(/<\/(script)/gi, '<\\/$1');
    } catch { omitted.add('スクリプト'); script.remove(); }
  }
}

/** Policy goes before ALL file content, even documents with their own head. */
export function previewDocument(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font:15px/1.7 system-ui,sans-serif;overflow-wrap:anywhere}img,svg{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

/** Scripts run in an opaque origin (never allow-same-origin): the app carries authenticated cookies. */
export function previewFrame(documentText, title) {
  const frame = isolateFrame(document.createElement('iframe'));
  frame.className = 'file-preview-frame'; frame.title = title; frame.srcdoc = documentText;
  return frame;
}

/** Never connect untrusted markup to the parent document. Templates are inert.
 * Serialize into an opaque sandboxed iframe (scripts allowed, no same-origin)
 * after replacing local resources. Source content cannot relax the CSP prepended before it.
 */
export async function htmlDocument(text, loadAsset) {
  const template = document.createElement('template');
  template.innerHTML = text;
  const fragment = template.content;
  const omitted = new Set();
  let count = 0;
  const asset = async raw => {
    if (++count > 24 || !fileReference(raw)) throw new Error('resource');
    return loadAsset(raw);
  };
  for (const element of fragment.querySelectorAll('iframe,frame,object,embed,base,meta[http-equiv],form')) {
    if (element.localName === 'form') element.replaceWith(...element.childNodes);
    else element.remove();
  }
  await inlineScripts(fragment, asset, omitted);
  async function cssText(css, base) {
    // Imports, remote fonts and remote URLs do not make network requests.
    if (/@import\b/i.test(css)) { omitted.add('追加のスタイル'); css = css.replace(/@import\s+(?:url\([^)]*\)|"[^"]*"|'[^']*')[^;]*;?/gi, ''); }
    const refs = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
    for (const ref of refs) {
      if (/^data:image\//i.test(ref[2]) || /^#/.test(ref[2])) continue;
      let replacement = 'none';
      try {
        const file = await loadAsset(ref[2], base);
        if (++count > 24 || file.kind !== 'image' || file.size > 4 * 1024 * 1024) throw new Error('resource');
        replacement = `url("${dataUrl(file)}")`;
      } catch { omitted.add('画像・フォント'); }
      css = css.replace(ref[0], replacement);
    }
    return css;
  }
  for (const link of fragment.querySelectorAll('link')) {
    if (link.rel.toLowerCase() === 'stylesheet') {
      try {
        const file = await asset(link.getAttribute('href'));
        if (file.kind !== 'text' || file.size > 512 * 1024) throw new Error('stylesheet');
        const style = document.createElement('style'); style.textContent = await cssText(file.text, file.path); link.replaceWith(style);
      } catch { omitted.add('スタイル'); link.remove(); }
    } else link.remove();
  }
  for (const style of fragment.querySelectorAll('style')) style.textContent = await cssText(style.textContent);
  for (const element of fragment.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (['srcdoc','srcset','ping','autofocus','formaction','action','target','download'].includes(name)) element.removeAttribute(attribute.name);
    }
    if (element.hasAttribute('style')) element.setAttribute('style', await cssText(element.getAttribute('style')));
    // Local document links are available in source mode. Prevent frame navigation.
    if (element.localName === 'a' || element.localName === 'area') { element.removeAttribute('href'); element.removeAttribute('xlink:href'); }
    if (element.localName === 'img') {
      const raw = element.getAttribute('src') ?? '';
      if (/^data:image\//i.test(raw)) continue;
      element.removeAttribute('src');
      try {
        const file = await asset(raw);
        if (file.kind !== 'image' || file.size > 4 * 1024 * 1024) throw new Error('image');
        element.setAttribute('src', dataUrl(file));
      } catch { omitted.add('画像'); element.setAttribute('alt', `${element.getAttribute('alt') || raw || '画像'}（表示できません）`); }
    }
    if (['video','audio','source','track','image','use'].includes(element.localName)) {
      for (const name of ['src','href','xlink:href','poster']) if (element.hasAttribute(name) && !element.getAttribute(name).startsWith('#')) { element.removeAttribute(name); omitted.add('メディア'); }
    }
  }
  return {
    document:previewDocument(template.innerHTML),
    note:omitted.size ? `一部の${[...omitted].join('・')}を読み込めません。外部の資源は、許可されたCDNのスクリプト以外は読み込みません。` : '',
  };
}

export async function markdownContent(text, loadAsset) {
  const article = document.createElement('article'); article.className = 'body file-preview-document';
  article.innerHTML = renderMarkdown(text);
  const notes = [];
  let count = 0;
  for (const img of article.querySelectorAll('img')) {
    const raw = img.getAttribute('src'); img.removeAttribute('src');
    if (/^data:image\//i.test(raw)) { img.src = raw; continue; }
    try {
      if (++count > 24) throw new Error('resource');
      const file = await loadAsset(fileReference(raw)?.path || raw);
      if (file.kind !== 'image' || file.size > 4 * 1024 * 1024) throw new Error('image');
      img.src = dataUrl(file);
    } catch { img.alt += '（表示できません）'; notes.push('一部の画像を表示できません。'); }
  }
  return { article, note:notes[0] || '' };
}
