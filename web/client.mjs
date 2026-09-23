import { isComposingKey } from "./keyboard.mjs";
import { createCompletionNotifications } from './notifications.mjs';
import { setupFilePreview } from './file-preview.mjs';
import { setupCodeCopy } from './code-copy.mjs';
setupCodeCopy();
import { setupUpdates } from './updates.mjs';
import { setupUsage } from './usage.mjs';
import { setupOnboarding } from "./onboarding.mjs";
import { setupClaudeAccounts } from './claude-accounts.mjs';
import { setupCompatEndpoints } from './compat-endpoints.mjs';
import { compatModelText } from './compat-models.mjs';
import { KIND_LABEL, CLAUDE_ROLES, lostText } from './compat-presets.mjs';
// host の UI。core とは WebSocket + protocolVersion で話す。
// 人間の操作と AI のツールは、経路が違っても同じ store・同じイベントを通る（設計メモ 2.2）。
// 見た目の規則は docs/design-system.md。
import { renderAssistantMarkdown, renderMarkdown, renderPresent, renderToolCall, applyToolResult, applyToolHints } from "./render.mjs";
import { createContextMenu } from "./context-menu.mjs";
import { setupComposerControls, resolvedModel } from "./composer-controls.mjs";
import { modelRowIds } from "./composer-labels.mjs";
import { setupSlashSkills } from "./slash-skills.mjs";
import { runMark, satMark, stillMark } from "./arc.mjs";
import { behindOfTasks } from './work-status.mjs';
import { createSide } from "./side.mjs";
import { familiesOf } from "./family.mjs";
import { createBranches, commonPrefix, nodeKeys } from "./branches.mjs";
import { makeBranchRow, layoutBranchSpine, motionDuration, EASING } from "./branch-view.mjs";
import { el, svgEl, relTime } from "./dom.mjs";
import { t, fmt, lang as uiLang, applyDom, languageName, rememberLang } from "./i18n.mjs";
import { buildItems, attachmentMessageIndex } from "./timeline.mjs";
import { createSessionLoads } from "./session-stream.mjs";
const sessionLoads = createSessionLoads();
import { createReadCompletions, READ_STORE } from "./unread.mjs";
import { setupContext } from './context.mjs';
import { setupSessionContext, chipText } from './session-context.mjs';
import { renderOutbox } from './outbox.mjs';
const outboxes = new Map();
const submittingMessages = new Set();
// Persist the request ID before transport so an acknowledgement lost on reload
// can be reconciled with server acceptance instead of sending a second copy.
const receipts = new Map();
try {
  for (const [id, request] of JSON.parse(localStorage.getItem('ply-message-receipts') ?? '[]')) receipts.set(id, request);
} catch {}
function saveReceipts() {
  localStorage.setItem('ply-message-receipts', JSON.stringify([...receipts]));
}
function paintOutbox() {
  const id = state.current;
  renderOutbox($('outbox'), outboxes.get(id) ?? [], async (messageId, action) => {
    await cmd('messageAction', { sessionId: id, messageId, action });
  });
}
async function refreshOutbox(id) {
  const messages = await cmd('listMessages', { sessionId: id });
  outboxes.set(id, messages);
  if (state.current === id) paintOutbox();
  return messages;
}

let readStorage;
try { readStorage = localStorage; } catch {}
const readCompletions = createReadCompletions(readStorage);
const displayedCompletions = new Map();

const token = new URL(location.href).searchParams.get("token") ?? "";
const $ = (id) => document.getElementById(id);
const log = $("log");
const thread = $("thread");

const NL = String.fromCharCode(10);
const PROTOCOL = 3;
const completionNotifications = createCompletionNotifications({ openSession: id => select(id) });

let ws = null;
let seq = 0;
const pending = new Map();

const state = {
  current: null,      // 選択中の sessionId（null = 新規）
  loadingSession: null,
  homeDir: "",
  draft: { status: null, cwd: "" },   // 新規セッションの予約（引き継いだ状態と作業ディレクトリ）。current が null のときだけ意味を持つ
  sessions: [],
  statuses: [],
  backends: [],       // 使えるエージェント [{id,label,capabilities,toolHints}]
  backendId: null,    // 新しいセッションを始めるときに使うエージェント
  vocab: new Map(),   // backendId -> { modes, models }。語彙はエージェントごとに違う
  modes: {},
  mode: "default",     // 次のターンに使う承認モード
  models: {},
  model: "",           // 次のターンに使うモデル（空 = 既定に従う）
  // 入力欄のチップ（web/composer-controls.mjs）が出す値。予約があれば予約の値
  cwd: "",             // 次のターンの作業ディレクトリ
  shownBackend: null,  // 次のターンのエージェント
  efforts: {},         // 選べるエフォートの段（core/effort.mjs の形。'' の resolvesTo が既定の段）
  effort: "",          // 次のターンのエフォート（空 = 既定に従う）
  effortDisabled: false,
  account: "",         // 次のターンの Claude のアカウント（空 = ログイン中のアカウント）
  accountShown: false, // アカウントの選択を出すか（登録が無く、選んでもいない会話には出さない）
  endpoint: "",        // 次のターンの互換の接続先（空 = 公式）。Claude Code・Codex だけ
  endpointShown: false, // 接続先の節を出すか（接続先を選べるエージェントのとき）
  prefs: {},           // 新しいセッションを始めるときの既定
  awaitingSession: false,  // 新規セッションの id 待ち（自分が送った直後だけ真）
  toolCards: new Map(),// tool_use_id -> 描いたカード（結果を後から差し込む）
  attached: [],        // 次の送信で渡す添付（{name, path, kind}）
  drafts: new Map(),   // 書きかけ: sessionId（新規は ""）-> { text, attached }
  askedFor: new Set(), // 一覧に無いセッションのために取り直した記録（取り直しの繰り返しを防ぐ）
  work: { count: 0, turns: [], permissions: [], subagents: [], background: [] },
  runningIds: new Set(),   // いま走っているセッション（サーバの running が正）
  bgWaiting: new Map(),    // 裏を待っているセッション -> 待っている本数（running のターン行の phase と background が正）
  waitingIds: new Set(),   // 承認・回答を待っているセッション
  // 未解決の承認: id -> permission イベントの中身。会話を開き直すたびに描き直す材料。
  // running が載せるのは id と道具名だけなので、カードを組み立てられるのはこちらだけ
  pendingPerms: new Map(),
  submitting: false,       // 新規セッションを送った直後（id が決まるまで）
  messages: [],        // 今のセッションの履歴（loadSession の messages）
  contextInfo: null,   // 今のセッションの読み込み記録（sessionContext の戻り）。タイトル行の入口と筋の一行に使う
  contextInfoId: null, // 上の記録がどのセッションのものか
  presents: [],
  turnEl: null,        // 追記中の AI の発言（.m.ai）
  turnClosed: false,   // text.end が来た。続くツール呼び出しは同じ発言に入り、次の本文は新しい発言になる
  streamEl: null,      // 追記中の本文
  thinkEl: null,       // 追記中の thinking 要素（平文が来たときだけ作る）
  thinkTokens: 0,
  auth: new Map(),         // backendId -> authStatus の戻り（{ supported, loggedIn, account?, detail?, pending? }）
  authUrl: new Map(),      // backendId -> { url, message } ログインの途中で出た URL
  busy: false,             // 枝の動きの最中。重ねて動かさない
};

// ---------------------------------------------------------------- 表示の下請け

const escText = (s) => {
  const n = document.createElement("span");
  n.textContent = String(s ?? "");
  return n.innerHTML;
};

const hhmm = (at) => {
  if (!at) return "";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toTimeString().slice(0, 5);
};

/**
 * 発言の入れ物。左の溝（gutter）に筋の節、右に中身。枝の最小化・最大化はこの高さと位置を動かす。
 * 節は中身の箱の外にあるので、中身の overflow:hidden に切られない。
 */
function wrap(node, key) {
  const w = el("div", "mw");
  if (key) w.dataset.key = key;
  if (node.matches?.(".m:not(.sys):not(.cont):not(.activity)")) w.classList.add("node");
  if (node.matches?.(".m.cont")) w.classList.add("cont");
  if (node.matches?.(".m.card")) w.classList.add("card");
  if (node.matches?.(".m.activity")) w.classList.add("activity");
  const body = el("div", "mw-body");
  body.append(node);
  w.append(el("div", "mw-gutter"), body);
  return w;
}

const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 40;

/** 筋の末尾に置く。稼働表示（走っている間だけある）は常に一番下に残す */
function place(w) {
  const act = thread.querySelector(".mw.activity");
  if (act && !w.classList.contains("activity")) act.before(w);
  else thread.append(w);
}

function append(node, key) {
  const stick = !state.busy && atBottom();
  const w = wrap(node, key);
  place(w);
  relayoutBranches();
  if (stick) log.scrollTop = log.scrollHeight;
  return w;
}

/** 出来事の一行。筋の節は持たない。html はこちらで組み立てた文字列だけ（中身は escText 済み） */
function sys(html) {
  const m = el("div", "m sys");
  m.innerHTML = html;
  append(m);
  return m;
}

function clearThread() {
  activity.hide();
  thread.replaceChildren(spine());
  thread.classList.remove("branched");
  state.streamEl = null;
  state.thinkEl = null;
  state.turnEl = null;
  state.turnClosed = false;
  state.toolCards.clear();
}

function spine() {
  const svg = svgEl("svg", { class: "spine", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: "M20,0 L20,0" }));
  return svg;
}


// ---------------------------------------------------------------- 発言

/** 「⑂ ここから分岐」。発言の uuid が分かってから見える */
function forkButton(m) {
  const actions = el('div', 'message-actions');
  actions.hidden = true;
  const b = el("button", "btn forkbtn", "⑂ ここから分岐");
  b.type = "button";
  b.onclick = () => forkFrom(m);
  actions.append(b);
  if (m.dataset.role === 'user') {
    for (const [label, className, edit] of [['編集して再送信', 'editbtn', true], ['再送信', 'resendbtn', false]]) {
      const action = el('button', `btn ${className}`, label);
      action.type = 'button';
      action.onclick = async () => {
        if (state.busy || m.querySelector('.message-editor')) return;
        const source = state.current;
        action.disabled = true;
        try {
          const data = await cmd('loadSession', { sessionId: source });
          if (state.current !== source || !m.isConnected || state.busy) return;
          const index = data.messages.findIndex(row => row.uuid === m.dataset.uuid);
          if (index < 0) throw new Error('この発言はまだ保存されていません。少し待って再試行してください');
          const attached = data.presents.filter(p => attachmentMessageIndex(data.messages, p) === index)
            .map(p => ({ path: p.path, name: p.caption?.replace(/^添付:\s*/, '') || p.path.split(/[\\/]/).at(-1),
              mime: p.mime ?? /^data:([^;,]+)/.exec(p.dataUri ?? '')?.[1] ?? '', kind: p.kind, dataUri: p.dataUri }));
          // 自動で付いた添付行だけを除く。本文に書かれた [添付] の説明は残す。
          const paths = new Set(attached.map(p => p.path.replace(/\\/g, '/').toLowerCase()));
          const text = (data.messages[index].text ?? '').split(/\r?\n/).filter(line => {
            const match = /^\[添付\]\s+(.+)$/.exec(line.trim());
            return !match || !paths.has(match[1].replace(/\\/g, '/').toLowerCase());
          }).join('\n').trimEnd();
          const draft = { text, attached, index };
          if (edit) editMessage(m, draft);
          else await forkFrom(m, { draft });
        } catch (e) { sys(`再送信の準備に失敗: ${escText(e.message)}`); }
        finally { action.disabled = false; }
      };
      actions.append(action);
    }
  }
  m.append(actions);
  return b;
}

