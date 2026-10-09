# 0183 API キーで Cerebras を特別扱いしない（cerebras.ai の互換の接続先は、ほかと同じ custom）

- 状態: 提案
- 日付: 2026-10-10
- 置き換える: [ADR 0177](0177-judges-via-openrouter.md) の決定 6 のうち「互換の接続先で `cerebras.ai` を使うためのプロバイダー名と、URL のホストからの見分け（`providerOfEndpoint`）は残す」
- 関連: [ADR 0155](0155-api-keys-in-one-place.md)、docs/design.md「API キー」

## 状況

ADR 0177 で Cerebras へ直に送る判定器をやめたあと、API キーには Cerebras 専用の扱いが 3 つ残っていた。プロバイダー名「Cerebras」（`PROVIDER_NAMES`）、ホストの決まったプロバイダーとしての扱い（`FIXED_HOST_PROVIDERS`。キーにホストを結び付けない）、接続先の URL が `cerebras.ai` ならプロバイダーを `cerebras` とみなす規則（`providerOfEndpoint`）。Pleiad は Cerebras をどこからも使っておらず、設定 › API キーの追加の選択肢にも無い。残っているのは、互換の接続先で `cerebras.ai` を使う人のための特別扱いだけだった。

## 決定

1. **Cerebras を名前付きのプロバイダーにしない。** `PROVIDER_NAMES`・`FIXED_HOST_PROVIDERS` から `cerebras` を外し、`providerOfEndpoint` は `cerebras.ai` のホストを見分けない。`cerebras.ai` の互換の接続先のキーは、ほかのサービスと同じ `custom`（使った接続先のホストに結び付くキー）になる。
2. **既存のキーの移行（`api-keys.json`）。** 台帳を読むとき（`core/api-keys.mjs` の `clean`）、`provider` が `cerebras` のキーを `custom` に直す。`host` は null（まだどのホストにも結び付いていないキー。接続先で選んだときに、その接続先のホストに結び付く）。`id`・`label`（多くは「Cerebras」）・キーの値は変えない。起動では書き直さず、次に台帳を保存したときに書く（ADR 0177 の `judge:cerebras` の移行と同じ。同じデータを使う前の版が台帳を読めなくならない）。キーを黙って消さない。API キーの追加で `provider: 'cerebras'` を渡されたときも `custom` として登録する。
3. **既存の接続先はそのまま使える。** そのキーを選んでいる互換の接続先は `keyRef`（キーの id）を変えずに動く。`custom`・host なしのキーは、`custom` の接続先ならどのホストにも当てはまる（`keyFitsEndpoint`）。選び直すと、その接続先のホストに結び付く。
4. **前の版の記録・設定の読み替えは残す。** `judge:cerebras` の台帳の移行、`delegation-routing` の `migrateLegacySettings`（`escalateToCerebras`・`judgeByKind` の `cerebras`）、古い置き場の `delegation-routing:cerebras`、辞書の `routing.judge.cerebras`（前の版のタスクの記録の表示）は、前の版で保存されたデータを読むためなので変えない。OpenRouter の provider 指定 `order: ['cerebras']`（`QWEN_PROVIDER`）は Pleiad の Cerebras ではなく OpenRouter 内の振り分けなので、これも変えない。

## 理由

- どこからも使っていないサービスのために、プロバイダーの一覧・ホストの規則・見分けの 3 か所を持ち続けると、新しいプロバイダーを足すときの手本を誤らせる。互換の接続先は、名前を持たなければ custom のホスト単位で足りる。
- 移行を起動で書かず、id と値を変えないのは ADR 0177 と同じ理由（前の版との共存、利用者の登録したものを黙って消さない）。

## 影響

- `cerebras.ai` の互換の接続先で、キーがホストに結び付くようになる（別のホストの接続先では、結び付いたあとは選べない）。以前は Cerebras のキーはどの `cerebras.ai` の接続先でも選べた。
- 次に台帳を保存したあと、`provider: 'cerebras'` のキーは `custom` で書かれる。前の版（このリリースより前）は `custom` のキーを `cerebras.ai` の接続先には当てはまらないものとして扱うので、同じデータを前の版で開いたときは、その接続先でキーを選び直す必要がある。
- 実装: `web/api-keys-model.mjs`、`core/api-keys.mjs`（`RETIRED_PROVIDERS`・`clean`）。
