// 振り分け用の使用量の取り置き。委譲のたびに使用量を取りに行って待たないよう、既存の使用量の取得（server の providerQuota。
// 設定の「使用量」・ply_usage と同じ quotaCache を通す）を定期的に（既定 5 分ごと、委譲の直後にも）呼び直し、
// 振り分けは snapshot() を同期的に読む。取得中・失敗は「不明」（checkedAt が null）。
//
// snapshot() の形（core/delegation-routing.mjs の checkCandidate が読む）:
//   { [backend]: { available, checkedAt, windows, accounts?, models: { [model]: bool } } }
//   accounts … Claude で登録したアカウントがあるとき。[{ account: ''（ログイン中）| アカウント id, label, windows, identity, runnable }]
//   models   … 候補に挙がっているモデルが今の一覧にあるか（無ければ model_unknown で飛ばす）

import { maskEmail } from './usage.mjs';

export const REFRESH_MS = 5 * 60_000;

/**
 * backends()   … 有効なバックエンド（listBackends）
 * installed(id)… CLI が入っているか
 * read(b)      … 使用量（providerQuota）
 * candidates() … 今の設定の候補（'backend:model' の一覧）
 * modelKnown(b, model) … そのモデルが一覧にあるか（validModel）。一覧を引く前なら warm(b) を 1 回呼んでから見直す
 * claudeIdentities() … { login: { org, email } | null, accounts: [{ id, hasToken, identity }] }
 */
export function createUsageMonitor({ backends, installed = () => true, read, candidates, modelKnown, warm = async () => {}, claudeIdentities = async () => null,
  intervalMs = REFRESH_MS, onChange = () => {} }) {
  let state = {};
  let running = null, timer = null, again = false;

  async function one(b, wanted) {
    const entry = { available: installed(b.id), checkedAt: null, windows: [], models: {} };
    if (!entry.available) return entry;
    const models = [...new Set(wanted.filter(c => c.backend === b.id).map(c => c.model))];
    const known = async () => Object.fromEntries(await Promise.all(models.map(async m => [m, await modelKnown(b, m).catch(() => false)])));
    entry.models = await known();
    if (Object.values(entry.models).some(v => !v)) { await warm(b).catch(() => {}); entry.models = await known(); }
    if (!b.usage) return entry;
    let quota;
    try { quota = await read(b); } catch { return entry; }
    // 取得に失敗した値（checkedAt が null）は「不明」のまま
    if (!quota?.checkedAt) return entry;
    entry.checkedAt = quota.checkedAt;
    entry.windows = Array.isArray(quota.windows) ? quota.windows : [];
    if (b.id === 'claude' && Array.isArray(quota.accounts)) {
      const ids = await claudeIdentities().catch(() => null);
      entry.accounts = quota.accounts.map(row => {
        const account = row.accountId ?? '';
        const registered = account ? ids?.accounts?.find(a => a.id === account) : null;
        // 見出しは人が付けた名前で、メールアドレスを書いていることがある。振り分けの記録はエージェントにも返るので伏せる（ply_usage と同じ）
        return { account, label: maskEmail(row.label), windows: Array.isArray(row.windows) ? row.windows : [],
          identity: account ? registered?.identity ?? null : ids?.login ?? null,
          // 登録したアカウントはトークンが無いと会話を回せない。ログイン中のアカウントは使用量が読めていれば回せる
          runnable: account ? Boolean(registered?.hasToken) : true };
      });
    }
    return entry;
  }

  async function refreshAll() {
    const wanted = candidates().map(c => { const at = c.indexOf(':'); return { backend: c.slice(0, at), model: c.slice(at + 1) }; });
    const list = backends();
    const next = {};
    await Promise.all(list.map(async b => { next[b.id] = await one(b, wanted).catch(() => ({ available: false, checkedAt: null, windows: [], models: {} })); }));
    state = next;
    onChange();
  }

  const monitor = {
    /** 取り直す。走っている最中に呼ばれたら、終わった後にもう 1 回取り直す */
    refresh() {
      if (running) { again = true; return running; }
      running = (async () => {
        try { do { again = false; await refreshAll(); } while (again); }
        finally { running = null; }
      })();
      return running;
    },
    /** 今の値（同期）。取得中は前回の値 */
    snapshot() { return state; },
    /** まだ一度も取れていないバックエンドがあり、取得中なら、最長 ms だけ待つ（起動直後の委譲のため） */
    async warmUp(ms) {
      if (!running || Object.keys(state).length) return;
      await Promise.race([running.catch(() => {}), new Promise(r => setTimeout(r, ms).unref?.())]);
    },
    start() {
      if (timer) return;
      monitor.refresh().catch(() => {});
      timer = setInterval(() => { monitor.refresh().catch(() => {}); }, intervalMs);
      timer.unref?.();
    },
    stop() { clearInterval(timer); timer = null; },
  };
  return monitor;
}
