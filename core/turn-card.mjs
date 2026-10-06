// ターンの札（無停止の更新 2b-2。docs/zero-downtime-update/stage2-server-state.md の §3 の 3・表の札の行・T1・§4.3・§6 の 2b-2、design.md §4）。
// 保持役の子ごとの label（札）に置き、新しいサーバーが付け直し（adoptTurn）で読む純粋な JSON。
//   - cardOf(ctx): ctx から札本体（card）と秘密の欄（secrets）を分けて取り出す。版 v: 1。
//   - restoreFields(card): 札から復元用のフィールド群を取り出す。知らない版は null を返す。
//   - 秘密（account.token、endpoint のキーなど）は札本体に入れない（保持役の預かり物 stash に置く想定）。
//   - 途中送信の控えを 1 つの欄（steers）にまとめる形（項目の id ごとに「誰が待っているか」）。
//   - ターンの前の切り口（T1: baseline の発言数と最後の uuid）。
//   - 会話の口のトークン（connectionTokens: { agents, computer, browser, control, context }）。
//   - 札の大きさの上限（CARD_MAX_BYTES = 64 KB）。超えたら失敗。
import crypto from 'node:crypto';

/** 札の規約の版 */
export const CARD_VERSION = 1;

/** 札の大きさの上限（64 KB）。保持役のパイプとメモリの肥大化を防ぐ */
export const CARD_MAX_BYTES = 64 * 1024;

/** 途中送信の控えを待つ 5 か所の識別子（stage2-server-state.md §3 の 3） */
export const STEER_WAITERS = Object.freeze([
  'pendingSteers',    // Claude の折り込み待ち (O5)
  'liveNotices',      // 完了通知の控え (M4)
  'liveInstructions', // 追加指示の控え (M5)
  'agentTasks',       // agentTasks の steers (O16)
  'botLiveSteers',    // bot の liveSteers (O21)
]);

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/**
 * 会話の口のトークン（connectionTokens）の形を正規化する。
 * 各口は 64 桁小文字 16 進の Bearer トークン、または null。
 */
export function normalizeConnectionTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const pick = (v) => (typeof v === 'string' && TOKEN_PATTERN.test(v) ? v : null);
  return {
    agents: pick(tokens.agents),
    computer: pick(tokens.computer),
    browser: pick(tokens.browser),
    control: pick(tokens.control),
    context: pick(tokens.context),
  };
}

/** entry から Bearer トークンを抽出する内部補助（server.mjs の connectionTokens と同等） */
function extractBearer(port) {
  return /^Bearer ([a-f0-9]{64})$/.exec(port?.headers?.Authorization ?? '')?.[1] ?? null;
}

/** ctx または entry から connectionTokens の形を取り出す */
function extractTokensFromCtx(ctx) {
  if (ctx.connectionTokens) return normalizeConnectionTokens(ctx.connectionTokens);
  const entry = ctx.entry ?? ctx.connection;
  if (entry) {
    return normalizeConnectionTokens({
      agents: extractBearer(entry.runtime),
      computer: extractBearer(entry.computer),
      browser: extractBearer(entry.browser),
      control: typeof entry.control?.token === 'string' ? entry.control.token : null,
      context: typeof entry.contextToken === 'string' ? entry.contextToken : null,
    });
  }
  return null;
}

/**
 * 途中送信の控え（steers）を正規化する。
 * 各項目 id ごとに { waiters: [...], ... } の形を保ち、無効な waiter 名は省く。
 */
export function normalizeSteers(steers) {
  if (!steers || typeof steers !== 'object' || Array.isArray(steers)) return {};
  const valid = {};
  for (const [id, entry] of Object.entries(steers)) {
    if (!id || typeof id !== 'string') continue;
    if (!entry || typeof entry !== 'object') continue;
    const rawWaiters = Array.isArray(entry.waiters) ? entry.waiters : [];
    const waiters = rawWaiters.filter(w => STEER_WAITERS.includes(w));
    valid[id] = {
      ...entry,
      waiters,
    };
  }
  return valid;
}