function editMessage(m, draft) {
  if (m.querySelector('.message-editor')) return;
  const body = m.querySelector(':scope > .body');
  const editor = el('div', 'message-editor');
  const input = el('textarea', 'message-edit-input');
  input.value = draft.text;
  input.setAttribute('aria-label', 'メッセージを編集');
  const controls = el('div', 'message-edit-controls');
  const cancel = el('button', 'btn', '取り消し');
  const send = el('button', 'btn btn-primary');
  send.innerHTML = $('send').innerHTML;
  send.title = '分岐して送信 (Ctrl+Enter)';
  send.setAttribute('aria-label', '分岐して送信');
  cancel.type = send.type = 'button';
  const close = () => {
    if (state.busy) return;
    editor.remove(); body.hidden = false; m.classList.remove('editing');
    m.querySelector('.editbtn')?.focus(); relayoutBranches();
  };
  cancel.onclick = close;
  const update = () => {
    send.disabled = !input.value.trim() && !draft.attached.length;
    input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`;
    relayoutBranches();
  };
  input.oninput = update;
  send.onclick = async () => {
    if (send.disabled || state.busy) return;
    send.disabled = cancel.disabled = input.disabled = true;
    try { await forkFrom(m, { draft: { ...draft, text: input.value } }); }
    finally { cancel.disabled = input.disabled = false; update(); }
  };
  input.onkeydown = event => {
    if (isComposingKey(event)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); send.click(); }
  };
  editor.append(input);
  if (draft.attached.length) editor.append(el('div', 'message-edit-attachments', draft.attached.map(a => a.name).join(' · ')));
  controls.append(cancel, send); editor.append(controls);
  body.hidden = true; body.after(editor); m.classList.add('editing');
  update(); input.focus();
}

function setUuid(m, uuid) {
  if (!uuid) return;
  m.dataset.uuid = uuid;
  if (capsOf(activeBackendId()).fork !== false) {
    const b = m.querySelector(":scope > .message-actions");
    if (b) b.hidden = false;
  }
}

function whoLine(who, at) {
  const w = el("div", "who");
  w.append(el("span", null, who), el("span", "when", hhmm(at)));
  return w;
}

function userMsg(text, { uuid, at } = {}) {
  const m = el("div", "m user");
  m.dataset.role = "user";
  if (at) m.dataset.at = at;
  m.append(whoLine("あなた", at));
  m.append(el("div", "body", text));
  forkButton(m);
  setUuid(m, uuid);
  return m;
}

function aiMsg({ uuid, at, cont, backend } = {}) {
  const m = el("div", "m ai" + (cont ? " cont" : ""));
  m.dataset.role = "assistant";
  if (at) m.dataset.at = at;
  m.append(whoLine(labelOf(backend ?? activeBackendId()) || "AI", at));
  forkButton(m);
  setUuid(m, uuid);
  return m;
}

/** 直前の発言が AI なら、続きとして見出しと節を繰り返さない */
const lastIsAi = () => thread.querySelector(".mw:last-of-type .m")?.classList.contains("ai") ?? false;

/**
 * ライブで AI の発言の入れ物。無ければ作る。text.end で閉じた後でも、続くツール呼び出しは
 * 同じ発言のもの（履歴では 1 メッセージ = 本文 + ツール呼び出し）なのでここへ入る。
 */
function ensureTurnEl() {
  if (state.turnEl) return state.turnEl;
  const m = aiMsg({ at: new Date().toISOString(), cont: lastIsAi() });
  append(m, `live:${++liveSeq}`);
  state.turnEl = m;
  return m;
}
let liveSeq = 0;

/** 本文や thinking が始まる。閉じた発言の後なら新しい発言になる */
function openTurnEl() {
  if (state.turnClosed) closeTurnEl();
  return ensureTurnEl();
}

function closeTurnEl() {
  closeThink();
  state.streamEl = null;
  state.turnEl = null;
  state.turnClosed = false;
}

// ---------------------------------------------------------------- 質問カード
// 質問は「危ないから承認する」ツールではなく、**こちらに聞いている**ツール。
// 承認チャネルはそのまま使い（core は保留・猶予をこの経路で面倒を見ている）、
// UI だけ専用のものにする。core が permission.kind === "question" として正規化して送ってくる。

function questionCard(ev) {
  const qs = Array.isArray(ev.questions) ? ev.questions : [];
  if (!qs.length) return null;

  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(el("span", "card-kind", "答えを待っている"));
  head.append(el("span", "desc", ev.title ?? ""));
  card.append(head);

  // question文字列をキーに答えを集める（SDK の answers がその形）
  const picked = new Map();   // question -> Set<label>
  const notes = new Map();    // question -> 自由記述

  for (const q of qs) {
    const box = el("div", "q");
    box.append(el("div", "q-text", q.question ?? ""));
    const multi = Boolean(q.multiSelect);
    box.append(el("div", "q-note", `${q.header ? q.header + " · " : ""}${multi ? "複数選べる" : "1 つ選ぶ"}。自由記述も可`));

    const opts = el("div", "opts");
    for (const o of q.options ?? []) {
      const b = el("button", "opt");
      b.type = "button";
      b.append(el("span", "opt-label", o.label ?? ""));
      if (o.description) b.append(el("span", "opt-desc", o.description));
      b.onclick = () => {
        const set = picked.get(q.question) ?? new Set();
        if (multi) { set.has(o.label) ? set.delete(o.label) : set.add(o.label); }
        else { set.clear(); set.add(o.label); }
        picked.set(q.question, set);
        for (const other of opts.querySelectorAll(".opt")) {
          other.classList.toggle("on", set.has(other.querySelector(".opt-label")?.textContent));
        }
        sync();
      };
      opts.append(b);

      // 選択肢に preview があれば畳んで見せる（コード片やモックが入る）
      if (o.preview) {
        const d = document.createElement("details");
        d.className = "opt-preview";
        const sm = document.createElement("summary");
        sm.textContent = `${o.label} の見本`;
        const pre = el("pre");
        pre.append(el("code", null, o.preview));
        d.append(sm, pre);
        opts.append(d);
      }
    }
    box.append(opts);

    // 「その他」は選択肢に含めない決まりなので、こちらで用意する
    const other = document.createElement("input");
    other.className = "other";
    other.placeholder = "その他（自由に書ける）";
    other.oninput = () => { notes.set(q.question, other.value.trim()); sync(); };
    box.append(other);
    card.append(box);
  }

  const actions = el("div", "card-actions");
  const skip = el("button", "btn", "答えずに進める");
  skip.type = "button";
  const send = el("button", "btn btn-primary", "回答する");
  send.type = "button";
  send.disabled = true;
  actions.append(skip, send);
  card.append(actions);

  function answersNow() {
    const out = {};
    for (const q of qs) {
      const set = picked.get(q.question);
      const free = notes.get(q.question);
      // 複数選択はカンマ区切り。SDK の出力仕様に合わせる
      const parts = [...(set ?? [])];
      if (free) parts.push(free);
      if (parts.length) out[q.question] = parts.join(", ");
    }
    return out;
  }

  function sync() {
    // 全部の質問に答えが付いたら送れるようにする
    send.disabled = Object.keys(answersNow()).length < qs.length;
  }

  function settle(answers) {
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    head.querySelector(".card-kind").textContent = "質問";
    const summary = answers
      ? qs.map((q) => `${q.header || q.question}: ${answers[q.question]}`).join(" / ")
      : "答えずに進めた";
    actions.replaceChildren(el("span", "res", summary));
    for (const b of card.querySelectorAll("button, input")) b.disabled = true;
    if (isRunningHere()) activity.show("続きを待っている");
    state.pendingPerms.delete(ev.id);
    cmd("resolvePermission", { id: ev.id, allow: true, answers: answers ?? {} })
      .catch((e) => sys(`回答の送信に失敗: ${escText(e.message)}`));
  }

  send.onclick = () => settle(answersNow());
  skip.onclick = () => settle(null);
  append(m, `perm:${ev.id}`);
  m.scrollIntoView({ block: "nearest" });   // あなたを待っている。見えていないと止まったまま
  return m;
}

// ---------------------------------------------------------------- 承認カード
// モーダルは使わない。ブラウザのダイアログは以降のイベントを止めるうえ、
// 会話の流れから目を離させる（＝離れさせない、という価値命題に反する）。

function permissionCard(ev) {
  const m = el("div", "m card");
  const card = el("div", "card");
  m.append(card);
  const head = el("div", "card-head");
  head.append(el("span", "card-kind", "承認を待っている"));
  head.append(el("span", "tool", ev.toolName ?? ""));
  head.append(el("span", "desc", ev.title ?? ""));
  card.append(head);

  const input = JSON.stringify(ev.input ?? {}, null, 2);
  const short = input.length > 1200 ? input.slice(0, 1200) + NL + "…" : input;
  const code = el("div", "code-block");
  const pre = el("pre");
  pre.append(el("code", null, short));
  code.append(pre);
  card.append(code);

  // 「常に許可」は候補を出せるエージェントでだけ。候補はこちらで組み立てない
  const canAlways = ev.canAlways && capsOf(activeBackendId()).alwaysAllow !== false;
  const actions = el("div", "card-actions");
  actions.append(el("span", "res", "許可しないと、このターンは止まったまま"));
  const always = el("button", "btn", "常に許可");
  always.type = "button";
  const deny = el("button", "btn btn-quiet", "拒否");
  deny.type = "button";
  const allow = el("button", "btn btn-primary", "許可");
  allow.type = "button";
  if (canAlways) actions.append(always);
  actions.append(deny, allow);
  card.append(actions);

  const settle = (ok, forever = false) => {
    m.classList.add("done");
    m.closest(".mw")?.classList.add("done");
    card.classList.add("done");
    head.querySelector(".card-kind").textContent = "承認";
    head.append(el("span", "res", `${ok ? (forever ? "常に許可した" : "許可した") : "拒否した"} · ${hhmm(new Date())}`));
    actions.remove();
    code.remove();
    if (isRunningHere()) activity.show(ok ? `${ev.toolName} を実行中` : "続きを待っている");
    state.pendingPerms.delete(ev.id);
    cmd("resolvePermission", { id: ev.id, allow: ok, always: forever, message: ok ? undefined : "ユーザーが拒否した" })
      .catch((e) => sys(`承認の送信に失敗: ${escText(e.message)}`));
  };
  allow.onclick = () => settle(true);
  deny.onclick = () => settle(false);
  always.onclick = () => settle(true, true);
  append(m, `perm:${ev.id}`);
  m.scrollIntoView({ block: "nearest" });
  return m;
}

/**
 * 承認・質問のカードを筋へ出す。届いたときと、その会話を開き直したときの両方から通る。
 * 同じ承認を二度描かない（枝の切り替えでは筋の前半が残るため）。
 */
function renderPermission(ev) {
  if (thread.querySelector(`.mw[data-key="perm:${CSS.escape(ev.id)}"]`)) return;
  closeTurnEl();
  // 質問は承認ではない。専用のカードで選択肢を出す
  if (ev.kind === "question") {
    activity.show("あなたの回答を待っている");
    const card = questionCard(ev);
    if (card) return card;
  }
  activity.show("承認を待っている");
  return permissionCard(ev);
}

/** 開いている会話で、まだ答えていない承認を描き直す。clearThread() の後に呼ぶ。 */
function paintPendingPerms(id) {
  for (const ev of state.pendingPerms.values()) if (ev.sessionId === id) renderPermission(ev);
}

// ---------------------------------------------------------------- 稼働表示
// 「動いているのか分からない」を無くす。何をしているかと、経過時間を出し続ける。
// 置き場は会話の筋の末尾の節（走っている間だけ存在し、新しい発言が来るとその下へ移る）。
// 節の代わりに弧が筋の上に載る。固定の帯や流れる線は置かない。

// main が返答を終え、裏の subagent などだけを待っている間（running のターン行の phase が waiting）は、
// 弧の代わりに衛星（§6）を置き、見出しを「サブエージェントを待っている」にする。
// その間に来る show()（subagent 側のツール名など）は text に覚えるだけで、見出しは変えない。

/** ターン行 -> 裏を待っているなら { n, label }、そうでなければ null */
const behindOf = (t) => (t?.phase === "waiting" ? behindOfTasks(t.background, { waiting: true }) : null);
/**
 * この画面の会話が裏を待っているか。ターンが走っていればターン行（Claude の phase: waiting）、
 * 走っていなければ running の background（Codex: ターンは終わったがバックグラウンド端末が残っている）
 */
function behindHere() {
  const t = (state.work.turns ?? []).find(belongsHere);
  if (t) return behindOf(t);
  const b = (state.work.background ?? []).find(belongsHere);
  return b ? behindOfTasks(b.tasks) : null;
}

const activity = {
  t0: 0,
  timer: null,
  el: null,          // .m.activity
  text: "",
  subagents: 0,
  ended: 0,          // 同じターンで終わったサブエージェント
  behind: null,      // behindOf() の結果。裏を待っている間だけ
  mark() {
    return this.behind ? satMark(this.behind.n, `裏で ${this.behind.n} 本が動いている`) : runMark("ターンが走っている");
  },
  paint() {
    this.el.querySelector(".txt").textContent = this.behind ? this.behind.label : this.text;
  },
  /** 印を今の状態（弧 / 衛星）に差し替える */
  remark() {
    this.el?.closest(".mw")?.querySelector(".activity-tip")?.replaceChildren(this.mark());
  },
  show(text) {
    this.text = text;
    if (!this.t0) this.t0 = Date.now();
    const was = this.behind;
    this.behind = behindHere();
    // ターンが終わって裏だけが残った、またはその逆。出ている節の印を差し替える
    if (this.el?.isConnected && (was?.n ?? 0) !== (this.behind?.n ?? 0)) this.remark();
    if (!this.el?.isConnected) {
      const m = el("div", "m activity");
      const work = el("button", "btn work");
      work.type = "button";
      work.hidden = true;
      work.onclick = openWork;
      m.append(el("span", "txt"), work, el("span", "el"));
      const w = append(m, "activity");
      const tip = el("span", "activity-tip");
      tip.append(this.mark());
      w.querySelector(".mw-gutter").append(tip);
      this.el = m;
    }
    this.paint();
    relayoutBranches();
    this.work(this.subagents, this.ended);
    this.timer ??= setInterval(() => {
      const s = Math.round((Date.now() - this.t0) / 1000);
      const e = this.el?.querySelector(".el");
      if (e) e.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  },
  /** running が変わった。裏を待っているかどうかで印と見出しを差し替える（表示中のときだけ） */
  sync() {
    if (!this.el?.isConnected) return;
    const was = this.behind;
    this.behind = behindHere();
    if ((was?.n ?? 0) !== (this.behind?.n ?? 0)) this.remark();
    // 待っている間に覚えた text は subagent 側のもの。main が戻ったら一旦中立の語にする
    if (was && !this.behind) this.text = "動いている";
    this.paint();
  },
  /**
   * この会話のサブエージェントの数。n は走っている子だけ（状態が分からない子を含む）、
   * ended は同じターンで終わった子。どちらも 0 なら文字ボタンを出さない。
   * 終わった子だけが残っているときも、ダイアログで結果の会話を読めるようにボタンは残す。
   * ターンの外に残っている裏の作業（Codex のバックグラウンド端末）もここから開けるようにする
   * ——止める口はこのダイアログにしか無いので、出さないと押せない。
   */
  work(n, ended = 0) {
    this.subagents = n;
    this.ended = ended;
    const b = this.el?.querySelector(".work");
    if (!b) return;
    const behind = backgroundHere().length;
    b.hidden = n === 0 && ended === 0 && behind === 0;
    if (n) b.textContent = `サブエージェント ${n}`;
    else if (behind) b.textContent = `裏で動いている ${behind}`;
    else if (ended) b.textContent = `サブエージェント · 終了 ${ended}`;
  },
  hide() {
    clearInterval(this.timer);
    this.timer = null;
    this.t0 = 0;
    this.text = "";
    this.behind = null;
    this.el?.closest(".mw")?.remove();
    this.el = null;
  },
};

function openWork() {
  renderWorkDialog();
  $("workDialog").showModal();
}

// ---------------------------------------------------------------- thinking
// 既定は閉じておく。読みたいときだけ開ける（畳んだままでも「考えた」ことは見える）。

function thinkBox() {
  if (state.thinkEl) return state.thinkEl;
  const d = document.createElement("details");
  d.className = "think live";
  const s = document.createElement("summary");
  s.textContent = "考えている";
  const body = el("div", "think-body");
  d.append(s, body);
  openTurnEl().append(d);
  state.thinkEl = d;
  return d;
}

function closeThink() {
  if (!state.thinkEl) return;
  const d = state.thinkEl;
  d.classList.remove("live");
  const n = d.querySelector(".think-body").textContent.length;
  d.querySelector("summary").textContent = `考えた（${fmt.number(n)} 文字）`;
  state.thinkEl = null;
}

/** 履歴から復元するときの thinking。最初から閉じた状態で作る。 */
function thinkFromText(text) {
  const d = document.createElement("details");
  d.className = "think";
  const s = document.createElement("summary");
  s.textContent = `考えた（${fmt.number(text.length)} 文字）`;
  const body = el("div", "think-body", text);
  d.append(s, body);
  return d;
}

// ---------------------------------------------------------------- ターンの流れ
// core が正規化して送ってくる（プロトコル v3）。エージェントごとの差は core で吸収済み。

function appendText(text) {
  closeThink();
  activity.show("書いている");
  const stick = atBottom();
  if (!state.streamEl) {
    // 閉じた発言の後は streamEl がリセットされるため、本文を作る前に開く。
    const turn = openTurnEl();
    state.streamEl = el("div", "body");
    state.streamEl.dataset.raw = "";
    turn.append(state.streamEl);
  }
  state.streamEl.dataset.raw += text;
  state.streamEl.innerHTML = renderAssistantMarkdown(state.streamEl.dataset.raw);
  if (stick) log.scrollTop = log.scrollHeight;
}

const ACTIVITY_LABEL = {
  thinking: "考えている",
  writing: "書いている",
  compacting: "文脈を圧縮している",
  waiting: "あなたの応答を待っている",
  running: "動いている",
};

// ---------------------------------------------------------------- イベント

/**
 * このイベントを今の画面に描いてよいか。
 * サーバは全部のタブに配るので、別セッションの流れが混ざりうる。
 * 自分が走らせているターンのものか、いま開いているセッションのものだけを描く。
 * ※ tests/unit/stream-routing.mjs に同じ規則を写してある。変えたら合わせること。
 */
function isMine(ev) {
  if (ev.type === "running") return true;      // 全体の状況。セッションに紐づかない
  const id = ev.sessionId;
  if (!id) return true;                       // セッションに紐づかないものは通す

  // 基準は「実行中かどうか」ではなく「いま何を表示しているか」。
  if (state.current) return id === state.current;

  // 新規セッションは最初の session イベントまで id が分からない。
  // 自分が送った直後だけ、しかも `first` の付いた session からのみ採用する
  // （本文の流れから拾うと、別タブが走らせたターンを取り違えうる。first の無い session は
  // 再開ターンのモデル通知でも流れるので、それを掴むと他所の id を自分のものにしてしまう）。
  if (state.awaitingSession && ev.type === "session" && ev.first) {
    state.current = id;
    state.awaitingSession = false;
    // 自分が走らせたターン。サーバの running が id を載せて来るまでの間も「走っている」扱いにする
    // （ここで止まっていると見なすと、追記中の発言が途中で閉じられる）
    state.runningIds.add(id);
    state.submitting = false;
    syncTopbar();
    return true;
  }
  return false;
}

// ---- 途中送信の配達（server の userMessage.pending / userMessage.delivered）
//
// 受理（吹き出しを出す）と「エージェントに渡った」は別の瞬間。渡るまでの間だけ、吹き出しの下に
// 回る弧と一言を出す（docs/design-system.md §6。印は待っている間しか DOM に置かない）。
// 渡ったら「AIへ送信済み」に戻し、渡らないままターンが終わったら、次のターンで答えることを言う。
const deliveredEarly = new Set();   // 吹き出しより先に届いた配達の合図
const DELIVERY = {
  pending: '次の区切りで AI に渡します',
  late: 'この作業には間に合いませんでした。続けて答えます',
  sent: 'AIへ送信済み',
};
const messageRow = (messageId) => (messageId
  ? [...thread.querySelectorAll('.mw[data-message-id]')].find(w => w.dataset.messageId === messageId)
  : null) ?? null;
function markDelivery(row, kind) {
  const status = row.querySelector('.outbox-status');
  if (!status) return;
  if (kind === 'pending') row.dataset.deliveryPending = '1';
  else delete row.dataset.deliveryPending;
  status.replaceChildren(...(kind === 'pending' ? [runMark('まだエージェントに渡っていない')] : []), DELIVERY[kind]);
  status.classList.toggle('outbox-status-mark', kind === 'pending');
}

function onEvent(ev, replay = false) {
  if (ev.type === 'outbox') {
    outboxes.set(ev.sessionId, ev.messages);
    if (state.current === ev.sessionId) {
      // 送ったつもりが届かず送信待ちへ戻ったもの（エージェントが別のターンを走らせていた）。
      // 会話の吹き出しを引っ込め、送信待ちの側に出す。そのターンが終わると改めて送られる
      const back = new Set((ev.messages ?? []).filter(m => m.status === 'queued').map(m => m.id));
      let withdrawn = false;
      for (const w of thread.querySelectorAll('.mw[data-message-id]')) {
        if (back.has(w.dataset.messageId)) { w.remove(); withdrawn = true; }
      }
      if (withdrawn) relayoutBranches();
      paintOutbox();
    }
    return;
  }
  if (ev.type === "turnEnd" && ev.sessionId) {
    const s = state.sessions.find(s => s.id === ev.sessionId);
    completionNotifications.completed(ev, s, replay);
    // requeued は完了ではない（何も届かず送信待ちへ戻った）。完了時刻も既読も触らない
    if (s && !ev.requeued) s.completedAt = ev.completedAt;
    if (ev.sessionId === state.current && !state.loadingSession && !ev.requeued) {
      displayedCompletions.set(ev.sessionId, ev.completedAt);
      if (document.visibilityState === "visible") readCompletions.mark(ev.sessionId, ev.completedAt);
    }
    // Process completion for every session, before filtering events to the open conversation.
    state.runningIds.delete(ev.sessionId);
    renderSessions();
    if (ev.sessionId !== state.current) refresh();
  }
  // 承認は一度きりしか届かない。開いていない会話の分も覚えておき、開いたときに描く
  // （覚えずに捨てると、一覧は「承認待ち」なのにカードがどこにも出ない）
  if (ev.type === "permission" && ev.id) state.pendingPerms.set(ev.id, ev);
  if (!replay && sessionLoads.capture(ev, state.current)) return;
  if (ev.type === "prefs") { state.prefs = ev.prefs ?? {}; applyLocale(ev.locale); return; }
  // Pleiad に登録した外部 MCP のログインの進み具合。会話には出さず、設定 › コンテキストと会話の右パネル（web/context.mjs・web/session-context.mjs）へ渡す
  if (ev.type === 'mcpAuth') { window.dispatchEvent(new CustomEvent('ply:mcp-auth', { detail: ev })); return; }
  // Claude のアカウントの認可（claude setup-token / 使用量の claude auth login）の進み具合。設定のアカウントの画面へ渡す
  if (ev.type === 'claudeLogin') { claudeAccounts.loginEvent(ev); return; }
  if (!isMine(ev)) {
    // 一覧に効くものだけは取り込む（画面には出さない）。セッションに紐づかないもの（statusIcon 等）はここへ来ない
    if (["status", "group", "title", "fork", "mode", "model", "cwd", "backend", "nextSettings"].includes(ev.type)) {
      // 家族の枝の名前が変わったなら、筋と分岐点の印にも出す
      if (ev.type === "title" && branches.has(ev.sessionId)) return refresh().then(paintBranchNames);
      // 開いている会話から枝が分かれた（fork イベントは子の id で来るのでここへ落ちる）
      if (ev.type === "fork") return refresh().then(() => reloadBranches(ev));
      refresh();
    }
    return;
  }
  switch (ev.type) {
    case 'userMessage': {
      if (replay && ev.messageId === state.initialMessageId) return;
      closeTurnEl();
      const row = append(userMsg(ev.text, { at: ev.at }), `live:${++liveSeq}`);
      if (ev.messageId) row.dataset.messageId = ev.messageId;
      const status = document.createElement('div');
      status.className = 'outbox-status';
      row.querySelector('.m').append(status);
      // pending = 受理はしたが、まだエージェントに渡っていない（userMessage.delivered を待つ）。
      // 配達の合図が先に来ていた分（速いバックエンド）はここで消化する
      if (ev.pending && ev.messageId && !deliveredEarly.delete(ev.messageId)) markDelivery(row, 'pending');
      else markDelivery(row, 'sent');
      paintContextLine();      // 最初の発言が出てから置く（記録は発言より先に届く）
      return;
    }
    case 'userMessage.delivered': {
      const row = messageRow(ev.messageId);
      // 吹き出しより先に届くことがある（受理の応答と配達の合図が競る）。覚えておいて吹き出しで消す
      if (!row) { if (ev.messageId) deliveredEarly.add(ev.messageId); return; }
      markDelivery(row, 'sent');
      return;
    }
    case 'userMessage.dropped':
      // 読まれないままターンが死んだ。発言は送信待ち（保留）へ戻るので、会話からは下げる
      messageRow(ev.messageId)?.remove();
      return;
    case "sessionsChanged":
      if (ev.deleted === state.current) { state.current = null; clearThread(); loadDraft(); }
      return refresh();
    case 'claudeAccountsChanged':
      claudeAccounts.invalidate();
      syncTopbar().catch(() => {});
      break;
    case 'compatEndpointsChanged':
      compatEndpoints.invalidate();
      syncTopbar().catch(() => {});
      renderAuth();
      break;
    case "nextSettings":
      return refresh();
    case "backend":
      if (ev.applied) return refresh();
      sys(`エージェントを ${escText(labelOf(ev.backend))} に変更しました。次の送信から会話を引き継ぎます。`);
      return refresh();
    case "text.delta":
      return appendText(String(ev.text ?? ""));

    case "text.end": {
      // 確定した発言。id が分かったので「ここから分岐」が押せるようになる。
      // 続くツール呼び出しは同じ発言に入る（履歴の 1 メッセージ = 本文 + ツール呼び出し）。
      // 既に閉じた発言に続けて来たなら（本文の無いツールだけの発言）、新しい発言を作る
      const m = openTurnEl();
      if (ev.uuid) setUuid(m, ev.uuid);
      closeThink();
      state.streamEl = null;
      state.turnClosed = true;
      return;
    }

    case "thinking.start":
      state.streamEl = null;
      state.thinkTokens = 0;
      activity.show("考えている");
      return;

    case "thinking.delta": {
      // 平文が来ないエージェント（Claude の thinking は署名だけ）もある。
      // 中身が来たときだけ箱を作り、来ないときは考えている量だけを稼働表示に出す。
      if (ev.text) {
        const box = thinkBox().querySelector(".think-body");
        box.textContent += ev.text;
        if (state.thinkEl.open) box.scrollTop = box.scrollHeight;
      }
      if (typeof ev.estimatedTokens === "number") state.thinkTokens = ev.estimatedTokens;
      activity.show(state.thinkTokens ? `考えている（約 ${state.thinkTokens} トークン）` : "考えている");
      return;
    }

    case "tool.start": {
      if (ev.id && state.toolCards.has(ev.id)) return state.toolCards.get(ev.id);
      state.streamEl = null;
      const stick = atBottom();
      const card = renderToolCall(ev.name, ev.input, { id: ev.id });
      ensureTurnEl().append(card);
      if (stick) log.scrollTop = log.scrollHeight;
      if (ev.id) state.toolCards.set(ev.id, card);
      activity.show(`${ev.name} を実行中`);
      return card;
    }

    // ツールの戻り。対応するカードに結果を差し込む（別の吹き出しにはしない）
    case "tool.result": {
      const card = state.toolCards.get(ev.id);
      if (card) { applyToolResult(card, ev); noteEndpointFailure(card, ev); }
      return;
    }

    case "activity":
      if (ev.state === "idle") return activity.hide();
      return activity.show(ev.label || ACTIVITY_LABEL[ev.state] || "動いている");

    case 'taskNotice':
      closeTurnEl();
      sys('Pleiad タスクの結果を受け取って再開しました');
      return;
    case "turnResult": {
      if (ev.outcome === "ok") return;             // 終わったことは稼働表示が消えれば分かる
      const what = ev.outcome === "aborted" ? "中断した" : `失敗: ${escText(ev.error ?? "理由不明")}`;
      closeTurnEl();
      sys(what);
      return;
    }

    case "auth":
      return onAuthEvent(ev);

    case "present": {
      if (ev.by === "human") {
        const rows = [...thread.querySelectorAll('.m[data-role="user"]')];
        const index = attachmentMessageIndex(rows.map(row => ({role:"user", at:row.dataset.at, text:row.querySelector('.body')?.textContent})), ev);
        const wrapper = append(renderPresent(ev), `live:${++liveSeq}`);
        wrapper.dataset.humanAttachment = "true";
        if (index >= 0) {
          let anchor = rows[index].closest('.mw');
          while (anchor.nextElementSibling?.dataset.humanAttachment === "true") anchor = anchor.nextElementSibling;
          anchor.after(wrapper);
          relayoutBranches();
        }
        return wrapper;
      }
      closeTurnEl();
      return append(renderPresent(ev), `live:${++liveSeq}`);
    }

    case "permission":
      return renderPermission(ev);

    case "session":
      if (ev.sessionId && state.current !== ev.sessionId) {
        state.current = ev.sessionId;
        syncTopbar();
      }
      return;

    case "status":
      if (ev.sessionId) sys(`状態 → <b>${escText(ev.status || "状態なし")}</b>（${escText(ev.by)}${ev.reason ? "：" + escText(ev.reason) : ""}）`);
      return refresh();

    case "statusIcon":
      return refresh();

    // グループ（fork のまとまり）から外れた / 戻った。会話には何も出さない（脇の見た目だけが変わる）
    case "group":
      return refresh();

    case "title":
      sys(`タイトル → <b>${escText(ev.title)}</b>（${escText(ev.by)}${ev.reason ? "：" + escText(ev.reason) : ""}）`);
      return refresh().then(paintBranchNames);

    case "fork":
      if (ev.by === "ai") sys(`分岐した（ai${ev.reason ? "：" + escText(ev.reason) : ""}）`);
      // 今の会話の家族が増えたなら系譜を読み直し、分岐点の印を置き直す
      return refresh().then(() => reloadBranches(ev));

    case "mode":
      sys(`承認モード → <b>${escText(state.modes[ev.mode]?.label ?? ev.mode)}</b>（${escText(ev.by)}${ev.live ? "" : "・次のターンから"}）`);
      return refresh();

    case "model":
      sys(`モデル → <b>${escText(ev.model ? state.models[ev.model]?.label ?? (state.endpoint ? compatModelText(ev.model) : ev.model) : state.models[""]?.resolvesTo ? `既定（${resolvedModel(state.models, "").label}）` : "既定")}</b>（${escText(ev.by)}${ev.live ? "" : "・次のターンから"}）`);
      return refresh();

    case "cwd":
      sys(`作業ディレクトリ → <b>${escText(ev.cwd)}</b>（${escText(ev.by)}${ev.reason ? "：" + escText(ev.reason) : ""}）`);
      return refresh();

    // 開始時と指示・Skills が変わっていたので、送信時に自動で読み込み直した（core/server.mjs の runTurn）
    case 'contextRefreshed': {
      const names = (ev.names ?? []).map(escText).join("・");
      const rest = ev.count > (ev.names ?? []).length ? ` ほか ${ev.count - (ev.names ?? []).length} 件` : "";
      sys(`指示・Skills が変わったので読み込み直しました${names ? `（${names}${rest}）` : ""}`);
      // 新しい記録はこの直後の contextUsage で届く。ここでは「変更あり」の印だけ先に消す
      if (state.contextInfo && state.contextInfoId === ev.sessionId) {
        state.contextInfo = { ...state.contextInfo, changed: { differs: false, paths: [], files: [] } };
        paintContextEntry();
        paintContextLine();
        sessionContext.refresh();
      }
      return;
    }

    // ターンの開始（と MCP の接続後）に届く、この会話が読み込んだものの記録
    case 'contextUsage': {
      // 開始時刻・外した MCP などは sessionContext の戻りにしか無いので、同じ会話なら前の値を引き継ぐ
      const id = state.current ?? state.contextInfoId;
      const prev = state.contextInfoId === id ? state.contextInfo : null;
      state.contextInfo = { ...prev, report: ev.report, owners: ev.report?.owners, pinned: isManagedContext(ev.report), changed: { differs: false, paths: [], files: [] } };
      state.contextInfoId = id;
      paintContextEntry();
      paintContextLine();
      sessionContext.refresh();
      return;
    }

    case "running":
      // 走っている本数はサーバが持っている。こちらはそれに合わせるだけ
      applyRunning(ev);
      return;

    case "turnEnd":
      closeTurnEl();
      // 区切りが来ないままターンが終わった分。エージェントは次のターンとして答える（claude で実測）。
      // 待っているものは何も走っていないので、回る弧はここで外す
      for (const row of thread.querySelectorAll('.mw[data-delivery-pending]')) markDelivery(row, 'late');
      state.awaitingSession = false;
      state.submitting = false;
      if (ev.sessionId) state.runningIds.delete(ev.sessionId);
      syncRunState();
      syncHistory();
      return refresh();
  }
}

/** running イベント / running コマンドの戻り。走っているもの・待っているものを一覧と稼働表示へ */
function applyRunning(work) {
  state.work = work ?? { count: 0, turns: [], permissions: [], subagents: [], background: [] };
  syncAgentTasks();
  syncBackgroundEntry();
  const running = new Set((state.work.turns ?? []).map((t) => t.sessionId).filter(Boolean));
  const waiting = new Set((state.work.permissions ?? []).map((p) => p.sessionId).filter(Boolean));
  // 誰が答えたか（別のタブ・中断）に関わらず、残っている承認はサーバが正。
  // 消えた分を覚えたままにすると、次にその会話を開いたとき解決済みのカードが出る
  const unresolved = new Set((state.work.permissions ?? []).map((p) => p.id));
  for (const id of state.pendingPerms.keys()) if (!unresolved.has(id)) state.pendingPerms.delete(id);
  const behind = new Map();
  for (const t of state.work.turns ?? []) {
    const b = behindOf(t);
    if (b && t.sessionId) behind.set(t.sessionId, b.n);
  }
  // ターンの外で裏に残っている作業（Codex の端末）。ターンが走っていればそちらが優先（弧）
  for (const x of state.work.background ?? []) {
    if (!x.sessionId || running.has(x.sessionId)) continue;
    const b = behindOfTasks(x.tasks);
    if (b) behind.set(x.sessionId, b.n);
  }
  // 4 秒ごとの放送で印が変わっていなければ一覧を描き直さない
  const changed = !sameSet(running, state.runningIds) || !sameSet(waiting, state.waitingIds)
    || behind.size !== state.bgWaiting.size || [...behind].some(([id, n]) => state.bgWaiting.get(id) !== n);
  state.runningIds = running;
  state.waitingIds = waiting;
  state.bgWaiting = behind;
  if (state.current && state.runningIds.has(state.current)) state.submitting = false;
  syncRunState();
  activity.sync();
  paintSettingsNotice();
  if (changed) renderSessions();
  // サブエージェントはこの会話の分だけ稼働表示に出す。他所の分は一覧の行に付く
  // 数は走っている子だけ（status が null＝分からない子も走っている側）。終わった子はダイアログに並ぶだけ
  const subs = subagentsHere();
  const live = subs.filter(subagentLive).length;
  activity.work(live, subs.length - live);
  // 会話を読んでいる間は描き直さない（4 秒ごとの配信で一覧へ戻されてしまう）
  if ($("workDialog").open && $("workBody").dataset.view === "list" && !$("workBody").contains(document.activeElement)) renderWorkDialog();
  if ($("workDialog").open && $("workBody").dataset.view === "background") refreshBackgroundDetail();
  if ($("workDialog").open && $("workBody").dataset.view === 'ply-tasks' && !$("workBody").contains(document.activeElement)) renderAgentTasks();
  // 走り出したばかりのセッションはまだ一覧に無い。そのときだけ取り直す
  for (const id of state.runningIds) {
    if (state.sessions.some((x) => x.id === id) || state.askedFor.has(id)) continue;
    state.askedFor.add(id);
    refresh();
    break;
  }
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

// ---------------------------------------------------------------- コマンド

function cmd(command, args = {}) {
  const id = String(++seq);
  return new Promise((res, rej) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return rej(new Error("未接続"));
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ kind: "command", command, id, args }));
  });
}

// ---------------------------------------------------------------- エージェント
// 実行先と次ターンの予約を区別する。履歴の発言は生成したエージェントを表示する。
// できること（fork / タイトル提案 / 常に許可 / サブエージェント）はエージェントごとに違うので、
// capabilities を見て口を出し分ける。押せるのに何も起きない口は作らない。

/** 今の会話が対応を終えたエージェントのものなら、続けられない理由（core/backends/index.mjs の RETIRED） */
function retiredHere() {
  return state.sessions.find((x) => x.id === state.current)?.retired ?? null;
}

function activeBackendId() {
  const s = state.sessions.find((x) => x.id === state.current);
  return s?.backend ?? state.backendId ?? null;
}

function capsOf(id) {
  return state.backends.find((b) => b.id === id)?.capabilities ?? {};
}

function labelOf(id) {
  return state.backends.find((b) => b.id === id)?.label ?? id ?? "";
}

/** 一覧に2つ以上並ぶときだけ、どのエージェントのものか出す（1つなら情報にならない）。 */
function backendLabels() {
  if (state.backends.length <= 1) return null;
  return Object.fromEntries(state.backends.map((b) => [b.id, b.label]));
}

async function loadBackends() {
  if (state.backends.length) return state.backends;
  const list = await cmd("backends").catch(() => []);
  state.backends = Array.isArray(list) ? list : [];
  for (const b of state.backends) applyToolHints(b.toolHints);
  state.backendId = state.backends.some((b) => b.id === state.prefs.backend)
    ? state.prefs.backend : state.backendId ?? state.backends[0]?.id ?? null;
  state.shownBackend ??= state.backendId;
  controls.paint();
  // 認証の状態はエージェントを引いたときに 1 回だけ。以降はログイン / ログアウトの後に取り直す
  refreshAuth().catch(() => {});
  return state.backends;
}

/** そのエージェントの語彙（承認モード / モデル）。値の意味はこちらでは解釈しない。 */
async function loadVocab(id) {
  if (!id) return { modes: {}, models: {} };
  if (state.vocab.has(id)) return state.vocab.get(id);
  return fetchVocab(id);
}

async function fetchVocab(id) {
  const [modes, models] = await Promise.all([
    cmd("modes", { backend: id }).catch(() => ({})),
    cmd("models", { backend: id }).catch(() => ({})),
  ]);
  const v = { modes: modes ?? {}, models: models ?? {} };
  // 失敗（切断中の cmd は即 reject する）で空になったものはキャッシュしない。
  // 掴んだままだと承認モード・モデルの候補が空のまま固定され、選んであった値が黙って既定へ戻る
  if (Object.keys(v.modes).length && Object.keys(v.models).length) state.vocab.set(id, v);
  return v;
}

/**
 * 語彙を裏で取り直す（モデルの面を開いたとき）。codex のモデルは更新や入れ替えで変わる。
 * 届くまでは覚えている一覧を出したまま。空（失敗）なら fetchVocab が覚えている方を残す
 */
function revalidateVocab(id) {
  if (!id) return;
  const before = state.vocab.get(id);
  fetchVocab(id).then((v) => {
    if (state.vocab.get(id) !== v || JSON.stringify(before) === JSON.stringify(v)) return;
    syncTopbar().catch(() => {});
  }).catch(() => {});
}

/** ログイン・ログアウトの後。使えるモデルはアカウントで変わるので、覚えた語彙を捨てて描き直す */
function forgetVocab(id) {
  state.vocab.delete(id);
  syncTopbar().catch(() => {});
}

// ---------------------------------------------------------------- エージェントの認証
// ログインの持ち方はエージェントごとに違う（Claude は Claude Code のログインをそのまま、
// codex は app-server 越しに ChatGPT）。capabilities.login が真のものだけ。
// 置き場は設定メニューの中。常設しない。ログインが要るときだけ脇の下に一行で知らせる。
// 設定モーダル内にURLを出し、コールバックを取れないときは手貼りの欄を出す。

/** 認証の状態を取り直す。refresh() は毎イベント走るので、ここは起動時とログイン / ログアウトの後だけ */
async function refreshAuth() {
  const targets = state.backends.filter((b) => b.capabilities?.login);
  await Promise.all(targets.map(async (b) => {
    const st = await cmd("authStatus", { backend: b.id }).catch((e) => ({ supported: false, error: e.message }));
    state.auth.set(b.id, st);
  }));
  renderAuth();
  await onboarding.refresh();
}

function renderAuth() {
  const sec = $("authSec");
  const targets = state.backends.filter((b) => b.capabilities?.login);
  sec.hidden = targets.length === 0;
  sec.replaceChildren();
  if (!targets.length) { $("authNeed").hidden = true; return; }
  sec.append(el("div", "head", "エージェント"));
  const need = [];
  for (const b of targets) {
    const st = state.auth.get(b.id) ?? {};
    const row = el("div", "auth-row");
    row.append(el("span", "name", b.label));
    const text = st.installed === false ? "未インストール" : !st.supported ? (st.error ? `見られない: ${st.error}` : "ログインを扱えない")
      : st.pending ? "ログインを待っている"
      : st.loggedIn ? (st.account || "ログイン済み")
      : "未ログイン";
    const s2 = el("span", "st", text);
    if (st.detail && st.loggedIn) s2.title = st.detail;
    row.append(s2);
    if (st.installed === false && st.installUrl) {
      const link = el("a", "btn", "インストール");
      link.href = st.installUrl; link.target = "_blank"; link.rel = "noreferrer";
      row.append(link);
    } else if (st.supported && !st.pending) {
      const loggedIn = st.loggedIn;
      const btn = el("button", "btn", loggedIn ? "ログアウト" : "ログイン");
      btn.type = "button";
      btn.onclick = (e) => { e.stopPropagation(); if (loggedIn) authLogout(b); else authLogin(b); };
      row.append(btn);
    }
    // 会話ごとに選べる Claude のアカウント（Pleiad が claude setup-token を回して発行したトークン）
    if (b.capabilities?.claudeAccounts && st.installed !== false) {
      const button = el('button', 'btn', 'アカウント'); button.type = 'button'; button.onclick = () => claudeAccounts.open(); row.append(button);
    }
    // 互換の接続先（Claude Code の Anthropic 互換・Codex の Responses 互換）。同じページの下に管理の面を開く
    if (b.capabilities?.compatEndpoints && st.installed !== false) {
      const button = el('button', 'btn', '接続先'); button.type = 'button';
      button.setAttribute('aria-expanded', String(compatEndpoints.openAgent === b.id));
      button.onclick = () => compatEndpoints.open(b.id);
      row.append(button);
    }
    sec.append(row);
    if (st.installed !== false && st.supported && !st.loggedIn && !st.pending) need.push(b.label);

    const box = authUrlBox(b.id);
    if (box) sec.append(box);
  }
  const line = $("authNeed");
  line.hidden = need.length === 0;
  if (need.length) line.textContent = `${need.join("・")} にログインが要る`;
}

/**
 * ログインの URL と、コールバックを取れないときの手貼り。
 * 設定画面と初期設定ダイアログの両方に出す。**初期設定は modal なので、
 * ここを設定画面にしか出さないと、初回の利用者はログインを終われない。**
 */
function authUrlBox(id) {
  const b = state.backends.find((x) => x.id === id);
  const pend = b && state.authUrl.get(id);
  if (!pend) return null;
  const frag = document.createDocumentFragment();
  const box = el("div", "auth-url");
  if (/^https?:\/\//i.test(pend.url)) {
    const a = el("a", null, pend.url);
    a.href = pend.url; a.target = "_blank"; a.rel = "noreferrer";
    box.append(a);
  } else box.append(el("span", null, pend.url));
  if (pend.message) box.append(el("div", null, pend.message));
  frag.append(box);
  // 貼り戻しを受けられるバックエンドにだけ入力欄を出す。
  // 受け取る口が無いのに出すと、貼っても何も起きない欄になる（agy がそれ）
  if (pend.message && b.capabilities?.submitCode) {
    const paste = el("div", "auth-paste");
    const inp = document.createElement("input");
    inp.className = "field";
    inp.placeholder = "リダイレクト先の URL か code を貼る";
    const send = el("button", "btn", "送る");
    send.type = "button";
    const submit = async () => {
      const v = inp.value.trim();
      if (!v) return;
      send.disabled = true;
      try {
        await cmd("authSubmit", { backend: b.id, input: v });
      } catch (err) {
        sys(`${escText(b.label)} のログインに失敗: ${escText(err.message)}`);
        send.disabled = false;
      }
    };
    send.onclick = (e) => { e.stopPropagation(); submit(); };
    inp.onkeydown = (e) => { if (isComposingKey(e)) return; if (e.key === "Enter") { e.preventDefault(); submit(); } };
    paste.append(inp, send);
    frag.append(paste);
  }
  return frag;
}

/** ログインは完了まで返ってこない（サーバがコールバックを待つ。10 分で時間切れ）。応答待ちで画面を止めない */
function authLogin(b) {
  state.auth.set(b.id, { ...(state.auth.get(b.id) ?? {}), supported: true, pending: true });
  renderAuth();
  onboarding.paint();
  let failure;
  cmd("authLogin", { backend: b.id })
    .catch((e) => { failure = e; sys(`${escText(b.label)} のログインに失敗: ${escText(e.message)}`); })
    .finally(async () => {
      state.authUrl.delete(b.id);
      forgetVocab(b.id);
      await refreshAuth().catch(() => {});
      if (failure) $("setupError").textContent = `${b.label} のログインに失敗: ${failure.message}。もう一度ログインしてください。`;
    });
}

async function authLogout(b) {
  try {
    await cmd("authLogout", { backend: b.id });
  } catch (e) {
    sys(`${escText(b.label)} のログアウトに失敗: ${escText(e.message)}`);
  }
  forgetVocab(b.id);
  await refreshAuth().catch(() => {});
}

function onAuthEvent(ev) {
  const b = state.backends.find((x) => x.id === ev.backend);
  const name = b?.label ?? ev.backend ?? "";
  if (ev.phase === "url") {
    // URL はサーバ経由とはいえ外から来うる。http(s) だと確かめたものだけリンクにする
    state.authUrl.set(ev.backend, { url: String(ev.url ?? ""), message: ev.message ? String(ev.message) : "" });
    renderAuth();
    onboarding.paint();             // 初期設定ダイアログの中でログインを始めたときは、そちらに出す
    openSettings();                 // 進め方が見える場所に居てもらう
    const row = el("div", "m sys", `${name} のログイン: `);
    const url = String(ev.url ?? "");
    const a = el("a", null, url);
    if (/^https?:\/\//i.test(url)) { a.href = url; a.target = "_blank"; a.rel = "noreferrer"; }
    row.append(a);
    if (ev.message) row.append(el("span", null, ` ${ev.message}`));
    return append(row);
  }
  state.authUrl.delete(ev.backend);
  if (ev.phase === "error") sys(`${escText(name)} のログインに失敗: ${escText(ev.message ?? "")}`);
  else sys(`${escText(name)}: ${escText(ev.message ?? "ログインした")}`);
  refreshAuth().catch(() => {});
}

// ---------------------------------------------------------------- 入力欄の combo
// 人間が入力する箇所は同時に候補も出す（docs/design-system.md §2.4）。

let settingsWrite = Promise.resolve();
let modeWrite = Promise.resolve();
let settingsFailure = null;
let failedSettingsPatch = null;
function reserveSettings(patch) {
  const id = state.current;
  if (!id) return;
  settingsWrite = settingsWrite.catch(() => {}).then(async () => {
    const s = state.sessions.find(s => s.id === id);
    const value = await cmd("setTurnSettings", { sessionId: id, ...patch });
    if (s) s.nextSettings = value;
    settingsFailure = null;
    $("retrySettings").hidden = true;
    if (state.current === id) { $("settingsError").textContent = ""; await syncTopbar(); }
  });
  settingsWrite.catch(e => {
    settingsFailure = id;
    failedSettingsPatch = patch;
    if (state.current === id) {
      $("settingsError").textContent = `設定を保存できませんでした: ${e.message}`;
      $("retrySettings").hidden = false;
    }
  });
  return settingsWrite;
}
function paintSettingsNotice() {
  const s = state.sessions.find(s => s.id === state.current);
  const next = s?.nextSettings;
  $("nextSettings").hidden = !next;
  if (next) {
    const changes = [];
    // 既定のモデルは実際に当たる名前を添える（分からなければ「既定」だけ）
    const fallback = state.models[""]?.resolvesTo || state.models[""]?.resolvedLabel ? `既定（${resolvedModel(state.models, "").label}）` : "既定";
    const nextEndpoint = next.endpoint ?? (next.backend !== s.backend ? "" : s.compatEndpoint ?? "");
    // 互換の接続先のモデルは表示名（web/compat-models.mjs。札を置けないので 1M は（1M））
    const epMain = nextEndpoint ? compatEndpoints.get(nextEndpoint)?.roles?.main : "";
    const epFallback = nextEndpoint ? `既定（${epMain ? compatModelText(epMain) : "接続先のメイン"}）` : fallback;
    if (next.backend !== s.backend || next.model !== (s.model ?? "")) changes.push(`${labelOf(next.backend)} / ${next.model ? (nextEndpoint ? compatModelText(next.model) : state.models[next.model]?.label ?? next.model) : epFallback}${next.backend !== s.backend && !next.model && fallback === "既定" ? "（変更先の既定モデル）" : ""}`);
    if (next.effort !== undefined && next.effort !== (s.effort ?? "")) changes.push(`エフォート: ${next.effort || "既定に従う"}`);
    if (next.cwd) changes.push(`作業ディレクトリ: ${next.cwd}`);
    if (next.mode !== undefined) changes.push(`承認モード: ${state.modes[next.mode]?.label ?? next.mode}`);
    if (next.endpoint !== undefined) changes.push(`接続先: ${endpointLabel(next.endpoint)}`);
    if (next.account !== undefined) changes.push(`アカウント: ${accountLabel(next.account)}`);
    $("nextSettingsText").textContent = `${changes.join(" · ")} · 次に送信すると適用されます`;
  }
}
$("cancelSettings").onclick = () => reserveSettings({ cancel: true });
$("retrySettings").onclick = () => { if (settingsFailure === state.current) reserveSettings(failedSettingsPatch); };

/** 最近使った作業ディレクトリ。いつ使ったかを添える */
function cwdOptions() {
  const seen = new Map();
  for (const s of state.sessions) {
    if (!s.cwd) continue;
    if (!seen.has(s.cwd) || (s.lastModified ?? 0) > seen.get(s.cwd)) seen.set(s.cwd, s.lastModified ?? 0);
  }
  return [...seen].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([d, t]) => ({ value: d, hint: relTime(t), time: t }));
}

// Claude のアカウントの設定（web/claude-accounts.mjs）。入力欄のチップが候補を引くので、controls より先に作る
const claudeAccounts = setupClaudeAccounts({ cmd,
  openSettings: () => { if ($('onboardingDialog').open) $('onboardingDialog').close(); onboarding.open(); },
  onChange: () => { syncTopbar().catch(() => {}); } });
/** Claude のアカウントの候補。選んでいたものが消えていれば、その旨の行を残す（黙って別のものに見せない） */
function accountOptions() {
  const s = state.sessions.find((x) => x.id === state.current);
  const value = s?.nextSettings?.account ?? s?.claudeAccount ?? "";
  const list = claudeAccounts.list();
  return [
    { value: "", label: "ログイン中", hint: "ログイン中のアカウント" },
    ...list.map((a) => ({ value: a.id, label: a.name, hint: a.hasToken ? "" : "トークン未登録" })),
    ...(value && !list.some((a) => a.id === value) ? [{ value, label: "削除されたアカウント", hint: "選び直してください" }] : []),
  ];
}
function accountLabel(id) {
  if (!id) return "ログイン中のアカウント";
  return claudeAccounts.list().find((a) => a.id === id)?.name ?? "削除されたアカウント";
}
let accountWarning = "";
/** 入力欄のアカウントの出し分け。登録が無く、選んでもいない会話には、モデルの面にアカウントの節を出さない */
async function syncAccount(s, bid) {
  const supported = Boolean(capsOf(bid).claudeAccounts);
  const list = supported ? await claudeAccounts.load().catch(() => []) : [];
  const value = s?.nextSettings?.account ?? s?.claudeAccount ?? "";
  state.accountShown = Boolean(s) && supported && (list.length > 0 || Boolean(value));
  const chosen = list.find((a) => a.id === value);
  const warning = !state.accountShown || !value ? "" : !chosen ? "選択中の Claude のアカウントは削除されています。アカウントを選び直してください"
    : !chosen.hasToken ? `Claude のアカウント「${chosen.name}」のトークンが未登録です。設定から貼り付けてください` : "";
  if (accountWarning && $("settingsError").textContent === accountWarning) $("settingsError").textContent = "";
  accountWarning = warning;
  if (warning) $("settingsError").textContent = warning;
  state.account = value;
}

// 互換の接続先の設定（web/compat-endpoints.mjs）。入力欄の面が候補を引くので、controls より先に作る
const compatEndpoints = setupCompatEndpoints({ cmd,
  openSettings: () => { if ($('onboardingDialog').open) $('onboardingDialog').close(); onboarding.open(); },
  onChange: () => { syncTopbar().catch(() => {}); },
  officialLine: (agent) => { const st = state.auth.get(agent); return st?.loggedIn ? (st.account || 'ログイン済み') : ''; } });
compatEndpoints.onOpen(() => renderAuth());
function endpointLabel(id) {
  if (!id) return "公式";
  return compatEndpoints.get(id)?.name ?? "削除された接続先";
}
/** 会話の次のターンの接続先（予約があればそれ。エージェントを変える予約で接続先が書かれていなければ公式） */
function endpointOf(s) {
  if (!s) return "";
  const next = s.nextSettings;
  return next?.endpoint ?? (next && next.backend !== s.backend ? "" : s.compatEndpoint ?? "");
}
let endpointWarning = "";
/** 入力欄の接続先の出し分け。選べないエージェントでは節を出さない。消えた・確認に失敗した接続先は入力欄の上に一文 */
async function syncEndpoint(s, bid) {
  const supported = Boolean(capsOf(bid).compatEndpoints);
  const list = supported ? await compatEndpoints.load().catch(() => []) : [];
  const value = supported ? endpointOf(s) : "";
  state.endpointShown = Boolean(s) && supported;
  const chosen = list.find((e) => e.id === value);
  const warning = !value ? "" : !chosen ? "選択中の接続先は削除されています。モデルのチップの面で接続先を選び直してください"
    : chosen.ready === false ? `接続先「${chosen.name}」は前回の確認に失敗しています。設定 › エージェント設定の「接続先」で確認し直してください` : "";
  if (endpointWarning && $("settingsError").textContent === endpointWarning) $("settingsError").textContent = "";
  endpointWarning = warning;
  if (warning) $("settingsError").textContent = warning;
  state.endpoint = value;
}
/** 入力欄のモデルの面に渡す接続先の値と口（web/composer-controls.mjs の endpointSection / compatModelSection） */
function endpointView(bid) {
  if (!state.endpointShown) return null;
  const list = compatEndpoints.list(bid);
  const defaults = compatEndpoints.defaults();
  const row = list.find((e) => e.id === state.endpoint) ?? null;
  const official = bid === "claude" ? "Anthropic · ログイン中のアカウントで使う" : "OpenAI · ChatGPT のログインで使う";
  return {
    selected: state.endpoint, row, lost: lostText(bid),
    roleNames: bid === "claude" ? CLAUDE_ROLES.map((r) => [r.key, r.short]) : [],
    options: [
      { value: "", label: "公式", sub: official, isDefault: !defaults[bid] },
      ...list.map((e) => ({ value: e.id, label: e.name, isDefault: defaults[bid] === e.id, warn: e.ready === false,
        sub: `${KIND_LABEL[e.kind]} · ${e.baseUrl.replace(/^https?:\/\//, "")}${e.ready === false ? " · ⚠ 確認に失敗しています" : ""}`, title: `${e.name}（${e.baseUrl}）` })),
      ...(state.endpoint && !row ? [{ value: state.endpoint, label: "削除された接続先", sub: "選び直してください", gone: true }] : []),
    ],
    manage: () => compatEndpoints.open(bid),
  };
}

// 入力欄の設定のチップ（web/composer-controls.mjs）。値は state に持ち、チップは get() で毎回読む
const controls = setupComposerControls({
  cmd,
  get: () => {
    const bid = state.shownBackend ?? activeBackendId();
    return {
      cwd: state.cwd, recent: cwdOptions(),
      backends: state.backends, backend: bid,
      // エージェントが 1 つしか無ければ選ぶ口を出さない
      backendSwitchable: state.backends.length > 1,
      models: state.models, model: state.model,
      efforts: state.efforts, effort: state.effort, effortDisabled: state.effortDisabled,
      accounts: state.accountShown ? accountOptions() : null, account: state.account,
      endpoint: endpointView(bid),
      modes: state.modes, mode: state.mode,
    };
  },
  on: {
    cwd: (v) => {
      state.cwd = v;
      controls.paint();
      if (state.current) reserveSettings({ cwd: v });
      else state.draft.cwd = v;
    },
    backend: (v) => { state.shownBackend = v; controls.paint(); reserveSettings({ backend: v, model: "" }); },
    model: (v) => { state.model = v; controls.paint(); reserveSettings({ model: v, rememberModel: true }); },
    // 互換の接続先。'' は公式。モデルは接続先の既定（メイン）に戻る（server も同じ）
    endpoint: (v) => { state.endpoint = v; state.model = ""; state.effort = ""; controls.paint(); reserveSettings({ endpoint: v }); },
    // Claude のアカウント。'' はログイン中のアカウント（既定）
    account: (v) => { state.account = v; controls.paint(); reserveSettings({ account: v }); },
    effort: (effort) => { state.effort = effort; controls.paint(); reserveSettings({ effort, rememberEffort: true }); },
    mode: (v) => {
      state.mode = v;
      controls.paint();
      const sessionId = state.current, backend = activeBackendId();
      const s = state.sessions.find(s => s.id === sessionId);
      if (s?.nextSettings?.backend && s.nextSettings.backend !== backend) {
        reserveSettings({ mode: v, rememberMode: true });
        return;
      }
      // 既存セッションなら覚えさせる。新規はこの後の最初の runTurn に載る
      modeWrite = modeWrite.catch(() => {}).then(() => sessionId
        ? cmd("setMode", { sessionId, mode: v, reason: "手動で変更" })
        : cmd("setPref", { key: "mode", value: v, backend }));
      modeWrite.catch(e => sys(`承認モードを保存できませんでした: ${escText(e.message)}`));
    },
    // モデルの面を開いた。候補を裏で取り直し、変わっていたら描き直す
    openModel: () => revalidateVocab(state.shownBackend ?? activeBackendId()),
  },
});

// カーソル位置の「/」。候補はコンテキスト画面と同じ探索結果から来る（core の slashSkills）。
// 送信・下書きの後片付けからも触るので、入力欄と送信の配線より先に用意する
const slashSkills = setupSlashSkills({
  input: $("prompt"),
  list: $("skillList"),
  hint: $("slashHint"),
  cwd: () => state.cwd.trim() || state.draft.cwd || "",
  load: (cwd) => cmd("slashSkills", { cwd: cwd || undefined }),
});

// ---------------------------------------------------------------- セッション一覧（web/side.mjs）

const side = createSide({
  onOpen: (id) => (id == null ? startNew(state.draft) : select(id)),
  onNew: startNew,
  onSetStatus: (id, status) => {
    if (id == null) {
      state.draft.status = status || null;
      side.keep(status);
      renderSessions();
      return;
    }
    side.keep(status);
    setStatusOf(id, status);
  },
  onSetIcon: (status, icon) => cmd("setStatusIcon", { status, icon })
    .catch((e) => sys(`アイコンの変更に失敗: ${escText(e.message)}`)),
  onContext: (s, x, y) => rowMenu(s, x, y),
  onGroupContext: (st, x, y) => groupMenu(st, x, y),
  onFamilyContext: (root, members, x, y) => familyMenu(root, members, x, y),
  onSetGrouped: (s, ungrouped) => setGrouped(s, ungrouped),
  onJoinGroup: (s, root) => joinGroup(s, root),
  onMoveGroup: (root, status) => moveGroup(root, status),
  onListContext: (x, y) => showMenu(x, y, [newGroupItem()]),
  onSettings: () => openSettings(),
  cwdNow: () => state.cwd,
});

function renderSessions() {
  side.render(state.sessions, {
    statuses: state.statuses,
    currentId: state.current,
    runningIds: state.runningIds,
    waitingIds: state.waitingIds,
    bgWaiting: state.bgWaiting,
    unreadIds: new Set(state.sessions.filter(s => readCompletions.hasUnread(s)).map(s => s.id)),
    draft: null,      // 新規のときだけ。予約は current が無いときに意味を持つ
    backendLabels: backendLabels(),
  });
}

function acknowledgeDisplayed(id, completedAt) {
  displayedCompletions.set(id, Math.max(displayedCompletions.get(id) ?? 0, completedAt ?? 0));
  if (document.visibilityState === "visible") readCompletions.mark(id, displayedCompletions.get(id));
  renderSessions();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.current && !state.loadingSession) {
    acknowledgeDisplayed(state.current, displayedCompletions.get(state.current));
  }
});
window.addEventListener("storage", ev => {
  if (ev.key === READ_STORE) { readCompletions.merge(ev.newValue); renderSessions(); }
});

