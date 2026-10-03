// 人が書いていないのに user の行として履歴に残る「システム側のメッセージ」の見分けと、表示用の形
// （ADR 0053、docs/design-system.md「システム側のメッセージ」、docs/multi-backend.md「NormalizedMessage」）。
//
// 見分けは行の形・フィールドを優先する。Claude は transcript から拾った印（claude-normalize.mjs の
// transcriptSystemMarks: 要約の uuid・コマンドの行の子の出力の uuid）を marks で渡す。
// 印が無いとき（transcript を読めない・切り替え済みの会話の保存分）は文面で見分ける。文面を使う所には「文面:」と書いてある。
// SDK も DOM も import しない純粋な関数。何度かけても同じ結果になる（kind の付いた発言は触らない）。

// 文面: 圧縮の要約の定型の書き出し（CLI が書く。transcript では isCompactSummary の行）
export const COMPACT_SUMMARY_PREFIX = "This session is being continued from a previous conversation";
// 文面: CLI が中断のときに user として残す固定の文字列
const INTERRUPTS = new Set(["[Request interrupted by user]", "[Request interrupted by user for tool use]"]);
// 文面: agent teams の teammate からの知らせの書き出し
const TEAMMATE_PREFIX = "Another Claude session sent a message:";

// Pleiad が中断の後の最初の発言の前に添える「止めたもの」の文の印（core/interrupt-stops.mjs。docs/design.md「中断と再開」）。
// 発言と同じ user の行に入る（Claude は別の text ブロック、Codex は別の入力、agy は本文の前）ので、履歴で切り分ける
export const INTERRUPTION_TAG = "pleiad-interruption";
const INTERRUPTION = new RegExp(`^\\s*<${INTERRUPTION_TAG}>\\s*([\\s\\S]*?)\\s*</${INTERRUPTION_TAG}>\\s*`);

/** 行の先頭の「止めたもの」の文を `{ body, rest }` にする（body は印の中、rest は続く人の発言）。無ければ null */
export function splitInterruptionNote(text) {
  const m = INTERRUPTION.exec(String(text ?? ""));
  return m ? { body: m[1], rest: String(text).slice(m[0].length) } : null;
}

/**
 * user の行の先頭にある「止めたもの」の文を、システム側の 1 行（kind: interruptionNote）と続く発言に分ける。
 * 発言の uuid（分岐点）は続く発言に残す。続きが空なら文の行に付ける。何度かけても同じ
 */
export function splitInterruptionNotes(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const note = m?.role === "user" && !m.kind && typeof m.text === "string" ? splitInterruptionNote(m.text) : null;
    if (!note) { out.push(m); continue; }
    const rest = (note.rest.trim() || m.attachments?.length) ? { ...m, text: note.rest } : null;
    out.push({ role: "system", kind: "interruptionNote", text: "", body: note.body, at: m.at ?? null,
      ...(rest ? {} : { uuid: m.uuid }), ...(m.backend ? { backend: m.backend } : {}) });
    if (rest) out.push(rest);
  }
  return out;
}