/**
 * ターンの文脈 ctx から、保持役に渡す札本体（card）と秘密の欄（secrets）を分けて取り出す純関数。
 * 秘密（account.token、endpoint.key 等）は card に含めず、secrets に隔離する。
 *
 * @param {object} ctx - ターンの文脈
 * @param {object} [options]
 * @param {number} [options.maxBytes=CARD_MAX_BYTES] - 札の大きさの上限
 * @returns {{ card: object, secrets: object }}
 */
export function cardOf(ctx, options = {}) {
  if (!ctx || typeof ctx !== 'object') {
    throw new TypeError('ctx must be an object');
  }
  const maxBytes = options.maxBytes ?? CARD_MAX_BYTES;

  // 1. 識別・セッション
  const key = ctx.turn?.key ?? ctx.key ?? ctx.sessionId ?? (ctx.turn ? `new:${crypto.randomUUID()}` : '');
  const sessionId = ctx.sessionId ?? ctx.turn?.info?.sessionId ?? null;
  const backend = (typeof ctx.backend === 'string' ? ctx.backend : ctx.backend?.id)
    ?? (typeof ctx.turn?.backend === 'string' ? ctx.turn.backend : ctx.turn?.backend?.id)
    ?? '';
  const agentLocale = ctx.agentLocale ?? ctx.turn?.agentLocale ?? 'ja';
  const startedAtMs = ctx.turn?.startedAtMs ?? ctx.startedAtMs ?? Date.now();
  const userSentAt = ctx.turn?.userSentAt ?? ctx.userSentAt ?? null;
  const presentKey = ctx.turn?.presentKey ?? ctx.presentKey ?? null;
  const browserRelayId = ctx.turn?.browserRelayId ?? ctx.browserRelayId ?? sessionId ?? key ?? null;

  // 2. ターンの前の切り口 (T1)
  const baselineCount = typeof ctx.baselineLength === 'number'
    ? ctx.baselineLength
    : (Array.isArray(ctx.turn?.stream?.messages) ? ctx.turn.stream.messages.length : 0);
  const baselineLastUuid = ctx.baselineLastUuid
    ?? (Array.isArray(ctx.turn?.stream?.messages) && ctx.turn.stream.messages.length > 0
      ? ctx.turn.stream.messages.at(-1)?.uuid ?? null
      : null);

  // 3. ターンの入力 (T2, T3, L1, L2, L3)
  const prompt = String(ctx.prompt ?? ctx.args?.prompt ?? '');
  const messageId = ctx.args?.messageId ?? ctx.turn?.stream?.initialMessageId ?? null;
  const user = ctx.turn?.stream?.user ? { ...ctx.turn.stream.user } : null;
  const scheduledFor = ctx.args?.scheduledFor ?? null;
  const sentBy = ctx.args?.sentBy ? { ...ctx.args.sentBy } : null;
  const compactTrigger = ctx.turn?.compactTrigger ?? ctx.hooks?.compact ?? null;
  const internal = Boolean(ctx.hooks?.internal);
  const taskId = ctx.hooks?.taskId ?? ctx.taskId ?? null;

  // 4. 設定・環境 (T22, T27, T42, L13)
  const cwd = ctx.cwd ?? ctx.turn?.info?.cwd ?? '';
  const permissionMode = ctx.permissionMode ?? ctx.turn?.info?.mode ?? '';
  const model = ctx.model ?? ctx.turn?.info?.model ?? '';
  const effort = ctx.effort ?? ctx.turn?.info?.effort ?? '';
  const accountId = ctx.accountId ?? ctx.turn?.info?.account ?? ctx.account?.id ?? '';
  const endpointId = ctx.endpointId ?? ctx.turn?.info?.endpoint ?? ctx.endpoint?.id ?? '';
  const attachments = Array.isArray(ctx.attachments)
    ? [...ctx.attachments]
    : Array.isArray(ctx.turn?.info?.attachments)
      ? [...ctx.turn.info.attachments]
      : [];
  const steeredAttachments = Array.isArray(ctx.turn?.steeredAttachments)
    ? [...ctx.turn.steeredAttachments]
    : [];
  const pastSubagents = Array.from(ctx.turn?.pastSubagents ?? ctx.pastSubagents ?? []);

  // 5. 渡した合図の印と控え (L6, L7, L8)
  const delivery = {
    initialDelivered: Boolean(ctx.initialDelivered),
    interruptionTaken: Boolean(ctx.interruptionTaken),
    shellHanded: Boolean(ctx.shellHanded),
  };
  const interruption = ctx.interruption ? {
    keys: Array.isArray(ctx.interruption.keys) ? [...ctx.interruption.keys] : [],
    dropped: Array.isArray(ctx.interruption.dropped) ? [...ctx.interruption.dropped] : [],
    text: ctx.interruption.text ?? null,
    body: ctx.interruption.body ?? null,
  } : null;
  const shellHandoff = ctx.shellHandoff ? {
    ids: Array.isArray(ctx.shellHandoff.ids) ? [...ctx.shellHandoff.ids] : [],
    skipped: Array.isArray(ctx.shellHandoff.skipped) ? [...ctx.shellHandoff.skipped] : [],
    lines: Array.isArray(ctx.shellHandoff.lines) ? [...ctx.shellHandoff.lines] : [],
  } : null;

  // 6. git の撮影 (T33)
  const git = (ctx.turn?.gitSetup || ctx.turn?.git || ctx.turn?.gitLate) ? {
    setup: ctx.turn.gitSetup ?? null,
    activity: ctx.turn.git ?? null,
    late: Boolean(ctx.turn.gitLate),
  } : null;

  // 7. 会話の口のトークン (M2, O9-O12)
  const connectionTokens = extractTokensFromCtx(ctx);

  // 8. 途中送信の控え (O5, M4, M5, O16, O21 - §3 の 3)
  const steers = normalizeSteers(ctx.steers ?? ctx.turn?.steers ?? {});

  // 9. hooks の登録材料 (L10)
  const hooks = ctx.hooksTurn ? {
    record: ctx.contextRecord?.hooks ?? ctx.hooksTurn.record ?? null,
    input: ctx.hooksTurn.input ?? null,
  } : null;

  // 10. 中断状態 (T7)
  const abort = {
    reason: ctx.turn?.abortReason ?? ctx.abortReason ?? null,
    stopping: Boolean(ctx.turn?.info?.stopping ?? ctx.stopping),
  };

  // 11. バックエンド固有の札 (2c, 2b-5 で足す)
  const backendCard = ctx.backendCard ?? ctx.turn?.backendCard ?? null;

  // 札本体 (card)
  const card = {
    v: CARD_VERSION,
    key,
    sessionId,
    backend,
    agentLocale,
    startedAtMs,
    userSentAt,
    presentKey,
    browserRelayId,
    baseline: {
      count: baselineCount,
      lastUuid: baselineLastUuid,
    },
    input: {
      prompt,
      messageId,
      user,
      scheduledFor,
      sentBy,
      compactTrigger,
      internal,
      taskId,
    },
    settings: {
      cwd,
      permissionMode,
      model,
      effort,
      accountId,
      endpointId,
      attachments,
      steeredAttachments,
      pastSubagents,
    },
    delivery,
    interruption,
    shellHandoff,
    git,
    connectionTokens,
    steers,
    hooks,
    abort,
    backendCard,
  };

  // 秘密の欄 (secrets) - 札本体には入れず、別に返す（保持役の預かり物に置く想定）
  const secrets = {
    account: ctx.account ? {
      id: accountId,
      token: ctx.account.token ?? null,
    } : null,
    endpoint: ctx.endpoint ? {
      id: endpointId,
      key: ctx.endpoint.key ?? ctx.endpoint.apiKey ?? null,
      headers: ctx.endpoint.headers ? { ...ctx.endpoint.headers } : null,
    } : null,
  };

  // 大きさ上限の検査
  const serialized = JSON.stringify(card);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`Turn card size exceeds limit: ${bytes} bytes > ${maxBytes} bytes`);
  }

  return { card, secrets };
}