/** 新しいセッション。絞り込みの条件（一意に定まるもの）を引き継ぐ */
let creatingSession = null;
async function startNew({ status = null, cwd = "", backend } = {}) {
  if (state.busy || creatingSession) return creatingSession;
  saveDraft().catch(() => {});
  const source = state.current;
  creatingSession = (async () => {
    try {
      await settingsWrite.catch(() => {});
      await modeWrite;
      const result = await cmd("newSession", { sourceSessionId: source, backend: backend ?? (source ? undefined : state.prefs.backend ?? state.backendId),
        cwd: cwd || state.cwd || state.homeDir || "", status });
      side.keep(status);
      await refresh();
      if (state.current === source) { await select(result.sessionId); $("prompt").focus(); }
      return result.sessionId;
    } catch (e) { sys(`セッションを保存できませんでした: ${escText(e.message)}`); }
    finally { creatingSession = null; }
  })();
  return creatingSession;
}

function branchIsFresh(id) {
  const r = branches.family?.rows.get(id);
  return Boolean(r) && r.messages.length === r.k + 1;
}

// ---------------------------------------------------------------- サブエージェント
// 会話が終わってもサブエージェントが残ることがある。この会話の分は稼働表示から辿れるようにする。

/**
 * いま開いている画面に属する項目か。
 * id の決まっていないターン（走り出したばかり）を「新規セッション」の分として数えてはいけない。
 * 自分が送った直後（submitting）だけ、id 無しを自分の分とみなす。
 * ※ tests/unit/work-attribution.mjs に同じ規則を写してある。変えたら合わせること。
 */
