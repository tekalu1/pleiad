// エージェントの返事（text.delta の差分）から、読み上げる文を切り出す（通話モード。docs/voice-call.md「読み上げ」）。
//
// 読むのは返事の本文だけ。コードのブロック・表・長い作業ログは読まず、ブロックの終わりに「コードは画面に出しました」と短く言う（種類ごとに 1 ターンに 1 回）。
// 1 文目が閉じた時点ですぐ出す（返事の全体を待たない）。文の切れ目は 。！？ と、ASCII の .!? のあとに空白か改行が来たとき、改行（段落・箇条書きの 1 項目）。
// 各ブロックの 1 文目だけは、読点（、，,）が来て 8 字を超えていればそこで切る（最初の音を早くする。小さく割りすぎると抑揚が途切れ、短い断片は遅く読まれるので 8 字を下限にする）。
// 切れ目が来ないまま 80 字に届いたら、直近の読点か空白で切る（無ければその場で）。
// 1 ターンに読む量には上限（既定 1500 字）がある。超えた分は読まない。
//
// 行頭で種類を決める（行の始まりが分かれば、その行の途中でも文を出せる）: ``` / ~~~ のフェンス（閉じるまで）・先頭の |（表）・4 字以上の字下げ（コード）・
// 日時・$ ・at ・diff の行頭（ログ）。それ以外は本文。見出しの #・箇条書きの印・引用の > は外す。
// 本文の中の記法は読む前に外す: **強調**・`コード`（30 字を超えるものは読まない）・[文字](URL)→文字・URL・HTML のタグ・絵文字。

const FENCE = /^(```|~~~)/;
const LOG_LINE = /^(?:\d{4}-\d{2}-\d{2}[ T]\d|\[\d{1,2}:\d{2}|\$ |at\s+\S+\s*\(|diff --git|@@ |\+\+\+ |--- [ab]\/|index [0-9a-f]{7}|[A-Z]:\\|\/[\w.-]+\/[\w.-]+\/[\w.-]+)/;
const PROSE_PREFIX = /^(?:\s*(?:[-*+]|\d+[.)])\s+|\s*#{1,6}\s+|\s*>\s?)+/;
const LIST_MARK = /^(?:[-*+]|\d+[.)])\s/;
const CLOSERS = /^[」』）)”’"'\]】〕》〉]+/u;

export const FIRST_MIN_CHARS = 8;
export const SENTENCE_MAX_CHARS = 80;
export const TURN_MAX_CHARS = 1500;

/** 読み上げる 1 文にする（記法を外す）。読むものが無ければ '' */
export function cleanSentence(raw) {
  let s = String(raw ?? '');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                   // 画像
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                // [文字](URL) → 文字
  s = s.replace(/<[^>\n]{1,200}>/g, '');                        // HTML のタグ
  s = s.replace(/https?:\/\/\S+/g, '');                         // URL
  s = s.replace(/`([^`]*)`/g, (_, inner) => (inner.length > 30 ? '' : inner));
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/\p{Extended_Pictographic}️?/gu, '');
  s = s.replace(/\s+/g, ' ').trim().replace(CLOSERS, '').trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : '';
}

/**
 * @param {object} o
 * @param {(sentence: string, info: { first: boolean, skip?: string }) => void} o.say  読む文（skip は「コードは画面に出しました」のような言い添えの種類）
 * @param {{ code: string, table: string, log: string }} o.phrases 言い添えの文（辞書から引いたもの）
 * @param {number} [o.turnMaxChars]
 */
