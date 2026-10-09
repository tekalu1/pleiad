// 自動更新の署名の確かめ（desktop/update-signature.cjs。ADR 0176）。
//   - (a) electron-updater の既定が合格なら合格（koffi に触らない）
//   - (b) WinVerifyTrust がちょうど CERT_E_UNTRUSTEDROOT で、状態データから読んだ署名者の SHA-1 指紋が一覧に一致するときだけ合格
//   - 他の結果（TRUST_E_BAD_DIGEST・TRUST_E_NOSIGNATURE・S_OK）・指紋違い・koffi / 呼び出しの失敗は不合格で、理由に HRESULT と指紋が出る。開いた状態データは必ず CLOSE する
//   - 一覧（update-signers.json）の形・同梱・リリースのビルドが一覧に無い指紋を止める（scripts/release-signing.cjs）
//   - 本物（Windows）: 本物の koffi で WinVerifyTrust を呼べる（信頼されないルートの実機の確かめは scripts/verify-update-signature.ps1）
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'yaml';

const require = createRequire(import.meta.url);
const sig = require('../../desktop/update-signature.cjs');
const { releaseSigning } = require('../../scripts/release-signing.cjs');

export const name = 'desktop-update-signature';
export const title = '自動更新の署名の確かめ（既定の確かめ + WinVerifyTrust の信頼されないルートを指紋で固定）';

const UNTRUSTED_ROOT = 0x800B0109, BAD_DIGEST = 0x80096010, NO_SIGNATURE = 0x800B0100;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex').toUpperCase();
const DER = Buffer.from('fake certificate der bytes');
const DER_SHA1 = sha1(DER);
const OTHER_SHA1 = 'A'.repeat(40);

/** koffi の身代わり。WinVerifyTrust の結果・署名者の証明書・どこで失敗させるかを決め、呼び出しを記録する */
function fakeKoffi({ hresult = UNTRUSTED_ROOT, der = DER, state = 'STATE', failAt = null } = {}) {
  const calls = [];
  const fail = at => { if (failAt === at) throw new Error(`${at} exploded`); };
  const koffi = {
    calls,
    struct: structName => ({ structName }),
    sizeof: () => 88,
    load: () => ({
      func: signature => {
        if (signature.includes('WinVerifyTrust')) return (hwnd, action, data) => {
          calls.push({ call: 'WinVerifyTrust', hwnd, action: { ...action }, ui: data.dwUIChoice, revoke: data.fdwRevocationChecks, union: data.dwUnionChoice, stateAction: data.dwStateAction, file: data.pFile.pcwszFilePath, state: data.hWVTStateData });
          fail(data.dwStateAction === 1 ? 'verify' : 'close');
          if (data.dwStateAction === 1) { data.hWVTStateData = state; return hresult | 0; }   // LONG は符号付きで返る
          return 0;
        };
        if (signature.includes('WTHelperProvDataFromStateData')) return handle => { calls.push({ call: 'provider', handle }); fail('provider'); return 'PROV'; };
        if (signature.includes('WTHelperGetProvSignerFromChain')) return (provider, signer, counter, index) => { calls.push({ call: 'signer', provider, signer, counter, index }); fail('signer'); return 'SGNR'; };
        return () => 0;
      },
    }),
    decode: (pointer, type, length) => {
      calls.push({ call: 'decode', pointer, type: type?.structName ?? type });
      if (type?.structName === 'PleiadWtProvSgnr') return { csCertChain: 1, pasCertChain: 'CHAIN' };
      if (type?.structName === 'PleiadWtProvCert') return { pCert: 'CERT' };
      if (type?.structName === 'PleiadWtCertContext') return { pbCertEncoded: 'DER', cbCertEncoded: der.length };
      if (type === 'uint8_t' && pointer === 'DER' && length === der.length) return [...der];
      throw new Error('unexpected decode');
    },
  };
  return koffi;
}

const quiet = () => { const lines = []; return { lines, info: m => lines.push(`info ${m}`), warn: m => lines.push(`warn ${m}`), error: m => lines.push(`error ${m}`) }; };

