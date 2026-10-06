# 通話モード（承認済み 2026-10-06、[ADR 0150](adr/0150-voice-call.md)）

声で話しかけると、聞き取って会話へ送り、返事を読み上げる。聞き取り（STT）と読み上げ（TTS）は OpenRouter の API を、ホスト（Pleiad の本体）が呼んで行う。見た目の決まりは `docs/design-system.md`「通話モード」、設定・費用の安全弁・`/voice-ws` は `docs/design.md`「通話モード」。ここは、構成・遅延の設計・測り方・確かめ方をまとめる。

## 構成

```
画面（web/voice/、素の ESM）                              ホスト（core/voice/、Node。ws は既にある）
──────────────────────────                               ───────────────────────────────────────────
engine.mjs  状態機械                                      host.mjs     /voice-ws・出来事の振り分け・キー・使用量
 ├ capture.mjs   getUserMedia → AudioWorklet → 16kHz s16le  ├ session.mjs   通話 1 本（プロトコル・限度・遅延の内訳）
 ├ send-gate.mjs 静かな間は送らない（プリロール 300ms）      ├ cutter.mjs    発話の区切り（無音・投機・片）
 ├ link.mjs      /voice-ws（バイナリ + JSON）               ├ stt.mjs       OpenRouter の聞き取り（片・投機・予備のモデル・順番）
 └ player.mjs    PCM 24kHz の再生キュー・位置              ├ tts.mjs       OpenRouter の読み上げ（逐次 PCM）
index.mjs   部品の差し込み（slot の契約）                    ├ reply-reader.mjs  返事の差分 → 読む文（コード・表・ログは読まない）
 ├ view.mjs        通話ボタン・マイク・スピーカー・一行     └ speaker.mjs   文ごとに合成を並行・中断
 ├ live-bubble.mjs あなたの声の吹き出し（片が足される）
 ├ reading-mark.mjs 話している場所の下線
 └ settings.mjs    設定 › 通話
```

- **別の WebSocket（`/voice-ws`）。** `/ws` は JSON のイベント配信で、大きなイベントと音声の高頻度のバイナリを同じ口に混ぜない。トークンは `/ws` と同じ（URL の `token`）。**キーを持つこの PC の画面からだけ**受ける（中継越しは 403。`ready` の `voice` も中継越しの接続には 0 を返し、通話ボタンを出さない。リモートの通話は今回の範囲外）。
- **キーはホストだけが持つ。** 設定 › API キー（`api-key-secrets.json`。Electron の safeStorage で暗号化。`npm start` は権限 0600 の平文）に登録した OpenRouter のキーのうち、設定 › 通話の「使うキー」で選んだもの（`setApiKeyUse`。human-only）を使う。**選んだときから音声と読み上げる文章が OpenRouter へ送られ、登録しただけ・「使わない」では何も送らない**（[ADR 0154](adr/0154-api-keys-in-one-place.md)。それまでは「キーの登録が同意」だった）。使うキーを消す・「使わない」にすると通話は切れる（`keysChanged`）。画面・ログ・エラーの文・AI の操作の返りにキーは出ない（`redactKey`。テストが見る）。確認は設定 › API キーの［確かめる］（OpenRouter の `GET /key`）。古い口 `setVoiceKey`・`deleteVoiceKey` は、同じ値のキーを登録して「使うキー」に選ぶ橋渡しとして残してある（後片付けで外す）。
- **ユーザーの発言は今の送信の経路にそのまま乗せる。** 確定した文字は画面が受け、会話へは `submit`（`sendMessage`）、スレッドへは `channels.post` で送る（ホストは送らない）。返事の読み上げは、ホストが `emitGlobal` の `text.delta`・`text.end`・`userMessage`・`turnEnd` を見て作る。通話が見る会話は、Chats は会話の id、スレッドはそのスレッドの bot の会話（`store.get(id).bot` の `channelId`・`threadId`）。新しい会話は最初のターンで id が決まるので、見ていない会話の直近 3 秒は覚えておき、見始めたら渡す。

## プロトコル（`/voice-ws`）

上り: 音声フレーム（バイナリ。16kHz s16le モノラル）と JSON `hello`（見る先）・`target`・`mute`・`spk`・`halt`（`barge` も同じ）・`lat`。
下り: JSON `ready`・`error`・`limit`・`speaking`・`partial`・`final`・`drop`・`seg`（読む文の始まり）・`seg.end`・`seg.fail`・`cancel`・`turn.end`・`lat`、バイナリ `[1][文の id uint32 LE][PCM 24kHz s16le]`。詳しい項目は `core/voice/session.mjs` の冒頭。

## 聞き取り

OpenRouter の `POST /audio/transcriptions` は**同期のみ**（ストリーミングも途中結果もない）。そこで、ホストが音声を区切って送る（出どころは vtc-web の有料モードの読解。`cutter.mjs`・`piece-text.mjs`・`stt.mjs` の冒頭に書いた）。

