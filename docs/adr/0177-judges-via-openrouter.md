# 0177 委譲の判定器を OpenRouter にまとめる（Cerebras の直の経路をやめる）

- 状態: 承認（2026-10-09。利用者が承認）
- 日付: 2026-10-09
- 置き換える: [ADR 0022](0022-delegation-routing.md) の判定器 `cerebras`（`api.cerebras.ai` へ直に送る）、[ADR 0155](0155-api-keys-in-one-place.md) の割り当て `judge:cerebras` と Cerebras のキーの［確かめる］（`GET /v1/models`）
- 関連: docs/agent-delegation.md「委譲先の自動振り分け」、docs/design.md「API キー」、docs/design-system.md「設定 › 委譲」「設定 › API キー」

## 状況

委譲の難しさの判定器は 2 つあり、Jev は OpenRouter（`/alpha/decisions`）、Qwen は Cerebras の API（`api.cerebras.ai/v1/chat/completions`、`qwen-3.8-27b`）へ直に送っていた。判定器ごとにキーを選ぶので、Cerebras のキーと OpenRouter のキーの 2 つを登録・管理させていた。利用者は外部の AI のサービスを OpenRouter に統一したい。

Qwen の判定器は「Jev が迷ったら聞き直す」（`escalateToCerebras`）と、Jev が使えないときの予備に使われている。Jev だけにすると、聞き直しと予備が無くなる。

## 決定

1. **Qwen の判定器を OpenRouter 経由にする（判定器 `qwen`）。** 送り先は `POST https://openrouter.ai/api/v1/chat/completions`、モデルは同じ Qwen の `qwen/qwen3.8-27b`。`provider: { order: ['cerebras'], allow_fallbacks: true, require_parameters: true }` で Cerebras を先に頼み（速さ）、受けない・落ちているときは関数の呼び出しを受けるほかの provider へ回す。推論なし（`reasoning: { effort: 'none' }`）・`temperature: 0`。
2. **答えは strict な関数の呼び出しで受ける。** OpenRouter の Cerebras は `response_format`（JSON schema）を受けないので、6 つの boolean を持つ関数 `routing_v3` を 1 つだけ渡し（`strict: true`）、`tool_choice` で呼ばせる。引数が無ければ本文の JSON を読む。形が違えば `bad_response`。
3. **キーは OpenRouter の 1 つ。** Jev と Qwen はどちらも `api-keys.json` の `uses['judge:jev']`（名前は前の版のまま）のキーで送る。判定器の予備（選んだ判定器が使えなければもう一方）と聞き直しは今までどおり。設定 › 委譲の「判定器が使うキー」は「OpenRouter（Jev・Qwen）」の 1 枚にし、設定 › API キーの追加から Cerebras を外す。
4. **設定の移行（`prefs.json` の `delegationRouting`）。** 読むとき（`normalizeSettings`・画面と操作からの保存）に、`escalateToCerebras` を `escalateToQwen` に、`judgeByKind` の `'cerebras'` を `'qwen'` に直す（両方あれば今の名前を残す。`migrateLegacySettings`）。起動では書き直さず、次に委譲の設定を保存したときに今の名前で書く。
5. **キーの台帳の移行（`api-keys.json`）。** 読み込むたびに、廃止した割り当て `judge:cerebras` を落とす。それがキーを指していて `judge:jev` が空なら、最初に登録した OpenRouter のキーを `judge:jev` に選ぶ（OpenRouter のキーが無ければ「使わない」のまま。Cerebras のキーを OpenRouter へ送ることはない）。起動では書き直さず、次に台帳を保存したときに書く。まだ API キーへ移行していない置き場からの移行（ADR 0155）では、古い置き場の `delegation-routing:cerebras` を取り込まず、選んでいたことだけを同じ規則で `judge:jev` へ引き継ぐ。
6. **Cerebras のキーは消さない。** 台帳にある Cerebras のキーの行と値は、使う所の無いキーとして残し、利用者が設定 › API キーで消す。古い置き場（`compat-endpoint-secrets.json` の `delegation-routing:cerebras`）にも手を付けない。互換の接続先で `cerebras.ai` を使うためのプロバイダー名と、URL のホストからの見分け（`providerOfEndpoint`）は残す。
7. **古い口。** `setDelegationRoutingKey`・`deleteDelegationRoutingKey` の `service: 'cerebras'` と、`setApiKeyUse` の `use: 'judge:cerebras'` は知らない値として断る。`apiKeys.check` は OpenRouter（`GET /key`）だけを確かめる。

## 理由

- 同じモデルが OpenRouter にあり、provider の順で Cerebras を先に頼めるので、判定器の中身と速さを大きく変えずにキーとサービスを 1 つにできる。Jev だけにまとめると、利用者が入れている「迷ったら聞き直す」と予備が消える。
- 関数の呼び出しにしたのは、OpenRouter の Cerebras が JSON schema の応答を受けないため。`require_parameters: true` で、関数の呼び出しを受けない provider へは回らない。
- 移行を起動で書かないのは、同じデータの置き場を使う前の版（無停止の更新の切り替えの間・入れ直した古い版）が、利用者が何もしていないのに判定器の割り当てや設定を失わないため。読むたびに同じ結果になる直し方なので、書くまでの間も動きは決まっている。`store.setPref` を起動で直に呼ばない決まり（ADR 0081）にも合う。
- Cerebras のキーを消さないのは、利用者の登録したものを黙って消さないため。使い道が無いことは、カードの「使っている所」が空になることで分かる。

## 影響

- OpenRouter 経由の Qwen の判定の質と速さは、ADR 0022 の検証（Cerebras へ直に送る・JSON schema）と同じ条件では測っていない。OpenRouter を挟む分の待ちが増え、1 回 3 秒の時間切れに当たりやすくなるかもしれない。答えの形が関数の引数に変わった。実際の委譲の記録（`routing.judge`・`fallback`・`escalated`）で見直す。
- 前の版のタスクの記録の `routing.judge: 'cerebras'` は、委譲カードの内訳でそのまま「Cerebras」と出す（辞書の `ui:routing.judge.cerebras` を残す）。
- Cerebras のキーを判定器にしか使っていなかった利用者は、OpenRouter のキーを登録して選ぶまで、Jev を含む判定器が使われない（難しさは中）。
- 実装: `core/delegation-judges.mjs`（`askQwen`・`QWEN_PROVIDER`）、`core/delegation-routing.mjs`（`JUDGES`・`migrateLegacySettings`）、`core/api-keys.mjs`（`USES`・`judge:cerebras` の扱い）、`core/server.mjs`・`core/ops/settings.mjs`（保存の前の直し）、`web/delegation-settings.mjs`・`web/api-keys-settings.mjs`。テストの `AGENT_HOST_CEREBRAS_API` は使わなくなった。