/**
 * 札 card から復元用フィールドを取り出す純関数。
 * 知らない版（v !== CARD_VERSION）や不正な値の場合は null を返す。
 *
 * @param {object} card - 札本体
 * @returns {object|null} 復元フィールド群、または null
 */
export function restoreFields(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return null;
  if (card.v !== CARD_VERSION) return null;

  return {
    v: card.v,
    key: typeof card.key === 'string' ? card.key : '',
    sessionId: typeof card.sessionId === 'string' ? card.sessionId : null,
    backendId: typeof card.backend === 'string' ? card.backend : '',
    agentLocale: typeof card.agentLocale === 'string' ? card.agentLocale : 'ja',
    startedAtMs: typeof card.startedAtMs === 'number' ? card.startedAtMs : 0,
    userSentAt: typeof card.userSentAt === 'number' ? card.userSentAt : null,
    presentKey: typeof card.presentKey === 'string' ? card.presentKey : null,
    browserRelayId: typeof card.browserRelayId === 'string' ? card.browserRelayId : null,

    // T1: ターンの前の切り口
    baseline: {
      count: typeof card.baseline?.count === 'number' ? card.baseline.count : 0,
      lastUuid: typeof card.baseline?.lastUuid === 'string' ? card.baseline.lastUuid : null,
    },

    // 入力
    prompt: typeof card.input?.prompt === 'string' ? card.input.prompt : '',
    messageId: typeof card.input?.messageId === 'string' ? card.input.messageId : null,
    user: card.input?.user ? { ...card.input.user } : null,
    scheduledFor: typeof card.input?.scheduledFor === 'string' ? card.input.scheduledFor : null,
    sentBy: card.input?.sentBy ? { ...card.input.sentBy } : null,
    compactTrigger: typeof card.input?.compactTrigger === 'string' ? card.input.compactTrigger : null,
    internal: Boolean(card.input?.internal),
    taskId: typeof card.input?.taskId === 'string' ? card.input.taskId : null,

    // 設定
    cwd: typeof card.settings?.cwd === 'string' ? card.settings.cwd : '',
    permissionMode: typeof card.settings?.permissionMode === 'string' ? card.settings.permissionMode : '',
    model: typeof card.settings?.model === 'string' ? card.settings.model : '',
    effort: typeof card.settings?.effort === 'string' ? card.settings.effort : '',
    accountId: typeof card.settings?.accountId === 'string' ? card.settings.accountId : '',
    endpointId: typeof card.settings?.endpointId === 'string' ? card.settings.endpointId : '',
    attachments: Array.isArray(card.settings?.attachments) ? [...card.settings.attachments] : [],
    steeredAttachments: Array.isArray(card.settings?.steeredAttachments) ? [...card.settings.steeredAttachments] : [],
    pastSubagents: new Set(Array.isArray(card.settings?.pastSubagents) ? card.settings.pastSubagents : []),

    // 進行・合図
    delivery: {
      initialDelivered: Boolean(card.delivery?.initialDelivered),
      interruptionTaken: Boolean(card.delivery?.interruptionTaken),
      shellHanded: Boolean(card.delivery?.shellHanded),
    },
    interruption: card.interruption ? { ...card.interruption } : null,
    shellHandoff: card.shellHandoff ? { ...card.shellHandoff } : null,

    // git
    git: card.git ? { ...card.git } : null,

    // 会話の口のトークン
    connectionTokens: normalizeConnectionTokens(card.connectionTokens),

    // 途中送信の控え
    steers: normalizeSteers(card.steers),

    // hooks
    hooks: card.hooks ? { ...card.hooks } : null,

    // 中断
    abortReason: typeof card.abort?.reason === 'string' ? card.abort.reason : null,
    stopping: Boolean(card.abort?.stopping),

    // バックエンド固有
    backendCard: card.backendCard ?? null,
  };
}
