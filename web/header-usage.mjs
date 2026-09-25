// 会話のヘッダーの使用量のチップ（docs/design-system.md「ヘッダーの使用量」、承認済みのモック docs/mockups/header-usage.html）。
// この会話のエージェント（新しい会話は入力欄で選んだもの）の枠のうち、使用率がいちばん高いものを 1 つだけ出す。
// 押すと全エージェントの一覧（浮く面）。トークン数・費用などの詳しい数字は、これまでどおり設定の「使用量」で見る。
//
// 取得は設定の「使用量」と同じ口（web/usage.mjs の createUsageSource）。同じエージェントの取得が走っていれば相乗りする。
// サーバーも 1 分はキャッシュを返す（core/server.mjs の providerQuota）ので、何度呼んでも各サービスへの問い合わせは増えない。
// 更新: 5 分ごと（見えている間）・ターンが終わった直後（そのエージェントの分）・一覧を開いたとき・↻。
// 取得に失敗したら直前の値を薄く出し、いつの値かを添える。
import { el } from './dom.mjs';
import { fmt, t } from './i18n.mjs';
import { isExpired } from './usage.mjs';

const HIGH = 80;
const EVERY = 5 * 60_000;
const DAY = 24 * 3600_000;

/** 今の使用率。時刻を過ぎた枠は今の値ではないので不明（null） */
export const usedOf = (w, now = Date.now()) => w?.usedPercent == null || isExpired(w, now) ? null : w.usedPercent;

/** 上限に達して、回復の時刻がまだ先 */
export function atLimit(w, now = Date.now()) {
  const used = usedOf(w, now);
  return used != null && (used >= 100 || w.remainingPercent === 0) && Boolean(w.resetsAt) && new Date(w.resetsAt).getTime() > now;
}

/** 表に出す率。100 に届いていないのに丸めて 100% と見せない */
export const percentText = used => used == null ? '—' : `${Math.min(Math.round(used), used < 100 ? 99 : 100)}%`;

/**
 * 会話で使うアカウントの使用量。Claude でアカウントを登録していれば quota.accounts にアカウントごとに並ぶ
 * （core/backends/claude-usage.mjs）。account は会話の設定の値で、'' はログイン中のアカウント（accountId の無い行）。
 * 見つからなければ先頭（ログイン中のアカウント）。登録が無ければ quota そのもの
 */
export function quotaOf(quota, account = '') {
  if (!Array.isArray(quota?.accounts) || !quota.accounts.length) return quota ?? null;
  return quota.accounts.find(a => account ? a.accountId === account : !a.accountId) ?? quota.accounts[0];
}

/** 使用量の表示の認可が要る（済んでいない・やり直し） */
export const needsAuth = row => Boolean(row?.needsUsageLogin || row?.reauth);

/** 枠の短い名前。Antigravity のグループ名の頭と、末尾の括弧書き（「週次（7日間）」の「（7日間）」）を外す */
export function shortLabel(w) {
  const full = String(w?.label ?? '');
  let label = full;
  if (w?.group && label.startsWith(w.group)) label = label.slice(w.group.length).replace(/^[\s·・:：]+/, '');
  return label.replace(/\s*[（(][^（）()]*[）)]\s*$/, '') || full;
}

/** チップに出す枠。使用率のいちばん高いもの（不明は除く）。無ければ null */
export function topWindow(windows, now = Date.now()) {
  let top = null;
  for (const w of windows ?? []) {
    const used = usedOf(w, now);
    if (used != null && (top == null || used > usedOf(top, now))) top = w;
  }
  return top;
}

/**
 * Antigravity はモデルのグループごとに枠を持つ（window.group）。いちばん使っているグループの枠だけを出し、
 * 残りは件数と「いずれも X% 未満」（10 刻みで切り上げ）にまとめる。グループが 1 つ以下なら全部
 */
