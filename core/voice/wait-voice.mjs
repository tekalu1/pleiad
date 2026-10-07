// 待ちの声（通話モード。ADR 0158）。強いモデルが考えたりツールを使ったりしている間の無音を、決まった短い文で埋める。モデルは使わない
// （遅延・費用・外部送信先が増えるため）。時計は呼ぶ側が渡す（tick を回す）。純粋な状態で、声を出す口（speak）だけを外から受ける。
//
//   受け取りの一言   声で送った 1 通が AI に渡ってから ACK_AFTER_MS たっても返事の読み上げが始まっていなければ、「はい、確認します」のような一言を読む。
//                    返事が先に来た（読み上げが始まった・本文が流れ始めた）・話し始めた・止めたなら言わない。受け取られていない（送信待ち）うちは
//                    起点が無い（クライアントが「AI に渡しました」を知らせる handed が来て初めて数える）。
//   待ちの実況       返事の読み上げも一言も鳴っていない無音が NARRATE_QUIET_MS 続き、そのターンにツールが動いていたら、ツールの種類から決まった短い文を読む。
//                    間隔は最低 NARRATE_GAP_MS、1 ターンに NARRATE_MAX 回まで。ツールの引数・ファイル名・コマンドの中身は読まない（名前の種類だけを見る。秘密や長い文字が混ざるため）。
//                    声で送ったターンだけ（handed で始まる）。人が話している最中・止めたあとのターンの残りは言わない。
//
// 一言の最中に返事の 1 文目が来たら、一言を最後まで読んでから返事に続ける（途中で切らない）。一言は短く（約 1 秒）、途中で切ると語が欠けて聞こえ、
// 返事の合成は一言と並行して進む（再生キューは文の番号順に並べる）ので、返事が遅れるのは一言の残りだけで済む。割り込み（halt）は一言も止める（session.mjs の halt が合成ごと捨てる）。
export const ACK_AFTER_MS = 1500;
export const NARRATE_QUIET_MS = 6000;
export const NARRATE_GAP_MS = 12000;
export const NARRATE_MAX = 4;
const MS_PER_CHAR = { ja: 130, en: 70 };   // 読み上げの長さの見積もり（文字数 × これ）。鳴り終わりの目安で、実際の長さは分からないので控えめに数える
const MAX_SPEECH_MS = 10_000;

export const TOOL_KINDS = Object.freeze(['read', 'search', 'command', 'web', 'delegate', 'edit', 'computer', 'other']);
export const ACK_COUNT = 4;

// ツール名（各バックエンドが正規化して tool.start に出す name）→ 種類。小文字で突き合わせる
const KIND_BY_NAME = new Map([
  ...['read', 'notebookread', 'read_file', 'list_dir', 'imageview'].map((n) => [n, 'read']),
  ...['glob', 'grep', 'grep_search', 'find_by_name'].map((n) => [n, 'search']),
  ...['bash', 'powershell', 'commandexecution', 'run_command', 'fake_shell'].map((n) => [n, 'command']),
  ...['webfetch', 'websearch', 'read_url', 'search_web'].map((n) => [n, 'web']),
  ...['task', 'agent', 'subagentactivity', 'collabagenttoolcall'].map((n) => [n, 'delegate']),
  ...['edit', 'write', 'multiedit', 'notebookedit', 'filechange', 'write_file', 'edit_file', 'replace'].map((n) => [n, 'edit']),
]);
// 実況の対象にしない（画面の見出し・TODO の更新など、利用者が待っている作業ではないもの）
const QUIET_TOOLS = /^(?:todowrite|toolsearch|mcp__host__|mcp__ply_context__)/;

/** ツール名から実況の種類を決める。名前だけを見る（引数は読まない）。実況しないツールは null */
export function toolKindOf(name) {
  const n = String(name ?? '').toLowerCase();
  if (!n || QUIET_TOOLS.test(n)) return null;
  const known = KIND_BY_NAME.get(n);
  if (known) return known;
  if (n.startsWith('mcp__ply_agents__')) return 'delegate';
  if (n.startsWith('mcp__ply_computer__')) return 'computer';
  return 'other';
}

/**
 * @param {object} o
 * @param {(text: string, kind: 'ack'|'status') => boolean} o.speak  読み上げに出す。出せなければ false（スピーカーのミュート・止めた・閉じた）
 * @param {() => number} o.now
 * @param {{ ack: string[], tool: Record<string, string> }} o.phrases  tool には TOOL_KINDS と still（続けて待っているとき）
 * @param {boolean} [o.ack]  受け取りの一言（設定）
 * @param {boolean} [o.narrate]  待ちの実況（設定）
 * @param {string} [o.language]  'ja' | 'en'（読み上げの長さの見積もり）
 * @param {() => number} [o.random]  最初の一言の選び（以後は順に回す。同じ文が続かない）
 */
