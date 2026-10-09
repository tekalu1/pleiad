# 0183 アカウントと公式の中継（のちに Cloud）

- 状態: 提案（2026-10-10。決定の 1〜6 は利用者が 2026-10-10 に決めた。細部は実装の分け方で詰める）
- 関連: [ADR 0013](0013-remote-via-relay-with-noise.md)（中継と Noise）・[ADR 0086](0086-notifications-through-relay.md)（中継の通知の線）・[ADR 0172](0172-play-review-access.md)（Play の審査）・[ADR 0174](0174-ios-capacitor-shell.md)（iOS の殻）・[docs/remote.md](../remote.md) §1・§3.4・§5・§9・[docs/play-store/data-safety.md](../play-store/data-safety.md)・[docs/play-store/app-access.md](../play-store/app-access.md)・[site/privacy/](../../site/privacy/index.html)

## 状況

### 今の作り

リモートは、利用者が自分で立てた中継（`relay/server.mjs`）を通す（ADR 0013、remote.md §5）。

- ホストの認証は `hostAuth` 1 つで、`Authorization: Bearer <RELAY_ENROLL_SECRET>` が合えば通す。`X-Pleiad-Host` の `hostId` は**ホストの名乗りのまま**で、鍵を持っていることは中継では確かめない（なりすましは端末が Noise の IK でホストの公開鍵を照合して防ぐ。中継にできるのは、同じ `hostId` の制御接続を置き換えて 4409 で前のものを閉じることまで）。
- 端末は、ホストが `sync`・`allow` で登録した中継用トークンのハッシュとの照合だけで通る。中継は端末が誰のものかを知らない。
- 状態はメモリだけ（§5.2）。上限は全体で 8 ホスト（`RELAY_MAX_HOSTS`）・ホストあたり 16 端末。レプリカは 1。
- 「中継は 1 人（ホストの持ち主）の持ち物」（§5.4）、「複数の利用者で 1 台の中継を共有すること」はやらない（§1）。登録用の秘密を他人と共有すると、帯域と上限を分け合う。
- 開発者は何も受け取らない。データセーフティもプライバシーポリシーも「開発者が受け取るデータは無い・アカウントを作る機能は無い」を前提に書いてある（data-safety.md の「削除のリクエスト」の答え）。

### 何が困るか

- 使い始めるには、利用者が中継のサーバー（TLS の終端つき）を立てて、登録用の秘密をホストに入れる必要がある。PC の Pleiad を入れただけでは外からつなげない。Play のクローズドテスト（12 人・14 日。ADR 0142）のテスターにも、この手間を求めることになる。
- 開発者が中継を立てて配るには、今の作りでは登録用の秘密を全員に配るしかない。秘密を持つ誰もが任意の `hostId` を名乗って他人のホストの制御接続を置き換えられ（4409）、上限は全体で分け合い、誰が使っているかも、止める単位も無い。
- 将来、PC を持たない人に、クラウドでエージェント（Pleiad の `procway` のバックエンド = procway-code）を動かす形（以下「Cloud」）を出すには、利用者を識別し、課金する仕組みが要る。

### この ADR が覆す前提

