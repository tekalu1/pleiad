// Shared wire format. Only standalone references outside Markdown fences execute.
export const VISUALIZE_START = '\uE200visualize\uE202';
export const VISUALIZE_END = '\uE201';
export function visualizeReferences(text) {
  const refs = [];
  let offset = 0, fence = null;
  for (const line of String(text ?? '').split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
    } else if (!fence && (line.startsWith(VISUALIZE_START) || line.startsWith('visualize{'))) {
      const raw = line.trim();
      const ascii = raw.startsWith('visualize{');
      if (ascii || raw.endsWith(VISUALIZE_END)) {
        let value, error;
        try {
          value = JSON.parse(ascii ? raw.slice('visualize'.length) : raw.slice(VISUALIZE_START.length, -1));
          if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).some(k => !['path', 'title', 'mode'].includes(k))
            || typeof value.path !== 'string' || !value.path || value.path.length > 8192
            || (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 1000))
            || (value.mode !== undefined && value.mode !== 'wide')) throw new Error();
        } catch { error = '可視化の参照形式が不正です'; } // i18n-ignore: core/visualize.mjs がサーバーの言語でエラーカードに保存する文。web の辞書では訳せない（server 段階の残課題「可視化のエラーカード」と一緒に扱う）
        refs.push({ start: offset, end: offset + line.length, raw, value, error });
      }
    }
    offset += line.length + 1;
  }
  return refs;
}

// The saved visual is rendered by the ordinary timeline, never by fetching a path
// from the browser. Leave code examples and user messages intact.
export function withoutVisualizeReferences(text, savedReferences) {
  let result = String(text ?? '');
  for (const ref of visualizeReferences(result).reverse()) {
    if (savedReferences && !savedReferences.includes(ref.raw)) continue;
    result = result.slice(0, ref.start) + result.slice(ref.end);
  }
  return result;
}