export function createWaitVoice({ speak, now, phrases, ack = true, narrate = true, language = 'ja', random = Math.random }) {
  const perChar = MS_PER_CHAR[language] ?? MS_PER_CHAR.ja;
  let running = false;       // 声で送った発言が AI に渡って、そのターンが終わっていない
  let ackDueAt = null;       // 受け取りの一言を言う時刻（言うと決まっていない間は null）
  let quietUntil = 0;        // 鳴っている（と見積もる）音の終わり。無音の数え始め（返事の読み上げ・一言・実況の、見積もりの終わり）
  let narrations = 0, lastNarrationAt = null;
  let tool = null, freshTool = false;   // 今のターンの最後のツールの種類・それをまだ実況していない
  let suppressed = false;    // 止めた（［止める］・話して割り込み）。次の発言が渡るまで言わない
  let hearing = false;       // 利用者が話している・確定を待っている最中
  let lastAck = -1;

  const noteSpeech = (text, t) => { quietUntil = Math.max(quietUntil, t) + Math.min(MAX_SPEECH_MS, Math.round(String(text).length * perChar)); };
  const pickAck = () => {
    const n = phrases.ack.length;
    lastAck = lastAck < 0 ? Math.min(n - 1, Math.floor(random() * n)) : (lastAck + 1) % n;
    return phrases.ack[lastAck];
  };

  return {
    /** 声で送った 1 通が AI に渡った（クライアントの「AI に渡しました」。送信待ち・差し込み待ちのあいだは来ない） */
    handed() {
      const t = now();
      if (!running) { running = true; narrations = 0; lastNarrationAt = null; }
      suppressed = false;
      quietUntil = Math.max(quietUntil, t);
      if (ack && phrases.ack?.length && ackDueAt === null) ackDueAt = t + ACK_AFTER_MS;
    },
    /** 新しい発言が会話に入った（host が見ている会話の userMessage）。話すのを止めた状態は戻す。受け取りの一言の予定は消さない（handed が先に来ることがある） */
    userMessage() { suppressed = false; },
    /** 返事の本文が流れ始めた。読み上げは文が閉じてからなので、その前でも一言は言わない（返事がすぐ来る） */
    textDelta() { ackDueAt = null; },
    /** 返事の 1 文を読み上げに出した */
    replySpoke(text) { ackDueAt = null; noteSpeech(text, now()); },
    /**
     * ツールが動き始めた。種類だけを覚える（引数は渡さない）。発言が渡る前のツールも覚える（渡った合図 handed はツールの開始より遅れることがある。
     * 長いツールの最中に差し込んだときは、ツールのほうが先に動いている）。言うかどうかは handed 以後（running）で決める
     */
    toolStart(name) {
      const kind = toolKindOf(name);
      if (!kind) return;
      tool = kind; freshTool = true;
    },
    turnEnd() { running = false; ackDueAt = null; tool = null; freshTool = false; },
    /** 止めた（割り込み・［止める］）。このターンの残りは言わない */
    halt() { ackDueAt = null; suppressed = true; },
    /** 利用者が話している・確定を待っている（聞き取りの busy）。話している間は言わない */
    setHearing(on) { hearing = Boolean(on); if (hearing) ackDueAt = null; },
    /** 時計を進める */
    tick() {
      const t = now();
      if (ackDueAt !== null && t >= ackDueAt) {
        ackDueAt = null;
        if (running && !suppressed && !hearing) {
          const text = pickAck();
          if (speak(text, 'ack')) noteSpeech(text, t);
        }
        return;
      }
      if (!narrate || !running || suppressed || hearing || tool === null || !phrases.tool) return;
      if (narrations >= NARRATE_MAX) return;
      if (t < quietUntil + NARRATE_QUIET_MS) return;
      if (lastNarrationAt !== null && t - lastNarrationAt < NARRATE_GAP_MS) return;
      // 新しいツールが動いたら、その種類で。変わらず待ち続けているなら「まだ作業しています」（同じ文を繰り返さない）
      const text = freshTool ? phrases.tool[tool] : phrases.tool.still;
      if (!text) return;
      if (speak(text, 'status')) { narrations++; lastNarrationAt = t; freshTool = false; noteSpeech(text, t); }
    },
    /** テスト・診断用 */
    get state() { return { running, ackDueAt, quietUntil, narrations, tool, suppressed }; },
  };
}