// bot の会話の user の行の先頭に付く包み（docs/design.md「Channels と bot」、ADR 0094・0095）。発言と同じ user の行に入る
// （Claude は別の text ブロック、Codex は別の入力、agy は本文の前）ので、履歴で切り分ける。組み立ては core/channels/types.mjs
export const MEMORY_CORE_TAG = "pleiad-memory-core";       // 会話の始まり・圧縮の後の最初のターンに 1 回だけ付く、核の記憶の写し
export const TURN_CONTEXT_TAG = "pleiad-turn-context";     // 毎ターンの末尾: 時刻・記憶の差分・関係する記憶
export const CHANNEL_THREAD_TAG = "pleiad-channel-thread"; // 初回に渡す、スレッドのそれまでの投稿（中に <pleiad-channel> が並ぶ）
export const CHANNEL_TAG = "pleiad-channel";               // 起こした投稿・途中送信する投稿 1 件
export const ROUTINE_PAYLOAD_TAG = "routine-payload";      // ルーティンの外から来た本文（先頭には付かない。<pleiad-channel> の中身に入る）
const LEADING_TAGS = [INTERRUPTION_TAG, MEMORY_CORE_TAG, TURN_CONTEXT_TAG, CHANNEL_THREAD_TAG, CHANNEL_TAG];
const LEADING = new RegExp(`^\\s*<(${LEADING_TAGS.join("|")})(?=[\\s>])([^>]*)>([\\s\\S]*?)</\\1>\\s*`);
const unescapeAttr = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");
const attrsOf = (text) => Object.fromEntries([...String(text).matchAll(/([\w-]+)="([^"]*)"/g)].map((m) => [m[1], unescapeAttr(m[2])]));

/** 行の先頭の包み 1 つを、システム側の 1 行の形（role: system）にする。包みの種類ごとの kind は splitLeadingNotes の説明 */
function leadingRow(tag, attrText, body, m) {
  const base = { role: "system", text: "", at: m.at ?? null, ...(m.backend ? { backend: m.backend } : {}) };
  if (tag === INTERRUPTION_TAG) return { ...base, kind: "interruptionNote", body };
  if (tag === MEMORY_CORE_TAG || tag === TURN_CONTEXT_TAG) return { ...base, kind: "contextNote", tag: tag === MEMORY_CORE_TAG ? "memory-core" : "turn-context", body };
  const a = attrsOf(attrText);
  return { ...base, kind: "channelEvent", history: tag === CHANNEL_THREAD_TAG, channel: a.channel ?? "", threadId: a.thread ?? null,
    postId: a.post ?? null, from: a.from ?? "", sentAt: a.at ?? null, body };
}

/**
 * user の行の先頭に並ぶ Pleiad の包みを、1 つずつシステム側の 1 行と、続く発言に分ける（splitInterruptionNotes を一般にしたもの）。
 *   - `<pleiad-interruption>` … `{ kind: 'interruptionNote', body }`
 *   - `<pleiad-memory-core>`・`<pleiad-turn-context>` … `{ kind: 'contextNote', tag: 'memory-core' | 'turn-context', body }`
 *   - `<pleiad-channel-thread …>`・`<pleiad-channel …>` … `{ kind: 'channelEvent', history, channel, threadId, postId, from, sentAt, body }`
 * 発言の uuid（分岐点）は続く発言に残す。続きが空なら最後の行に付ける。bot の会話では、包みだけの行は人の吹き出しにならない（ADR 0053）。何度かけても同じ
 */
export function splitLeadingNotes(messages) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m?.role !== "user" || m.kind || typeof m.text !== "string") { out.push(m); continue; }
    const rows = [];
    let rest = m.text;
    for (let hit; (hit = LEADING.exec(rest));) {
      rows.push(leadingRow(hit[1], hit[2], hit[3].trim(), m));
      rest = rest.slice(hit[0].length);
    }
    if (!rows.length) { out.push(m); continue; }
    const keep = Boolean(rest.trim() || m.attachments?.length);
    if (!keep) rows[rows.length - 1].uuid = m.uuid;
    out.push(...rows);
    if (keep) out.push({ ...m, text: rest });
  }
  return out;
}

const head = (text) => String(text ?? "").trimStart();
const startsWithAny = (text, tags) => { const s = head(text); return tags.some((tag) => s.startsWith(tag)); };
// ANSI の色の指定（/model の出力などに入る）は画面では字化けになるので外す
const plain = (s) => String(s ?? "").replace(/\u001b\[[0-9;]*m/g, "").replace(/\r\n/g, "\n");

function tagBody(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? plain(m[1]) : null;
}

const COMMAND_TAGS = ["<command-name>", "<command-message>"];
const COMMAND_OUTPUT_TAGS = ["<local-command-stdout>", "<local-command-stderr>"];
const SHELL_INPUT_TAGS = ["<bash-input>"];
const SHELL_OUTPUT_TAGS = ["<bash-stdout>", "<bash-stderr>"];

/** 文面: 行の先頭が `<command-name>`／`<command-message>` のスラッシュコマンドの行を `{ name, args }` にする */
export function parseCommand(text) {
  if (!startsWithAny(text, COMMAND_TAGS)) return null;
  const message = tagBody(text, "command-message")?.trim();
  let name = tagBody(text, "command-name")?.trim() || (message ? `/${message}` : "");
  if (name && !name.startsWith("/")) name = `/${name}`;
  const args = tagBody(text, "command-args")?.trim() ?? "";
  return name ? { name, args } : null;
}

/** 文面: `<local-command-stdout>`／`-stderr` の出力。空は null */
function commandOutput(text) {
  const out = [tagBody(text, "local-command-stdout"), tagBody(text, "local-command-stderr")]
    .map((s) => s?.replace(/\s+$/, "")).filter(Boolean).join("\n");
  return out || null;
}

/** 文面: `!` モードの出力の行（`<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>`。どちらも空のことがある） */
function shellOutput(text) {
  const clean = (s) => { const v = s?.replace(/\s+$/, ""); return v ? v : null; };
  return { stdout: clean(tagBody(text, "bash-stdout")), stderr: clean(tagBody(text, "bash-stderr")) };
}

/**
 * 文面: 人の発言の先頭に付く文脈のタグを外す。
 * - Claude（VS Code）の `<ide_opened_file>`・`<ide_selection>`。transcript では別の text ブロックなので
 *   claude-normalize.mjs の extract がブロックごと外す。ここは保存分（ブロックをつないだ後の本文）のため
 * - Codex Desktop の `<in-app-browser-context …>`。人の本文と同じ text 要素の先頭に付く
 */
export function stripInjectedContext(text) {
  let s = String(text ?? "");
  for (;;) {
    const m = /^\s*<(ide_opened_file|ide_selection|in-app-browser-context)\b[^>]*>[\s\S]*?<\/\1>/.exec(s);
    if (!m) return s === text ? s : s.replace(/^\s+/, "");
    s = s.slice(m[0].length);
  }
}

/**
 * 文面: teammate の知らせを `{ from, body }` にする。待機の知らせ（idle_notification）だけなら null。
 * 1 行に複数の `<teammate-message>` があれば、待機の知らせ以外をつなぐ
 */
export function parseTeammate(text) {
  const s = head(text);
  if (!(s.startsWith(TEAMMATE_PREFIX) || s.startsWith("<teammate-message")) || !s.includes("<teammate-message")) return undefined;
  const from = [];
  const bodies = [];
  for (const m of s.matchAll(/<teammate-message\b([^>]*)>([\s\S]*?)<\/teammate-message>/g)) {
    const body = m[2].trim();
    let idle = false;
    try { idle = JSON.parse(body)?.type === "idle_notification"; } catch { /* 文の知らせ */ }
    if (idle) continue;
    const id = /\bteammate_id="([^"]*)"/.exec(m[1])?.[1];
    if (id && !from.includes(id)) from.push(id);
    bodies.push(body);
  }
  return bodies.length ? { from: from.join(", "), body: bodies.join("\n\n") } : null;
}