export function createReplyReader({ say, phrases, turnMaxChars = TURN_MAX_CHARS, firstMinChars = FIRST_MIN_CHARS, maxChars = SENTENCE_MAX_CHARS }) {
  let line = '';             // いまの行（改行まで）
  let kind = null;           // null（未決）| 'prose' | 'skip'
  let skipKind = 'code';
  let inFence = false;
  let fenceOpening = false;
  let sent = '';             // 読み上げる文の元（本文だけ）
  let asciiEnd = false;      // 直前が ASCII の . ! ?（次が空白なら文の終わり）
  let first = true;          // このブロックの 1 文目か
  let skipped = new Set();   // このブロックで読まなかった種類
  let announced = new Set(); // このターンに言い添えた種類
  let spoken = 0;            // このターンに読んだ字数

  const closeSentence = () => {
    const text = cleanSentence(sent);
    sent = '';
    asciiEnd = false;
    if (!text) return;
    if (spoken + text.length > turnMaxChars) return;
    spoken += text.length;
    const wasFirst = first;
    first = false;
    say(text, { first: wasFirst });
  };

  const addProse = (ch) => {
    if (asciiEnd && /\s/.test(ch)) { closeSentence(); return; }
    asciiEnd = false;
    sent += ch;
    if ('。！？'.includes(ch)) closeSentence();
    else if ('.!?'.includes(ch)) asciiEnd = true;
    else if (first && '、，,'.includes(ch) && sent.length >= firstMinChars) closeSentence();
    else if (sent.length >= maxChars) {
      let at = -1;
      for (const mark of ['、', '，', ',', ' ']) at = Math.max(at, sent.lastIndexOf(mark));
      if (at >= firstMinChars) { const rest = sent.slice(at + 1); sent = sent.slice(0, at + 1); closeSentence(); sent = rest; }
      else closeSentence();
    }
  };

  /** 行頭の種類を決める。まだ決められなければ何もしない */
  const decide = (atNewline) => {
    if (kind !== null) return;
    const s = line.trimStart();
    if (inFence) { kind = 'skip'; skipKind = 'code'; return; }
    if (s.startsWith('|')) { kind = 'skip'; skipKind = 'table'; return; }
    if (s.length >= 3 && FENCE.test(s)) { kind = 'skip'; skipKind = 'code'; fenceOpening = true; return; }
    if (s.length < 3 && s.startsWith('`') && !atNewline) return;     // ``` の途中かもしれない
    const indented = /^( {4,}|\t)/.test(line);
    if (indented && s.length >= 3 && !LIST_MARK.test(s)) { kind = 'skip'; skipKind = 'code'; return; }
    // 日本語の字で始まる行は本文（ログ・コードの行頭は英数字・記号）。すぐ読み始められる
    if (/^[\u3040-\u30ff\u3400-\u9fff]/.test(s.replace(PROSE_PREFIX, ''))) { kind = 'prose'; for (const ch of s.replace(PROSE_PREFIX, '')) addProse(ch); return; }
    if (s.length < 12 && !atNewline) return;                          // ログの行頭を見分けるには少し要る
    if (/^at\s/.test(s) && !s.includes('(') && s.length < 40 && !atNewline) return;   // スタックのフレーム（at 関数名 (場所)）は括弧まで見ないと本文と見分けられない
    if (LOG_LINE.test(s)) { kind = 'skip'; skipKind = 'log'; return; }
    kind = 'prose';
    for (const ch of s.replace(PROSE_PREFIX, '')) addProse(ch);
  };

  const endLine = () => {
    decide(true);
    if (kind === 'prose') closeSentence();
    else if (kind === 'skip') {
      skipped.add(skipKind);
      if (fenceOpening) { inFence = true; fenceOpening = false; }
      else if (inFence && FENCE.test(line.trimStart())) inFence = false;
    }
    line = '';
    kind = null;
  };

  return {
    /** text.delta の差分を入れる */
    push(delta) {
      for (const ch of String(delta ?? '')) {
        if (ch === '\r') continue;
        if (ch === '\n') { endLine(); continue; }
        line += ch;
        if (kind === null) decide(false);
        else if (kind === 'prose') addProse(ch);
      }
    },
    /** text.end: 残りを読み、読まなかったもの（コード・表・ログ）を言い添える。次の本文は新しいブロック */
    end() {
      if (line) endLine();
      closeSentence();
      for (const k of ['code', 'table', 'log']) {
        if (skipped.has(k) && !announced.has(k)) { announced.add(k); say(phrases[k], { first: false, skip: k }); }
      }
      skipped = new Set();
      inFence = false;
      fenceOpening = false;
      first = true;
    },
    /** 新しいターン（ユーザーの発言）。言い添えと字数の数え直し、読みかけは捨てる */
    reset() {
      line = ''; kind = null; sent = ''; asciiEnd = false; inFence = false; fenceOpening = false;
      first = true; skipped = new Set(); announced = new Set(); spoken = 0;
    },
  };
}

/** 返事の全文から読む文の一覧（テスト・見積もり用） */
export function sentencesOf(text, phrases = { code: 'code', table: 'table', log: 'log' }) {
  const out = [];
  const reader = createReplyReader({ say: (s, info) => out.push({ text: s, ...info }), phrases });
  reader.push(text);
  reader.end();
  return out;
}
