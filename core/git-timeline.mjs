// 会話に流れたコマンドの結果から、git でしたことを拾う（ブランチの作成・コミット・PR の作成。docs/design.md「git の動き」、ADR 0085）。
// 純関数だけ。エージェントの種類には依らず、ツールの入力の command（Claude の Bash・PowerShell、Codex の commandExecution）か
// CommandLine（Antigravity の run_command）と、結果の本文だけを見る。構造化されていないので文字列の読み取りになる:
//   git checkout -b <名前> / git switch -c <名前>    → ブランチの作成（コマンドの引数から）
//   git commit …の結果の「[ブランチ hash] 件名」     → コミット
//   gh pr create の結果の URL（…/pull/<番号>）       → PR の作成
// 失敗した呼び出し・結果の無い呼び出しは拾わない。拾えなかったものは出さない（推測で作らない）。

const COMMIT_LINE = /^\[(?<branch>[^\]\s]+)(?: \(root-commit\))? (?<hash>[0-9a-f]{7,40})\] (?<subject>.*)$/gm;
const PR_URL = /https?:\/\/[^\s)>"'\]]+\/pull\/(?<number>\d+)/;
const SEPARATORS = new Set(['&&', '||', ';', '|', '&']);

/** コマンドを語に分ける（引用符の中・\ の後は区切らない）。連結の記号（&& || ; | 改行）は独立した語にする */
export function shellWords(command) {
  const words = [];
  let word = '', quote = null, has = false;
  const push = () => { if (has) words.push(word); word = ''; has = false; };
  const text = String(command ?? '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) { word += text[++i]; }
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue; }
    if (c === '`' && i + 1 < text.length) { word += text[++i]; has = true; continue; }
    if (c === '\\' && i + 1 < text.length && !/\s/.test(text[i + 1])) { word += text[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (c === '\n') { push(); words.push(';'); } else push(); continue; }
    if (c === '&' || c === '|' || c === ';') {
      push();
      const two = text.slice(i, i + 2);
      if (two === '&&' || two === '||') { words.push(two); i++; } else words.push(c);
      continue;
    }
    word += c; has = true;
  }
  push();
  return words;
}

/** 語の列を連結の記号で区切った節の配列にする */
function segments(words) {
  const out = [[]];
  for (const w of words) { if (SEPARATORS.has(w)) out.push([]); else out.at(-1).push(w); }
  return out.filter((s) => s.length);
}

const isGit = (w) => /(^|[\\/])git(\.exe)?$/i.test(w ?? '');
const isGh = (w) => /(^|[\\/])gh(\.exe)?$/i.test(w ?? '');

/** git の節からサブコマンドとその引数を取り出す（-C <dir>・-c <k=v>・--no-pager などの前置きを飛ばす） */
function gitSub(words) {
  let i = 1;
  while (i < words.length) {
    const w = words[i];
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') { i += 2; continue; }
    if (w.startsWith('-')) { i++; continue; }
    return { sub: w, args: words.slice(i + 1) };
  }
  return null;
}

/** ブランチを作る呼び出しなら、その名前（checkout -b/-B・switch -c/-C/--create）。違えば null */
function createdBranch({ sub, args }) {
  const flags = sub === 'checkout' ? ['-b', '-B'] : sub === 'switch' ? ['-c', '-C', '--create', '--force-create'] : null;
  if (!flags) return null;
  const at = args.findIndex((a) => flags.includes(a));
  if (at < 0) return null;
  const name = args[at + 1];
  return name && !name.startsWith('-') ? name : null;
}

/** 結果の本文の先頭の「exit=N」（Codex）が 0 以外か */
const exitedWithError = (text) => { const m = /^exit=(\d+)/.exec(String(text ?? '')); return Boolean(m && Number(m[1]) !== 0); };

/**
 * 1 回のコマンドの呼び出しから、git でしたことを順に取り出す。
 * @param {{ command: string, text?: string, isError?: boolean }} call
 * @returns {Array<{ kind: 'branch', branch: string } | { kind: 'commit', branch: string, hash: string, subject: string } | { kind: 'pr', number: number, url: string }>}
 */
export function eventsFromCall({ command, text = '', isError = false } = {}) {
  if (isError || exitedWithError(text) || typeof command !== 'string' || !command) return [];
  const events = [];
  const output = String(text ?? '');
  let committed = false;
  for (const words of segments(shellWords(command))) {
    if (isGit(words[0])) {
      const call = gitSub(words);
      if (!call) continue;
      const branch = createdBranch(call);
      if (branch) events.push({ kind: 'branch', branch });
      else if (call.sub === 'commit' && !committed) {
        committed = true;
        for (const m of output.matchAll(COMMIT_LINE)) events.push({ kind: 'commit', branch: m.groups.branch, hash: m.groups.hash.slice(0, 7), subject: m.groups.subject.trim() });
      }
    } else if (isGh(words[0]) && words[1] === 'pr' && words[2] === 'create') {
      const m = PR_URL.exec(output);
      if (m) events.push({ kind: 'pr', number: Number(m.groups.number), url: m[0] });
    }
  }
  return events;
}

/** ツールの入力から実行したコマンドの文字列を取り出す（無ければ null）。Claude・Codex は command、Antigravity は CommandLine */
export function commandOf(input) {
  if (!input || typeof input !== 'object') return null;
  const v = input.command ?? input.CommandLine ?? input.cmd;
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.join(' ');
  return null;
}

/**
 * 会話の履歴（NormalizedMessage の配列。toolCalls: [{ id, name, input, result: { text, isError } | null }]）から時刻順の一覧を作る。
 * @returns {Array<{ kind, at: string|null, uuid: string|null, toolId: string|null }>} 各要素に eventsFromCall の項目が入る
 */
export function timelineOf(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const command = commandOf(call?.input);
      if (!command || !call.result) continue;
      for (const event of eventsFromCall({ command, text: call.result.text ?? '', isError: Boolean(call.result.isError) }))
        out.push({ ...event, at: message.at ?? null, uuid: message.uuid ?? null, toolId: call.id ?? null });
    }
  }
  return out;
}

/**
 * ターンの間に流れた tool.start / tool.result から、git でしたことを集める（ターンの終わりの要約に使う）。
 * track(event) を全イベントに通し、events() で今までの分を返す
 */
export function createCallTracker() {
  const commands = new Map();
  const events = [];
  return {
    track(event) {
      if (event?.type === 'tool.start' && event.id) {
        const command = commandOf(event.input);
        if (command) commands.set(event.id, command);
      } else if (event?.type === 'tool.result' && event.id && commands.has(event.id)) {
        const command = commands.get(event.id);
        commands.delete(event.id);
        events.push(...eventsFromCall({ command, text: event.text ?? '', isError: Boolean(event.isError) }));
      }
    },
    events: () => [...events],
  };
}