/**
 * 発言の並び（NormalizedMessage[]）から、システム側のメッセージを落とす・表示用の形に置き換える。
 *
 * 置き換えた形（どれも kind を持つ。docs/multi-backend.md「NormalizedMessage」）:
 * - `{ role:'user', kind:'command', text, command, output }` … スラッシュコマンドとその出力
 * - `{ role:'user', kind:'shell', text, command, stdout, stderr }` … `!` モードの入力と出力
 * - `{ role:'system', kind:'compactSummary', text:'', summary, boundary }` … 圧縮の要約（区切りに入れる。core/compaction-history.mjs）
 * - `{ role:'system', kind:'interrupt', text:'' }` … 中断
 * - `{ role:'system', kind:'teammate', text:'', from, body }` … agent teams の teammate の知らせ
 * - `{ role:'system', kind:'interruptionNote', text:'', body }` … 中断で止めたものを Pleiad が伝えた文（splitInterruptionNotes）
 * - `{ role:'system', kind:'contextNote' | 'channelEvent', text:'', … }` … bot の会話の先頭の包み（記憶・チャンネルの出来事。splitLeadingNotes）
 * 落とすもの: Pleiad の `/compact` の行とその出力、待機だけの teammate の知らせ、裏の作業の完了通知、文脈だけの発言。
 * コマンド・シェルの出力は入力の行へまとめ、uuid は出力の行のものにする（分岐点。SDK は追記した行より前で分岐できない）。
 *
 * @param messages バックエンドが返した発言
 * @param marks transcript から拾った印。無ければ文面で見分ける
 *   - summaries: Map<要約の uuid, 区切りの uuid | null>
 *   - outputs: Map<出力の行の uuid, 親（コマンド・シェルの行）の uuid>
 */
