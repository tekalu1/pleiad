// Shared destination for external links from the conversation and preview frames.
// The browser opens a tab; Electron's setWindowOpenHandler routes it to the OS browser.
export function openExternalLink(url, { newWindow = true } = {}) {
  // The in-app browser route can use newWindow when it replaces this function.
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
  const link = document.createElement('a');
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer nofollow';
  document.body.append(link);
  try { link.click(); } finally { link.remove(); }
  return true;
}

export function handlePreviewLinkMessage(event) {
  if (event.data?.type !== 'ply-preview-open-link' || typeof event.data.url !== 'string' ||
      typeof event.data.newWindow !== 'boolean') return false;
  for (const frame of document.querySelectorAll('iframe.visualize-frame, iframe.file-preview-frame')) {
    if (frame.contentWindow === event.source) {
      return openExternalLink(event.data.url, { newWindow: event.data.newWindow });
    }
  }
  return false;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('message', handlePreviewLinkMessage);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a.md-link[target="_blank"]');
    if (!link || !document.querySelector('#log')?.contains(link)) return;
    if (!/^https?:\/\//i.test(link.getAttribute('href') || '')) return;
    event.preventDefault();
    openExternalLink(link.href, { newWindow: true });
  });
}
