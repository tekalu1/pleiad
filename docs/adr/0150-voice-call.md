# 0150 通話モード: 声で話しかけ、返事を読み上げる（OpenRouter の STT・TTS）

- 状態: 承認（2026-10-06）

## 状況

Pleiad には声の入口が無い。手が離せないときや長い指示のときに使えず、返事も画面を見ないと分からない。ユーザーは、OpenRouter の API キーで聞き取り（STT）と読み上げ（TTS）を行う「通話モード」を求め、遅延と UX を最優先とした。

調べた事実（`temporary/reports/voice-call-vtc-reference.md`、2026-10-06）:

- OpenRouter の `/audio/transcriptions` は同期のみ（ストリーミング・途中結果なし）。`/audio/speech` は `response_format: "pcm"` で PCM（24kHz mono s16le）を逐次で返す。
- 姉妹製品 vtc-web の有料モードが同じ構成（gateway が OpenRouter を呼ぶ）で、区切り・片・投機・予備のモデルの実装と実測がある。割り込み（barge-in）は無い。
- `desktop/main.cjs` の権限ハンドラーはマイク（`media`）を断っていた。

ユーザーの承認（2026-10-06）: モック（`unify-chat-channel-call.html` の 05）の形。背景は案 D（話している間だけ）、話している場所は案 1（伸びる下線）。入口は会話・スレッドの頭の通話ボタン。

## 決定

- **構成**: OpenRouter のキーと呼び出し・区切りはホスト（`core/voice/`）、録音・再生・印の描画はクライアント（`web/voice/`）。音声は別の WebSocket（`/voice-ws`。バイナリ + JSON、トークンで認可）。**キーを持つこの PC の画面からだけ**受ける（中継越しは断り、`ready.voice` は 0）。
- **キー**: ホストだけが持つ（`voice-secrets.json`、safeStorage で暗号化）。Jev の判定器のキーとは別の項目。登録・削除は human-only の WS コマンド（`setVoiceKey`・`deleteVoiceKey`。HUMAN_ONLY の「秘密の値」に足す）。画面・ログ・エラーの文・AI の操作の返りへ出さない。登録が音声と読み上げる文章の外部送信の同意。
- **聞き取り**: ホストが音声を区切って同期の STT へ送る。発話の区切り（無音 600ms）・片（話しながら文字を出す。直前 2 秒を付け、重なりを文字合わせで除く）・投機（無音 341ms で先に送る）・予備のモデル（`microsoft/mai-transcribe-2` が 429 なら待たず `assemblyai/universal-3-5-pro`）。片は初版から入れる（費用は片なしの約 3 倍）。確定は発話全体の認識。
- **読み上げ**: エージェントの `text.delta` から、1 文目が閉じた時点（1 文目だけは 8 字を超えた読点）で合成を出す。文ごとに並行して合成し、再生キューが番号どおりに並べる。返事の本文だけを読み、コード・表・長い作業ログは「コードは画面に出しました」と言い添える。モデルは `x-ai/grok-voice-tts-1.0`（設定で替えられる）。
- **ユーザーの発言は今の送信の経路**（会話は `submit`、スレッドは `channels.post`）。通話中の画面は確定した文字をその経路へ送り、ホストは送らない。
- **割り込み**: 話して割り込むのは 2 段目。今回はマイクのミュート・スピーカーのミュート・［止める］ボタンまで（`halt`・`barge` の口だけ用意）。読み上げ中とその後 700ms はマイクの音声を送らない（半二重）。
- **費用の安全弁**: 1 回と 1 日の通話の長さの上限（設定。上げる向きは `guarded`）・声が聞こえないまま 10 分で終了・無音と雑音を送らない（送信ゲート・200ms 未満の声・空の結果）。使用量は日ごとの台帳（直近 31 日。`voice-usage.json`）。
- **設定**: `voice`（モデル・声・言語・上限・エコー除去。`defineSetting`）と、状態を読む `voice.status`（キーの有無・今日の使用量。キーそのものは返さない）。設定の画面は設定 › 通話。
- **見た目**: 新しいトークン族 `--glow-*`（通話中の背景の光。`radial-gradient` の色と濃さにだけ。`lint-design` が場所を `web/voice.css` に絞る）。通話中だけ弱い字・リンクを 1 段濃く（ダークは明るく）して光の上でも 4.5:1 を保つ。詳細は `docs/design-system.md`「通話モード」。
- **差し込み口**: 通話の機能は `web/voice/`・`core/voice/` に閉じる。入力欄・会話（スレッド）の頭・メインの面へは、口 1 か所ずつ（Chats は `client.mjs` の `voiceUi.mount`、スレッドは `web/channels/thread.mjs` の `host.voice?.mount`）。契約は `web/voice/index.mjs` の先頭のコメント。
- **プラットフォーム**: Electron は本体の画面（メインフレーム・同じ origin）の音声入力に限って `media` を許可。macOS は `NSMicrophoneUsageDescription` と audio-input の entitlement、Android は `RECORD_AUDIO`。実機の確認はできていない。

## 理由

- 同期の STT を実用の遅延にするには、区切り・投機・片が要る。vtc-web で実測のある設計を、割り込み以外そのまま使えた。
- キーをブラウザーに出さないことで、画面・ログ・AI からキーを守る。別の WebSocket にすると、音声の高頻度のバイナリが `/ws` の大きなイベントと詰まり合わない。
- 返事の全体を待たず 1 文目で合成を出すのが、最初の音を早くする最大の手。コードや表を読み上げても役に立たないので、画面に任せる。
- 半二重は、割り込みを作る前に、スピーカーの音を自分の発言と取り違えて勝手に送る事故を防ぐ。
- 光の背景は、面は無彩色という規則の例外。例外を広げないよう、トークン族を分け、lint で使える場所を絞った。

## 影響

- 新しい永続のファイル: `voice-secrets.json`（秘密）・`voice-usage.json`（31 日分。`tests/data-writes-allowlist.mjs` に上限つきで載せた）。DB の形は変えない。
- 新しい WS の口 `/voice-ws`、WS コマンド 2 つ（human-only）、操作 `voice.status`、設定 `voice`、イベント `voiceChanged`、`ready.voice`。
- 通話中は OpenRouter（と選んだモデルの提供元）へ音声と読み上げる文章が送られる。`provider.zdr` などのリクエスト単位の指定は音声の口で効くか未確認（vtc-web の 2026-10-02 の実測では黙って捨てられていた）。保持・学習を避けたいときは、モデル選びで守る（ZDR の一覧に載るモデル。`x-ai/grok-voice-tts-1.0` は載っていない）。
- リモート（中継越し）の通話・話して割り込む 2 段目・複数端末の同時通話は未対応。