export function classifySystemMessages(messages, marks = null) {
  const summaries = marks?.summaries ?? null;
  const outputs = marks?.outputs ?? null;
  const out = [];
  // 直前のコマンド・シェルの行。続く出力の行を受け取る。raw は元の行の uuid（印の親と照らす）
  let owner = null;
  for (const m of splitLeadingNotes(messages)) {
    if (!m || m.role !== "user" || m.kind || m.internalTaskNotice || typeof m.text !== "string") {
      out.push(m); owner = null; continue;
    }
    const text = m.text;
    // 出力の行。印があれば親で、無ければ直前の行（文面: 行の先頭のタグ）でコマンド・シェルの行にまとめる
    const isCommandOutput = startsWithAny(text, COMMAND_OUTPUT_TAGS);
    const isShellOutput = startsWithAny(text, SHELL_OUTPUT_TAGS);
    if (isCommandOutput || isShellOutput) {
      const linked = owner && (outputs?.has(m.uuid) ? outputs.get(m.uuid) === owner.raw : true)
        && (isShellOutput ? owner.kind === "shell" : owner.kind !== "shell");
      if (linked) {
        owner.lastUuid = m.uuid;
        if (owner.drop) continue;
        const target = owner.message;
        if (isShellOutput) Object.assign(target, shellOutput(text));
        else target.output = [target.output, commandOutput(text)].filter(Boolean).join("\n") || null;
        if (m.uuid) target.uuid = m.uuid;
        continue;
      }
      owner = null;
      // 文面: 親の分からない Pleiad の /compact の出力（"Compacted …"）
      if (isCommandOutput && /^\s*<local-command-stdout>\s*Compacted\b/.test(text)) continue;
      if (isShellOutput) out.push({ ...m, kind: "shell", text: "", command: "", ...shellOutput(text) });
      else out.push({ ...m, kind: "command", text: "", command: "", output: commandOutput(text) });
      continue;
    }
    owner = null;

    // 圧縮の要約。印があれば印だけで見る（人が要約を貼った発言を取り違えない）
    if (summaries ? summaries.has(m.uuid) : head(text).startsWith(COMPACT_SUMMARY_PREFIX)) {
      out.push({ role: "system", kind: "compactSummary", text: "", summary: text.trim(), boundary: summaries?.get(m.uuid) ?? null,
        uuid: m.uuid, at: m.at ?? null, ...(m.backend ? { backend: m.backend } : {}) });
      continue;
    }

    const command = parseCommand(text);
    if (command) {
      const shown = command.args ? `${command.name} ${command.args}` : command.name;
      // Pleiad の手動圧縮が残す /compact の行。圧縮の区切りが代わりに出る
      if (command.name === "/compact") { owner = { kind: "command", raw: m.uuid, drop: true }; continue; }
      const message = { ...m, kind: "command", text: shown, command: shown, output: null };
      out.push(message);
      owner = { kind: "command", raw: m.uuid, message };
      continue;
    }
    if (startsWithAny(text, SHELL_INPUT_TAGS)) {
      // CLI の `!` は入力と出力が別々の行。Claude の SDK は、次の発言の前に積んだ shouldQuery: false の行（Pleiad の `!`）を
      // `\n` でつないで 1 行に残す（入力と出力の組が並ぶ）。組ごとに 1 行にする。uuid は最後の組だけに付ける
      // （前の組で分岐すると後の組まで入るため）
      const segments = [];
      const seg = /<bash-input>([\s\S]*?)<\/bash-input>\s*(?:<bash-stdout>[\s\S]*?<\/bash-stdout>)?\s*(?:<bash-stderr>[\s\S]*?<\/bash-stderr>)?\s*/y;
      seg.lastIndex = text.length - head(text).length;
      for (let hit; seg.lastIndex < text.length && (hit = seg.exec(text));) segments.push(hit);
      if (!segments.length) segments.push([text, tagBody(text, "bash-input") ?? ""]);
      let message = null;
      segments.forEach((hit, i) => {
        const command = plain(hit[1]).trim();
        const output = hit[0].includes("<bash-stdout>") || hit[0].includes("<bash-stderr>");
        const last = i === segments.length - 1;
        const { uuid: _uuid, ...rest } = m;
        message = { ...(last ? m : rest), kind: "shell", text: `! ${command}`, command, ...(output ? shellOutput(hit[0]) : { stdout: null, stderr: null }) };
        out.push(message);
      });
      // 出力を持たない入力の行（CLI の形）だけが、続く出力の行を受け取る
      const tail = segments[segments.length - 1][0];
      owner = tail.includes("<bash-stdout>") || tail.includes("<bash-stderr>") ? null : { kind: "shell", raw: m.uuid, message };
      continue;
    }
    if (INTERRUPTS.has(text.trim())) {
      out.push({ role: "system", kind: "interrupt", text: "", uuid: m.uuid, at: m.at ?? null, ...(m.backend ? { backend: m.backend } : {}) });
      continue;
    }
    const teammate = parseTeammate(text);
    if (teammate !== undefined) {
      if (teammate) out.push({ role: "system", kind: "teammate", text: "", ...teammate, uuid: m.uuid, at: m.at ?? null, ...(m.backend ? { backend: m.backend } : {}) });
      continue;
    }
    // 文面: 裏の作業の完了通知（claude-normalize.mjs の extract と同じ。保存分に残っている分）
    if (head(text).startsWith("<task-notification>")) continue;
    const stripped = stripInjectedContext(text);
    if (stripped !== text) {
      if (stripped.trim()) out.push({ ...m, text: stripped });
      continue;
    }
    out.push(m);
  }
  return out;
}