function belongsHere(x) {
  if (state.current) return x.sessionId === state.current;
  return state.submitting && !x.sessionId;
}

/** 稼働表示のボタンの数と一覧に出す分。同じ規則で数える（tests/unit/work-attribution.mjs） */
const subagentsHere = () => (state.work.subagents ?? []).filter(belongsHere);
/** 走っている子か。状態を返せないバックエンドの子（status: null）も走っている側に置く（server の count と同じ） */
const subagentLive = (a) => a.status === "running" || a.status == null;

/**
 * 行の左端に置く状態の印（docs/design-system.md §2.2）。running は回る弧（走っている間だけ DOM に置く）、
 * 終わった子は静止した印。status が null（分からない）なら印を置かない
 */
const STATE_MARK = {
  running: { label: "実行中" },
  completed: { shape: "done", label: "完了" },
  failed: { shape: "fail", label: "失敗" },
  stopped: { shape: "stop", label: "停止" },
};
function stateMark(status) {
  const m = STATE_MARK[status];
  if (!m) return null;
  if (m.shape) return stillMark(m.shape, m.label);
  const run = runMark(m.label);
  run.setAttribute("role", "img");
  run.setAttribute("aria-label", m.label);
  return run;
}

const plyTasksHere = () => (state.work.tasks ?? []).filter(t => t.parentSessionId === state.current || t.sessionId === state.current);
function syncAgentTasks() {
  const tasks = plyTasksHere();
  $('agentTasksEntry').hidden = !tasks.length;
  $('agentTasksEntry').textContent = `Pleiad タスク · ${tasks.length}`;
}
const TASK_STATUS = { queued: '待機中', running: '実行中', cancelling: '停止中', waiting: '承認待ち', completed: '完了', failed: '失敗', cancelled: '停止済み', interrupted: '中断' };
// Pleiad タスクの状態 -> 行の印（サブエージェント行と同じ語彙）。まだ終わっていないものは弧、文字の状態はそのまま残す
const TASK_MARK = { queued: 'running', running: 'running', cancelling: 'running', waiting: 'running',
  completed: 'completed', failed: 'failed', cancelled: 'stopped', interrupted: 'stopped' };
function renderAgentTasks() {
  const body = $('workBody');
  $('workTitle').textContent = 'Pleiad タスク';
  body.dataset.view = 'ply-tasks';
  body.replaceChildren();
  for (const task of plyTasksHere()) {
    const group = el('div', 'sec ply-task');
    group.append(workRow(task.task, `Pleiad 管理 · ${labelOf(task.backend)} · ${TASK_STATUS[task.status] ?? task.status}`,
      () => { $('workDialog').close(); select(task.sessionId); }, '会話を見る', stateMark(TASK_MARK[task.status])));
    if (task.sessionId === state.current) group.append(workRow('依頼元の会話', sessionLabel(task.parentSessionId), () => { $('workDialog').close(); select(task.parentSessionId); }, '開く'));
    if (task.error) group.append(el('div', 'work-head', task.error));
    if (task.notification === 'unknown') group.append(el('div', 'work-head', '完了通知の配送結果は不明です。子の会話で結果を確認してください。'));
    if (['queued', 'running'].includes(task.status)) {
      const stop = el('button', 'btn btn-quiet', 'タスクを停止'); stop.type = 'button';
      stop.onclick = async () => {
        stop.disabled = true;
        try { await cmd('cancelAgentTask', { taskId: task.taskId }); }
        catch (e) { group.append(el('div', 'work-head', e.message)); stop.disabled = false; }
      };
      group.append(stop);
    }
    body.append(group);
  }
}
$('agentTasksEntry').onclick = () => { renderAgentTasks(); $('workDialog').showModal(); };

function sessionLabel(id) {
  if (!id) return "（新しいセッション）";
  return state.sessions.find((x) => x.id === id)?.title ?? id.slice(0, 8);
}

function workRow(label, sub, onClick, badge, mark = null) {
  const row = el("button", "work-row");
  row.type = "button";
  if (mark) { row.classList.add("has-mark"); row.append(mark); }
  row.append(el("span", "work-label", label), el("span", "work-sub", sub ?? ""));
  if (badge) row.append(el("span", "work-badge", badge));
  row.onclick = onClick;
  return row;
}

