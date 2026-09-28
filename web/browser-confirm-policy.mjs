// Shared by the renderer and snapshot responses. Only exact HTTPS origins enter CSP.
export function externalOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

export function validBrowserPref(key, value) {
  if (['confirmExternalLoads', 'confirmAgentSites'].includes(key)) return typeof value === 'boolean';
  if (!['externalSitePermissions', 'agentSitePermissions'].includes(key) || !Array.isArray(value) || value.length > 500) return false;
  return value.every(row => {
    if (!row || !['always', 'ask'].includes(row.mode)) return false;
    let url;
    try { url = new URL(row.origin); } catch { return false; }
    if (!['https:', ...(key === 'agentSitePermissions' ? ['http:'] : [])].includes(url.protocol) || url.origin !== row.origin || url.username || url.password) return false;
    return key !== 'agentSitePermissions' || typeof row.agent === 'string' && /^[a-z0-9_-]{1,100}$/i.test(row.agent);
  });
}

export function previewPolicy(prefs = {}, once = []) {
  return { confirm: prefs.confirmExternalLoads === true, origins: [...(prefs.externalSitePermissions ?? []).filter(row => row.mode === 'always').map(row => row.origin), ...once] };
}

export function previewCsp({ confirm = false, origins = [] } = {}) {
  const sources = confirm ? [...new Set(origins.map(externalOrigin).filter(Boolean))].join(' ') : 'https:';
  const remote = sources || "'none'";
  return `default-src 'none'; script-src 'unsafe-inline'${sources ? ' ' + sources : ''}; style-src 'unsafe-inline'${sources ? ' ' + sources : ''}; img-src ${sources ? sources + ' ' : ''}data: blob:; font-src ${sources ? sources + ' ' : ''}data: blob:; connect-src ${remote}; frame-src ${remote}; media-src ${sources ? sources + ' ' : ''}data: blob:; worker-src ${sources ? sources + ' ' : ''}blob:; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
