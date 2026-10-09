'use strict';
// 自動更新のダウンロード後の署名の確かめ（ADR 0176）。electron-updater の NsisUpdater.verifyUpdateCodeSignature に差し込む。
//   (a) electron-updater の既定（Get-AuthenticodeSignature が Valid で、発行元名が合う）が合格なら合格。将来の認証局の署名はこの道
//   (b) WinVerifyTrust の結果がちょうど CERT_E_UNTRUSTEDROOT（信頼されないルート）のときだけ、同じ状態データから取った署名者の証明書の
//       SHA-1 指紋が desktop/update-signers.json の一覧に完全一致すれば合格。自己署名を Windows に信頼させていない PC でも更新できる
// (b) は他の失敗（TRUST_E_BAD_DIGEST・TRUST_E_NOSIGNATURE ほか）を通さない。署名者の証明書は WinVerifyTrust の状態データからだけ読む
// （別の読み方で取ると、検証した署名と別のものを見かねない）。koffi の読み込み・呼び出しの失敗は (b) の不合格で、更新全体は壊さない。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SIGNERS_FILE = path.join(__dirname, 'update-signers.json');

const CERT_E_UNTRUSTEDROOT = 0x800B0109;
const WTD_UI_NONE = 2;
const WTD_REVOKE_NONE = 0;
const WTD_CHOICE_FILE = 1;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
const WTD_REVOCATION_CHECK_NONE = 0x10;
// WINTRUST_ACTION_GENERIC_VERIFY_V2 {00AAC56B-CD44-11d0-8CC2-00C04FC295EE}
const GENERIC_VERIFY_V2 = { Data1: 0x00AAC56B, Data2: 0xCD44, Data3: 0x11D0, Data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE] };

