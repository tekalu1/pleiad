// Provider quota snapshots and local usage are deliberately separate: tokens cannot
// be converted into subscription percentages. Never persist account credentials.
import fs from 'node:fs/promises';
import path from 'node:path';

export const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// Thread totals include previous turns; last describes the latest model request.
export function createCodexMeter() {
  const previous = {}, totals = {};
  return usage => {
    for (const [key, native] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['cachedTokens', 'cachedInputTokens']]) {
      const total = number(usage?.total?.[native]), last = number(usage?.last?.[native]);
      if (total == null || last == null) continue;
      const delta = previous[key] == null || total < previous[key] ? last : total - previous[key];
      totals[key] = (totals[key] ?? 0) + delta; previous[key] = total;
    }
    return { ...totals };
  };
}
const iso = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
export function usageWindow(label, used, resetsAt, minutes) {
  const percent = number(used);
  return { label, usedPercent: percent, remainingPercent: percent == null ? null : Math.max(0, 100 - percent),
    resetsAt: iso(resetsAt), minutes: number(minutes) };
}
const duration = minutes => minutes === 300 ? '5時間' : minutes === 10080 ? '週次（7日間）' : minutes ? `${minutes / 60}時間` : '期間不明';

export function codexQuota(data) {
  const buckets = Object.values(data?.rateLimitsByLimitId ?? {});
  if (!buckets.length && data?.rateLimits) buckets.push(data.rateLimits);
  const windows = buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(key => {
    const w = bucket?.[key];
    if (!w) return [];
    const label = `${bucket.limitName || (bucket.limitId !== 'codex' && bucket.limitId) || ''} ${duration(w.windowDurationMins)}`.trim();
    return [usageWindow(label, w.usedPercent, number(w.resetsAt) == null ? null : w.resetsAt * 1000, w.windowDurationMins)];
  }));
  return { plan: buckets[0]?.planType ?? null, windows,
    message: windows.length ? null : '使用枠を取得できません。API 接続や未対応のアカウントでは表示されません。' };
}
export function whamQuota(data) {
  const convert = (limit, id, name) => ({ limitId: id, limitName: name, planType: data?.plan_type,
    ...Object.fromEntries(['primary', 'secondary'].map(key => {
      const w = limit?.[key + '_window'];
      return [key, w ? { usedPercent: w.used_percent, windowDurationMins: number(w.limit_window_seconds) == null ? null : w.limit_window_seconds / 60, resetsAt: w.reset_at } : null];
    })) });
  return codexQuota({ rateLimitsByLimitId: Object.fromEntries([
    ['codex', convert(data?.rate_limit, 'codex')],
    ...(data?.additional_rate_limits ?? []).map((b, i) => [String(i), convert(b.rate_limit, b.metered_feature, b.limit_name)]),
  ]) });
}
export function claudeQuota(data) {
  const limits = data?.rate_limits;
  const labels = { five_hour: ['5時間', 300], seven_day: ['週次（7日間）', 10080],
    seven_day_oauth_apps: ['OAuth アプリ・週次', 10080], seven_day_opus: ['Opus・週次', 10080], seven_day_sonnet: ['Sonnet・週次', 10080] };
  const windows = Object.entries(labels).flatMap(([key, [label, minutes]]) => limits?.[key]
    ? [usageWindow(label, limits[key].utilization, limits[key].resets_at, minutes)] : []);
  for (const w of limits?.model_scoped ?? []) windows.push(usageWindow(`${w.display_name}・週次`, w.utilization, w.resets_at, 10080));
  return { plan: data?.subscription_type ?? null, windows,
    message: windows.length ? null : '使用枠を取得できません。API 接続・権限不足・未対応の CLI では表示されません。' };
}

// Cache only successful sanitized responses, coalesce concurrent refresh requests.
export function createQuotaCache({ now = Date.now, ttl = 60_000 } = {}) {
  const cache = new Map(), pending = new Map();
  let generation = 0;
  const read = async (key, fetcher) => {
    const hit = cache.get(key);
    if (hit && now() - hit.checkedAt < ttl) return hit;
    if (pending.has(key)) return pending.get(key);
    const version = generation;
    const task = Promise.resolve().then(fetcher).then(value => {
      if (version !== generation) return { windows: [], checkedAt: null, message: '認証状態が変わりました。更新してください。' };
      const result = { ...value, checkedAt: now() }; cache.set(key, result); return result;
    }).catch(() => ({ windows: [], checkedAt: null, message: '取得に失敗しました。ログイン状態を確認し、しばらくして更新してください。' }))
      .finally(() => pending.delete(key));
    pending.set(key, task); return task;
  };
  read.clear = () => { generation++; cache.clear(); };
  return read;
}

