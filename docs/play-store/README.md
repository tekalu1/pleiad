# Google Play の申請の資料

Android 版を Google Play に出すときに Play Console へ入れるものの下書き。流れと Play Console での手順は [android-releases.md](../android-releases.md)「Google Play」、決定は [ADR 0141](../adr/0141-android-play-distribution.md)。

| ファイル | 中身 |
|---|---|
| [listing.md](listing.md) | ストアの掲載文（アプリ名・短い説明・詳しい説明。日本語と英語）・画像・そのほかの欄 |
| [foreground-service.md](foreground-service.md) | 前面サービス `remoteMessaging` の申告文（何をするか・止められたときの影響。日本語と英語）と動画の台本 |
| [app-access.md](app-access.md) | 審査員向けのアプリへのアクセス（ホストとのペアリングが要ることへの案の比べと、入れる文） |
| [data-safety.md](data-safety.md) | データセーフティの回答案と、コードで確かめた送り先の一覧 |
| [content-rating.md](content-rating.md) | コンテンツのレーティング・ターゲット層・そのほかの申告の回答案 |

プライバシーポリシーはサイトの `site/privacy/`（https://pleiad.dev/privacy/ ）。アプリの送るもの・権限・SDK を変えたら、data-safety.md とプライバシーポリシーを一緒に直す。
