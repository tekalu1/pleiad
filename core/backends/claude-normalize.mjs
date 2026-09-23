// Claude Agent SDK のメッセージ形 -> 正規化イベント / NormalizedMessage への変換。
//
// **SDK を import しない**。ここは純粋な関数だけを置く。
// 理由が2つある:
//   1. 「Anthropic の API ストリーム型を知っているのはここだけ」という境界を目に見える形にする。
//      claude.mjs は query() を回すだけ、web は正規化イベントしか知らない。
//   2. LLM もサーバも要らない unit テスト（tests/unit/claude-normalize.mjs）から直接呼べる。
//      既存の unit テストは「core/ を読み込まない」ことで SDK を避けていたので、
//      SDK を引き込むとその方針を壊す。
//
// 正規化イベントの一覧は docs/multi-backend.md §2.2。
import { MAX_RESULT_CHARS } from "./shared.mjs";

/** tool_result の content は string か [{type:"text"}] で来る。文字列に均す */
export function resultText(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(resultText).filter(Boolean).join("\n");
  if (c && typeof c === "object" && typeof c.text === "string") return c.text;
  return "";
}

/**
 * SDK メッセージ1件 -> 正規化イベントの配列（0件以上）。
 *
 * `session` イベントはここでは作らない。session_id の追跡は runTurn 側の仕事
 * （1ターンに1回でよく、メッセージ単位の変換とは粒度が違う）。
 *
 * ライブのツール結果は切らない。履歴（transcriptToMessages）は表示に要らない分を
 * 保存の時点で切るが、ライブは v1 が生の SDK メッセージを素通ししていたので、
 * 同じ見た目を保つためにそのまま流す。
 */
export function normalizeSdkMessage(m) {
  const out = [];
  if (!m || typeof m !== "object") return out;

  // ---- サブエージェント側のメッセージ（parent_tool_use_id 付き）は本流に出さない。
  // SDK は子の発言とツール結果も本流と同じ流れで渡してくる。ここで落とさないと、子の Bash や Read の
  // カードが main の会話に積まれ、履歴（transcriptToMessages は落とす）を読み直すと消える。
  // 子の中身は「サブエージェント N」の画面（listSubagents / getSubagentMessages）で見る
  if ((m.type === "assistant" || m.type === "user" || m.type === "stream_event") && m.parent_tool_use_id) return out;

  // ---- 部分メッセージ（includePartialMessages: true でだけ来る）
  if (m.type === "stream_event") {
    const ev = m.event;
    const d = ev?.delta;

    if (ev?.type === "content_block_start" && ev.content_block?.type === "thinking") {
      out.push({ type: "thinking.start" });
      out.push({ type: "activity", state: "thinking" });
      return out;
    }

    if (d?.type === "thinking_delta") {
      // このモデルの thinking ブロックは署名だけで平文が入らない（2026-08 時点）。
      // 中身が来たときだけ text を載せ、来ないときは estimatedTokens だけが手がかりになる。
      const e = { type: "thinking.delta" };
      if (typeof d.thinking === "string" && d.thinking) e.text = d.thinking;
      if (typeof d.estimated_tokens === "number") e.estimatedTokens = d.estimated_tokens;
      out.push(e);
      return out;
    }

    if (d?.type === "text_delta" && typeof d.text === "string") {
      out.push({ type: "text.delta", text: d.text });
    }
    return out;
  }

  // ---- 確定した assistant メッセージ。ここで本文の追記は終わる
  if (m.type === "assistant") {
    // 確定した発言の id。走っている最中でも「ここから分岐」の起点にできる
    out.push({ type: "text.end", ...(m.uuid ? { uuid: String(m.uuid) } : {}) });
    for (const b of m.message?.content ?? []) {
      if (b?.type !== "tool_use" || !b.name) continue;
      out.push({
        type: "tool.start",
        id: b.id ? String(b.id) : null,
        name: String(b.name),
        input: b.input && typeof b.input === "object" ? b.input : {},
      });
    }
    return out;
  }

  // ---- ツールの戻り。user メッセージに tool_result として乗ってくる
  if (m.type === "user") {
    for (const b of m.message?.content ?? []) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      out.push({
        type: "tool.result",
        id: String(b.tool_use_id),
        text: resultText(b.content),
        isError: Boolean(b.is_error),
        truncated: false,
      });
    }
    return out;
  }

  // ---- CLI が出す権威ある稼働状態。推測より、こちらを優先する
  if (m.type === "system" && m.subtype === "status") {
    if (m.status === "compacting") out.push({ type: "activity", state: "compacting" });
    else if (m.status === "requesting") out.push({ type: "activity", state: "thinking" });
    return out;
  }

  if (m.type === "system" && m.subtype === "session_state_changed") {
    if (m.state === "requires_action") out.push({ type: "activity", state: "waiting" });
    else if (m.state === "running") out.push({ type: "activity", state: "running" });
    return out;
  }

  if (m.type === "result") {
    const models = Object.values(m.modelUsage ?? {});
    if (models.length) {
      const sum = key => models.reduce((n, u) => n + (Number.isFinite(u[key]) ? u[key] : 0), 0);
      out.push({ type: 'usage', inputTokens: sum('inputTokens') + sum('cacheReadInputTokens') + sum('cacheCreationInputTokens'),
        outputTokens: sum('outputTokens'), cachedTokens: sum('cacheReadInputTokens'),
        costUsd: Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null });
    } else if (Number.isFinite(m.total_cost_usd)) out.push({ type: 'usage', costUsd: m.total_cost_usd });
    const ok = m.subtype === "success";
    out.push({
      type: "turnResult",
      outcome: ok ? "ok" : "error",
      turns: m.num_turns ?? null,
      costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : null,
      ...(ok ? {} : { error: String(m.subtype ?? "error") }),
    });
  }

  return out;
}