| 仕組み | 中身 |
|---|---|
| 発話の区切り | 声のあと無音 600ms（8 フレーム）か最長 15 秒。声が 200ms に届かない発話（咳・物音）は送らない。音声の時計だけで動く |
| 片（途中の文字） | 声の頭から 1.0 秒を超えたあと無音 171ms（息継ぎ）か 2.5 秒（強制）で切り、頭に直前の 2 秒を付けて先に送る。返った文字から前の片と重なる頭を文字合わせで除いて、吹き出しへ足す。重なりが見つからない・片が失敗したら、その発話の途中経過はあきらめて確定を待つ（二重に読むより安全）。**確定は発話全体を 1 回で認識した結果**（片のつなぎではない）。費用は片なしの約 3 倍 |
| 投機 | 無音が 341ms に届いた時点で、区切ったときと同じ音声を先に送る。声が戻れば捨てる。往復を無音の待ちに隠し、確定が約 1.1 秒 → 約 0.75 秒になる |
| 予備のモデル | `microsoft/mai-transcribe-2` は共有枠で、混む時間帯は 4〜5 割が 429。429 を受けたら待たずに予備（`assemblyai/universal-3-5-pro`）へ送る。Retry-After の間は主を「混んでいる」とみなし、片は主を飛ばして予備へ直接送る（確定と投機は主を先に試す）。前の片が予備へ行った発話は、冷却が明けても予備で揃える |
| 順番 | 区切った順に確定を出す（前の結果を待つ）。後の発話が先に返っても入れ替わらない |

## 読み上げ

