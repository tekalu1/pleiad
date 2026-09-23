# セキュリティポリシー / Security Policy

## 対象

脆弱性の報告は、デフォルトブランチ（`main`）の最新のコードと、その時点の最新の評価版リリースを対象とする。
古いバージョンへの修正の提供（バックポート）は行わない。

Reports are accepted for the latest code on the default branch (`main`) and the latest evaluation release. Fixes are not backported to older versions.

## 報告のしかた

脆弱性と思われるものを見つけたら、**公開の Issue や Pull Request には書かず**、GitHub の
[Private vulnerability reporting](https://github.com/tekalu1/pleiad/security/advisories/new)（リポジトリの「Security」タブ →「Report a vulnerability」）から非公開で報告してほしい。

Please do **not** open a public issue or pull request for security problems. Report them privately through GitHub's
[Private vulnerability reporting](https://github.com/tekalu1/pleiad/security/advisories/new) ("Security" tab → "Report a vulnerability").

報告には、可能な範囲で次を含めてほしい。

- 影響（何ができてしまうか）と、影響を受けるバージョン・OS
- 再現手順、または概念実証
- 関係するファイルや設定

個人で運用しているプロジェクトのため、返信や修正の時期は約束できないが、受け取った報告は確認し、修正の公開後に必要に応じて報告者を記載する。
