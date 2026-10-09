const { loadSigners, normalizeThumbprint } = require('../desktop/update-signature.cjs');

// 署名に使う証明書の指紋が、自動更新の受け入れる署名者の一覧（desktop/update-signers.json）に無いと、その版は次の更新を受けられない
// （Windows が信頼していない自己署名は、一覧の指紋でだけ通る。desktop/update-signature.cjs・ADR 0176）。認証局の署名（Azure）では検査しない
function assertUpdateSigner(thumbprint, signers = loadSigners()) {
  if (!signers.includes(normalizeThumbprint(thumbprint))) {
    throw new Error(`Signing certificate ${normalizeThumbprint(thumbprint)} is not listed in desktop/update-signers.json. A build signed with it could not be installed by the auto-updater. Ship the new fingerprint in a build signed with the old key first`);
  }
}

// Only public signing configuration is returned. Credentials stay in the environment.
function releaseSigning(env = process.env, platform = process.platform, { signers } = {}) {
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
      // pfx は証明書の指紋を環境から知らない。PLY_WIN_CERTIFICATE_SHA1 を渡したときだけ検査する
      if (env.PLY_WIN_CERTIFICATE_SHA1?.trim()) assertUpdateSigner(env.PLY_WIN_CERTIFICATE_SHA1.trim(), signers);
    } else {
      const certificateSha1 = required('PLY_WIN_CERTIFICATE_SHA1');
      if (!/^[a-f\d]{40}$/i.test(certificateSha1)) throw new Error('Invalid signing certificate thumbprint');
      assertUpdateSigner(certificateSha1, signers);
      win.signtoolOptions.certificateSha1 = certificateSha1;
    }
  } else throw new Error('PLY_WINDOWS_SIGNING must be pfx, store, or azure');
  return { win };
}
module.exports = { releaseSigning };