export default async function (t) {
  const rejectDefault = async () => 'publisherNames: Example, raw info: {"Status": 5}';
  const make = (koffi, extra = {}) => sig.createUpdateSignatureVerifier({ defaultVerify: rejectDefault, koffi, signers: [DER_SHA1], logger: quiet(), ...extra });
  const closes = koffi => koffi.calls.filter(c => c.call === 'WinVerifyTrust' && c.stateAction === 2).length;

  // ---- (a) 既定の確かめ
  {
    const verify = sig.createUpdateSignatureVerifier({ defaultVerify: async (names, file) => (names[0] === 'Ply' && file === 'C:\\u.exe' ? null : 'wrong args'), loadKoffi: () => { throw new Error('must not load koffi'); }, signers: [DER_SHA1] });
    t.ok('(a): 既定の確かめが合格なら合格で、koffi は読まない', await verify(['Ply'], 'C:\\u.exe') === null);
  }

  // ---- (b) 合格
  {
    const koffi = fakeKoffi();
    const log = quiet();
    const result = await make(koffi, { logger: log })(['Ply'], 'C:\\u.exe');
    t.ok('(b): 信頼されないルート + 一覧にある指紋なら合格', result === null, String(result));
    const verifyCall = koffi.calls.find(c => c.call === 'WinVerifyTrust');
    t.ok('(b): WINTRUST_ACTION_GENERIC_VERIFY_V2・UI なし・失効確認なし・ファイル・VERIFY で呼ぶ',
      verifyCall.action.Data1 === 0x00AAC56B && verifyCall.action.Data2 === 0xCD44 && verifyCall.action.Data3 === 0x11D0 && verifyCall.action.Data4.join() === '140,194,0,192,79,194,149,238'
      && verifyCall.ui === 2 && verifyCall.revoke === 0 && verifyCall.union === 1 && verifyCall.stateAction === 1 && verifyCall.file === 'C:\\u.exe' && verifyCall.hwnd === -1);
    const order = koffi.calls.map(c => c.call);
    t.ok('(b): 署名者は同じ状態データ（VERIFY が返したもの）から読み、その後に CLOSE を同じ状態データで呼ぶ',
      order.join() === 'WinVerifyTrust,provider,signer,decode,decode,decode,decode,WinVerifyTrust' && koffi.calls[1].handle === 'STATE' && koffi.calls[2].provider === 'PROV' && koffi.calls[2].signer === 0 && koffi.calls[2].counter === 0
      && koffi.calls.at(-1).stateAction === 2 && koffi.calls.at(-1).state === 'STATE');
    t.ok('(b): 合格は updater.log に残る（指紋つき）', log.lines.some(l => l.startsWith('info') && l.includes(DER_SHA1)));
    t.ok('(b): 指紋は大文字小文字・空白・コロンを問わず一覧と突き合わせる', await make(fakeKoffi(), { signers: [DER_SHA1.toLowerCase().replace(/(..)/g, '$1:').slice(0, -1)] })(['Ply'], 'x') === null);
  }

  // ---- (b) 不合格
  {
    const koffi = fakeKoffi();
    const reason = await make(koffi, { signers: [OTHER_SHA1] })(['Ply'], 'C:\\u.exe');
    t.ok('(b): 信頼されないルートでも指紋が一覧に無ければ不合格。理由に HRESULT と見つけた指紋', typeof reason === 'string' && reason.includes('0x800B0109 CERT_E_UNTRUSTEDROOT') && reason.includes(DER_SHA1) && reason.includes('not an accepted update signer'), String(reason));
    t.ok('(b): 理由に既定の確かめの結果も付く', reason.includes('default verification: publisherNames: Example'));
    t.ok('(b): 不合格でも CLOSE を呼ぶ', closes(koffi) === 1);

    for (const [label, hresult, expected] of [['TRUST_E_BAD_DIGEST', BAD_DIGEST, '0x80096010 TRUST_E_BAD_DIGEST'], ['TRUST_E_NOSIGNATURE（未署名）', NO_SIGNATURE, '0x800B0100 TRUST_E_NOSIGNATURE'], ['S_OK（既定の確かめだけが落ちた = 発行元名の違い）', 0, '0x00000000 S_OK'], ['知らない HRESULT', 0x800B0109 + 1, '0x800B010A CERT_E_CHAINING']]) {
      const fake = fakeKoffi({ hresult });
      const result = await make(fake)(['Ply'], 'C:\\u.exe');
      t.ok(`(b): ${label} は不合格（指紋が一覧にあっても通さない）`, typeof result === 'string' && result.includes(expected), String(result));
      t.ok(`(b): ${label} では署名者を読まず、CLOSE は呼ぶ`, !fake.calls.some(c => c.call === 'provider' || c.call === 'signer') && closes(fake) === 1);
    }

    const noState = fakeKoffi({ state: null });
    const noStateReason = await make(noState)(['Ply'], 'x');
    t.ok('(b): 状態データが無ければ不合格（読み直さない）', typeof noStateReason === 'string' && noStateReason.includes('no state data') && !noState.calls.some(c => c.call === 'provider'));
    t.ok('(b): 証明書が空なら不合格', typeof await make(fakeKoffi({ der: Buffer.alloc(0) }))(['Ply'], 'x') === 'string');
  }

  // ---- 失敗は更新全体を壊さず不合格の理由にする
  {
    for (const failAt of ['provider', 'signer']) {
      const koffi = fakeKoffi({ failAt });
      const result = await make(koffi)(['Ply'], 'x');
      t.ok(`失敗: 状態データを読む途中（${failAt}）で例外でも不合格の理由を返し、CLOSE は呼ぶ`, typeof result === 'string' && result.includes(`${failAt} exploded`) && closes(koffi) === 1, String(result));
    }
    const verifyFails = fakeKoffi({ failAt: 'verify' });
    const verifyReason = await make(verifyFails)(['Ply'], 'x');
    t.ok('失敗: WinVerifyTrust 自体の例外は不合格の理由（呼び出しの失敗）', typeof verifyReason === 'string' && verifyReason.includes('could not be called') && verifyReason.includes('verify exploded'));
    t.ok('失敗: VERIFY が例外なら状態データは開かれていないので CLOSE しない', closes(verifyFails) === 0);
    const noKoffi = await make(null, { loadKoffi: () => { throw new Error('koffi is missing'); } })(['Ply'], 'x');
    t.ok('失敗: koffi を読めなければ不合格の理由', typeof noKoffi === 'string' && noKoffi.includes('koffi is missing'));
    const badList = await make(fakeKoffi(), { signers: ['not-a-thumbprint'] })(['Ply'], 'x');
    t.ok('失敗: 指紋の一覧が使えなければ不合格（通さない）', typeof badList === 'string' && badList.includes('signer list is unusable'));
    const defaultThrows = await sig.createUpdateSignatureVerifier({ defaultVerify: async () => { throw new Error('powershell is gone'); }, koffi: fakeKoffi(), signers: [DER_SHA1] })(['Ply'], 'x');
    t.ok('既定の確かめが例外でも (b) を試す（合格すれば合格）', defaultThrows === null);
    const bothFail = await sig.createUpdateSignatureVerifier({ defaultVerify: async () => { throw new Error('powershell is gone'); }, koffi: fakeKoffi({ hresult: BAD_DIGEST }), signers: [DER_SHA1] })(['Ply'], 'x');
    t.ok('両方失敗なら、両方の理由が残る', typeof bothFail === 'string' && bothFail.includes('powershell is gone') && bothFail.includes('TRUST_E_BAD_DIGEST'));
  }

  // ---- main への差し込み
  {
    class Win { verifyUpdateCodeSignature = null; logger = quiet(); }
    const win = new Win();
    t.ok('差し込み: Windows の NsisUpdater の確かめを差し替える', sig.installUpdateSignatureVerifier(win, { platform: 'win32', defaultVerify: async () => null }) === true && typeof win.verifyUpdateCodeSignature === 'function' && await win.verifyUpdateCodeSignature(['Ply'], 'x') === null);
    t.ok('差し込み: Windows 以外は何もしない', sig.installUpdateSignatureVerifier({ verifyUpdateCodeSignature: null }, { platform: 'darwin' }) === false);
    t.ok('差し込み: 確かめを持たない updater（macOS の MacUpdater など）には何もしない', sig.installUpdateSignatureVerifier({}, { platform: 'win32' }) === false);
  }

  // ---- 指紋の一覧
  {
    const signers = sig.loadSigners();
    t.ok('一覧: update-signers.json は 40 桁の大文字の 16 進で、今の評価版の署名者を含む', signers.length >= 1 && signers.every(s => /^[0-9A-F]{40}$/.test(s)) && signers.includes('BCEE9BE88BEE6BB94909FC74C0622420CAE50910'));
    const file = new URL('../../desktop/update-signers.json', import.meta.url);
    t.ok('一覧: 鍵を替える順序（古い鍵で先に配る）をファイルに書いている', JSON.parse(fs.readFileSync(file, 'utf8')).note.includes('古い鍵'));
    const config = parse(fs.readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8'));
    t.ok('一覧: アプリに同梱される（files の desktop/** に入り、除外されない）', config.files.includes('desktop/**') && !config.files.some(f => typeof f === 'string' && f.startsWith('!') && /update-sign/.test(f)));
    let rejected = false;
    try { sig.normalizeThumbprint('12345'); } catch { rejected = true; }
    t.ok('一覧: 40 桁でない指紋は例外', rejected && sig.normalizeThumbprint(' bc:ee 9b e8 8b ee 6b b9 49 09 fc 74 c0 62 24 20 ca e5 09 10 '.replace(/ /g, '')) === 'BCEE9BE88BEE6BB94909FC74C0622420CAE50910');
  }

  // ---- リリースのビルド: 署名の指紋が一覧に無ければ止める
  {
    const publisher = { PLY_WIN_PUBLISHER: 'Example Publisher' };
    const listed = 'bcee9be88bee6bb94909fc74c0622420cae50910';
    const throws = fn => { try { fn(); return null; } catch (error) { return error.message; } };
    t.ok('ビルド: store の証明書の指紋が一覧にあれば通る', releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: listed }, 'win32').win.signtoolOptions.certificateSha1 === listed);
    const store = throws(() => releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32'));
    t.ok('ビルド: store の証明書の指紋が一覧に無ければ止める（次の更新を受けられない版を出さない）', typeof store === 'string' && store.includes('update-signers.json') && store.includes(OTHER_SHA1));
    t.ok('ビルド: テストの一覧を渡せる', releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32', { signers: [OTHER_SHA1] }).win.signtoolOptions.certificateSha1 === OTHER_SHA1);
    const pfx = { ...publisher, CSC_LINK: 'key', CSC_KEY_PASSWORD: 'password' };
    t.ok('ビルド: pfx は指紋を渡したときだけ検査する（渡さなければ今のとおり）', typeof throws(() => releaseSigning({ ...pfx, PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32')) === 'string' && releaseSigning(pfx, 'win32').win.verifyUpdateCodeSignature === true && releaseSigning({ ...pfx, PLY_WIN_CERTIFICATE_SHA1: listed }, 'win32').win.verifyUpdateCodeSignature === true);
    const azure = { ...publisher, PLY_WINDOWS_SIGNING: 'azure', PLY_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/', PLY_AZURE_ACCOUNT: 'a', PLY_AZURE_PROFILE: 'p', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };
    t.ok('ビルド: Azure（認証局）の署名では検査しない', releaseSigning({ ...azure, PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32', { signers: [] }).win.azureSignOptions.publisherName === 'Example Publisher');
    t.ok('ビルド: macOS は一覧を読まない', releaseSigning({ CSC_LINK: 'k', CSC_KEY_PASSWORD: 'p', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, 'darwin', { signers: [] }).mac.notarize === true);
  }

  // ---- 本物の koffi（Windows）
  if (process.platform === 'win32') {
    // 信頼されたルートの署名（node.exe）は S_OK で返る。(b) は「ちょうど信頼されないルート」だけなので不合格 = (a) に任せる道
    const trusted = sig.verifyPinnedSigner(process.execPath, { signers: [DER_SHA1] });
    t.ok('本物: 本物の koffi で WinVerifyTrust を呼べ、信頼されたルートの署名は (b) では通さない', trusted.ok === false && /WinVerifyTrust returned 0x[0-9A-F]{8}/.test(trusted.reason) && !trusted.reason.includes('could not be called'), trusted.reason);
    const missing = sig.verifyPinnedSigner('C:\\no\\such\\ply-update.exe', { signers: [DER_SHA1] });
    t.ok('本物: 無いファイルは不合格で、理由に HRESULT が出る', missing.ok === false && /WinVerifyTrust returned 0x[0-9A-F]{8}/.test(missing.reason), missing.reason);
    const unsigned = sig.verifyPinnedSigner(new URL(import.meta.url).pathname.slice(1), { signers: [DER_SHA1] });
    t.ok('本物: 署名の無いファイルは TRUST_E_SUBJECT_FORM_UNKNOWN か TRUST_E_NOSIGNATURE で不合格', unsigned.ok === false && /0x800B000[0-3]|0x800B0100/.test(unsigned.reason), unsigned.reason);
  }
}