- **逐次の PCM。** `POST /audio/speech` に `response_format: "pcm"`（24kHz mono s16le）。応答が PCM でない・レートが違うなら 1 バイトも流さずに失敗させる。奇数バイトは持ち越し、先頭の無音（0〜320ms）は声の 80ms 前まで詰める。
- **1 文目が閉じた時点で出す。** エージェントの `text.delta` を `reply-reader.mjs` が文に割る（。！？・ASCII の `.!?` のあと空白・改行）。各ブロックの 1 文目だけは、読点が 8 字を超えていればそこで切る。2 文目以降も閉じたらすぐ合成を始め（同時に 3 本まで）、音は文の番号つきで流す。並べるのはクライアントの再生キュー（前の文が終わるまで後の文の音は持つ。文の間に 120ms）。
- **読むのは返事の本文だけ。** コードのブロック・表・長い作業ログは読まず、ブロックの終わりに「コードは画面に出しました」（表・ログも同じ形）と短く言う。種類ごとに 1 ターンに 1 回。1 ターンに読む量には上限（1500 字）。記法（`**`・`` ` ``・リンク・URL・絵文字）は外して読む。
- **止める。** スピーカーのミュート（読み上げを止め、ミュート中の文は合成を頼まない。解除すると次の文から）と、返事の下の［止める］（このターンの残りは読まない）。どちらも進行中の合成を `AbortController` で中断し、鳴っている音は 25ms で絞って止める。**話して割り込むのは 2 段目**（`halt`・`barge` の口だけ用意してある。半二重で自分のスピーカーの音を拾わないよう、読み上げ中とその後 700ms はマイクの音声を送らない）。
- **話している場所の下線**（`reading-mark.mjs`）。ホストが送る文（記法を外した読み上げの文）を、画面の返事の本文の文字から探し（句読点・空白・大小を除いた文字で突き合わせる）、その文の下に 2px の線を `requestAnimationFrame` で伸ばす。DOM は作り直さない（本文の外の層の線の幅だけを動かす）。音が出そろう前は文字数から見積もる。画面の外なら「話している場所へ ↓」。

## 遅延の設計

目標: 声の終わり → 返事の最初の音を短くする。内訳と縮め方:

| 区間 | 設計 |
|---|---|
| 声の終わり → 確定 | 無音 600ms の待ちは縮めない（行が割れる）。**投機**で往復を隠し、片で途中の文字を先に出す。区切りは音声の時計だけで決め、クライアントのゲートは区切りの無音（900ms）を流し切る |
| 確定 → 最初の文が閉じる | エージェントの速さ。**返事の全体を待たず**、1 文目が閉じた時点（または 8 字を超えた読点）で合成を出す |
| 最初の文 → 最初の音 | 逐次の PCM（最初のバイトまで約 0.35 秒）。合成は文ごとに並行。AudioContext は通話の開始時に作って resume 済み（最初の音で作ると遅れる）。再生は currentTime + 20ms から背中合わせ。先頭の無音を詰める |
| STT の混雑 | 予備のモデル（429 を待たない） |
| 画面の体感 | 声を区切ったら即「考え中」（縁を点が回る）。確定した文字は片で先に出ている |

## 遅延の測り方

- **ホストのログ**（標準出力）。`voice.final`（`speechEndToFinalMs` = 最後の声のフレームを受けてから確定を出すまで・STT の往復・モデル・route・投機か）、`voice.latency`（確定ごとに 1 行。`speechEndToFinalMs`・`finalToFirstTextMs`・`firstTextToSentenceMs`・`sentenceToFirstAudioMs`・`finalToFirstAudioMs`）、`voice.latency_client`（クライアントが測った確定 → 最初の音が鳴るまで）、`voice.stt.request`・`voice.tts.request`（`firstChunkMs`・`tookMs`・`audioMs`・費用）。本文とキーは出さない。
- **画面の開発用の表示。** `localStorage.setItem('ply-voice-debug', '1')` のあと通話すると、画面の左下に直近の「声の終わり→確定 / 確定→最初の文 / 文→音（ホスト）/ 確定→音」が出る。
- **声の終わり → 最初の音** = `speechEndToFinalMs` + `finalToSoundMs`（クライアント）。偽の OpenRouter では 651ms + 238ms ほど（STT 220ms・TTS 最初のバイト 150ms の模擬を含む。**本物の値ではない**）。
- **本物のキーでの測り方**（ユーザーがキーを入れてから）: (1) 設定 › 通話にキーを登録する。(2) 開発用の表示を有効にする。(3) ヘッドホンで（スピーカーだとエコーで測りが乱れる）、同じ短い質問を 10 回話して、ホストのログの `voice.latency` と `voice.final` を集める（中央値と最大）。(4) 混む時間帯の 429 の率は `voice.stt.request` の `model` が予備だった割合と、`voice.stt.cooldown` の回数。(5) エージェントの最初の文までの時間（`finalToFirstTextMs` + `firstTextToSentenceMs`）はバックエンドの速さなので、通話の遅延と分けて見る。(6) 日本語の TTS は聞き比べる（`ttsModel`・`ttsVoice` は設定で替えられる。vtc の実測では `x-ai/grok-voice-tts-1.0` が最初のバイト 344ms・誤読が少ない。`deepgram/aura-2` は速いが日本語の誤読が多い）。

## 費用の安全弁

- **1 回の通話の長さの上限**（既定 30 分）と **1 日の通話の長さの上限**（既定 120 分。この PC の日付）。超えたら通話を終える（1 日の上限に達していれば始められない）。設定 › 通話で替える。上限を上げる向きは AI からは承認カード（`guarded`）。
- **声が聞こえないまま 10 分**たった通話は終える（つけっぱなしで周りの音を送り続けない）。
- **無音・雑音を送らない。** クライアントの送信ゲート（RMS 0.012）と、ホストの区切り（声が 200ms に届かない発話は送らない・文字が空や記号だけの結果は捨てる）。
- 使用量は日ごとの台帳（`voice-usage.json`。直近 31 日。通話の長さ・聞き取りの秒数・読み上げの字数）で、設定 › 通話に今日の分を出す。

## 確かめ方

- 単体: `node tests/run.mjs voice`（`voice-core`・`voice-reply-reader`・`voice-openrouter`・`voice-session`・`server-voice`・`voice-ui`）。偽の OpenRouter は `tests/lib/fake-openrouter.mjs`（`AGENT_HOST_VOICE_API` で向ける。`tests/lib/server.mjs` は既定で閉じたポートを向け、本物へは送らない）。
- 実ブラウザー: `node tests/browser/voice-call.mjs`（`VOICE_SHOTS=<ディレクトリ>` で場面ごとに撮る）。fake バックエンド・一時のデータ置き場・偽の OpenRouter・Chromium の `--use-fake-device-for-media-stream`・`--use-fake-ui-for-media-stream`・`--use-file-for-fake-audio-capture`（声のような WAV）で、頭のボタン → 準備中 → 聞いています → 片が足される → 送信 → 返事 → 下線が伸びる → ミュート・止める → 終える、権限なし、スレッド、360・ライト・ダーク・動きを減らすを通す。fake が声の言葉に台本の返事をするには `AGENT_HOST_FAKE_VOICE_REPLY=<{ when, steps } の JSON>`。
- エコー除去（ブラウザーの標準）は、偽のマイクの音を消すことがあるので、確かめるときは設定で切る。

## 前提と未確認

- **Electron**: `desktop/main.cjs` の権限ハンドラーは、本体の画面（メインフレーム・同じ origin）の音声入力（`media` で `audio` だけ）に限って許可する。映像・ほかの枠・ほかの権限は今までどおり断る。Electron の実機でマイクが取れるかは**確かめていない**（ヘッドレスの Chromium で確かめた）。
- **macOS**: `NSMicrophoneUsageDescription` と `com.apple.security.device.audio-input` の entitlement（`build/entitlements.mac.plist`。electron-builder の既定の entitlement を含めた）を足した。署名・公証した配布版は**確かめていない**（Mac が無い）。
- **Android**: `RECORD_AUDIO` を足した。通話はいまは中継越しの画面に出さないので、実機は**確かめていない**。
- 中継越し（リモート）の通話・話して割り込む（barge-in）・複数の端末での同時の通話は、今回の範囲外。