| 今の前提 | 場所 | この ADR の後 |
|---|---|---|
| 中継は 1 人の持ち物。複数の利用者で共有しない | remote.md §1・§5.4 | 開発者が運営する**公式の中継**は、アカウントで分けて多くの利用者が共有する。自分の中継（今のもの）は 1 人の持ち物のまま残す |
| 中継に要るのは登録用の秘密 1 つ | remote.md §3.1・§5.1、`hostAuth` | 中継の認可を差し替えられるようにし、公式の中継はアカウント（Firebase の ID トークン）で認可する。自分の中継は登録用の秘密のまま |
| `hostId` は名乗りでよい | `hostAuth` | 公式の中継では、ホストが `hostId` の鍵を持つことを証明し、`hostId` をアカウントに束ねる |
| 中継が知るのは識別子・ハッシュ・付随情報 | remote.md §3.4 | 公式の中継の運営（開発者）は、それに加えてアカウント（メール・識別子）・接続元の IP・時刻・量・課金の状態を知る。中身・鍵は今までどおり知らない（決定の「E2E を壊さない約束」） |
| 第三者のアカウントを挟まない | ADR 0013「採らなかった案」 | 公式の中継は開発者のサービスと Firebase Authentication を挟む。ただし**選べる道**で、自分の中継を使えば今までどおり挟まない |
| 配布元が何も運用しなくてよい | ADR 0086「理由」 | 公式の中継は開発者が運用する。通知の運び方（前面サービスの線・端末ごとの鍵の暗号文・FCM を使わない）は変えない |
| 開発者が受け取るデータは無い。アカウントを作る機能は無い | data-safety.md・site/privacy | 公式の中継とアカウントについて、受け取るものが増え、アプリの中にアカウントの作成と削除が入る |

変えないもの: Noise（IK / IKpsk2）・QR のペアリング（ホストの公開鍵を QR で直接渡す）・ホストでの承認と確認コード・ホストの接続口の防火壁（§4.2）・端末は全権限（§9）・審査モード（ADR 0172）。

### 外部の条件（2026-10-10 に原文を開いて確かめた）

**Apple**（[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)）

- 4.2.7 Remote Desktop Clients: 「If your remote desktop app acts as a mirror of specific software or services rather than a generic mirror of the host device, it must comply with the following: (a) The app must only connect to a user-owned host device that is a personal computer or dedicated game console owned by the user, and both the host device and client must be connected on a local and LAN-based network. … (c) All account creation and management must be initiated from the host device. … (e) Thin clients for cloud-based apps are not appropriate for the App Store.」
  Pleiad のアプリはホストが配る画面（`web/`）を映すので、「特定のソフトを映すリモートアプリ」と読まれると、(a) の LAN の中だけ・(c) のアカウントはホストから・(e) のクラウドの薄いクライアントは不可、のどれにも当たる。リモート（中継越し）も、端末でのログインも、Cloud も成り立たない。
