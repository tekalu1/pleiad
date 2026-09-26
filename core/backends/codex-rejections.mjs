// Codex が実行前に拒否したコマンドを、rollout（Codex がディスクに残す会話の記録。jsonl）から拾う。
//
// Codex 0.156.1 は承認なしのモード（approvalPolicy never）でも、組み込みの危険コマンドの判定で一部のコマンドを
// プロセスを作る前に `blocked by policy` などで拒否する。拒否はアイテム（item/*）にならず、thread/read にも残らない。
// 残るのは rollout の response_item（ツールの出力）だけなので、ターンの後にこのターンの分を読んで拾う
// （docs/multi-backend.md「Codex の実行前の拒否」、ADR 0028）。
//
// 拾うのは出力の先頭（exec_command を直接呼んだとき）か `Script error:\n` の直後（code mode の exec・wait）にある
// `exec_command failed: CreateProcess { message: "…" }` だけ。出力の途中に引用されただけの同じ文（issue の本文を読んだ結果など）は拾わない。
// 形は Codex の Rust の Debug 表示で、公開の約束ではない。形が違えば拾わない（黙って空を返す）。
import fs from 'node:fs/promises';
import path from 'node:path';

const HEAD = 'exec_command failed: CreateProcess { message: "';
const FAILED = /^exec_command failed: CreateProcess \{ message: "((?:[^"\\]|\\.)*)" \}/;
const SCRIPT_ERROR = 'Script error:\n';
const REJECTED = /^Rejected\("((?:[^"\\]|\\.)*)"\)$/;
const POLICY_SEP = '` rejected: ';
const SPAWN = /^Failed to create unified exec process: ([\s\S]*)$/;

/** Rust の Debug 形式の文字列（"…" の中身）を戻す */
export function decodeRustDebug(s) {
  return s.replace(/\\(u\{([0-9a-fA-F]+)\}|.)/g, (_, e, hex) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'" }[e] ?? e;
  });
}

/** POSIX sh の語分け（Codex がコマンドを描くときの shlex の逆）。戻せなければ null */
export function shlexSplit(s) {
  const out = [];
  let cur = null, i = 0;
  const push = () => { if (cur !== null) out.push(cur); cur = null; };
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n') { push(); i++; continue; }
    cur ??= '';
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return null;
      cur += s.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && '"\\$`\n'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; } else { cur += s[i]; i++; }
      }
      if (s[i] !== '"') return null;
      i++; continue;
    }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    cur += c; i++;
  }
  push();
  return out;
}

/**
 * ツールの出力 1 つ（文字列）から、実行前の拒否を 1 件取り出す。無ければ null。
 *   { kind: 'policy', command, shell, reason, raw }  ポリシーの拒否（`<描いたコマンド>` rejected: <理由>）
 *   { kind: 'spawn', command: null, shell: null, reason, raw }  プロセス作成の失敗（同じ形に包まれて来る）
 *   { kind: 'other', command: null, shell: null, reason: null, raw }  どちらでもない
 * raw は Codex の生の文（`exec_command failed: …` の 1 件分）。afterScriptError は code mode の形だったか
 */
export function parseRejection(text) {
  if (typeof text !== 'string') return null;
  let at = -1;
  if (text.startsWith(HEAD)) at = 0;
  else {
    // code mode は「Script error:\n」の直後に置く。途中の引用（前に別の文がある）は拾わない
    const k = text.indexOf(SCRIPT_ERROR + HEAD);
    if (k >= 0 && (k === 0 || text[k - 1] === '\n')) at = k + SCRIPT_ERROR.length;
  }
  if (at < 0) return null;
  const m = FAILED.exec(text.slice(at));
  if (!m) return null;
  const raw = m[0];
  const afterScriptError = at > 0;
  const outer = decodeRustDebug(m[1]);
  const r = REJECTED.exec(outer);
  if (!r) return { kind: 'other', command: null, shell: null, reason: null, raw, afterScriptError };
  const msg = decodeRustDebug(r[1]);
  if (msg.startsWith('`')) {
    // PowerShell の命令にも ` が入るので、最後の「` rejected: 」で切る
    const k = msg.lastIndexOf(POLICY_SEP);
    if (k > 0) {
      const rendered = msg.slice(1, k);
      const reason = msg.slice(k + POLICY_SEP.length);
      const argv = shlexSplit(rendered);
      const shell = argv?.[0] ? path.win32.basename(argv[0]) : null;
      // [shell, -Command|-c, script] に戻せれば script を、戻せなければ描いた文字列をそのまま
      const script = argv && argv.length === 3 && /^-(?:Command|c|lc)$/i.test(argv[1]) ? argv[2] : null;
      return { kind: 'policy', command: script ?? rendered, shell, reason, raw, afterScriptError };
    }
  }
  const spawn = SPAWN.exec(msg);
  if (spawn) return { kind: 'spawn', command: null, shell: null, reason: spawn[1], raw, afterScriptError };
  return { kind: 'other', command: null, shell: null, reason: null, raw, afterScriptError };
}

const CALLS = new Set(['function_call', 'custom_tool_call']);
const OUTPUTS = new Set(['function_call_output', 'custom_tool_call_output']);

/** 出力の文字列の並び。custom_tool_call_output は output[] の各 text、function_call_output は output（文字列か同じ配列） */
function outputTexts(output) {
  if (typeof output === 'string') return [output];
  if (Array.isArray(output)) return output.map(x => (typeof x?.text === 'string' ? x.text : '')).filter(Boolean);
  if (typeof output?.content === 'string') return [output.content];
  return [];
}