// エージェント（ply_usage）へ渡す使用枠。委譲先を選ぶ判断に要る分だけに絞る（残率・期間の分・ローカル実績は落とす）。
// Claude のアカウントの見出しは人が付けた表示名なので、メールアドレスを書いていることがある。
// 会話へそのまま流さないよう、ローカル部を1文字だけ残して伏せる（見出しとして見分けは付く）
const maskEmail = text => typeof text === 'string' ? text.replace(/([^\s@<>()"'「」（）]?)[^\s@<>()"'「」（）]*@([^\s@<>()"'「」（）]+\.[A-Za-z]{2,})/g, '$1***@$2') : null;
// 使用率は小数第 1 位まで（残率から逆算した 9.999999999999998 のような端数を渡さない）
const percent = value => number(value) == null ? null : Math.round(value * 10) / 10;
// リセット時刻を過ぎた枠の使用率は今の値ではない。画面（web/usage.mjs）と同じく不明（null）として渡す
const expired = (w, now) => w.resetsAt != null && new Date(w.resetsAt).getTime() <= now;
export function compactQuota(quota, now = Date.now()) {
  const windows = list => (Array.isArray(list) ? list : []).map(w => ({ label: maskEmail(w.label),
    usedPercent: expired(w, now) ? null : percent(w.usedPercent), resetsAt: w.resetsAt ?? null }));
  return { plan: quota?.plan ?? null, windows: windows(quota?.windows),
    ...(Array.isArray(quota?.accounts) ? { accounts: quota.accounts.map(a => ({ label: maskEmail(a.label), plan: a.plan ?? null, windows: windows(a.windows), message: maskEmail(a.message) })) } : {}),
    checkedAt: iso(quota?.checkedAt), message: maskEmail(quota?.message) };
}

/**
 * ply_usage の本体。backend を省けば使用枠を読めるバックエンドすべて。
 * read は providerUsage と同じ取得（同じ quotaCache を通す）。1 つが失敗しても他は返す
 */
export async function agentUsage({ backend, list, get, read }) {
  let targets;
  if (backend === undefined) targets = list().filter(b => b.usage);
  else {
    const found = typeof backend === 'string' ? get(backend) : null;
    if (!found) throw new Error(`知らないバックエンドです: ${String(backend)}（使えるもの: ${list().map(b => b.id).join(', ')}）`);
    targets = [found];
  }
  const backends = await Promise.all(targets.map(async b => {
    let quota;
    try { quota = await read(b); }
    catch { quota = { windows: [], checkedAt: null, message: '取得に失敗しました。' }; }
    return { backend: b.id, label: b.label, ...compactQuota(quota) };
  }));
  return { backends };
}

export function createUsageStore(dir, { now = Date.now } = {}) {
  const file = path.join(dir, 'usage.json');
  let writes = Promise.resolve();
  async function read() {
    try {
      const data = JSON.parse(await fs.readFile(file, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.records)) throw new Error('使用量記録の形式が不正です');
      return data;
    } catch (e) { if (e.code === 'ENOENT') return { version: 1, since: now(), records: [] }; throw e; }
  }
  return {
    record(record) {
      const task = writes.catch(() => {}).then(async () => {
        const data = await read();
        const safe = { id: record.id, backend: record.backend, at: now(),
          inputTokens: number(record.inputTokens), outputTokens: number(record.outputTokens),
          cachedTokens: number(record.cachedTokens), costUsd: number(record.costUsd) };
        if (!data.records.some(r => r.id === safe.id)) data.records.push(safe);
        await fs.mkdir(dir, { recursive: true });
        const tmp = file + '.tmp';
        await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(tmp, file);
      });
      writes = task; return task;
    },
    async summary(backend) {
      await writes;
      const data = await read();
      const summarize = hours => {
        const rows = data.records.filter(r => r.backend === backend && r.at >= now() - hours * 3600_000);
        return { turns: rows.length, ...Object.fromEntries(['inputTokens', 'outputTokens', 'cachedTokens', 'costUsd'].map(key => {
          const known = rows.filter(r => number(r[key]) != null);
          return [key, { value: known.length ? known.reduce((sum, r) => sum + r[key], 0) : null, measured: known.length }];
        })) };
      };
      return { since: data.records.length ? data.since : null, fiveHour: summarize(5), sevenDay: summarize(168) };
    },
  };
}