- 4.8 Login Services: 「Apps that use a third-party or social login service (such as … Google Sign-In …) to set up or authenticate the user's primary account with the app must also offer as an equivalent option another login service with the following features: the login service limits data collection to the user's name and email address; … allows users to keep their email address private …; … does not collect interactions with your app for advertising purposes without consent.」（Sign in with Apple がこれに当たる）
- 5.1.1(v) Account Sign-In: 「If your app supports account creation, you must also offer account deletion within the app.」
- 3.1.3(f) Free Stand-alone Apps: 「Free apps acting as a stand-alone companion to a paid web based tool (i.e. VoIP, Cloud Storage, Email Services, Web Hosting) do not need to use in-app purchase, provided there is no purchasing inside the app, or calls to action for purchase outside of the app.」
- [Payment options on the App Store in Japan](https://developer.apple.com/support/payment-options-on-the-app-store-in-japan): iOS 26.2 以降、日本で配るアプリは代わりの決済やアプリの外の購入への誘導（リンクの有無によらず）を出せるが、StoreKit External Purchases or Offers Entitlement と、そのための事業条件が要る。3.1.3(f) の道（アプリに購入も誘導も置かない）ならこれを使わない。

**Google Play**

- [Payments](https://support.google.com/googleplay/android-developer/answer/9858738)（Play Console Help）: Play で配るアプリで、アプリの機能やサービスへのアクセスに支払いを求める・受けるものは、3・8・9 節に当たらない限り Play の課金を使う。例に「cloud software and services」がある。さらに、アプリの中の WebView・ボタン・リンク・メッセージ・広告・そのほかの誘導と、「account creation or sign-up flows」を含むアプリの中の流れで、Play の課金以外の支払いへ導いてはならない。
- [Understanding Google Play's app account deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111): 「If your app allows users to create an account from within your app, our User data policy requires that it must also allow users to request for their account to be deleted.」アプリの中の削除の道と、データセーフティの削除の質問への回答が要る。

**Anthropic**（[Legal and compliance - Claude Code Docs](https://code.claude.com/docs/en/legal-and-compliance)）

- 「Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential」（Claude Code を自社の製品・サービス（hosted sandboxes など）で動かすときの条件）。
- 「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens」。
- つまり Cloud で、利用者の Claude の個人契約をクラウドに預かって動かすことはできない。開発者の API キーで Claude Code を動かして利用者に課金することも、この条件に反する。ChatGPT の個人契約も同じ扱いにする（OpenAI の規約は未確認）。

**決済**: [Stripe Managed Payments](https://docs.stripe.com/payments/managed-payments) は Stripe が販売者（マーチャント・オブ・レコード）になり、80 か国以上の売上税・VAT・GST・不正対策・不審請求・取引のサポートを受け持つ。対象はデジタル商品（ソフトウェア・クラウドサービスなど）で、使えるかは事業の形と所在地による Stripe の審査で決まる（[利用資格](https://docs.stripe.com/payments/managed-payments/eligibility)。日本の個人事業で使えるかは未確認）。手数料は未確認。

**電気通信事業**: 総務省「[電気通信事業参入マニュアル［追補版］](https://www.soumu.go.jp/main_content/000477428.pdf)」（平成 17 年策定・令和 5 年 1 月 30 日改定）は、「他人の通信を媒介」を「他人の依頼を受けて、情報をその内容を変更することなく、伝送・交換し、隔地者間の通信を取次、又は仲介してそれを完成させること」とし、媒介する電気通信役務を営む者は登録か届出が要るとする。公式の中継は、利用者のホストと端末の間の暗号文を内容を変えずに運ぶ。同じ人の機械どうしでも当たるか、招待した別の人の端末なら当たるかは、問い合わせ中。

## 案

### A. ログインをどこで求めるか（公式の中継を使うとき）

| 案 | 中身 | 中継の認可・不正対策 | 失効・課金 | アプリと審査 | Cloud へのつながり |
|---|---|---|---|---|---|
| (a) ログイン無し | 公式の中継の登録用の秘密（か招待コード）を配る | 秘密を持つ誰でも任意の `hostId` を名乗れる。誰が使っているか分からず、止める単位が無い | 課金の単位が無い | 変わらない | 無い |
| (b) ホストだけ | PC の Pleiad でログインし、中継はホストのアカウントで認可する。端末は今までどおりホストが登録したトークンで通す | ホストの単位では止められる。端末が誰のものかは分からない（有料のホスト 1 台に、他人の端末を 16 台つなげる） | ホストのアカウントで止めると、そのホストの端末はまとめて切れる | アプリにログインもアカウントの作成も削除も要らない。4.8・5.1.1(v)・Play の削除の要件に当たらない。4.2.7(c)（アカウントはホストから）とも合う | Cloud は PC が無いので、端末でのログインがいずれ要る。そこで作り直す |
| (c) **両方**（ペアリングは QR のまま） | PC と端末の両方でログインする。中継は、ホストと端末が同じアカウント（または招待された人）かを確かめる | ホストと端末の両方を、アカウントで認可・計量・停止できる。トークンが漏れても、別のアカウントの端末は通らない | 失効したアカウントの線を、中継が両側で閉じる | アプリにログイン・Sign in with Apple（iOS）・アカウントの削除・審査用のテストアカウントが要る。「自分のサーバーのクライアント」として出す必要が強まる（4.2.7(c) と読まれないこと） | 端末のログインがそのまま Cloud の入口になる |

鍵の信頼はどの案でも QR のまま変わらない。案の差は「中継を誰に使わせるか」の確かさと、アプリに入る手間。

### B. 認証の仕組み

| 候補 | ログインの手段 | アプリ・デスクトップへの入れ方 | サーバーでの検証 | Procway・Cloud との共有 | 費用・縛り |
|---|---|---|---|---|---|
| **Firebase Authentication** | Google・GitHub・Apple・メール（リンク・パスワード）が揃う | Android・iOS はネイティブの SDK か Web の流れ。デスクトップは外部ブラウザーを使う流れを自分で組む | ID トークン（JWT）を Google の公開鍵で検証するだけ。中継に依存を足さずに Node の `crypto` で書ける | Procway の `IdentityProviderKind` に `firebase` がある（`procway-internal/dashboard/server/auth/types.ts`。今の実装は GitHub だけ）ので、同じ利用者を共有できる | Google のサービスに縛られる。料金は未確認 |
| Auth0・Clerk などの専業 | 揃う | SDK あり | JWT の検証 | 共有はできるが Procway の型には無い | 月額が利用者数で増える |
| Supabase Auth | 揃う | SDK あり | JWT の検証 | Procway の型には無い | DB と一緒に使う前提が強い |
| 自前（メールのリンク・パスキー） | 足すたびに作る | すべて作る | 自分で署名 | 自由 | 作る・守る手間が最も大きい。Sign in with Apple なども自分で |
| Procway の GitHub OAuth をそのまま使う | GitHub だけ | — | — | 同じ | GitHub を持たない人が使えない。4.8 のために Apple も要る |

### C. 課金の置き場

- アプリの中の購入（Apple・Google の課金）: 手数料と審査の手間が増え、PC の Pleiad（Web・デスクトップ）とで値段と状態を二重に持つ。
- **Web だけ**: アプリは「有料の Web のサービスの無料のコンパニオン」（Apple 3.1.3(f)）。アプリには購入も誘導も置かない。Play の Payments のポリシー（アプリの中の誘導の禁止）にも合わせやすい。

### D. コードの置き場

- 全部を公開の Pleiad に置く: 運営の仕組み（課金・不正対策・Cloud の実行）まで公開する。Cloud は Procway の非公開の基盤に依るので、そもそも置けない。
- **公開と非公開に分ける**: 公開の Pleiad には利用者の手元で動くもの（ログインの画面・差し込み口・中継の参照実装・プロトコル）だけを置き、運営だけが使うものを非公開に置く。

## 決定

1. **公式の中継を使うときは、PC（ホスト）とスマホ（端末）の両方でログインを必須にする。そのうえでペアリングは今の QR のまま（案 A の (c)）。**
   - QR がホストの公開鍵を直接渡すので、運営のサーバーは鍵を仲介しない。E2E の信頼は今のまま（ADR 0013）。
   - ログインの役目は、誰が公式の中継を使えるかの**認可**と、**課金・計量・不正対策の単位**だけ。ホストの画面の権限（全権限）にも、端末の承認にも使わない。
   - 中継は、ホストと端末が同じアカウント（または、そのアカウントが招待した人）であることを確かめてから通す。
   - 自分の中継（登録用の秘密）を使うときは、ログインは要らない。今の道をそのまま残す。
2. **認証は Firebase Authentication。** ログインは Google・GitHub・Apple・メール。
   - iOS で Google などを出すなら Sign in with Apple を並べる（4.8）。
   - アプリの中にアカウントを作る道を置くので、アプリの中からアカウントを削除できる道を置く（Apple 5.1.1(v)・Google Play のアカウントの削除の要件）。Play には、アプリの外から削除を求める Web の窓口も出す。
   - デスクトップ（Electron）は、外部のブラウザーでログインし、ループバックへの戻り（RFC 8252 §7.3）と PKCE（RFC 7636）で Firebase の ID トークンを得る形を検討する。ブラウザーの側は公式サービスの Web のログイン画面（Firebase の Web SDK）で、戻った認可コードを公式サービスで Firebase のカスタムトークンに替え、デスクトップが Firebase にサインインして ID トークンと更新トークンを持つ、という形が候補。アプリ（Android・iOS）にネイティブの SDK を入れるか、同じ外部ブラウザーの流れにするかは、実装 5 で比べて決める（ネイティブの SDK は `google-services.json` と Google Play 開発者サービスへの依存が入る。ADR 0086 は FCM のためにそれを避けた）。
   - 中継と公式サービスは、ID トークン（JWT）を Google の公開鍵で検証する（署名・`aud` = プロジェクト・`iss`・期限）。公開鍵は取り置き、依存は足さない。
   - Procway には `IdentityProviderKind` に `firebase` が用意されているので、将来 Procway・Cloud と同じ利用者を共有できる。
3. **当面は個人で運営する。** 法人にするのは後で決める。特定商取引法の表示・規約・プライバシーポリシーの運営者は個人の名で書く。
4. **非公開のコードは新しい非公開のリポジトリに置く。Cloud の実行は Procway の基盤を呼ぶ。**
   - リポジトリとサービスの名前は未定（別に提案中）。この ADR では仮に「**公式サービス**」と書き、名前が決まったら埋める。
   - 公式サービスに置くもの: アカウントの台帳（アカウント ↔ `hostId`・招待・停止）・中継のアカウントの認可（下の差し込み口に差すもの）・計量と上限・課金（段階 1）・デスクトップのログインの仲介・Web の管理画面（アカウントの削除の窓口を含む）・Cloud の呼び出し（段階 2）。
   - Cloud の実行は Procway の基盤（テナントの namespace・会話ごとの pod・gVisor・LLM のプロキシ）を呼ぶ。Pleiad の側に実行の基盤は作らない。
   - **公開の Pleiad（Apache-2.0）に置くもの**: ログインの画面（ホストの設定・アプリ）・中継の認可の差し込み口・中継の参照実装（今の `relay/`。既定は登録用の秘密）・中継とホスト・端末の間のプロトコル（鍵の所有の証明・ID トークンの渡し方・閉じる理由）。
   - 自分の中継を使う道（今の登録用の秘密）は残す。公式の中継が無くても、Pleiad はすべて使える。
5. **課金は Web だけ。アプリは無料のコンパニオン**（3.1.3(f)）。
   - アプリの中に購入も、購入への誘導（値段・プランの案内・Web の購入画面へのリンク）も置かない。ログイン・アカウント作成の流れにも置かない（Play の Payments のポリシーの「account creation or sign-up flows」）。使えないアカウントでは「このアカウントでは公式の中継を使えません」とだけ出す。
   - 決済は Stripe Managed Payments（Stripe が販売者になる）を第一候補、Paddle を次点とする。どちらも手数料は未確認。日本の個人で使えるかを先に確かめる。
6. **段階を分ける。**

   | 段階 | 中身 | 始める条件 |
   |---|---|---|
   | 0 招待制の無料のテスト | 公式の中継を、招待したアカウントにだけ無料で開く。Play のクローズドテストのテスター 12 人にも招待を配る | 下の「段階 0 の実装」の 1〜7。プライバシーポリシー・データセーフティ・アプリへのアクセスの書き直し |
   | 1 有料化 | 月額。Web で申し込み、Stripe で払う | 電気通信事業の届出（要るなら）・特定商取引法の表示・プライバシーポリシーと規約が揃っていること。Play の Payments のポリシーで、Web だけの課金が認められる形かを確かめていること（未決 6） |
   | 2 Cloud | PC を持たない人のために、クラウドで procway-code を動かす。LLM は開発者が契約する API キーで、Procway の LLM のプロキシを通す | 段階 1。Anthropic・OpenAI の商用の規約に合う形であること。利用者の Claude・ChatGPT の個人契約をクラウドで代わりに動かすことは規約上しない（上の「Anthropic」）。Claude Code 自体を動かす形にするなら、利用者が自分の API キーで認証する形に限る |

### 公式の中継の認可の形

- **中継の認可の差し込み口**: `relay/server.mjs` の `hostAuth` と端末の照合を、差し替えられる認可の口にする。既定は今の登録用の秘密（振る舞いを変えない）。公式の中継は、公式サービスが「アカウントの認可」を差す。
- **ホスト**: 制御用の接続で、Firebase の ID トークンを渡し、`hostId` の鍵を持つことを証明する（例: 中継が出す使い捨ての値に、ホストの静的鍵と中継の一時鍵の X25519 から導いた鍵で HMAC を付ける。ホストは公開鍵も送り、中継は `hostId` = その公開鍵のハッシュであることを確かめる）。初めての `hostId` は証明したアカウントに束ね、ほかのアカウントからは名乗れなくする（4409 での置き換えも同じアカウントだけ）。
- **端末**: `/v1/device` と `/v1/device/notify` に、今の中継用トークンに加えて ID トークンを渡す。中継は、端末のアカウントがホストのアカウントか、そのアカウントが招待した人かを確かめる。ペアリングの接続（入場券）にも ID トークンを求める。ID トークンは 1 時間で切れるので、長く張る通知の線は張り直すときに新しいものを渡す（張っている間は切らない）。
- **閉じ方**: アカウントの停止・削除・契約の失効では、中継がそのアカウントの線（ホストの制御・データ・端末・通知）を **4401** で閉じる。理由に `account` を付け、新しいホスト・端末は「取り消された」と見分けて「ログインし直す・アカウントを確かめる」を出す（ペアリングは消さない）。古いアプリは 4401 を取り消しとして張り直しを止める。
- **上限と計量**: 全体で 8 ホストの上限は、公式の中継ではアカウントごとの上限（ホスト数・端末数・同時接続・量）に替える。計量はアカウントごとの接続の時間と量（バイト）の合計だけ。
- **E2E を壊さない約束**: 運営（公式サービス・公式の中継）は、ホストと端末の鍵・ホストの UI トークン・ペアリングの秘密・psk・会話の中身・通知の中身を受け取らない。受け取るのは、アカウント（メール・識別子・ログインの手段）・`hostId`・`deviceId`・トークンと入場券のハッシュ・接続元の IP・時刻・量・課金の状態だけ。中継は今までどおり中身を読めず、ディスクに書かない（台帳は公式サービスが持つ）。

## 理由

- **両方でログイン**: ホストだけ（b）だと、中継は端末が誰のものか分からず、有料のホスト 1 台に他人の端末をつなぐ使い方を止められない。課金と不正対策の単位は「人」なので、端末もアカウントに束ねる。Cloud には PC が無く、端末のログインがいずれ要る。先に入れておけば、作り直さずに段階 2 へ進める。
- **ペアリングを QR のままにする**: 運営のサーバーに鍵を仲介させると、運営（とその乗っ取り）が偽のホストの鍵を渡せるようになり、ADR 0013 の「中継の持ち主の不注意や乗っ取りでも、中身となりすましは守られる」が崩れる。ログインを認可だけに使えば、運営を信じなくても E2E は保たれる。
- **`hostId` の鍵の所有を証明する**: 今は登録用の秘密を持つ人が少ない前提で名乗りを許している。公式の中継では多くの人が登録するので、名乗りのままだと他人のホストの制御接続を置き換えて止められる。
- **Firebase Authentication**: 4.8 に要る Apple を含めて手段が揃い、ID トークンの検証は中継に依存を足さずに書け、Procway の型にも入っている。自前は手間が最も大きく、Procway の GitHub だけでは GitHub を持たない人が使えない。
- **自分の中継を残す**: Pleiad は Apache-2.0 で、第三者を挟まないことを選べるのが ADR 0013 の約束だった。公式の中継は手間を省く道として足し、置き換えない。
- **非公開に分ける**: 運営の仕組み（不正対策の判定・課金・Cloud の呼び出し）と Procway の非公開の基盤への依存を公開に混ぜない。利用者の手元で動く部分と、プロトコルは公開に置き、自分の中継を作れるようにする。
- **Web だけの課金**: アプリの中の課金にすると、Apple・Google の手数料と審査がかかり、PC の Pleiad と状態を二重に持つ。3.1.3(f) の形なら、アプリは購入も誘導も持たないので、日本の代わりの決済の資格（External Purchases or Offers Entitlement）も要らない。
- **段階を分ける**: 有料にする前に、届出・特定商取引法の表示・規約が要る。招待制の無料のテストなら、それを待たずに中継の手間を取り除き、テスターに配れる。

## 影響

- **本体で必ず変えるもの**（公開の Pleiad）
  - 中継: 認可の差し込み口、閉じる理由 `account`、アカウントごとの上限と計量の口。既定（登録用の秘密）の振る舞いは変えない。
  - ホストの資格情報（`core/remote/connector.mjs`）: 中継の種類（自分 / 公式）・ID トークンと更新トークン（secret-store）・鍵の所有の証明。
  - 設定 › リモート（`web/remote.mjs`）: 「自分の中継 / 公式」の切り替え、公式ではログインの状態とアカウント、自分では今の URL と登録用の秘密。
  - 端末（Android・iOS・デスクトップ版の端末）: ログインの画面・アカウントの削除・中継への ID トークン・4401 の `account` の見分け。QR の中継が公式かどうかで、ログインを求めるかを決める。
  - 伏せ字（`core/ops/redact.mjs`）: ID トークン・更新トークン・アカウントの資格情報を、操作の一覧（`ply_control`・CLI）と画面への返り・ログに出さない。今の `enrollSecret` と同じく、返さないのが先で、伏せ字は最後の網。
- **開発者が受け取るデータが増える**: アカウントのメール・識別子・ログインの手段・接続元の IP・時刻・量・課金の状態。
  - プライバシーポリシー（`site/privacy/`）・データセーフティ（`docs/play-store/data-safety.md`。「個人情報 › メールアドレス」「ユーザー ID」・削除のリクエストの答えが「はい」になる・Firebase の SDK を入れるならその収集）・アプリへのアクセス（`docs/play-store/app-access.md`）を書き直す。書き直しは別の作業で、段階 0 でテスターに配る前に済ませる。
  - App Store の「App のプライバシー」も同じく変わる（iOS を出すとき）。
- **審査**: アプリにログインが入るので、審査（ADR 0172）には審査用のテストアカウント（使い回せ、2 段階認証なし）も要る。アカウントの削除を審査で試されても、審査用のホストと招待が壊れない形にする（削除してもよい使い捨てのアカウントを別に出すなど）。
- **iOS の審査の危険**: 4.2.7（特定のソフトを映すリモートアプリは LAN の中だけ・アカウントはホストから・クラウドの薄いクライアントは不可）と読まれると、リモートも端末のログインも Cloud も通らない。アプリは「Pleiad（利用者のサーバー）のクライアント」として出す。説明・審査のメモ・画面で、PC の画面を映すものでないこと（ホストの API を使う専用のクライアントで、ホストのデスクトップを映さない）を示す。iOS は Android の後に出し、差し戻されたら iOS の出し方だけを別に決める。
- **運用**: 公式の中継と公式サービスを、開発者が常に動かす。止まると公式の中継の利用者全員がつなげない（自分の中継の利用者は影響を受けない）。中継は今は 1 台（状態がメモリ）で、水平に広げる形は未決。
- **ADR との関係**: ADR 0013 の「第三者のアカウントや TLS の終端を挟まない」は、自分の中継の道でだけ保たれる（公式の中継を選ぶと開発者と Firebase を挟む）。ADR 0086 の通知の運び方は変えないが、「配布元が何も運用しなくてよい」は公式の中継では成り立たない。ADR 0172 の審査用のホストと中継は、審査用のテストアカウントを足して続ける。
- remote.md §1（共有しない）・§5.4（1 人の持ち物）に、この ADR への参照を足した。仕様の書き換えは実装のときに行う。

## 未決

1. **サービスとリポジトリの名前**（別に提案中）。決まったら、この ADR の「公式サービス」を置き換える。
2. **料金とプラン**（段階 1 の前に）。
3. **端末をアカウントに束ねる細かい形**: 招待した家族・同僚の端末を許すか、許すならホストの持ち主が誰をどう招待し、中継がどう確かめるか（招待されたアカウントの端末は、ホストの持ち主の上限・計量に数えるか）。
4. **中継の水平展開**: `hostId` で振り分けて複数台にする形（同じ `hostId` の制御接続と端末の接続を同じ台に寄せる）。段階 0 は 1 台。
5. **電気通信事業の届出の要否**（問い合わせ中）。同じ人の機械どうしの暗号文の転送が「他人の通信を媒介」に当たるか、招待した別の人の端末なら当たるか。
6. **Play の Payments のポリシーとの整合**（この ADR で足した）: Play で配るアプリで、Web だけで払うサービスを使う形が、ポリシーの例外（3・8・9 節）や誘導の禁止の範囲で許されるか。段階 1 の前に確かめる。

## 実装の分け方（段階 0）

それぞれ単独で入れられる順に並べる。1〜2 は公開の Pleiad、3 は公式サービス、4〜6 は公開の Pleiad、7 は文書と運用。

1. **中継の認可の差し込み口**（公開）: `relay/server.mjs` のホストの認証・端末の照合・上限を、差し替えられる口に分ける。既定は今の登録用の秘密で、振る舞いを変えない（今の `tests/unit/relay.mjs` がそのまま通ること）。閉じる理由 `account` を足す。試験: 既定の口で今の試験が通る、試験用の差し込み（偽のアカウント）で、通す・断る・4401 `account` で閉じる。
2. **`hostId` の鍵の所有の証明**（公開）: 中継の使い捨ての値への証明を、中継（差し込み口から使う）とホストの接続口（`core/remote/connector.mjs`）に足す。自分の中継では求めない。試験: 鍵を持たないホストが他人の `hostId` を名乗れない、同じアカウントだけが置き換えられる。
3. **公式サービスの最小**（非公開）: Firebase のプロジェクト、ID トークンの検証、招待の一覧（招待されたアカウントだけ通す）、アカウント ↔ `hostId` の台帳、アカウントの停止、上限と計量の合計、1 の口に差す中継のアカウントの認可、Web のアカウントの削除の窓口、デスクトップのログインの仲介。公式の中継を 1 台置く。
4. **ホストのログイン**（公開）: デスクトップの外部ブラウザーでのログイン（ループバック + PKCE）、ID トークンと更新トークンを secret-store に置く、制御用の接続で ID トークンと所有の証明を渡す、設定 › リモートの「自分の中継 / 公式」とログインの状態、伏せ字（`redact.mjs`）。`npm start` のホストのログインの形もここで決める。
5. **端末のログイン**（公開）: Android のアプリのログイン画面（Google・GitHub・メール。Apple は iOS のときに）、ネイティブの SDK か外部ブラウザーかの比べと決定、`/v1/device`・`/v1/device/notify`・ペアリングに ID トークンを渡す、ID トークンの更新と通知の線の張り直し、4401 `account` の見分け、アプリの中のアカウントの削除、自分の中継のホストではログインを求めない。デスクトップ版の端末も同じ。
6. **失効と上限**（公開と非公開）: アカウントの停止・削除で、中継がそのアカウントのすべての線を 4401 `account` で閉じる。アカウントごとの上限を超えたら 4429。試験: 停止したアカウントのホストと端末が両方切れ、ペアリングは残り、ログインし直すと戻る。
7. **文書・審査・配布**: プライバシーポリシー・データセーフティ・アプリへのアクセスの書き直し、審査用のテストアカウント、remote.md（§1・§3.1・§3.4・§5・§9）の書き換え。それから Play のクローズドテストのテスター 12 人にアカウントの招待を配る。