const HRESULT_NAMES = new Map([
  [0, 'S_OK'],
  [CERT_E_UNTRUSTEDROOT, 'CERT_E_UNTRUSTEDROOT'],
  [0x800B0100, 'TRUST_E_NOSIGNATURE'],
  [0x80096010, 'TRUST_E_BAD_DIGEST'],
  [0x800B0101, 'CERT_E_EXPIRED'],
  [0x800B010A, 'CERT_E_CHAINING'],
  [0x800B0111, 'TRUST_E_EXPLICIT_DISTRUST'],
  [0x800B0004, 'TRUST_E_SUBJECT_NOT_TRUSTED'],
]);
const hex = hr => `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const describe = hr => HRESULT_NAMES.has(hr >>> 0) ? `${hex(hr)} ${HRESULT_NAMES.get(hr >>> 0)}` : hex(hr);

/** 40 桁の 16 進（空白・コロン・大小は問わない）を大文字に揃える。違う形は例外 */
function normalizeThumbprint(value) {
  const text = String(value ?? '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(text)) throw new Error(`Invalid certificate thumbprint: ${String(value).slice(0, 60)}`);
  return text;
}

/** update-signers.json の指紋の一覧（大文字の 40 桁）。読めない・空・形が違うときは例外 */
function loadSigners(file = SIGNERS_FILE) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data?.signers) || !data.signers.length) throw new Error(`No update signers in ${path.basename(file)}`);
  return [...new Set(data.signers.map(s => normalizeThumbprint(s?.sha1)))];
}

const apis = new WeakMap();   // koffi の型は名前がグローバルなので、同じ koffi では 1 回だけ定義する

function api(koffi) {
  if (apis.has(koffi)) return apis.get(koffi);
  const wintrust = koffi.load('wintrust.dll');
  const GUID = koffi.struct('PleiadWtGuid', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8_t[8]' });
  const FILE_INFO = koffi.struct('PleiadWtFileInfo', { cbStruct: 'uint32', pcwszFilePath: 'const char16_t*', hFile: 'void*', pgKnownSubject: 'void*' });
  const DATA = koffi.struct('PleiadWtData', {
    cbStruct: 'uint32', pPolicyCallbackData: 'void*', pSIPClientData: 'void*', dwUIChoice: 'uint32', fdwRevocationChecks: 'uint32', dwUnionChoice: 'uint32',
    pFile: 'PleiadWtFileInfo*', dwStateAction: 'uint32', hWVTStateData: 'void*', pwszURLReference: 'void*', dwProvFlags: 'uint32', dwUIContext: 'uint32', pSignatureSettings: 'void*',
  });
  // CRYPT_PROVIDER_SGNR / CRYPT_PROVIDER_CERT / CERT_CONTEXT は、使う先頭の部分だけ（読むのは先頭の要素 = 署名者の証明書）。
  // koffi は戻り値・構造体の中のポインターを開かないので、inspectSignature が koffi.decode で 1 段ずつ読む
  const CERT_CONTEXT = koffi.struct('PleiadWtCertContext', { dwCertEncodingType: 'uint32', pbCertEncoded: 'void*', cbCertEncoded: 'uint32' });
  const PROV_CERT = koffi.struct('PleiadWtProvCert', { cbStruct: 'uint32', pCert: 'void*' });
  const FILETIME = koffi.struct('PleiadWtFileTime', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });
  const PROV_SGNR = koffi.struct('PleiadWtProvSgnr', { cbStruct: 'uint32', sftVerifyAsOf: 'PleiadWtFileTime', csCertChain: 'uint32', pasCertChain: 'void*' });
  const table = {
    WinVerifyTrust: wintrust.func('long __stdcall WinVerifyTrust(intptr_t hwnd, PleiadWtGuid* action, _Inout_ PleiadWtData* data)'),
    WTHelperProvDataFromStateData: wintrust.func('void* __stdcall WTHelperProvDataFromStateData(void* state)'),
    WTHelperGetProvSignerFromChain: wintrust.func('void* __stdcall WTHelperGetProvSignerFromChain(void* provData, uint32 signer, int counterSigner, uint32 counterIndex)'),
    GUID, FILE_INFO, DATA, CERT_CONTEXT, PROV_CERT, FILETIME, PROV_SGNR,
  };
  apis.set(koffi, table);
  return table;
}

/**
 * ファイルの署名を WinVerifyTrust で確かめ、結果が CERT_E_UNTRUSTEDROOT のときだけ、署名者の証明書の SHA-1 指紋を返す。
 * 戻り値 { hresult, thumbprint, error }（hresult は符号なしの数値。thumbprint は UNTRUSTEDROOT で読めたときだけ。error は読めなかった理由）。
 * 状態データを開いたら、読み終えた後で必ず WTD_STATEACTION_CLOSE を呼ぶ。koffi の例外は呼んだ側へ投げる
 */
function inspectSignature(koffi, filePath) {
  const a = api(koffi);
  const fileInfo = { cbStruct: koffi.sizeof(a.FILE_INFO), pcwszFilePath: filePath, hFile: null, pgKnownSubject: null };
  const data = {
    cbStruct: koffi.sizeof(a.DATA), pPolicyCallbackData: null, pSIPClientData: null, dwUIChoice: WTD_UI_NONE, fdwRevocationChecks: WTD_REVOKE_NONE, dwUnionChoice: WTD_CHOICE_FILE,
    pFile: fileInfo, dwStateAction: WTD_STATEACTION_VERIFY, hWVTStateData: null, pwszURLReference: null, dwProvFlags: WTD_REVOCATION_CHECK_NONE, dwUIContext: 0, pSignatureSettings: null,
  };
  const noWindow = -1;   // INVALID_HANDLE_VALUE: UI を出さず、窓の持ち主も無い
  let opened = false, hresult;
  try {
    hresult = a.WinVerifyTrust(noWindow, GENERIC_VERIFY_V2, data) >>> 0;
    opened = true;
    if (hresult !== CERT_E_UNTRUSTEDROOT) return { hresult, thumbprint: null, error: null };
    if (!data.hWVTStateData) return { hresult, thumbprint: null, error: 'WinVerifyTrust returned no state data' };
    const provider = a.WTHelperProvDataFromStateData(data.hWVTStateData);
    if (!provider) return { hresult, thumbprint: null, error: 'WTHelperProvDataFromStateData returned null' };
    const signerPointer = a.WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    const signer = signerPointer ? koffi.decode(signerPointer, a.PROV_SGNR) : null;
    const leaf = signer?.csCertChain && signer.pasCertChain ? koffi.decode(signer.pasCertChain, a.PROV_CERT) : null;
    if (!leaf?.pCert) return { hresult, thumbprint: null, error: 'the signer certificate was not found' };
    const cert = koffi.decode(leaf.pCert, a.CERT_CONTEXT);
    if (!cert.pbCertEncoded || !(cert.cbCertEncoded > 0) || cert.cbCertEncoded > 64 * 1024) return { hresult, thumbprint: null, error: 'the signer certificate could not be read' };
    const der = Buffer.from(koffi.decode(cert.pbCertEncoded, 'uint8_t', cert.cbCertEncoded));
    return { hresult, thumbprint: crypto.createHash('sha1').update(der).digest('hex').toUpperCase(), error: null };
  } finally {
    // 開いた状態データは必ず閉じる（VERIFY が失敗を返しても状態データは作られていることがある）
    if (opened || data.hWVTStateData) {
      data.dwStateAction = WTD_STATEACTION_CLOSE;
      try { a.WinVerifyTrust(noWindow, GENERIC_VERIFY_V2, data); } catch { /* 閉じる失敗は結果を変えない */ }
    }
  }
}

/**
 * (b) の確かめ。戻り値 { ok, reason }。reason は不合格の理由（updater.log に残る。HRESULT と、見つけた指紋）
 * @param {object} deps
 * @param [deps.koffi] 偽物でもよい
 * @param [deps.loadKoffi] koffi を読む（既定は require('koffi')）
 * @param [deps.signers] 受け入れる指紋の一覧（既定は update-signers.json）
 */
function verifyPinnedSigner(filePath, { koffi = null, loadKoffi = () => require('koffi'), signers = null } = {}) {
  let allowed;
  try { allowed = (signers ?? loadSigners()).map(normalizeThumbprint); }
  catch (error) { return { ok: false, reason: `the signer list is unusable: ${error.message}` }; }
  let found;
  try { found = inspectSignature(koffi ?? loadKoffi(), filePath); }
  catch (error) { return { ok: false, reason: `WinVerifyTrust could not be called: ${String(error?.message ?? error)}` }; }
  if (found.hresult !== CERT_E_UNTRUSTEDROOT) return { ok: false, reason: `WinVerifyTrust returned ${describe(found.hresult)}` };
  if (!found.thumbprint) return { ok: false, reason: `WinVerifyTrust returned ${describe(found.hresult)} but ${found.error}` };
  if (!allowed.includes(found.thumbprint)) return { ok: false, reason: `WinVerifyTrust returned ${describe(found.hresult)} and the signer ${found.thumbprint} is not an accepted update signer` };
  return { ok: true, reason: null, thumbprint: found.thumbprint };
}

/**
 * NsisUpdater.verifyUpdateCodeSignature に渡す関数（(publisherNames, path) => null | 不合格の理由）。
 * @param {object} deps
 * @param deps.defaultVerify electron-updater の既定の確かめ（publisherNames, path, logger）。(a)
 * @param [deps.logger] electron-updater の logger（info・warn）
 */
function createUpdateSignatureVerifier({ defaultVerify, logger = null, ...pinned }) {
  return async function verifyUpdateSignature(publisherNames, filePath) {
    let defaultReason;
    try {
      defaultReason = await defaultVerify(publisherNames, filePath, logger ?? { info() {}, warn() {}, error() {} });
      if (defaultReason == null) return null;
    } catch (error) { defaultReason = `the default verification failed: ${String(error?.message ?? error)}`; }
    // Windows が署名者を信頼していない PC（自己署名）。信頼されないルートのときだけ、指紋で固定した署名者を受け入れる
    const pin = verifyPinnedSigner(filePath, pinned);
    if (pin.ok) {
      logger?.info?.(`Update signature accepted: untrusted root, pinned signer ${pin.thumbprint}`);
      return null;
    }
    const reason = `not signed by a trusted publisher (${pin.reason}); default verification: ${String(defaultReason).slice(0, 300)}`;
    logger?.warn?.(`Update signature rejected: ${reason}`);
    return reason;
  };
}

/** main から呼ぶ。Windows の NsisUpdater の確かめを差し替える（それ以外は何もしない）。差し替えたら true */
function installUpdateSignatureVerifier(updater, { platform = process.platform, defaultVerify = null, ...rest } = {}) {
  if (platform !== 'win32' || !updater || !('verifyUpdateCodeSignature' in updater)) return false;
  const verify = defaultVerify ?? require('electron-updater/out/windowsExecutableCodeSignatureVerifier').verifySignature;
  updater.verifyUpdateCodeSignature = createUpdateSignatureVerifier({ defaultVerify: verify, logger: updater.logger, ...rest });
  return true;
}

module.exports = { CERT_E_UNTRUSTEDROOT, SIGNERS_FILE, normalizeThumbprint, loadSigners, inspectSignature, verifyPinnedSigner, createUpdateSignatureVerifier, installUpdateSignatureVerifier };