/** 直接の exec_command の引数から、Codex が描いたものより元に近いコマンドを取る（読めなければ null） */
function directArgs(call) {
  if (call?.type !== 'function_call' || call.name !== 'exec_command') return null;
  try {
    const args = JSON.parse(call.arguments ?? '');
    return { cmd: typeof args?.cmd === 'string' ? args.cmd : null, shell: typeof args?.shell === 'string' ? args.shell : null };
  } catch { return null; }
}

/**
 * rollout の行（完全な行だけ）から、指定のターンの拒否を取り出す。
 * 戻り値: { rejections: [{ tool, via, command, shell, kind, reason, raw, callId, turnId }], complete, pending }
 *   complete: このターンの終わり（event_msg の task_complete / turn_aborted）の行まで書かれていたか
 *   pending: 呼び出しの行はあるのに出力の行がまだ無い数（書き込みが追いついていない）
 * turnId が無ければターンで絞らない。読めない行・知らない形の行は飛ばす
 */
export function rejectionsFromRollout(lines, turnId) {
  const calls = new Map();
  const answered = new Set();
  const rejections = [];
  const seen = new Set();
  let complete = false;
  for (const line of lines) {
    if (!line || (!line.includes('"response_item"') && !line.includes('"event_msg"'))) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const p = o?.payload;
    if (!p || typeof p !== 'object') continue;
    if (o.type === 'event_msg') {
      if ((p.type === 'task_complete' || p.type === 'turn_aborted') && (!turnId || p.turn_id === turnId)) complete = true;
      continue;
    }
    if (o.type !== 'response_item') continue;
    const turn = p.internal_chat_message_metadata_passthrough?.turn_id ?? null;
    if (turnId && turn !== turnId) continue;
    if (CALLS.has(p.type)) {
      if (typeof p.call_id === 'string') calls.set(p.call_id, { type: p.type, name: p.name, arguments: p.arguments });
      continue;
    }
    if (!OUTPUTS.has(p.type)) continue;
    answered.add(p.call_id);
    const call = calls.get(p.call_id) ?? null;
    for (const text of outputTexts(p.output)) {
      if (!text.includes(HEAD)) continue;
      const got = parseRejection(text);
      if (!got) continue;
      const key = `${p.call_id} ${got.raw}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // code mode（custom tool の exec と、その続きを待つ wait）か、exec_command を直接呼んだか
      const via = p.type === 'custom_tool_call_output' || call?.type === 'custom_tool_call' || (call?.name && call.name !== 'exec_command') || (!call && got.afterScriptError)
        ? 'code_mode' : 'direct';
      const direct = via === 'direct' ? directArgs(call) : null;
      rejections.push({
        tool: 'exec_command', via,
        command: got.command ?? direct?.cmd ?? null,
        shell: got.shell ?? (direct?.shell ? path.win32.basename(direct.shell) : null),
        kind: got.kind, reason: got.reason, raw: got.raw,
        callId: typeof p.call_id === 'string' ? p.call_id : null, turnId: turn,
      });
    }
  }
  const pending = [...calls.keys()].filter(id => !answered.has(id)).length;
  return { rejections, complete, pending };
}

// ---------------------------------------------------------------- ファイルを読む

// 1 ターンで読む上限。これを超えたら末尾のこの分だけ読む（拒否はターンの途中にもあるので、取りこぼしはありうる）
const MAX_BYTES = 64 * 1024 * 1024;
// 呼び出しの出力がまだ書かれていないときに待つ間隔（ms）。Codex は rollout を別の書き手で追記するので、
// turn/completed の時点で末尾の数行が遅れることがある（上流の保証は無い）。合わせて 0.75 秒で諦める
const WAITS = [50, 100, 200, 400];

/** thread/start・thread/resume の応答の thread.path（[UNSTABLE]）。rollout の絶対パスでなければ null */
export function rolloutPathOf(res) {
  const p = res?.thread?.path;
  return typeof p === 'string' && path.isAbsolute(p) ? p : null;
}

/** turn/start の直前のファイルの長さ（ここから後がこのターンの分）。まだ無ければ 0、読めなければ null */
export async function rolloutSize(file) {
  if (!file) return null;
  try { return (await fs.stat(file)).size; } catch (e) { return e?.code === 'ENOENT' ? 0 : null; }
}

/** from から末尾までの完全な行（最後の改行より後は書きかけなので捨てる） */
async function linesFrom(file, from) {
  const fh = await fs.open(file, 'r');
  try {
    const { size } = await fh.stat();
    // 短くなっていたら（作り直された）頭から。ターンの id で絞るので、前のターンの分は混ざらない
    let start = size < from ? 0 : from;
    const clipped = size - start > MAX_BYTES;
    if (clipped) start = size - MAX_BYTES;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const text = buf.subarray(0, got).toString('utf8');
    const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
    // 途中から読み始めた最初の行は欠けている
    return clipped ? lines.slice(1) : lines;
  } finally { await fh.close(); }
}

/**
 * このターンの拒否を rollout から読む。出力の行がまだ書かれていなければ少し待って読み直す。
 * 読めない・形が違うときは黙って [] を返す（ターンの結果は変えない。Codex の版で形が変わっても壊れない）
 */
export async function readTurnRejections({ file, from, turnId, waits = WAITS }) {
  if (!file || !Number.isFinite(from) || !turnId) return [];
  try {
    for (let i = 0; ; i++) {
      const got = rejectionsFromRollout(await linesFrom(file, from), turnId);
      if (got.complete || !got.pending || i >= waits.length) return got.rejections;
      await new Promise(resolve => setTimeout(resolve, waits[i]));
    }
  } catch { return []; }
}