/**
 * 一覧。このセッションのサブエージェントと、ターンの外に残っている裏の作業を出す。
 * main のターンと承認待ちは稼働表示と承認カードで見えているので載せない。
 */
function renderWorkDialog() {
  backgroundView = null;
  const body = $("workBody");
  const behind = backgroundHere();
  $("workTitle").textContent = behind.length ? "裏で動いているもの" : "サブエージェント";
  body.dataset.view = "list";
  body.replaceChildren(...subagentsHere().map((a) => workRow(a.description || a.id,
    `${a.messages} メッセージ${a.lastAt ? " · 最終 " + relTime(a.lastAt) : ""}`,
    () => openSubagent(a), "会話を見る", stateMark(a.status))));

  // 行は詳細を見る操作。停止は独立したボタンだけで実行する。
  for (const { task, entry } of behind) {
    const canStop = Boolean(capsOf(entry.backend).stopBackground);
    const group = el('div', 'work-task');
    const row = workRow(task.label || task.id, KIND_SUB[task.kind] ?? "裏で動いている",
      () => openBackground(task, entry), '詳細を見る');
    group.append(row);
    if (canStop) group.append(backgroundStopButton(entry.sessionId, task));
    body.append(group);
  }

  // 終わった子もターンが終わるまでは並ぶので「動いている」とは言わない。ターンが終わると一覧から外れる
  if (!body.childElementCount) body.append(el("div", "work-head", "このターンのサブエージェントはありません"));
}

/**
 * この会話で裏に動いているものを、行ごとに平らにする。
 *
 * 2 つある。ターンの外に残っているもの（Codex の端末）と、
 * 走っているターンが抱えているもの（Claude のバックグラウンドのコマンド）。
 * ターンの中のサブエージェントは会話を読む専用の行が別にあるので、ここでは重ねない。
 */
function backgroundHere() {
  const rows = (state.work.background ?? []).filter(belongsHere)
    .flatMap((entry) => (entry.tasks ?? []).map((task) => ({ task, entry })));
  for (const t of (state.work.turns ?? []).filter(belongsHere)) {
    for (const task of t.background ?? []) {
      if (task.kind === "agent") continue;
      rows.push({ task, entry: { sessionId: t.sessionId, backend: t.backend } });
    }
  }
  return rows;
}

function syncBackgroundEntry() {
  const tasks = backgroundHere();
  const button = $('backgroundEntry');
  button.hidden = !tasks.length;
  button.textContent = `${tasks.every(x => x.task.kind === 'terminal') ? '端末' : 'バックグラウンド'} · ${tasks.length}`;
}
$('backgroundEntry').onclick = openWork;

function backgroundStopButton(sessionId, task) {
  const button = el('button', 'btn btn-quiet work-stop', '停止');
  button.type = 'button';
  button.setAttribute('aria-label', `${task.label || task.id} を停止`);
  button.onclick = () => stopBackground(button, sessionId, task);
  return button;
}

let backgroundView = null;
function openBackground(task, entry) {
  const body = $('workBody');
  body.dataset.view = 'background';
  $('workTitle').textContent = KIND_SUB[task.kind] ?? 'バックグラウンド';
  const actions = el('div', 'work-actions');
  const back = el('button', 'btn work-back', '← 一覧へ戻る');
  back.type = 'button';
  back.onclick = renderWorkDialog;
  const reload = el('button', 'btn', '更新');
  reload.type = 'button';
  reload.onclick = () => refreshBackgroundDetail();
  const stop = capsOf(entry.backend).stopBackground ? backgroundStopButton(entry.sessionId, task) : null;
  actions.append(back, reload);
  if (stop) actions.append(stop);
  const status = el('div', 'work-head', '読み込み中…');
  status.setAttribute('role', 'status');
  const command = el('pre', 'work-command', task.label || task.id);
  const cwd = el('div', 'work-location');
  const output = el('pre', 'work-output', '');
  output.setAttribute('aria-label', '端末の出力');
  body.replaceChildren(actions, status, el('div', 'work-head', 'コマンド'), command, cwd,
    el('div', 'work-head', '出力'), output);
  backgroundView = { task, entry, status, command, cwd, output, stop, reload, busy: false };
  refreshBackgroundDetail();
}

async function refreshBackgroundDetail() {
  const view = backgroundView;
  if (!view || view.busy || !$('workDialog').open || $('workBody').dataset.view !== 'background') return;
  view.busy = true;
  view.reload.disabled = true;
  try {
    const canRead = capsOf(view.entry.backend).backgroundDetails;
    const live = backgroundHere().some(x => x.entry.sessionId === view.entry.sessionId && x.task.id === view.task.id);
    const data = canRead
      ? await cmd('loadBackground', { sessionId: view.entry.sessionId, taskId: view.task.id })
      : { task: live ? { ...view.task, output: null } : null };
    if (backgroundView !== view) return;
    if (!data.task) {
      view.status.textContent = '終了しました。出力は最後に取得した内容です。';
      if (view.stop) view.stop.disabled = true;
      return;
    }
    const task = data.task;
    view.status.textContent = `稼働中${task.startedAtMs ? ' · 起動 ' + fmt.dateTime(task.startedAtMs) : ''}${task.outputTruncated ? ' · 出力は末尾64K文字' : ''}`;
    view.command.textContent = task.command || task.label || view.task.label || view.task.id;
    view.cwd.textContent = task.cwd ? `作業場所: ${task.cwd}` : '';
    const text = task.output === null ? 'このエージェントは出力の取得に対応していません。' : task.output || 'まだ出力はありません。';
    if (view.output.textContent !== text) view.output.textContent = text;
  } catch (e) {
    if (backgroundView === view) view.status.textContent = `読み込めませんでした: ${e.message}`;
  } finally {
    view.busy = false;
    view.reload.disabled = false;
  }
}

const KIND_SUB = {
  terminal: "バックグラウンド端末",
  agent: "サブエージェント",
  shell: "バックグラウンドのコマンド",
  other: "裏の作業",
};

/**
 * 裏の作業を 1 本止める。
 * 消えたかどうかはサーバが codex に数え直させて `running` で配るので、**先回りして消さない**
 * （止めたつもりで生きている端末の印を落とす方が、消え遅れるより悪い）。
 */
async function stopBackground(button, sessionId, task) {
  button.disabled = true;
  button.textContent = "停止中…";
  try {
    const result = await cmd("stopBackground", { sessionId, taskId: task.id });
    if (result.stopped === false) throw new Error('停止を確認できませんでした');
    button.textContent = '停止要求済み';
    await refreshBackgroundDetail();
  } catch (e) {
    button.textContent = "再度停止";
    button.disabled = false;
    $("workBody").append(el("div", "work-head", `止められなかった: ${e.message}`));
  }
}

async function openSubagent(a) {
  const body = $("workBody");
  body.dataset.view = "agent";
  $("workTitle").textContent = `サブエージェント${a.description ? " — " + a.description.slice(0, 40) : ""}`;
  body.replaceChildren(el("div", "work-head", "読み込み中…"));
  let data;
  try {
    data = await cmd("loadSubagent", { sessionId: a.sessionId, agentId: a.id });
  } catch (e) {
    return body.replaceChildren(el("div", "work-head", `読めなかった: ${e.message}`));
  }
  const back = el("button", "btn work-back", "← 一覧へ戻る");
  back.type = "button";
  back.onclick = renderWorkDialog;
  body.replaceChildren(back);
  for (const m of data.messages ?? []) {
    if (m.role === "user") {
      const u = el("div", "m user");
      u.append(el("div", "body", m.text));
      body.append(u);
    } else {
      const ai = el("div", "m ai");
      if (m.text) { const b = el("div", "body"); b.innerHTML = renderAssistantMarkdown(m.text, []); ai.append(b); }
      for (const c of m.toolCalls ?? []) {
        const card = renderToolCall(c.name, c.input, { id: c.id });
        if (c.result) { applyToolResult(card, c.result); noteEndpointFailure(card, c.result); }
        ai.append(card);
      }
      if (!m.toolCalls) for (const t of m.tools ?? []) ai.append(renderToolCall(t, null));
      body.append(ai);
    }
  }
}

// ---------------------------------------------------------------- 配色
// 明示的に選んだらそれを守る。選んでいなければ OS の設定に従う。端末ごとの好みなのでブラウザ側に覚える。

const THEMES = ["auto", "light", "dark"];

function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : "auto";
  if (m === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = m;
  try { localStorage.setItem("agent-host-theme", m); } catch { /* 保存できなくても動く */ }
  for (const b of $("themeSeg").querySelectorAll("button")) b.classList.toggle("on", b.dataset.theme === m);
  paintTitleBar();
}

function initTheme() {
  let saved = "auto";
  try { saved = localStorage.getItem("agent-host-theme") ?? "auto"; } catch { /* 読めなくても動く */ }
  applyTheme(saved);
  for (const b of $("themeSeg").querySelectorAll("button")) b.onclick = () => applyTheme(b.dataset.theme);
  // 自動のときは OS の明暗が変わると面の色も変わる。窓のボタンの地も追いかける
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintTitleBar);
}

// ---------------------------------------------------------------- 言語
// 設定値（auto|ja|en）はサーバーの prefs.json に置く。サーバーが OS の言語と合わせて解決した言語が画面の正本で、
// ready と prefs イベントで届く。今の画面と違う言語が届いたら、写し（localStorage）を直して読み直す。
// 途中で文言を差し替える経路は持たない（読み直せば全部が確実にその言語になる）。

state.locale = { setting: "auto", lang: uiLang };

function paintLocale() {
  const { setting, lang } = state.locale;
  for (const b of $("localeSeg").querySelectorAll("button")) {
    const v = b.dataset.locale;
    b.classList.toggle("on", v === setting);
    b.setAttribute("aria-pressed", String(v === setting));
    b.textContent = v === "auto"
      ? setting === "auto" ? t("settings.appearance.language.autoResolved", { lang: languageName(lang) }) : t("settings.appearance.language.auto")
      : languageName(v);
  }
  $("localeNow").textContent = t("settings.appearance.language.current", { lang: languageName(uiLang) });
}

/** サーバーから届いた言語を受ける。読み直すなら true */
function applyLocale(info) {
  if (!info || !["ja", "en"].includes(info.lang)) return false;
  state.locale = { setting: info.setting ?? "auto", lang: info.lang };
  // 写しを書けないとき（保存が禁止されている）は読み直しても同じ言語で始まるので、読み直さない（繰り返さないため）
  if (rememberLang(info.lang) && info.lang !== uiLang) { location.reload(); return true; }
  paintLocale();
  return false;
}

function initLocale() {
  for (const b of $("localeSeg").querySelectorAll("button")) b.onclick = () => {
    if (b.dataset.locale === state.locale.setting) return;
    // 結果は prefs イベントで届く（ほかのタブにも）。ここでは失敗だけ拾う
    cmd("setPref", { key: "locale", value: b.dataset.locale })
      .catch((e) => { $("localeNow").textContent = t("settings.appearance.language.saveFailed", { error: e.message }); });
  };
  paintLocale();
}

// ---------------------------------------------------------------- 窓の上端（デスクトップ版）
// 閉じる・最小化のボタンは OS が描くので、地（帯の右端の面）と記号（本文の字）の色を今の配色から読んで送る。
// 地は脇の開閉・設定・プレビュー・窓の幅でも変わる（style.css の --bar-end）。どの条件で何色かは CSS だけが決め、
// ここは解決した結果を読むだけ。tokens.css の値も二重に持たない。同じ色は送り直さない
let titleBarSent = "";
function paintTitleBar() {
  if (!window.plyDesktop?.setTitleBar) return;
  const bar = document.querySelector(".titlebar");
  if (!bar) return;
  const css = getComputedStyle(bar);
  const colors = { color: css.getPropertyValue("--bar-end").trim(), symbolColor: css.getPropertyValue("--ink").trim() };
  const key = JSON.stringify(colors);
  if (key === titleBarSent) return;
  titleBarSent = key;
  window.plyDesktop.setTitleBar(colors);
}

// 帯の色を決める印（html の class・配色、body の class）が変わるたび、窓の幅が変わるたびに合わせ直す。
// 脇の開閉では setSidebar が side-moving を外した瞬間が、そのまま切り替えの瞬間になる
function watchTitleBar() {
  if (!window.plyDesktop?.setTitleBar) return;
  const watch = new MutationObserver(paintTitleBar);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  watch.observe(document.body, { attributes: true, attributeFilter: ["class"] });
  addEventListener("resize", paintTitleBar);
  paintTitleBar();
}

// ---------------------------------------------------------------- 脇の開閉
// 端末ごとの好みなのでブラウザ側に覚える。最初の描画での反映は index.html の先頭の script が済ませている。
// 設定の間は脇が設定メニューなので、開閉は受け付けない（CSS でも必ず開いて見える）

const SIDEBAR_STORE = "agent-host-sidebar";
let sidebarMoving;

function setSidebar(open) {
  const root = document.documentElement;
  if (document.body.classList.contains("settings") || root.classList.contains("side-closed") !== open) return;
  document.body.classList.add("side-moving");
  root.classList.toggle("side-closed", !open);
  try { localStorage.setItem(SIDEBAR_STORE, open ? "open" : "closed"); } catch { /* 保存できなくても動く */ }
  // 押したボタンは消える。居場所を body に落とさず、反対側のボタンへ移す
  const from = document.activeElement;
  if (!open && $("sidebar").contains(from)) $("openSidebar").focus();
  else if (open && from === $("openSidebar")) $("closeSidebar").focus();
  // 動き終わったら動きを外し、会話の幅が変わった分だけプレビューの幅を測り直す。--dur（240ms）より少し待つ
  clearTimeout(sidebarMoving);
  sidebarMoving = setTimeout(() => { document.body.classList.remove("side-moving"); filePreview.layout(); }, motionDuration(240) + 40);
}

function initSidebar() {
  $("closeSidebar").onclick = () => setSidebar(false);
  $("openSidebar").onclick = () => setSidebar(true);
  // Ctrl+B（macOS は ⌘B）。入力欄でも太字などの既定の意味は無いので、どこからでも効かせる。
  // macOS の Ctrl+B は入力欄で「1 文字戻る」なので奪わない
  const mac = /Mac/.test(navigator.platform);
  document.addEventListener("keydown", (e) => {
    if (isComposingKey(e) || e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "b") return;
    if (document.querySelector("dialog[open]")) return;
    e.preventDefault();
    setSidebar(document.documentElement.classList.contains("side-closed"));
  });
}

// ---------------------------------------------------------------- 下書き
// 書きかけの文章と添付をセッションごとに持つ。共有にすると A で書いたものが B から送れてしまう。

const draftKey = () => state.current ?? "";
const DRAFT_STORE = "agent-host-drafts-v1";
try { state.drafts = new Map(JSON.parse(localStorage.getItem(DRAFT_STORE) ?? "[]")); } catch { /* server copy remains available */ }
const draftWrites = new Map();
function saveDraft() {
  const id = draftKey();
  if (id && state.loadingSession === id) return Promise.resolve();
  const value = { text: $("prompt").value, attached: state.attached.slice(), dirty: true };
  return persistDraft(id, value);
}
function persistDraft(id, value) {
  state.drafts.set(id, value);
  try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch { /* report server result below */ }
  if (!id) return Promise.resolve();
  if (state.current === id) $("draftSaved").textContent = "保存中…";
  const work = (draftWrites.get(id) ?? Promise.resolve()).catch(() => {}).then(() => cmd("saveDraft", { sessionId: id, ...value }));
  draftWrites.set(id, work);
  work.then(() => {
    if (state.drafts.get(id) === value) {
      value.dirty = false;
      try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch {}
    }
    const s = state.sessions.find(s => s.id === id);
    if (s) s.hasDraft = Boolean(value.text || value.attached.length);
    if (state.current === id && draftWrites.get(id) === work) $("draftSaved").textContent = "保存済み";
  }, () => {
    if (state.current === id) $("draftSaved").textContent = "保存できませんでした。入力を保持しています · 再試行";
  });
  return work;
}
function loadDraft() {
  const d = state.drafts.get(draftKey());
  $("prompt").value = typeof d?.text === "string" ? d.text : "";
  fitPrompt();
  state.attached = Array.isArray(d?.attached) ? d.attached.slice() : [];
  renderAttached();
  $("draftSaved").textContent = d?.text || d?.attached?.length ? "下書きを復元しました" : "";
}
$("draftSaved").onclick = () => saveDraft().catch(() => {});
const filePreview = setupFilePreview({
  getContext: anchor => ({ sessionId:state.current, at:anchor?.closest('.m')?.dataset.at }),
  onLayout: () => requestAnimationFrame(relayoutBranches),
  useFile: file => {
    if ($('prompt').disabled) return;
    if (!state.attached.some(a => a.path === file.path)) {
      if (state.attached.length >= 20) { $('draftSaved').textContent = '添付は20件までです。不要な添付を外してください。'; return; }
      state.attached.push({ path:file.path, name:file.name, kind:'file', mime:file.mime ?? '' });
      renderAttached(); saveDraft().catch(() => {});
    }
    $('prompt').focus();
  },
});
$("prompt").addEventListener("input", () => saveDraft().catch(() => {}));
addEventListener("pagehide", () => saveDraft().catch(() => {}));

// ---------------------------------------------------------------- 添付
// present の逆方向。AI が人間に見せるのと同じ流れに、人間からも置けるようにする（設計メモ §7）。
// 送るまでは入力欄の中（サムネイル）。会話に載るのは送信のとき（runTurn の attachments → present）。

function renderAttached() {
  const box = $("attached");
  box.replaceChildren(...state.attached.map((a, i) => {
    const item = el("span", "att" + (a.dataUri ? " att-img" : ""));
    if (a.dataUri) {
      const b = el("button", "att-thumb");
      b.type = "button";
      b.title = `${a.name}（押すと大きく見る）`;
      const img = el("img");
      img.src = a.dataUri;
      img.alt = a.name;
      b.append(img);
      b.onclick = () => openLightbox(a.dataUri, a.name);
      item.append(b);
    } else {
      item.append(el("span", "att-name", a.name));
    }
    const x = el("button", "x", "×");
    x.type = "button";
    x.title = "外す";
    x.onclick = () => { state.attached.splice(i, 1); renderAttached(); saveDraft().catch(() => {}); };
    item.append(x);
    return item;
  }));
}

/** 画像を大きく見る。閲覧だけ。会話の present も入力欄の添付も同じ */
function openLightbox(src, caption) {
  const d = $("lightbox");
  d.querySelector("img").src = src;
  d.querySelector(".lb-cap").textContent = caption ?? "";
  d.showModal();
}

const readAsDataUri = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onerror = () => rej(new Error("読めなかった"));
  fr.onload = () => res(String(fr.result));
  fr.readAsDataURL(file);
});

async function attachFiles(files) {
  const sessionId = state.current;
  for (const file of files) {
    if (file.size > 8 * 1024 * 1024) {
      sys(`${escText(file.name)} は大きすぎる（上限 8MB）`);
      continue;
    }
    try {
      const dataUri = await readAsDataUri(file);
      const data = dataUri.split(",")[1] ?? "";
      const r = await cmd("attachFile", { sessionId, name: file.name, mime: file.type, data });
      const item = { name: file.name, path: r.path, kind: r.kind, mime: file.type, ...(r.kind === "image" ? { dataUri } : {}) };
      if (state.current === sessionId) { state.attached.push(item); renderAttached(); saveDraft().catch(() => {}); }
      else {
        const draft = state.drafts.get(sessionId) ?? { text: "", attached: [] };
        draft.attached.push(item); state.drafts.set(sessionId, draft);
        try { localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); } catch {}
        await cmd("saveDraft", { sessionId, ...draft });
      }
    } catch (e) {
      sys(`${escText(file.name)} を渡せなかった: ${escText(e.message)}`);
    }
  }
}