// ------------------------------------------------------------------ 履歴

/**
 * assistant / user のエントリから表示に必要な最小形だけを取り出す。
 * 実際の JSONL では content は次の形になる（実データで確認済み）:
 *   user      … string（CLI 由来の発言）
 *                / [{type:"text"}]（SDK 由来の発言。CLI 側では出ない形）
 *                / [{type:"tool_result"}]（ツールの戻り。発言ではない）
 *   assistant … [{type:"text"}] / [{type:"thinking"}] / [{type:"tool_use"}]
 * 1つの API メッセージがブロックごとに別エントリへ分かれて並ぶ。
 *
 * user の判定を「string かどうか」でやると SDK 由来のセッションで発言が全部消える。
 * **text ブロックを含むかどうか**で見る。
 *
 * tool_result は発言ではないので messages には出さないが、**捨てもしない**。
 * results として返し、呼び出し側が tool_use_id で tool_use に紐づける。
 */
function extract(entry, fullResults = false) {
  const content = entry?.message?.content;

  // 表示用ではない注入メッセージ（システムが差し込む注意書きなど）は出さない
  if (entry?.isMeta) return null;

  if (entry.type === "user") {
    // 裏の subagent の完了通知。CLI が main を再開させるために user として積む（origin: task-notification）。
    // 人の発言ではない。getSessionMessages は origin を落とすので中身で見分ける
    if (typeof content === "string" && content.trimStart().startsWith("<task-notification>")) return null;
    if (typeof content === "string") return content.trim() ? { text: content } : null;
    if (!Array.isArray(content)) return null;

    let text = "";
    const results = [];
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
      else if (block?.type === "tool_result" && block.tool_use_id) {
        const raw = resultText(block.content);
        results.push({
          id: String(block.tool_use_id),
          text: !fullResults && raw.length > MAX_RESULT_CHARS ? raw.slice(0, MAX_RESULT_CHARS) + "…（以下略）" : raw,
          isError: Boolean(block.is_error),
          truncated: !fullResults && raw.length > MAX_RESULT_CHARS,
        });
      }
    }
    if (!text.trim() && !results.length) return null;
    return { text: text.trim() ? text : "", results };
  }

  if (entry.type !== "assistant" || !Array.isArray(content)) return null;

  let text = "";
  let thinking = "";
  const toolCalls = [];
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") text += block.text;
    // 名前だけでは何をしたか分からない。input も一緒に返す（web 側が1行に要約する）
    else if (block?.type === "tool_use" && block.name) {
      toolCalls.push({
        id: block.id ? String(block.id) : null,
        name: String(block.name),
        input: block.input && typeof block.input === "object" ? block.input : {},
        result: null,
      });
    }
    // thinking は本文と分けて返す。host 側で折りたたんで見せる。
    else if (block?.type === "thinking" && typeof block.thinking === "string") thinking += block.thinking;
  }
  if (!text && !thinking && toolCalls.length === 0) return null;
  return {
    text,
    thinking: thinking || null,
    // tools は名前だけの旧形。後方互換のため残す
    tools: toolCalls.length ? toolCalls.map((c) => c.name) : null,
    toolCalls: toolCalls.length ? toolCalls : null,
  };
}