export function groupsOf(windows = [], now = Date.now()) {
  const groups = new Map();
  for (const w of windows) {
    const key = w.group ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  if (groups.size <= 1) return { windows, group: null, others: 0, below: null };
  const peak = list => Math.max(-1, ...list.map(w => usedOf(w, now) ?? -1));
  const [[group, shown], ...rest] = [...groups].sort((a, b) => peak(b[1]) - peak(a[1]));
  const top = Math.max(-1, ...rest.map(([, list]) => peak(list)));
  return { windows: shown, group: group || null, others: rest.length, below: top < 0 || top >= 100 ? null : Math.min(100, Math.floor(top / 10) * 10 + 10) };
}

/**
 * チップの中身。null は出さない（枠が 1 つも無い: fake・互換の接続先・未対応）。
 *   kind: 'auth' … 認可が要る（「使用量 —」を薄く）  'unknown' … 枠はあるが率が分からない  'value' … 率または上限
 */
export function chipState(row, now = Date.now()) {
  if (!row) return null;
  const window = topWindow(row.windows, now);
  if (window) {
    const used = usedOf(window, now);
    return { kind: 'value', window, used, high: used >= HIGH, limit: atLimit(window, now) };
  }
  if (needsAuth(row)) return { kind: 'auth' };
  return row.windows?.length ? { kind: 'unknown' } : null;
}

/** 残りの時間。「3 時間 10 分」「42 分」 */
function duration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours && rest ? t('usage.header.hoursMinutes', { hours, minutes: rest })
    : hours ? t('usage.header.hours', { hours }) : t('usage.header.minutes', { minutes });
}
/** 回復の時刻。24 時間より先なら日付を付ける */
const resetTime = (when, now) => new Date(when).getTime() - now < DAY ? fmt.time(when)
  : fmt.dateTime(when, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** 枠の下に添える回復の目安。「あと 3 時間 10 分で回復」「9/29(月) 9:00 に回復」「14:30 に回復（あと 42 分）」 */
export function resetText(w, now = Date.now()) {
  if (!w.resetsAt) return t('usage.resetsUnknown');
  if (isExpired(w, now)) return t('usage.expired');
  const left = new Date(w.resetsAt).getTime() - now;
  if (left >= DAY) return t('usage.header.resetOn', { when: fmt.dateTime(w.resetsAt, { month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) });
  return atLimit(w, now) ? t('usage.header.resetAtIn', { time: fmt.time(w.resetsAt), duration: duration(left) })
    : t('usage.header.resetIn', { duration: duration(left) });
}

export function setupHeaderUsage({ $, source, getBackends, onUsageLogin, openSettings }) {
  const chip = $('usageChip'), pop = $('usagePop');
  // エージェントごとの最後の値。{ label, quota, failed }。failed は直前の取得に失敗した（quota はその前の値）
  const data = new Map();
  // asked は一度でも取りに行ったエージェント（あとから有効にしたエージェントを、次の 5 分を待たずに取るため）
  const asked = new Set();
  let shown = { backend: null, account: '', endpoint: '' }, loading = 0, lastRefresh = 0;

  // 枠・認可のどちらかを持つ結果だけを値として覚える。持たない（取得の失敗・未対応）ときは前の値を残す
  const usable = quota => Boolean(quota?.windows?.length || quota?.accounts?.length || needsAuth(quota));
  function take(backend, result) {
    const prev = data.get(backend);
    if (usable(result?.quota) || !prev || !usable(prev.quota)) data.set(backend, { label: result?.label, quota: result?.quota ?? null, failed: false });
    else data.set(backend, { ...prev, failed: true });
  }
  source.onResult((backend, result) => { take(backend, result); paint(); });

  const labelOf = id => data.get(id)?.label ?? getBackends().find(b => b.id === id)?.label ?? id;
  const ids = () => getBackends().map(b => b.id);

  async function refresh(list = ids()) {
    if (!list.length) return;
    loading++; paint();
    if (list.length === ids().length) lastRefresh = Date.now();
    for (const id of list) asked.add(id);
    await Promise.all(list.map(id => source.load(id).catch(() => {
      const prev = data.get(id);
      if (prev) data.set(id, { ...prev, failed: true });
    })));
    loading--; paint();
  }

  // ---- チップ ----
  const mini = used => {
    const bar = el('span', 'usage-mini'); bar.setAttribute('aria-hidden', 'true');
    const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, used ?? 0))}%`;
    bar.append(fill); return bar;
  };
  const staleNote = entry => entry?.failed && entry.quota?.checkedAt ? t('usage.header.stale', { when: fmt.relative(entry.quota.checkedAt) }) : '';

  function paintChip() {
    const entry = data.get(shown.backend);
    const row = quotaOf(entry?.quota, shown.account);
    // 互換の接続先で動く会話はサブスクの枠を使わない
    const state = shown.endpoint ? null : chipState(row);
    chip.hidden = !state;
    if (!state) { close(); return; }
    const agent = labelOf(shown.backend), stale = staleNote(entry);
    chip.className = 'btn usage-chip' + (state.high ? ' hi' : '') + (state.kind !== 'value' || entry.failed ? ' dim' : '');
    if (state.kind !== 'value') {
      const text = state.kind === 'auth' ? t('usage.header.unauthorized') : t('usage.unknown');
      chip.replaceChildren(mini(0), el('span', 'lb', t('usage.header.title')), el('span', 'pc', '—'));
      chip.setAttribute('aria-label', t('usage.header.chipLabel', { agent, text }));
      chip.title = [state.kind === 'auth' ? row.message || text : text, stale].filter(Boolean).join(' · ');
      return;
    }
    const w = state.window, label = shortLabel(w);
    let text;
    if (state.limit) {
      const time = resetTime(w.resetsAt, Date.now());
      text = t('usage.header.limitUntil', { time });
      const pc = el('span', 'pc');
      pc.append(el('span', 'long', text), el('span', 'short', t('usage.header.limitShort', { time })));
      chip.replaceChildren(mini(state.used), pc);
    } else {
      text = percentText(state.used);
      chip.replaceChildren(mini(state.used), el('span', 'lb', label), el('span', 'pc', text));
    }
    chip.setAttribute('aria-label', t('usage.header.chipLabel', { agent, text: state.limit ? text : `${label} ${text}` }));
    chip.title = [t('usage.header.chipTitle', { agent, label: w.label, percent: percentText(state.used), reset: resetText(w) }), stale].filter(Boolean).join(' · ');
  }

  // ---- 一覧（浮く面） ----
  function rows(windows) {
    const grid = el('div', 'usage-rows'), now = Date.now();
    for (const w of windows) {
      const used = usedOf(w, now), high = used != null && used >= HIGH ? ' hi' : '';
      const name = el('span', 'wl', shortLabel(w)); name.title = w.label;
      const bar = el('span', 'usage-bar' + high);
      bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', t('usage.meter', { label: w.label }));
      const fill = el('i'); fill.style.width = `${Math.max(0, Math.min(100, used ?? 0))}%`; bar.append(fill);
      grid.append(name, bar, el('span', 'v' + high, percentText(used)), el('span', 'rs' + high, resetText(w, now)));
    }
    return grid;
  }
  function agentSection(id, entry, current) {
    const row = quotaOf(entry.quota, current ? shown.account : '');
    if (!row || !(row.windows?.length || needsAuth(row))) return null;
    const section = el('section', 'usage-agent' + (entry.failed ? ' usage-old' : ''));
    const { windows, group, others, below } = groupsOf(row.windows ?? []);
    const notes = [current && t('usage.header.thisConversation'), entry.quota?.accounts?.length && row.label,
      group && t('usage.header.group', { name: group })].filter(Boolean);
    const head = el('div', 'an', labelOf(id));
    if (notes.length) head.append(el('small', null, notes.join(' · ')));
    section.append(head);
    if (entry.failed) section.append(el('p', 'usage-note', staleNote(entry)));
    if (windows.length) section.append(rows(windows));
    if (others) section.append(el('p', 'more', below == null ? t('usage.header.otherGroups', { count: others })
      : t('usage.header.otherGroupsBelow', { count: others, percent: below })));
    if (needsAuth(row)) {
      if (row.message) section.append(el('p', 'usage-note', row.message));
      // 登録したアカウントの使用量は、アカウントごとに「使用量の表示を認可」が済んでから読める（web/usage.mjs と同じ口）
      if (row.accountId && onUsageLogin) {
        const button = el('button', 'btn btn-quiet', row.needsUsageLogin ? t('accounts.authorizeUsage') : t('usage.redoAuth'));
        button.type = 'button'; button.onclick = () => { close(); onUsageLogin(row.accountId); };
        section.append(button);
      }
    }
    return section;
  }
  function paintPop() {
    if (pop.hidden) return;
    const head = el('div', 'usage-pop-head');
    const checked = data.get(shown.backend)?.quota?.checkedAt;
    const again = el('button', 'rf', '↻');
    again.type = 'button'; again.disabled = loading > 0;
    again.setAttribute('aria-label', t('usage.header.refresh')); again.title = t('usage.header.refresh');
    again.onclick = () => refresh();
    head.append(el('b', null, t('usage.header.title')), el('span', 'when', checked ? fmt.relative(checked) : ''), again);
    const order = [shown.backend, ...ids().filter(id => id !== shown.backend)];
    const sections = order.map(id => data.has(id) ? agentSection(id, data.get(id), id === shown.backend) : null).filter(Boolean);
    const foot = el('div', 'foot');
    const more = el('button', null, t('usage.header.openSettings'));
    more.type = 'button'; more.onclick = () => { close(); openSettings(); };
    foot.append(more);
    pop.replaceChildren(head, ...sections, foot);
  }
  function paint() { paintChip(); paintPop(); }

  function open() {
    pop.hidden = false; chip.setAttribute('aria-expanded', 'true');
    paintPop(); refresh();
  }
  function close(focus = false) {
    if (pop.hidden) return;
    pop.hidden = true; chip.setAttribute('aria-expanded', 'false');
    if (focus) chip.focus();
  }
  chip.onclick = e => { e.stopPropagation(); if (pop.hidden) open(); else close(); };
  // 面の中の押下は描き直しで要素が外れることがあるので、closest ではなく押した時点の経路で見る
  document.addEventListener('click', e => { if (!pop.hidden && !e.composedPath().includes(pop)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !e.isComposing && !pop.hidden) close(true); });

  // 5 分ごと。隠れている間は取らず、見えたときに古ければ取る
  const due = () => !document.hidden && Date.now() - lastRefresh >= EVERY - 1000;
  const timer = setInterval(() => { if (due()) refresh(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (due()) refresh(); });
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });

  return {
    /** 今の会話のエージェント・アカウント・互換の接続先。client.mjs の syncTopbar が呼ぶ */
    show(next) {
      shown = { backend: next.backend ?? null, account: next.account ?? '', endpoint: next.endpoint ?? '' };
      if (shown.backend && getBackends().length && (!lastRefresh || !asked.has(shown.backend))) refresh(lastRefresh ? [shown.backend] : ids());
      else paint();
    },
    /** どこかの会話のターンが終わった。そのエージェントの分だけ取り直す */
    turnEnded(backend) { refresh(backend ? [backend] : ids()); },
  };
}