/** 入力欄の高さを中身に合わせる。最小 3 行、最大は画面の 40%、その先は中でスクロール */
function fitPrompt() {
  const ta = $("prompt");
  ta.style.height = "auto";
  const max = Math.floor(innerHeight * 0.4);
  ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
  ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
}

function wireDropZone() {
  // クリップ → 隠した file input。選んだものはドロップ・貼り付けと同じ列に入る
  $("attach").onclick = () => $("fileIn").click();
  $("fileIn").onchange = () => { attachFiles([...$("fileIn").files]); $("fileIn").value = ""; };
  // 会話に載った画像も同じライトボックスで大きく見る
  log.addEventListener("click", (e) => {
    const img = e.target.closest(".present-body > img, .tc-preview > img, .md-img");
    if (img) openLightbox(img.src, img.alt);
  });
  const lb = $("lightbox");
  lb.addEventListener("click", (e) => {
    if (e.target === lb || e.target.closest("[data-close]")) lb.close();
  });
  const zone = document.querySelector("main");
  let depth = 0;
  const show = (on) => zone.classList.toggle("dropping", on);
  zone.addEventListener("dragenter", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault(); depth++; show(true);
  });
  zone.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; show(false); } });
  zone.addEventListener("drop", (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault(); depth = 0; show(false);
    attachFiles([...e.dataTransfer.files]);
  });
  // 貼り付けでも渡せるようにする。スクショを撮ってそのまま貼る動線が一番短い
  $("prompt").addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    attachFiles(files);
  });
}

// ---------------------------------------------------------------- 右クリックのメニュー
// サブメニューはホバーで右へ展開。端では左へ返し、クリックとキーボードでも辿れる。

const contextMenu = createContextMenu();
const closeMenu = () => contextMenu.close();
function showMenu(x, y, items, title) { side.closePops(); contextMenu.open(x, y, items, title); }

const copy = (text, what) => {
  navigator.clipboard?.writeText(String(text ?? ""))
    .then(() => sys(`${what}をコピーした`))
    .catch(() => sys(`${what}のコピーに失敗した`));
};

function setStatusOf(sessionId, status) {
  const s = state.sessions.find((x) => x.id === sessionId);
  if (s) return changeStatus(s, status);
  cmd("setStatus", { sessionId, status, reason: "メニューから変更" })
    .catch((e) => sys(`状態変更に失敗: ${escText(e.message)}`));
}

// ---------------------------------------------------------------- グループ（fork のまとまり、§4.1）
// グループは持ち物ではなく、親子・状態・「人が外した印」から決まる。だから操作は 2 つしかない:
// 状態を変える（setStatus）と、外した印を付け外しする（setGrouped）。
// 状態が黙って動く操作なので、どれも脇の下に「元に戻す」を出す。

const rowLabel = (s) => (s.title && s.title !== "(no title)" ? s.title : "新しいセッション");
const statusWord = (st) => st || "状態なし";

/** 取り消し用に、触る前の状態と所属を覚える */
const snapOf = (rows) => rows.map((s) => ({ sessionId: s.id, status: s.status ?? "", ungrouped: Boolean(s.ungrouped) }));

/** 覚えた通りに戻す。1 本ずつ戻すので、途中の伝播（根を動かすと中も動く）は起こさない */
function restore(before, what) {
  Promise.all(before.map(async (b) => {
    await cmd("setStatus", { sessionId: b.sessionId, status: b.status, reason: "元に戻す", alone: true });
    await cmd("setGrouped", { sessionId: b.sessionId, ungrouped: b.ungrouped });
  })).then(refresh).catch((e) => sys(`${what}を戻せなかった: ${escText(e.message)}`));
}

/** その行と同じグループに居る行（描画と同じ規則。web/family.mjs） */
function groupOf(root) {
  const fam = familiesOf(state.sessions, state.sessions).find((f) => f.root.id === root.id);
  return fam ? [fam.root, ...fam.kin] : [root];
}

/**
 * 行の状態を変える。グループの根なら、まとまりごと移る（サーバが根の移動として広げる）。
 * 中の行なら、その 1 本だけが出る。どちらも脇の下に「元に戻す」を出す
 */
function changeStatus(s, status) {
  const fam = familiesOf(state.sessions, state.sessions).find((f) => f.kin.length && f.root.id === s.id);
  if (fam) return moveGroup(s, status);
  const before = snapOf([s]);
  const wasIn = familiesOf(state.sessions, state.sessions).some((f) => f.kin.some((k) => k.id === s.id));
  cmd("setStatus", { sessionId: s.id, status, reason: "手動で変更" })
    .then(() => {
      refresh();
      side.showUndo(wasIn ? `「${rowLabel(s)}」を ${statusWord(status)} にしてグループから外した`
                          : `「${rowLabel(s)}」を ${statusWord(status)} にした`,
        () => restore(before, "状態の変更"));
    })
    .catch((e) => sys(`状態変更に失敗: ${escText(e.message)}`));
}

/** グループごと別の状態へ。中の会話も一緒に動く（サーバが根の移動として広げる） */
function moveGroup(root, status) {
  const before = snapOf(groupOf(root));
  cmd("setStatus", { sessionId: root.id, status, reason: "グループごと移動" })
    .then(() => {
      refresh();
      side.showUndo(`「${rowLabel(root)}」のグループを ${statusWord(status)} に移した（${before.length} 件）`,
        () => restore(before, "グループの移動"));
    })
    .catch((e) => sys(`グループの移動に失敗: ${escText(e.message)}`));
}

/** グループから外す / 戻す。外すだけなら状態は動かさない */
function setGrouped(s, ungrouped) {
  const before = snapOf([s]);
  cmd("setGrouped", { sessionId: s.id, ungrouped })
    .then(() => {
      refresh();
      side.showUndo(ungrouped ? `「${rowLabel(s)}」をグループから外した` : `「${rowLabel(s)}」をグループに戻した`,
        () => restore(before, "グループの出入り"));
    })
    .catch((e) => sys(`グループの変更に失敗: ${escText(e.message)}`));
}

/** そのグループへ入れる。状態を根に合わせるところまでが 1 つの操作 */
function joinGroup(s, root) {
  const before = snapOf([s, ...groupOf(s)]);
  cmd("setGrouped", { sessionId: s.id, ungrouped: false })
    .then(() => cmd("setStatus", { sessionId: s.id, status: root.status ?? "", reason: "グループに入れる" }))
    .then(() => {
      refresh();
      side.showUndo(`「${rowLabel(s)}」を「${rowLabel(root)}」のグループに入れた（状態: ${statusWord(root.status)}）`,
        () => restore(before, "グループの出入り"));
    })
    .catch((e) => sys(`グループに入れられなかった: ${escText(e.message)}`));
}

/** グループを解除する。中の会話は独立した行になり、状態はそのまま */
function ungroupFamily(root, members) {
  const before = snapOf(members);
  Promise.all(members.map((m) => cmd("setGrouped", { sessionId: m.id, ungrouped: true })))
    .then(() => {
      refresh();
      side.showUndo(`「${rowLabel(root)}」のグループを解除した（${members.length} 件）`,
        () => restore(before, "グループの解除"));
    })
    .catch((e) => sys(`グループを解除できなかった: ${escText(e.message)}`));
}

/** 散らばっている枝をまとめてグループにする。状態は根に揃える */
function gatherKin(root, loose) {
  const before = snapOf([root, ...loose]);
  Promise.all([root, ...loose].map(async (m) => {
    await cmd("setGrouped", { sessionId: m.id, ungrouped: false });
    if ((m.status ?? null) !== (root.status ?? null)) {
      await cmd("setStatus", { sessionId: m.id, status: root.status ?? "", reason: "枝をまとめる", alone: true });
    }
  })).then(() => {
    refresh();
    side.showUndo(`「${rowLabel(root)}」のグループを作った（枝 ${loose.length} 件、状態を ${statusWord(root.status)} に揃えた）`,
      () => restore(before, "グループ作成"));
  }).catch((e) => sys(`枝をまとめられなかった: ${escText(e.message)}`));
}

/** その行の系譜（fork でつながった会話。グループに入っているかどうかは見ない） */
function kinOf(s) {
  const byId = new Map(state.sessions.map((r) => [r.id, r]));
  const rootOf = (r) => {
    let cur = r;
    const seen = new Set([r.id]);
    for (let i = 0; i < 64; i++) {
      const p = cur.parent?.sessionId;
      if (!p || seen.has(p) || !byId.has(p)) break;
      seen.add(p);
      cur = byId.get(p);
    }
    return cur;
  };
  const root = rootOf(s);
  return { root, all: state.sessions.filter((r) => rootOf(r).id === root.id) };
}

/** 行の右クリックに出すグループの項目。当てはまらないときは何も出さない */
function groupItems(s) {
  const fams = familiesOf(state.sessions, state.sessions);
  const mine = fams.find((f) => f.kin.length && (f.root.id === s.id || f.kin.some((k) => k.id === s.id)));
  if (mine && mine.root.id === s.id) {
    const members = [mine.root, ...mine.kin];
    return [{ label: "グループを解除", hint: `${members.length} 件`, onClick: () => ungroupFamily(mine.root, members) }];
  }
  if (mine) return [{ label: "このグループから外す", hint: "状態はそのまま", onClick: () => setGrouped(s, true) }];
  // 外に居る行。入れる先（同じ系譜にできているグループ）があれば入れる、無ければ枝をまとめる
  const { root, all } = kinOf(s);
  if (all.length < 2) return [];
  const host = fams.find((f) => f.kin.length && all.some((r) => r.id === f.root.id));
  if (host) return [{ label: `「${rowLabel(host.root)}」のグループに入れる`, hint: `状態も ${statusWord(host.root.status)} に`,
    onClick: () => joinGroup(s, host.root) }];
  const loose = all.filter((r) => r.id !== root.id);
  return [{ label: "枝をまとめる", hint: `${loose.length} 件`, onClick: () => gatherKin(root, loose) }];
}

/** グループの見出しの右クリック。解除と、まとまりごとの状態変更 */
function familyMenu(root, members, x, y) {
  const known = [...new Set(state.sessions.map((z) => z.status).filter(Boolean))];
  showMenu(x, y, [
    { label: "グループを解除", hint: `${members.length} 件`, onClick: () => ungroupFamily(root, members) },
    { sep: true },
    { label: "グループの状態を変更", hint: statusWord(root.status), sub: () => [
      { input: { placeholder: "新しい状態を作る", onCommit: (v) => moveGroup(root, v) } },
      ...known.map((k) => ({ label: k, hint: `${members.length} 件`, checked: k === root.status, onClick: () => moveGroup(root, k) })),
      { sep: true },
      { label: "状態なしにする", onClick: () => moveGroup(root, "") },
    ] },
    { sep: true },
    { label: "根の会話を開く", hint: rowLabel(root), onClick: () => select(root.id) },
  ], `${rowLabel(root)} のグループ`);
}

async function rowMenu(s, x, y) {
  const actual = await loadVocab(s.backend);
  const next = s.nextSettings?.backend ? await loadVocab(s.nextSettings.backend) : actual;
  const vocab = next;
  const efforts = await cmd("efforts", { backend: s.nextSettings?.backend ?? s.backend, model: s.nextSettings?.model ?? s.model ?? "", cwd: s.nextSettings?.cwd || s.cwd || undefined });
  const mode = selectedMode(s, s.nextSettings?.backend ?? s.backend, vocab.modes);
  const known = [...new Set(state.sessions.map((z) => z.status).filter(Boolean))];
  // 枝の行き来。親があるか子がある行だけ。家族は開いている間に取り寄せる（メニューは同期で組む）
  const hasKin = Boolean(s.parent?.sessionId) || state.sessions.some((z) => z.parent?.sessionId === s.id);
  let kin = null;
  if (hasKin) cmd("lineage", { sessionId: s.id }).then((r) => { kin = r; }).catch(() => {});
  const kinItems = () => !kin ? [{ label: "読み込んでいる…" }]
    : kin.sessions.map((r) => ({ label: r.title && r.title !== "(no title)" ? r.title : "新しいセッション",
        hint: r.id === s.id ? "この行" : r.parent?.sessionId ? "枝" : "根", checked: r.id === state.current, onClick: () => select(r.id) }));
  const items = [
    { label: "開く", onClick: () => select(s.id) },
    ...(s.parent?.sessionId ? [{ label: "親の枝を開く", hint: sessionLabel(s.parent.sessionId).slice(0, 20), onClick: () => select(s.parent.sessionId) }] : []),
    ...(hasKin ? [{ label: "枝の一覧", sub: kinItems }] : []),
    { label: "タイトルを変更…", sub: () => [
      { input: { placeholder: "新しいタイトル", value: s.title === "(no title)" ? "" : s.title, onCommit: (v) =>
        cmd("setTitle", { sessionId: s.id, title: v, reason: "メニューから変更" })
          .catch((e) => sys(`タイトル変更に失敗: ${escText(e.message)}`)) } },
    ] },
    { label: "状態を変更", hint: s.status ?? "状態なし", sub: () => [
      { input: { placeholder: "新しい状態を作る", onCommit: (v) => setStatusOf(s.id, v) } },
      ...known.map((k) => ({ label: k, checked: k === s.status, onClick: () => setStatusOf(s.id, k) })),
      { sep: true },
      { label: "状態なしにする", onClick: () => setStatusOf(s.id, "") },
    ] },
    ...(capsOf(s.backend).fork === false ? [] : [{ label: "末尾から分岐", onClick: () => forkTail(s.id) }]),
    ...groupItems(s),
    { sep: true },
    { label: "承認モード", hint: vocab.modes[mode]?.label ?? mode, sub: () =>
      Object.entries(vocab.modes).map(([id, m]) => ({
        label: m.label, hint: m.note, checked: id === mode,
        onClick: () => (s.nextSettings?.backend && s.nextSettings.backend !== s.backend
          ? cmd("setTurnSettings", { sessionId: s.id, backend: s.nextSettings.backend, mode: id, rememberMode: true })
          : cmd("setMode", { sessionId: s.id, mode: id, reason: "メニューから変更" }))
          .then(refresh).catch((e) => sys(`承認モードの変更に失敗: ${escText(e.message)}`)),
      })) },
    // 名前は版付き（入力欄のチップと同じ）。「既定に従う」には実際に当たるモデルを添える。隠した別名は選んでいるときだけ。
    // 段違いを系統にまとめた一覧（antigravity）は系統ごとに 1 行（composer-labels.mjs の modelRowIds）
    { label: "モデル（次のターン）", hint: endpointOf(s) && (s.nextSettings?.model ?? s.model) ? compatModelText(s.nextSettings?.model ?? s.model) : resolvedModel(vocab.models, s.nextSettings?.model ?? s.model ?? "").label, sub: () =>
      Object.entries(vocab.models).filter(([id]) => id === "" || modelRowIds(vocab.models, s.nextSettings?.model ?? s.model ?? "").includes(id)).map(([id, m]) => ({
        label: id === "" && m.resolvesTo ? `${m.label}（${vocab.models[m.resolvesTo]?.label ?? m.resolvesTo}）` : m.label,
        hint: m.note, checked: id === (s.nextSettings?.model ?? s.model ?? ""),
        onClick: () => cmd("setTurnSettings", { sessionId: s.id, backend: s.nextSettings?.backend ?? s.backend, model: id, rememberModel: true })
          .then(refresh).catch((e) => sys(`モデルの変更に失敗: ${escText(e.message)}`)),
      })) },
    ...(await rowEndpointItems(s)),
    ...(await rowAccountItems(s)),
    { sep: true },
    { label: "エフォート（次のターン）", hint: (s.nextSettings?.effort ?? s.effort) || efforts[""]?.resolvesTo || "既定", sub: () =>
      Object.entries(efforts).map(([effort, m]) => ({
        label: effort === "" && m.resolvesTo ? `${m.label}（${m.resolvesTo}）` : m.label,
        hint: m.note, checked: effort === (s.nextSettings?.effort ?? s.effort ?? ""),
        onClick: () => cmd("setTurnSettings", { sessionId: s.id, effort, rememberEffort: true })
          .then(refresh).catch(e => sys(`エフォートの変更に失敗: ${escText(e.message)}`)),
      })) },
    { label: "作業ディレクトリをコピー", hint: s.cwd ?? "", onClick: () => copy(s.cwd, "作業ディレクトリ") },
    { label: "セッション ID をコピー", onClick: () => copy(s.id, "セッション ID") },
    ...(s.unsent ? [{ label: "未送信のセッションを削除…", sub: () => [
      { label: "下書きも削除する", onClick: async () => {
        try { await cmd("deleteUnsentSession", { sessionId: s.id }); state.drafts.delete(s.id); localStorage.setItem(DRAFT_STORE, JSON.stringify([...state.drafts])); await refresh(); }
        catch (e) { sys(`削除に失敗: ${escText(e.message)}`); }
      } },
    ] }] : []),
  ];
  showMenu(x, y, items, s.title && s.title !== "(no title)" ? s.title : "新しいセッション");
}

/** 「新しいグループを作る…」。その場に名前の欄が出て、Enter で作る。空のままでも一覧に残る（statuses.json） */
function newGroupItem() {
  return { label: "新しい状態を作る…", sub: () => [
    { input: { placeholder: "状態の名前", onCommit: (v) =>
      cmd("createStatus", { status: v }).then(refresh)
        .catch((e) => sys(`状態を作れなかった: ${escText(e.message)}`)) } },
  ] };
}

function groupMenu(st, x, y) {
  if (st == null) return showMenu(x, y, [newGroupItem()], "状態なし");
  const n = state.sessions.filter((s) => s.status === st).length;
  showMenu(x, y, [
    { label: "アイコンを変える…", hint: state.statuses.find((s) => s.status === st)?.icon ?? "", onClick: () => side.pickIcon(st) },
    { label: "名前を変更…", sub: () => [
      { input: { placeholder: "新しい名前", value: st, onCommit: (v) =>
        cmd("renameStatus", { from: st, to: v }).then(refresh)
          .catch((e) => sys(`状態の名前の変更に失敗: ${escText(e.message)}`)) } },
    ] },
    newGroupItem(),
    { sep: true },
    { label: "この状態を削除", hint: n ? `${n} 件は状態なしへ` : "空",
      onClick: () => cmd("renameStatus", { from: st, to: "" }).then(refresh)
        .catch((e) => sys(`削除に失敗: ${escText(e.message)}`)) },
  ], st);
}

// ---------------------------------------------------------------- 読み込んだコンテキスト
// タイトル行の入口と、共通読み込みの会話に残る一行（docs/design-system.md §9）。
// 出所はどちらも sessionContext の記録で、ターンの開始に届く contextUsage で更新する。

const CTX_WORDS = { instruction: '指示', skill: 'Skills', mcp: 'MCP' };
// 実際に渡ったものだけ数える。除外・重複・未対応・接続できなかった MCP は数に入れない
const CTX_LOADED = { instruction: ['supplied', 'loaded'], skill: ['available', 'manual-only', 'loaded'], mcp: ['pending', 'connected'] };
// Pleiad が担当する種類だけ数える（エージェント任せの種類は Pleiad が中身を把握していない）
const contextTotal = (report) => Object.keys(CTX_WORDS).filter((kind) => report?.owners?.[kind] === 'ply')
  .reduce((sum, kind) => sum + (report.entries ?? []).filter((e) => e.kind === kind && CTX_LOADED[kind].includes(e.status)).length, 0);