/**
 * Claude Code の transcript エントリ配列 -> NormalizedMessage[]。
 *   { role, text, uuid, at, thinking?, tools?, toolCalls?: [{id,name,input,result}] }
 *
 * @param entries getSessionMessages / getSubagentMessages が返す生のエントリ
 * @param includeNested サブエージェント側のメッセージ（parent_tool_use_id 付き）も含めるか。
 *        本流の会話では落とすが、サブエージェントの会話を読むときはそれしか無い。
 */
export function transcriptToMessages(entries, { includeNested = false, fullResults = false } = {}) {
  const messages = [];
  // tool_use_id -> toolCall。結果は後続の user エントリに来るので、後から書き戻す
  const calls = new Map();

  for (const entry of entries ?? []) {
    if (!includeNested && entry?.parent_tool_use_id) continue;

    const got = extract(entry, fullResults);
    if (!got) continue;

    // 結果を先に畳み込む。messages に積んだ toolCall と同じオブジェクトなので、そのまま反映される
    for (const r of got.results ?? []) {
      const call = calls.get(r.id);
      if (call) call.result = { text: r.text, isError: r.isError, truncated: r.truncated };
    }
    for (const c of got.toolCalls ?? []) if (c.id) calls.set(c.id, c);

    // tool_result だけのエントリは発言ではない。紐づけたら捨てる
    if (!got.text && !got.thinking && !got.toolCalls) continue;

    const role = entry.type === "user" ? "user" : "assistant";
    const at = entry.timestamp ?? null;

    // ツール呼び出しは1ブロック1エントリで並ぶ。連続する分は1件にまとめる
    const last = messages[messages.length - 1];
    if (got.toolCalls && !got.text && !got.thinking && last && last.role === "assistant" && !last.text && last.toolCalls) {
      last.tools.push(...got.tools);
      last.toolCalls.push(...got.toolCalls);
      last.at = at ?? last.at;
      continue;
    }

    const msg = { role, text: got.text, uuid: entry.uuid, at };
    if (got.thinking) msg.thinking = got.thinking;
    if (got.tools) msg.tools = got.tools;
    if (got.toolCalls) msg.toolCalls = got.toolCalls;
    messages.push(msg);
  }

  return messages;
}

/**
 * 途中送信（差し込まれた発言）を transcript の並びへ差し戻す。
 *
 * 走っているターンの区切りに折り込まれた発言は、transcript に**普通の user 行としては残らない**。
 * `{ type:'attachment', attachment:{ type:'queued_command', prompt, commandMode:'prompt' } }` として
 * 残り、getSessionMessages はこれを返さない（includeSystemMessages を付けても返らない。2026-09 実測）。
 * 拾わないと、ライブでは差し込んだ位置に見えていた発言が、開き直すと会話から消える。
 *
 * 置く場所は時刻では決められない（timestamp は push した時刻で、直前の行より古いことがある）。
 * 親子（parentUuid）の鎖が本当の並びなので、鎖を遡って **getSessionMessages に出ている最初の祖先**を
 * 見つけ、その直後へ差す。間に挟まっているのは CLI が足す attachment 行（環境・トークン数など）。
 *
 * 折り込まれずにターンが終わった発言は dequeue されて普通の user 行になる（＝ここには来ない）ので、
 * 同じ発言が二重に並ぶことはない（実測。両方が残る形は観測していない）。
 *
 * @param entries getSessionMessages が返すエントリ。この並びが正
 * @param rows transcript の attachment 行（uuid / parentUuid / attachment を持つもの）
 * @returns 差し戻した新しい配列。差すものが無ければ entries をそのまま返す
 */
