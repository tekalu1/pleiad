'use strict';
// scripts/verify-update-signature.ps1 から呼ぶ手元確認用。desktop/update-signature.cjs の本物の koffi の実装で、
// 1 つのファイルを (b) の道（WinVerifyTrust の信頼されないルート + 指紋）と、(a)+(b) を合わせた確かめで調べて JSON で出す。
//   node scripts/update-signature-check.cjs <ファイル> [受け入れる指紋 ...]   （指紋を省くと update-signers.json の一覧）
const { verifyPinnedSigner, loadSigners, createUpdateSignatureVerifier } = require('../desktop/update-signature.cjs');
const { verifySignature } = require('electron-updater/out/windowsExecutableCodeSignatureVerifier');

const [file, ...thumbprints] = process.argv.slice(2);
if (!file) { console.error('usage: update-signature-check.cjs <file> [thumbprint ...]'); process.exit(2); }
const signers = thumbprints.length ? thumbprints : loadSigners();
(async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  const pinned = verifyPinnedSigner(file, { signers });
  const combined = await createUpdateSignatureVerifier({ defaultVerify: verifySignature, logger: quiet, signers })(['Ply Evaluation (hikaru)'], file);
  console.log(JSON.stringify({ file, pinned, combined }));
})();
