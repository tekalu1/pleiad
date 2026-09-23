// Only public signing configuration is returned. Credentials stay in the environment.
function releaseSigning(env = process.env, platform = process.platform) {
  const required = name => {
    if (!env[name]?.trim()) throw new Error(`Missing signing setting: ${name}`);
    return env[name].trim();
  };
  if (platform === 'darwin') {
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) required(name);
    return { mac: { hardenedRuntime: true, notarize: true } };
  }
  if (platform !== 'win32') throw new Error('Signed desktop builds require Windows or macOS');
  const publisherName = required('PLY_WIN_PUBLISHER');
  const method = env.PLY_WINDOWS_SIGNING || 'pfx';
  const win = { verifyUpdateCodeSignature: true };
  if (method === 'azure') {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) required(name);
    const endpoint = required('PLY_AZURE_ENDPOINT');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.codesigning.azure.net') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Azure signing endpoint');
    win.azureSignOptions = { publisherName, endpoint, codeSigningAccountName: required('PLY_AZURE_ACCOUNT'), certificateProfileName: required('PLY_AZURE_PROFILE') };
  } else if (method === 'pfx' || method === 'store') {
    win.signtoolOptions = { publisherName, signingHashAlgorithms: ['sha256'] };
    if (method === 'pfx') {
      required('CSC_LINK'); required('CSC_KEY_PASSWORD');
    } else {
      const certificateSha1 = required('PLY_WIN_CERTIFICATE_SHA1');
      if (!/^[a-f\d]{40}$/i.test(certificateSha1)) throw new Error('Invalid signing certificate thumbprint');
      win.signtoolOptions.certificateSha1 = certificateSha1;
    }
  } else throw new Error('PLY_WINDOWS_SIGNING must be pfx, store, or azure');
  return { win };
}
module.exports = { releaseSigning };