export function mergeQueuedCommands(entries, rows) {
  const list = Array.isArray(entries) ? entries : [];
  const queued = (Array.isArray(rows) ? rows : []).filter((r) =>
    r?.type === "attachment" && r.uuid
    && r.attachment?.type === "queued_command"
    // commandMode が 'prompt' 以外（スラッシュコマンドなど）は発言として出さない
    && r.attachment.commandMode === "prompt"
    && typeof r.attachment.prompt === "string" && r.attachment.prompt.trim());
  if (!queued.length) return list;

  const parentOf = new Map();
  for (const r of rows) if (r?.uuid) parentOf.set(r.uuid, r.parentUuid ?? null);
  const known = new Set(list.map((e) => e?.uuid).filter(Boolean));

  // 祖先の uuid -> その直後に差す行（同じ区切りに 2 件以上が折り込まれることがある）
  const after = new Map();
  for (const row of queued) {
    let cursor = row.parentUuid ?? null;
    // 鎖が壊れている（祖先が見つからない）分は黙って落とす。今までどおり履歴から消えるだけで、
    // 見当違いの場所へ差すより害が小さい
    for (let hops = 0; cursor && !known.has(cursor) && hops < 500; hops++) cursor = parentOf.get(cursor) ?? null;
    if (!cursor || !known.has(cursor)) continue;
    if (!after.has(cursor)) after.set(cursor, []);
    after.get(cursor).push(row);
  }
  if (!after.size) return list;

  const asUser = (row) => ({
    type: "user", uuid: row.uuid, timestamp: row.timestamp ?? null,
    message: { role: "user", content: row.attachment.prompt },
  });
  const merged = [];
  for (const entry of list) {
    merged.push(entry);
    for (const row of after.get(entry?.uuid) ?? []) merged.push(asUser(row));
  }
  return merged;
}

/**
 * サブエージェントの transcript（`<sessionId>/subagents/agent-<id>.jsonl` の中身）を、
 * SDK の getSubagentMessages と同じ形のエントリ列にする。
 *
 * SDK（0.3.258）の getSubagentMessages は user / assistant の行だけを拾ってから parentUuid の鎖を遡る。
 * CLI（2.1.27x）は鎖の間に attachment 行（hook_success・total_tokens_reminder など）を挟むので、
 * 鎖が最初の 1 歩で切れ、**いつも最後の 1 件しか返らない**（2026-09-18 実測。6 本中 6 本で 1 件）。
 * ここでは全部の行で鎖を繋ぎ、その上の user / assistant だけを返す。
 *
 * @param text transcript の中身
 * @param toolUseId 生んだ委譲ツールの id（meta.json の toolUseId）。各エントリの parent_tool_use_id に載せる
 * @param limit 返す上限。超えたら最初の 1 件（依頼文）と末尾を残す。走っている子の「いま」が見えるように
 */
export function subagentEntries(text, { toolUseId = null, limit = 0 } = {}) {
  const rows = new Map();
  let leaf = null;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }   // 書きかけの最後の行など
    if (typeof row?.uuid !== "string") continue;
    rows.set(row.uuid, row);
    if (row.type === "user" || row.type === "assistant") leaf = row;
  }
  const chain = [];
  const seen = new Set();
  for (let row = leaf; row && !seen.has(row.uuid); row = row.parentUuid ? rows.get(row.parentUuid) : null) {
    seen.add(row.uuid);
    if (row.type === "user" || row.type === "assistant") chain.push(row);
  }
  chain.reverse();
  const kept = limit > 0 && chain.length > limit ? [chain[0], ...chain.slice(chain.length - (limit - 1))] : chain;
  return kept.map((row) => ({
    type: row.type,
    uuid: row.uuid,
    session_id: row.sessionId,
    message: row.message,
    parent_tool_use_id: toolUseId ?? null,
    timestamp: row.timestamp,
  }));
}