// エージェント任せの会話（と、Pleiad 担当を受け取れなかった antigravity の会話）
const isManagedContext = (report) => Boolean(report) && report.status !== 'native';
/** 設定のコンテキストのページを開く。place を渡すとその場所の設定を選んだ状態で */
function openContextPage(place) {
  onboarding.open('context');
  context.openPage(typeof place === 'string' ? place : undefined);
}
/** タイトル行の右の入口。押すと右パネル「この会話のコンテキスト」を開閉する。セッションを選んでいないときは出さない */
function paintContextEntry() {
  const button = $('contextEntry'), report = state.contextInfo?.report;
  button.hidden = !state.current;
  if (button.hidden) return;
  const managed = isManagedContext(report);
  button.classList.toggle('ply', managed);
  button.title = report ? `この会話のコンテキスト：${chipText(state.contextInfo)}` : 'この会話のコンテキスト';
  $('contextEntryCount').hidden = !managed;
  $('contextEntryCount').textContent = managed ? String(contextTotal(report)) : '';
  $('contextEntryChanged').hidden = !state.contextInfo?.changed?.differs;
}
const CHIP_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h10M4 18h7"/></svg>';
/** 会話の頭に付く札（指示 2 · Skills 14 · MCP …）。最初の発言の下。押すと右パネルが開く */
function paintContextLine() {
  thread.querySelector('.mw[data-key="context"]')?.remove();
  const report = state.contextInfo?.report;
  if (!report) return;
  const anchor = thread.querySelector('.mw:has(.m[data-role="user"])');
  if (!anchor) return;
  const m = el("button", "ctx-chip");
  m.type = 'button';
  m.innerHTML = CHIP_ICON;
  m.append(el('span', null, chipText(state.contextInfo)));
  if (state.contextInfo?.changed?.differs) m.append(el('span', 'chg', '· 変更あり'));
  m.setAttribute('aria-label', `この会話のコンテキストを開く：${chipText(state.contextInfo)}`);
  m.setAttribute('aria-expanded', String(sessionContext.isOpen()));
  m.onclick = () => sessionContext.toggle(m);
  // 分岐点の行は同じ発言の後ろに入る。その後ろに置いて順番を保つ
  let after = anchor;
  while (after.nextElementSibling?.classList.contains('branch-row')) after = after.nextElementSibling;
  after.after(wrap(m, 'context'));
  relayoutBranches();
}
/** 今のセッションの読み込み記録を取り直す。固定された会話ではサーバが今のファイルと突き合わせる */
async function refreshContextEntry({ force = false } = {}) {
  const id = state.current;
  if (!id) {
    state.contextInfo = null;
    state.contextInfoId = null;
  } else if (force || state.contextInfoId !== id) {
    const info = await cmd('sessionContext', { sessionId: id }).catch(() => null);
    if (state.current !== id) return state.contextInfo;
    state.contextInfo = info;
    state.contextInfoId = id;
  } else return state.contextInfo;
  paintContextEntry();
  paintContextLine();
  sessionContext.refresh();
  return state.contextInfo;
}

// ---------------------------------------------------------------- 上部と入力欄の同期

let topbarVersion = 0;
/** 右クリックメニューのアカウント（入力欄と同じ選択肢。登録が無く、選んでもいなければ出さない） */
async function rowAccountItems(s) {
  if (!capsOf(s.nextSettings?.backend ?? s.backend).claudeAccounts) return [];
  const list = await claudeAccounts.load().catch(() => []);
  const value = s.nextSettings?.account ?? s.claudeAccount ?? "";
  if (!list.length && !value) return [];
  const choices = [{ value: "", label: "ログイン中のアカウント", note: "" }, ...list.map((a) => ({ value: a.id, label: a.name, note: a.hasToken ? "" : "トークン未登録" }))];
  return [{ label: "アカウント（次のターン）", hint: accountLabel(value), sub: () => choices.map((c) => ({
    label: c.label, hint: c.note, checked: c.value === value,
    onClick: () => cmd("setTurnSettings", { sessionId: s.id, account: c.value })
      .then(refresh).catch((e) => sys(`アカウントの変更に失敗: ${escText(e.message)}`)),
  })) }];
}

/**
 * 互換の接続先の会話で Web 検索が失敗したら、そのカードに理由を一文足す（画面 4）。
 * エージェントの失敗文だけでは接続先が原因だと分からないため。公式の会話では何もしない
 */
function noteEndpointFailure(card, result) {
  if (!card || !(result?.isError ?? result?.is_error) || !/^(WebSearch|webSearch|web_search)$/.test(card.dataset?.tool ?? "")) return;
  const s = state.sessions.find((x) => x.id === state.current);
  const e = s?.compatEndpoint ? compatEndpoints.get(s.compatEndpoint) : null;
  if (!e || card.querySelector(".tc-note")) return;
  const note = el("p", "tc-note", `この接続先（${e.name}）では Web 検索を使えません。`);
  const more = el("button", "clink", "接続先の詳細"); more.type = "button";
  more.onclick = () => compatEndpoints.open(e.agent);
  note.append(" ", more);
  card.append(note);   // 畳んだ詳細（details）の外に置く。畳んでいても見える
}

/** 右クリックメニューの接続先（入力欄と同じ選択肢。接続先を選べるエージェントの会話だけ） */
async function rowEndpointItems(s) {
  const bid = s.nextSettings?.backend ?? s.backend;
  if (!capsOf(bid).compatEndpoints) return [];
  const list = (await compatEndpoints.load().catch(() => [])).filter((e) => e.agent === bid);
  const value = endpointOf(s);
  if (!list.length && !value) return [];
  const choices = [{ value: "", label: "公式", note: "" }, ...list.map((e) => ({ value: e.id, label: e.name, note: e.ready === false ? "⚠ 確認に失敗" : "" }))];
  return [{ label: "接続先（次のターン）", hint: endpointLabel(value), sub: () => choices.map((c) => ({
    label: c.label, hint: c.note, checked: c.value === value,
    onClick: () => cmd("setTurnSettings", { sessionId: s.id, endpoint: c.value })
      .then(refresh).catch((e) => sys(`接続先の変更に失敗: ${escText(e.message)}`)),
  })) }];
}

// AI がタイトルを考えている会話。その間は欄に書き込ませず、途中で一覧が更新されても開け直さない
const titleGenerating = new Set();
function syncTitleControls() {
  const s = state.sessions.find((x) => x.id === state.current);
  const on = Boolean(state.current);
  const caps = capsOf(activeBackendId());
  const busy = on && titleGenerating.has(state.current);
  $("titleField").classList.toggle("generating", busy);
  $("titleEdit").disabled = !on || busy;
  $("titleEdit").setAttribute("aria-busy", String(busy));
  $("titleWand").classList.toggle("busy", busy);
  $("titleWand").hidden = caps.suggestTitle === false;
  $("titleWand").disabled = !on || busy || s?.unsent || caps.suggestTitle === false;
  paintContextEntry();
}
function selectedMode(s, bid, modes) {
  const prefs = (state.prefs.backends ? state.prefs.backends[bid] : state.prefs) ?? {};
  const mode = s?.nextSettings?.mode ?? (s?.backend === bid ? s.mode : prefs.mode);
  return mode in modes ? mode : "default" in modes ? "default" : Object.keys(modes)[0] ?? "";
}
async function syncTopbar() {
  syncAgentTasks();
  syncBackgroundEntry();
  const version = ++topbarVersion;
  const s = state.sessions.find((x) => x.id === state.current);
  const on = Boolean(state.current);
  const id = state.current;
  const bid = s?.nextSettings?.backend ?? activeBackendId();
  const caps = capsOf(activeBackendId());

  $("titleEdit").value = s?.title === "(no title)" ? "" : (s?.title ?? "");
  syncTitleControls();

  if (bid) state.shownBackend = bid;

  // 予約があれば次のターンの作業場所を表示する。
  if (s) state.cwd = s.nextSettings?.cwd ?? s.cwd ?? state.homeDir ?? "";
  else if (state.draft.cwd) state.cwd = state.draft.cwd;
  else if (state.homeDir) state.cwd = state.homeDir;
  controls.paint();

  // 語彙はエージェントごとに違う。切り替えたら取り直す
  const { modes, models } = await loadVocab(bid);
  if (state.current !== id || version !== topbarVersion) return;
  state.modes = modes;
  state.models = models;
  if (s) { state.mode = s.mode ?? "default"; state.model = s.nextSettings?.model ?? s.model ?? ""; }
  else { const prefs = (state.prefs.backends ? state.prefs.backends[bid] : state.prefs) ?? {}; state.mode = prefs.mode ?? "default"; state.model = prefs.model ?? ""; }
  state.mode = selectedMode(s, bid, modes);
  await syncEndpoint(s, bid);
  if (state.current !== id || version !== topbarVersion) return;
  // 互換の接続先のモデルは接続先の一覧＋自由入力なので、公式の一覧に無くても戻さない
  if (!state.endpoint && !(state.model in models)) state.model = "" in models ? "" : Object.keys(models)[0] ?? "";
  const efforts = await cmd('efforts', { backend: bid, model: state.model, cwd: s?.nextSettings?.cwd || s?.cwd || undefined, ...(state.endpoint ? { endpoint: state.endpoint } : {}) }).catch(() => ({ '': { label: '既定に従う' } }));
  if (state.current !== id || version !== topbarVersion) return;
  state.efforts = efforts;
  state.effort = s?.nextSettings?.effort ?? s?.effort ?? '';
  state.effortDisabled = Object.keys(efforts).length <= 1;
  controls.paint();
  await syncAccount(s, bid);
  if (state.current !== id || version !== topbarVersion) return;
  controls.paint();
  paintSettingsNotice();
  renderSessions();
}

let refreshVersion = 0;
async function refresh() {
  const version = ++refreshVersion;
  const t0 = performance.now();
  const [sessions, statuses, prefs] = await Promise.all([
    cmd("listSessions"),
    cmd("listStatuses").catch(() => []),
    cmd("prefs").catch(() => ({})),
  ]);
  if (version !== refreshVersion) return;
  state.sessions = sessions;
  state.statuses = statuses;
  state.prefs = prefs ?? {};
  await loadBackends();
  await syncTopbar();
  cmd("running").then(applyRunning).catch(() => {});
}

// ---------------------------------------------------------------- 履歴と枝（web/branches.mjs）

const branches = createBranches({
  cmd,
  // 枝の名前は一覧のタイトル。refresh() が保つものを読むだけで、筋の側に写しは持たない
  titleOf: (id) => state.sessions.find((x) => x.id === id)?.title ?? null,
});
// 発言の高さが変わったら（画像の読み込み・折り畳み・返答が伸びる）枝のグラフを貼り直す
if (typeof ResizeObserver === "function") new ResizeObserver(() => relayoutBranches()).observe(thread);

/** Layout runs on append as well as resize; the spine exists even before the first turn. */
function relayoutBranches() { layoutBranchSpine(thread); }

let pendingBranchReload = false, pendingHistorySync = false;
async function reloadBranches(ev) {
  const id = state.current;
  if (!id) return;
  const related = ev.parent?.sessionId === id || ev.sessionId === id || branches.has(ev.parent?.sessionId) || branches.has(ev.sessionId);
  if (!related) return;
  if (state.busy) { pendingBranchReload = true; return; }
  await branches.load(id, state.messages);
  if (state.current !== id) return;
  if (state.busy) { pendingBranchReload = true; return; }
  placeJunctions();
}
async function finishBranchChange() {
  state.busy = false;
  if (pendingHistorySync) { pendingHistorySync = false; await syncHistory(); }
  if (pendingBranchReload) {
    pendingBranchReload = false;
    await reloadBranches({ sessionId: state.current });
  }
  log.classList.remove('branch-transition');
}
function paintBranchNames() {
  if (state.busy) { pendingBranchReload = true; return; }
  if (!state.current || !branches.has(state.current)) return;
  placeJunctions();
}

/** 履歴を描く。from 以降の添字（messages の mi）だけ。返すのは足した要素 */
function paintHistory(fromMi = 0) {
  const items = buildItems(state.messages, state.presents);
  const added = [];
  let prevRole = fromMi > 0 ? state.messages[fromMi - 1]?.role : null;
  const startAt = fromMi > 0 ? new Date(state.messages[fromMi - 1]?.at ?? 0) : null;
  for (const it of items) {
    if (it.kind === "present") {
      if (it.anchorMi >= 0 && it.anchorMi < fromMi) continue;
      if (it.anchorMi < 0 && startAt && new Date(it.p.at ?? 0) < startAt) continue;
      const wrapper = append(renderPresent(it.p), `p:${it.pi}`);
      if (it.p.by === "human") wrapper.dataset.humanAttachment = "true";
      added.push(wrapper);
      continue;
    }
    if (it.mi < fromMi) continue;
    const m = it.m;
    if (m.internalTaskNotice) {
      added.push(append(el('div', 'm sys', 'Pleiad タスクの結果を受け取って再開しました'), `m:${it.mi}`));
      prevRole = null;
      continue;
    }
    let node;
    if (m.role === "user") node = userMsg(m.text, { uuid: m.uuid, at: m.at });
    else {
      node = aiMsg({ uuid: m.uuid, at: m.at, backend: m.backend, cont: prevRole === "assistant" });
      if (m.thinking) node.append(thinkFromText(m.thinking));
      for (const c of m.toolCalls ?? []) {
        const card = renderToolCall(c.name, c.input, { id: c.id });
        if (c.result) { applyToolResult(card, c.result); noteEndpointFailure(card, c.result); }
        node.append(card);
        if (c.id) state.toolCards.set(c.id, card);
      }
      if (!m.toolCalls) for (const t of m.tools ?? []) node.append(renderToolCall(t, null));
      if (m.text) { const b = el("div", "body"); b.innerHTML = renderAssistantMarkdown(m.text, state.presents.map(p => p.reference)); node.append(b); }
    }
    prevRole = m.role;
    added.push(append(node, `m:${it.mi}`));
  }
  return added;
}

/** A live assistant row can represent several persisted tool/thinking entries. */
function branchAnchor(mi) {
  const rows = [...thread.querySelectorAll('.mw[data-key^="m:"]')];
  return rows.find(w => Number(w.dataset.key.slice(2)) === mi)
    ?? rows.filter(w => Number(w.dataset.key.slice(2)) <= mi).at(-1)
    ?? thread.querySelector('.mw[data-key^="live:"]')
    ?? thread.querySelector('.mw');
}
function branchSnapshots() {
  return new Map([...thread.querySelectorAll('.branch-row')].map(r => [r.dataset.key, r.snapshot()]));
}
function placeJunctions({ snapshots = branchSnapshots() } = {}) {
  const focused = document.activeElement?.closest('.branch-tip');
  const focusId = focused?.dataset.session;
  const focusKey = focused?.closest('.branch-row')?.dataset.key;
  for (const row of thread.querySelectorAll('.branch-row')) row.remove();
  thread.classList.toggle('branched', branches.has(state.current));
  if (!state.current) return [];
  const byNode = nodeKeys(branches.junctions(state.current), state.messages.length);
  if (!byNode.size) {
    const parent = state.sessions.find(x => x.id === state.current)?.parent?.sessionId;
    if (parent) byNode.set(0, [{ id: parent, name: '親の会話', n: 0, back: true }]);
  }
  // Empty forks still have a selectable group before their first message.
  if (!state.messages.length && branches.has(state.current)) {
    const entries = [...branches.family.rows.values()].filter(r => r.id !== state.current)
      .map(r => ({ id: r.id, name: branches.nameOf(r.id), n: r.messages.length }));
    if (entries.length) byNode.set(-1, entries);
  }
  const added = [];
  for (const [mi, entries] of [...byNode].sort((a,b) => a[0]-b[0])) {
    const key = `m:${mi}`;
    const all = [{ id: state.current, name: branches.nameOf(state.current), n: Math.max(0, state.messages.length-mi-1) }, ...entries];
    const row = makeBranchRow(key, all, state.current, switchTo, snapshots.get(key));
    const anchor = mi >= 0 ? branchAnchor(mi) : null;
    // Two boundaries may share one live DOM row; keep their order.
    let after = anchor;
    while (after?.nextElementSibling?.classList.contains('branch-row')) after = after.nextElementSibling;
    if (after) after.after(row); else thread.querySelector('.spine').after(row);
    added.push(row);
  }
  relayoutBranches();
  if (focusId) {
    const group = added.find(r => r.dataset.key === focusKey);
    [...(group?.querySelectorAll('.branch-tip') ?? [])].find(t => t.dataset.session === focusId)?.focus({ preventScroll: true });
  }
  return added;
}

/**
 * セッションを開く。keepUpTo を渡すと、その添字より前の発言は画面に残したまま続きだけ描く
 * （枝の切り替え。共通部分は動かさない）。
 */
async function select(id, { keepUpTo, reload = false } = {}) {
  if (state.busy || (id === state.current && keepUpTo === undefined && !reload)) return;
  filePreview.sessionChanged(id);
  if (keepUpTo === undefined) {
    // 開き直し: 先に空にして「読み込み中」。切り替え（keepUpTo）は剥がれた後に一緒に描くので、ここでは触らない
    saveDraft().catch(() => {});
    state.current = id;
    try { localStorage.setItem("agent-host-current", id); } catch {}
    state.loadingSession = id;
    $("prompt").disabled = true;
    $("settingsError").textContent = "";
    $("retrySettings").hidden = settingsFailure !== id;
    state.awaitingSession = false;
    state.submitting = false;
    syncRunState();
    syncTopbar();
    clearThread();
    loadDraft();
    sys("履歴を読み込み中…");
  }
  sessionLoads.cancel(state.displayLoad);
  const load = sessionLoads.begin(id);
  state.displayLoad = load;
  let data;
  try {
    data = await cmd("loadSession", { sessionId: id, live: true });
  } catch (e) {
    sessionLoads.cancel(load);
    if (state.current !== id || state.displayLoad !== load) return;
    state.loadingSession = null;
    clearThread();
    return sys(`履歴を読めなかった: ${escText(e.message)}`);
  }
  try {
    if (state.displayLoad !== load || keepUpTo === undefined && state.current !== id) return;
    await paintSession(id, data, { keepUpTo, load });
  } finally { sessionLoads.cancel(load); }
}

/**
 * 読んだ履歴を今の会話にする。keepUpTo を渡すと、その添字より前の発言（と剥がれていない印）は画面に残し、
 * 続きだけ描く。タイトル・一覧の選択・入力欄もここで一緒に切り替わる（= 描画の最終コマと同じタイミング）。
 * transition は選択前のノード座標。本文の高さを畳まず、ノードを横移動する。
 */
