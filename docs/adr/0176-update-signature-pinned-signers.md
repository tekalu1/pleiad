# ADR 0176: 自己署名の更新は、署名者の指紋を固定して受け入れる

- 状態: 提案
- 日付: 2026-10-09
- 関連: [desktop-releases.md](../desktop-releases.md)、[ADR 0151](0151-zero-downtime-update.md)

## 状況

評価版の Windows インストーラーは自己署名（`CN=Ply Evaluation (hikaru)`）で、Windows に信頼されていない PC がある。electron-updater の既定の確かめ（`verifyUpdateCodeSignature`。PowerShell の `Get-AuthenticodeSignature` の結果と発行元名を見る）は、署名者を信頼していない PC では `UnknownError` になり、更新が「署名が無効」で止まる。これまでは利用者が `evaluation-certificate.ps1 -Action Trust` で証明書を信頼する必要があった。

## 決定

1. 更新の確かめを 2 段にする（`desktop/update-signature.cjs`）。(a) electron-updater の既定が通れば合格。(b) 通らないとき、`WinVerifyTrust`（koffi）の結果がちょうど `CERT_E_UNTRUSTEDROOT`（0x800B0109）で、同じ状態データから読んだ署名者の証明書の SHA-1 が `desktop/update-signers.json` の一覧にあれば合格。`TRUST_E_BAD_DIGEST`（改ざん）・`TRUST_E_NOSIGNATURE`（未署名）・その他の結果・一覧に無い指紋・読み取りの失敗は不合格。開いた状態データは必ず `WTD_STATEACTION_CLOSE` で閉じ、失敗は例外にせず、HRESULT と見つけた指紋つきの理由で返す。
2. 差し込みは Windows のパッケージ版の更新だけ（Store 版・開発起動・macOS は変えない）。
3. 署名者は名前ではなく指紋で固定する。一覧の形は `update-signers.json`（指紋・主体・期限・鍵を替える順序のメモ）。
4. Windows の `Root` ストアには何も入れない。
5. リリースのビルドは、署名に使う証明書の指紋が一覧に無いと止める（pfx は `PLY_WIN_CERTIFICATE_SHA1` を渡したとき、ストアは常に。Azure・macOS は対象外。`scripts/release-signing.cjs`）。

## 理由

- 発行元名での一致は、誰でも同じ名前の自己署名を作れる。指紋は特定の鍵だけを指すので、名前より強い。
- `Root` への自動追加は避ける。CurrentUser の `Root` への追加は Windows の警告の確認が出る。LocalMachine は管理者権限が要る。どちらも更新以外（ブラウザー・他のアプリの TLS・コード署名の判定）の信頼まで広げる。更新の確かめのために、PC 全体の信頼の範囲を変えない。
- `CERT_E_UNTRUSTEDROOT` だけを許す。チェーンが署名者まで正しく組めて、ルートが信頼されていないという 1 点だけを緩めるため。ダイジェストの不一致・未署名・失効などは通らない。
- 指紋は `WinVerifyTrust` の状態データ（`WTHelperProvDataFromStateData` → `WTHelperGetProvSignerFromChain`）から読む。検証したファイルと別の経路で指紋を取らないので、確かめた対象と指紋が食い違わない。
- 一覧に無い指紋のビルドを止めるのは、次の更新を受けられない版を出さないため。

## 影響

- 利用者は証明書を信頼しなくても更新できる。ファイルの改ざん・未署名・別の鍵の署名は更新されない。
- この確かめを持たない古い版（beta.4 以前）から最初の対応版へは、古い版の確かめが働くので、手動で入れ直すか一度 `Trust` が要る。以降は不要。
- 鍵を替えるときは、新しい指紋を足した版を古い鍵で署名して先に配る。順序を逆にすると今の利用者は更新できない。評価証明書の期限（2027-09-18）より前にこの手順を済ませる。
- 秘密鍵が漏れたら、一覧から指紋を外した版を配るしかなく、その版は古い鍵の利用者に受け入れられない（手動の入れ直しが要る）。自己署名の評価という前提の限界。
- 失効の確認はしない（`WTD_REVOKE_NONE`）。更新のたびにネットワークの失効確認を待たないため。
- koffi を更新の確かめで読む。読めなければ不合格の理由に出て、更新は止まる（誤って通ることはない）。
