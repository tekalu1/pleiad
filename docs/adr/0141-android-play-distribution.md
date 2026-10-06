# 0141 Android 版を Google Play にも出す: APK と同じ鍵・同じ版の AAB を、手動のワークフローで上げる

- 状態: 提案

## 状況

Android 版は、`main` への push で署名済み APK を GitHub Release に出している（[ADR 0066](0066-android-release-on-main-push.md)）。これに加えて Google Play でも配りたい。

- 配布元は日本の個人で、Play Console の個人アカウントはまだ無い。2023 年 11 月 13 日より後に作った個人アカウントは、12 人以上のテスターが 14 日続けて参加するクローズドテストを通してからでないと、製品版を申請できない。
- Play は AAB を受け取り、端末へ配る APK を Play App Signing の「アプリ署名鍵」で署名し直す。新しいアプリの既定は Google が作る鍵で、自分の鍵に変えられるのは、オープンテストか製品版にリリースを出す前まで。
- Android は、入っているアプリと同じ鍵で署名したものでしか上書き更新できない。GitHub の APK を入れた端末を、入れ直さずに（端末のデータを消さずに）Play 版へ移したい。
- APK の流れは、Android の殻に効く変更が `main` に入るたびに自動で出る。Play へ上げると審査が走り、テスターの端末へ届く。

## 決定

1. **Play App Signing のアプリ署名鍵には、今の APK の署名鍵（Secrets の `PLY_ANDROID_KEYSTORE_*`）を登録する。** 最初のリリースを出す前に、Play Console の「アプリ署名鍵を変更」から PEPK で暗号化して上げる。Google が作る鍵にはしない。
2. **アップロード鍵は、既定では同じ鍵にする**（Secrets を共用）。別のアップロード鍵を作ったときは、Secrets の `PLY_ANDROID_UPLOAD_*` 4 つと変数 `PLY_ANDROID_UPLOAD_CERT_SHA256` を全部入れると、そちらで署名する。一部だけなら止まる。
3. **Play へ上げるワークフローは、APK の流れとは別のファイル（`.github/workflows/android-play.yml`）にし、手動の起動（`workflow_dispatch`）だけにする。** `main` の上でしか動かない。上げ先は内部テスト（`internal`）とクローズドテスト（`alpha` か自分で作ったトラック）だけで、`production`・`beta`（オープンテスト）は弾く。状態は下書き（`draft`、既定）・すぐ公開（`completed`）・段階公開（`inProgress` と割合）を選べる。
4. **版の決め方は APK の流れと同じ**（`versionCode` = `git rev-list --count HEAD`、`versionName` = `<mobile/package.json の version>-<versionCode>`）。同じコミットからは同じ `versionCode` になる。
5. 上げるのは `r0adkll/upload-google-play`（Google Play Developer API。サービスアカウントの JSON を Secret `PLY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON` で渡す）で、commit の SHA で固定する。重い手順の前に、入力と Secrets を確かめ、足りなければ名前を出して止まる。
6. APK の流れ（`android-release.yml`）は変えない。2 つのワークフローの共通の部分（版の決め方・署名鍵の Secrets・アクションの版）は、`tests/unit/android-play-workflow.mjs` が突き合わせる。

## 理由

- 同じ鍵にすれば、GitHub の APK と Play の版は同じ署名になり、どちらからどちらへも上書きで移れる。Google が作る鍵にすると、2 つの配り方は別のアプリ扱いになり、移るにはアンインストール（端末のデータが消える）が要る。鍵を変えられるのはオープンテスト・製品版の前までなので、最初に決める。
- アップロード鍵を別にする利点（漏れても Google にリセットを頼める）は、アプリ署名鍵が APK のためにすでに同じ Secrets に置かれている今は小さい。Secrets を倍にする手間に見合わないので、既定は共用にし、分けたくなったときに分けられるようにする。
- 手動にするのは、Play へ上げることが人の判断だから。上げるたびに審査が走り、クローズドテストの間はテスターに届き、同じ `versionCode` は二度と上げられず、まだ一度も公開していないアプリには下書きしか作れない。`main` への push ごとに自動で上げると、審査とテスターを毎回巻き込む。
- 別のファイルにするのは、APK の流れの形（path で絞った push で起動し、タグがあれば何もしない、`contents: write`）と、Play の流れの形（手動・入力あり・書く権限は要らない・Play の Secret が要る）が違うため。1 つにまとめると、push の起動で Play の手順を飛ばす分岐と、手動の起動にだけ要る入力が混ざり、Play の失敗が APK のリリースの失敗に見える。共通の手順を composite action や再利用のワークフローに切り出すと、動いている APK の流れを手元で試せないまま書き換えることになるので、ずれはテストで止める。
- production・オープンテストを弾くのは、個人アカウントのテストの条件を満たす前に誤って出さないためと、製品版の公開は Play Console で人が決めるため。

## 影響

- Secret `PLY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON` が増える（任意で `PLY_ANDROID_UPLOAD_*`）。運用と Play Console での手順は [android-releases.md](../android-releases.md)「Google Play」。
- Play に登録した鍵は、Play の上では後から別の鍵へ替えにくい（鍵の更新の手順が要る）。鍵を失えば、APK・Play の両方で上書き更新ができなくなる。控えの保管は今まで以上に大事になる。
- 同じ `versionCode` は Play に二度と上げられない。同じコミットでワークフローをやり直すと、Play が拒む（新しいコミットを `main` に入れてから上げ直す）。
- GitHub の APK と Play の版は、同じコミットなら同じ `versionCode` になる。端末は、入っているものより `versionCode` が大きい方から更新を受け取る。
- Play の申請に要る資料（掲載文・前面サービスの申告・審査員向けのアクセス方法・データセーフティ・コンテンツのレーティング）は `docs/play-store/`、プライバシーポリシーは `site/privacy/`。前面サービスが差し戻されたときの案は [ADR 0142](0142-play-foreground-service-fallback.md)。