async function paintSession(id, data, { keepUpTo, transition, loaded = false, load } = {}) {
  filePreview.sessionChanged(id);
  const snapshots = branchSnapshots();
  if (keepUpTo !== undefined) saveDraft().catch(() => {});
  state.current = id;
  if (state.contextInfoId !== id) { state.contextInfo = null; state.contextInfoId = null; }   // 前の会話の記録を持ち越さない
  paintOutbox();
  refreshOutbox(id).catch(() => {});
  try { localStorage.setItem("agent-host-current", id); } catch {}
  const localDraft = state.drafts.get(id);
  if (!localDraft?.dirty) {
    const restored = data?.draft ?? { text: "", attached: [] };
    restored.attached = (restored.attached ?? []).map(a => ({ ...a, dataUri: localDraft?.attached?.find(old => old.path === a.path)?.dataUri }));
    state.drafts.set(id, restored);
  }
  state.awaitingSession = false;
  state.submitting = false;
  state.messages = data?.messages ?? [];
  state.initialMessageId = data?.initialMessageId;
  state.presents = data?.presents ?? [];
  if (!loaded) await branches.load(id, state.messages);
  if (state.current !== id || load && state.displayLoad !== load) return;
  state.loadingSession = null;
  $("prompt").disabled = false;
  syncRunState();
  syncTopbar();

  const scrollAt = log.scrollTop;
  if (keepUpTo === undefined) clearThread();
  else {
    const last = keepUpTo > 0 ? branchAnchor(keepUpTo - 1) : null;
    let after = !last;
    for (const x of [...thread.children]) {
      if (x.classList.contains('spine')) continue;
      if (after) x.remove();
      if (x === last) after = true;
    }
  }
  // Shared DOM survives a fork switch, but its UUID must belong to the selected session.
  for (const w of thread.querySelectorAll('.mw[data-key^="m:"]')) {
    const message = state.messages[Number(w.dataset.key.slice(2))];
    const m = w.querySelector('.m[data-role]');
    if (m && message) {
      delete m.dataset.uuid;
      const button = m.querySelector('.message-actions');
      if (button) button.hidden = true;
      setUuid(m, message.uuid);
    }
  }
  loadDraft();
  closeTurnEl();
  const added = paintHistory(keepUpTo ?? 0);
  // Replay synchronously after clearing/painting; only events after the server
  // snapshot are appended, so an in-flight delta is neither lost nor doubled.
  if (load) for (const event of sessionLoads.finish(load, data)) onEvent(event, true);
  // まだ答えていない承認は本文の後（＝稼働表示の手前）に出す。届いたときに取りこぼしていても、
  // loadSession が返す保留中の一覧から拾える
  for (const ev of data?.permissions ?? []) if (ev.id) state.pendingPerms.set(ev.id, ev);
  paintPendingPerms(id);
  acknowledgeDisplayed(id, data?.completedAt);
  const groups = placeJunctions({ snapshots });
  const moving = transition ? groups.find(r => r.dataset.key === transition.key) : null;
  if (transition) {
    for (const node of added) node.animate([{ opacity: .15 }, { opacity: 1 }], { duration: motionDuration(420), easing: EASING });
  }
  // この会話が読み込んだ記録。取り直しは待たない（固定された会話では今のファイルとの突き合わせが入る）
  paintContextLine();
  refreshContextEntry({ force: true }).catch(() => {});
  thread.classList.toggle("branched", branches.has(id));   // 枝があるとき、筋は「今いる枝」として青く太い
  if (isRunningHere()) activity.show(activity.text || "動いている");   // 走っている会話を開いたら末尾に弧
  else if (behindHere()) activity.show("裏の作業を待っている");     // ターンは終わったが裏の子が残っている会話は衛星
  relayoutBranches();     // 稼働表示が出た後の高さで、今いる枝の終端ノードを置き直す
  $("prompt").placeholder = branchIsFresh(id) ? `${branches.nameOf(id)} の最初の発言を書く` : "Ctrl+Enter で送信";
  // 対応を終えたエージェントの会話は読むだけ。入力欄を閉じ、理由を末尾に出す（送信はサーバーも断る）
  const retired = data?.retired ?? null;
  if (retired) { sys(escText(retired)); $("prompt").disabled = true; $("prompt").placeholder = retired; }
  log.scrollTop = keepUpTo === undefined ? log.scrollHeight : scrollAt;
  if (moving) await moving.promote(transition.snapshot);
}

/**
 * ターンが終わった後、履歴を静かに読み直す。ライブで描いた発言（data-key が live:）に
 * 履歴の添字と uuid を付け（同じ id で「ここから分岐」が押せるように）、枝の筋の件数を合わせる。
 * 照合するのはライブで描いた節だけ。履歴から描いた古い発言は本文が同じでも触らない。
 * 1 つの添字は 1 つの節にしか付けない（分岐点や切り替えはこの対応を信じる）。
 */
async function syncHistory() {
  if (state.busy) { pendingHistorySync = true; return; }
  const id = state.current;
  if (!id) return;
  const before = state.messages.length;
  const data = await cmd("loadSession", { sessionId: id }).catch(() => null);
  if (!data || state.current !== id) return;
  if (state.busy) { pendingHistorySync = true; return; }
  state.messages = data.messages ?? [];
  state.presents = data.presents ?? [];
  const claimed = new Set();
  // text.end で uuid が分かっていた発言は、履歴の添字を uuid で引く
  for (const m of thread.querySelectorAll('.mw[data-key^="live:"] .m[data-uuid]')) {
    const idx = state.messages.findIndex((x) => x.uuid === m.dataset.uuid);
    if (idx < 0 || claimed.has(idx)) continue;
    m.closest(".mw").dataset.key = `m:${idx}`;
    claimed.add(idx);
  }
  // 残り（人間の発言、uuid の来ないエージェントの発言）は、今回増えた分の中から役割と本文で
  let j = before;
  for (const m of thread.querySelectorAll('.mw[data-key^="live:"] .m[data-role]:not([data-uuid])')) {
    const raw = m.querySelector(":scope > .body")?.dataset.raw ?? m.querySelector(":scope > .body")?.textContent ?? "";
    const idx = state.messages.findIndex((x, i) => i >= j && !claimed.has(i) && x.role === m.dataset.role
      && (m.dataset.role === "user" ? (x.text ?? "") === raw : (!raw || (x.text ?? "") === raw)));
    if (idx < 0) continue;
    setUuid(m, state.messages[idx].uuid);
    m.closest(".mw").dataset.key = `m:${idx}`;
    claimed.add(idx);
    j = idx + 1;
  }
  branches.update(id, state.messages);
  if (!branches.has(id)) await branches.load(id, state.messages);
  if (state.current !== id) return;
  if (state.busy) { pendingBranchReload = true; return; }
  placeJunctions();
}

// ---------------------------------------------------------------- 分岐

/** Create the actual child first, then grow its edge, reveal its node, and promote it. */
async function forkFrom(m, { draft } = {}) {
  const uuid = m.dataset.uuid, mw = m.closest('.mw');
  if (!uuid || !state.current || state.busy) return;
  const key = mw?.dataset.key ?? '';
  const mi = draft ? draft.index - 1 : key.startsWith('m:') ? Number(key.slice(2)) : state.messages.findIndex(x => x.uuid === uuid);
  const source = state.current;
  let sendTo;
  state.busy = true;
  log.classList.add('branch-transition');
  try {
    await settingsWrite;
    await modeWrite;
    const boundary = draft ? { beforeMessageId: uuid } : { upToMessageId: uuid };
    const result = await cmd('fork', { sessionId: source, ...boundary });
    if (!result?.sessionId) throw new Error('分岐先の id が返らなかった');
    if (draft) await persistDraft(result.sessionId, { text: draft.text, attached: draft.attached, dirty: true });
    await refresh();
    await branches.load(source, state.messages);
    const groups = placeJunctions();
    const row = groups.find(r => r.dataset.key === `m:${mi}`);
    if (row) await row.grow(result.sessionId);
    await changeBranch(result.sessionId, row);
    if (draft) sendTo = result.sessionId;
    $('prompt').focus({ preventScroll: true });
  } catch (e) {
    placeJunctions();
    sys(`分岐に失敗: ${escText(e.message)}`);
  } finally { await finishBranchChange(); }
  if (sendTo && state.current === sendTo) await submit();
}

/** The session menu uses the same creation animation as the message action. */
async function forkTail(id) {
  if (state.busy) return;
  await select(id);
  if (state.current !== id || state.busy) return;
  const last = [...thread.querySelectorAll('.m[data-uuid]')].at(-1);
  if (last) return forkFrom(last);
  state.busy = true;
  log.classList.add('branch-transition');
  try {
    await settingsWrite;
    await modeWrite;
    const r = await cmd('fork', { sessionId: id });
    await refresh();
    await branches.load(id, state.messages);
    const row = placeJunctions().at(-1);
    if (row) await row.grow(r.sessionId);
    await changeBranch(r.sessionId, row);
  } catch (e) { sys(`分岐に失敗: ${escText(e.message)}`); }
  finally { await finishBranchChange(); }
}

async function changeBranch(id, row) {
  const source = state.current;
  // Resolve data before touching the visible selection or conversation.
  sessionLoads.cancel(state.displayLoad);
  const load = sessionLoads.begin(id);
  state.displayLoad = load;
  try {
    const data = await cmd('loadSession', { sessionId: id, live: true });
    const target = data?.messages ?? [];
    let keep = commonPrefix(state.messages, target);
    const cut = branches.boundary(source, id);
    if (cut != null) keep = Math.min(keep, cut + 1);
    const anchor = keep ? branchAnchor(keep - 1) : null;
    const retainedIndex = anchor?.dataset.key?.startsWith('m:') ? Number(anchor.dataset.key.slice(2)) : -1;
    keep = Math.min(keep, retainedIndex + 1);
    const transition = row ? { key: row.dataset.key, snapshot: row.snapshot() } : null;
    await branches.load(id, target);
    if (state.current !== source) return;
    await paintSession(id, data, { keepUpTo: keep, transition, loaded: true, load });
  } finally { sessionLoads.cancel(load); }
}
async function switchTo(id, row) {
  if (state.busy || id === state.current) return;
  state.busy = true; row?.lock();
  log.classList.add('branch-transition');
  try { await changeBranch(id, row); }
  catch (e) { row?.unlock(); sys(`切り替えに失敗: ${escText(e.message)}`); }
  finally { await finishBranchChange(); }
}

// ---------------------------------------------------------------- 送信

/** いま表示しているセッションが走っているか。並行実行するので画面ごとに違う。 */
function isRunningHere() {
  return state.current ? state.runningIds.has(state.current) : state.submitting;
}

const isWaitingHere = () => (state.work.permissions ?? []).some(belongsHere);

/** 実行状態から見た目を合わせる。走っている本数ではなく「この画面が走っているか」で決める。 */
function syncRunState() {
  const here = isRunningHere();
  // エージェント・作業ディレクトリは実行中も次のターンの分を予約できる（チップは無効にしない）
  $("send").disabled = submittingMessages.has(state.current) || state.loadingSession === state.current && Boolean(state.current)
    || Boolean(retiredHere());
  $("abort").hidden = !(here || isWaitingHere());
  if (!here) {
    closeTurnEl();
    // ターンは終わったが裏の作業が残っている。末尾の節は消さずに衛星にする（中断は出さない）
    if (behindHere() && !state.loadingSession) activity.show(activity.text || "裏の作業を待っている");
    else activity.hide();
  }
}

async function clearSentDraft(id, text, attachments) {
  const draft = state.current === id ? { text: $('prompt').value, attached: state.attached } : state.drafts.get(id);
  if (draft?.text !== text || JSON.stringify((draft.attached ?? []).map(a => a.path)) !== JSON.stringify(attachments.map(a => a.path))) return;
  if (state.current === id) { $('prompt').value = ''; state.attached = []; renderAttached(); $('slashHint').textContent = ''; slashSkills.close(); fitPrompt(); }
  await persistDraft(id, { text: '', attached: [], dirty: true });
}
async function submit() {
  if ($('prompt').value.trim() || state.attached.length) completionNotifications.requestPermission();
  if (!state.current) { await startNew(); if (!state.current) return; }
  const sessionId = state.current;
  if (submittingMessages.has(sessionId) || state.busy || state.loadingSession || retiredHere()) return;
  submittingMessages.add(sessionId);
  syncRunState();
  try {
    await settingsWrite.catch(() => {});
    await modeWrite;
    if (state.current !== sessionId || settingsFailure === sessionId) return;
    // 候補が開いたまま blur した場合の後片付けが先に走ると、送信の入力が書き換わる
    slashSkills.close();
    const text = $('prompt').value;
    const attachments = state.attached.map(a => ({ path: a.path, name: a.name, mime: a.mime ?? '' }));
    if (!text.trim() && !attachments.length) return;
    const full = [text.trim(), attachments.map(a => `[添付] ${a.path}`).join(NL)].filter(Boolean).join(NL + NL);
    const args = { sessionId, prompt: full, cwd: state.cwd.trim() || undefined, mode: state.mode,
      ...(attachments.length ? { attachments } : {}) };
    const previous = receipts.get(sessionId);
    if (previous) {
      const known = (await refreshOutbox(sessionId)).find(m => m.id === previous.messageId);
      if (!known && previous.prompt !== full) throw new Error('前の送信結果を確認できません。元の入力で再試行してください。');
      if (known && previous.prompt === full) {
        await clearSentDraft(sessionId, text, attachments);
        receipts.delete(sessionId); saveReceipts();
        return;
      }
    }
    const request = previous && previous.prompt === full ? previous : { ...args, messageId: crypto.randomUUID() };
    receipts.set(sessionId, request); saveReceipts();
    await cmd('sendMessage', request);
    await clearSentDraft(sessionId, text, attachments);
    receipts.delete(sessionId); saveReceipts();
    $('settingsError').textContent = '';
  } catch (e) {
    $('settingsError').textContent = `送信を確認できませんでした。入力は保持しています: ${e.message}`;
  } finally {
    submittingMessages.delete(sessionId);
    syncRunState();
  }
}

// ---------------------------------------------------------------- 接続

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);

    if (m.kind === "ready") {
      // protocolVersion は必ず gate する。想定外なら黙って誤動作させない
      if (m.protocolVersion !== PROTOCOL) {
        sys(`未対応の protocolVersion: ${escText(m.protocolVersion)}`);
        return ws.close();
      }
      if (m.homeDir) state.homeDir = m.homeDir;
      // 画面と違う言語なら読み直すので、ここで止める
      if (applyLocale(m.locale)) return;
      side.setConnLost(false);
      return refresh().then(async () => {
        if (state.current) return select(state.current, { reload: true });
        let saved;
        try { saved = localStorage.getItem("agent-host-current"); } catch {}
        if (saved && state.sessions.some(s => s.id === saved)) await select(saved);
        else await startNew();
      }).catch(e => sys(`初期化に失敗: ${escText(e.message)}`));
    }

    if (m.kind === "event") return onEvent(m.event);

    if (m.kind === "response") {
      const p = pending.get(m.id);
      pending.delete(m.id);
      return m.ok ? p?.res(m.result) : p?.rej(new Error(String(m.error)));
    }

    if (m.kind === "error") sys(`error: ${escText(m.error)}`);
  };

  ws.onclose = () => {
    // 困っているときだけ出す。切れても向こうは走り続けている（猶予の間）ので実行中の印は消さない
    side.setConnLost(true);
    for (const [, p] of pending) p.rej(new Error("切断"));
    pending.clear();
    setTimeout(connect, 1500);
  };

  ws.onerror = () => ws.close();
}

// ---------------------------------------------------------------- 操作

$("composer").onsubmit = (e) => { e.preventDefault(); submit(); };
$("prompt").onkeydown = (e) => {
  if (isComposingKey(e)) return;
  // 入力欄の「/」の候補が開いている間は候補の操作を先に取る（Ctrl+Enter は送信のまま）
  if (slashSkills.keydown(e)) return;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
};
// コンテキストの画面は今見ているセッションの作業ディレクトリを使う。無ければ入力欄の値
const context = setupContext({ button: $('openContext'), cmd, current: () => state.cwd,
  session: () => state.sessions.find(s => s.id === state.current) ?? null,
  show: () => onboarding.page('context'), recentPlaces: cwdOptions, backends: () => state.backends });
// 会話の右パネル「この会話のコンテキスト」。札とタイトル行の入口から開く
const sessionContext = setupSessionContext({ cmd, preview: filePreview,
  session: () => state.sessions.find(s => s.id === state.current) ?? null,
  info: () => (state.contextInfoId === state.current ? state.contextInfo : null),
  refreshInfo: (force) => refreshContextEntry({ force }),
  openSettings: (place) => openContextPage(place), labelOf,
  isRunning: () => Boolean(state.current && state.runningIds.has(state.current)) });
$('contextEntry').onclick = () => sessionContext.toggle($('contextEntry'));
// 止めるのは今見ているセッションだけ。他のセッションは走らせたままにする
$("abort").onclick = () => cmd("abort", { sessionId: state.current }).catch(() => {});

$("authNeed").onclick = (e) => { e.stopPropagation(); side.closePops(); openSettings(); };

$("prompt").addEventListener("input", fitPrompt);
addEventListener("resize", fitPrompt);

$("workDialog").addEventListener("click", (e) => {
  if (e.target.dataset?.close !== undefined || e.target === $("workDialog")) $("workDialog").close();
});
$('workDialog').addEventListener('close', () => { backgroundView = null; });

// タイトルは人間もその場で変えられる。AI 用ツールと同じ store を通る（設計メモ 2.2）
let titleSent = null;   // 送ったばかりの値。Enter → blur で change と blur の両方から呼ばれても 1 回にする
async function commitTitle() {
  const s = state.sessions.find((x) => x.id === state.current);
  const v = $("titleEdit").value.trim();
  if (!state.current || !v || v === s?.title || v === titleSent) return;
  titleSent = v;
  await cmd("setTitle", { sessionId: state.current, title: v, reason: "手動で変更" })
    .catch((e) => sys(`タイトル変更に失敗: ${escText(e.message)}`));
}
$("titleEdit").onchange = commitTitle;
$("titleEdit").onblur = commitTitle;
$("titleEdit").onkeydown = (e) => { if (isComposingKey(e)) return; if (e.key === "Enter") { e.preventDefault(); $("titleEdit").blur(); } };

// タイトルは AI にも考えてもらえる。人間が同じことをできる場所の隣に置く（設計メモ 2.2）
$("titleWand").onclick = async () => {
  const id = state.current;
  if (!id || titleGenerating.has(id)) return;
  titleGenerating.add(id);
  syncTitleControls();
  let result = null;
  try {
    result = await cmd("suggestTitle", { sessionId: id });
  } catch (e) {
    sys(`タイトルを考えられなかった: ${escText(e.message)}`);
  } finally {
    titleGenerating.delete(id);
    syncTitleControls();
  }
  // 考えている間に別の会話へ移っていたら、その会話の欄には入れない
  if (!result || state.current !== id) return;
  // 勝手に確定させず、入力欄に入れて選択状態にする。気に入らなければそのまま書き換えられる
  $("titleEdit").value = result.title;
  $("titleEdit").focus();
  $("titleEdit").select();
};

const onboarding = setupOnboarding({ cmd, refreshAuth, getAuth: () => state.auth, authLogin, authUrlBox,
  begin: async (settings, prompt) => {
    if (state.busy || creatingSession) throw new Error("実行中の作業が完了してから、新しい会話を始めてください。");
    const id = await startNew(settings);
    if (!id || state.current !== id) throw new Error("新しい会話を開けませんでした。もう一度お試しください。");
    $("prompt").value = prompt;
    $("prompt").dispatchEvent(new Event("input", { bubbles: true }));
  },
});
setupUpdates({ page: onboarding.page, open: onboarding.open, lock: onboarding.lock, flush: async () => {
  const work = await cmd('running');
  if (work.count > 0) {
    // どの会話が止めているかを名前で出す。数だけだと、どこを待てばよいか探し回ることになる
    const ids = [...new Set([...work.turns, ...work.permissions.filter(p => !p.relay), ...work.subagents].map(w => w.sessionId).filter(Boolean))];
    const names = ids.slice(0, 3).map(id => `「${rowLabel(state.sessions.find(s => s.id === id) ?? {})}」`).join('');
    const where = names ? `${names}${ids.length > 3 ? ` ほか ${ids.length - 3} 件` : ''}で作業か承認待ちが続いています` : '委譲した作業が続いています';
    throw new Error(`更新できません：${where}。完了してから再起動してください。更新は準備済みのまま残ります。`);
  }
  if (creatingSession || state.loadingSession) throw new Error('会話の読み込みが完了してから更新してください。');
  if (!state.current && ($('prompt').value || state.attached.length)) throw new Error('下書きを保存する会話を開いてから更新してください。');
  await saveDraft();
  await Promise.all([settingsWrite, modeWrite, ...[...state.drafts].filter(([id, draft]) => id && draft.dirty).map(([id, draft]) => persistDraft(id, draft))]);
  await Promise.all([...draftWrites.values()]);
} });
function openSettings() { onboarding.open(); }
setupUsage({ $, cmd, getBackends: () => state.backends, endpoints: async (agent) => (await compatEndpoints.load(true)).filter((e) => e.agent === agent), page: onboarding.page, isOpen: onboarding.isOpen,
  // 使用量の認可が済んでいないアカウントの「使用量の表示を認可」。アカウントの画面を開いて、そのまま認可を始める
  onUsageLogin: accountId => claudeAccounts.open({ usageLogin: accountId }) });
clearThread();
applyDom(document);
initTheme();
initLocale();
initSidebar();
watchTitleBar();
wireDropZone();
fitPrompt();
connect();
