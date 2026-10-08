// 委譲の子の「固定の部分」（Claude の会話の最初のリクエストの文脈。システムプロンプト・道具・指示など）の直近の値（ADR 0166）。
// 子の最初のターンはまだ自分の値が無いので、自動圧縮の閾値（固定の部分 + 空き）をここから見積もる:
// 同じ作業場所・同じモデルの直近 → 何でもよいので直近 → 無ければ呼び出し側の定数。
// 再起動をまたいで残すため、データ置き場の context-bases.json に写す（作業場所 × モデルで LIMIT 件まで。古いものから捨てる）
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeAtomic } from './atomic-file.mjs';
import { validContextBase } from './compaction-settings.mjs';

export const CONTEXT_BASES_LIMIT = 50;

/** 作業場所の比べ方。Windows は大文字・小文字を区別しない */
const placeKey = (cwd) => {
  const resolved = path.resolve(String(cwd ?? ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export function createContextBases({ file, limit = CONTEXT_BASES_LIMIT, now = Date.now, log = (...args) => console.error(...args) }) {
  // 新しいものが後ろ。{ cwd, model, tokens, at }
  let entries = [];
  let chain = Promise.resolve();

  const save = () => {
    const data = JSON.stringify({ version: 1, entries }, null, 2);
    chain = chain.then(() => writeAtomic(file, data))
      // i18n-ignore: サーバーのログ
      .catch(err => log('  委譲の子の固定の部分を保存できませんでした:', String(err?.message ?? err)));
    return chain;
  };

  return {
    /** 前の起動の値を読む。無い・壊れていれば空から始める */
    async load() {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        entries = saved?.version === 1 && Array.isArray(saved.entries)
          ? saved.entries.filter(e => typeof e?.cwd === 'string' && typeof e.model === 'string' && validContextBase(e.tokens) && Number.isFinite(e.at))
            .sort((a, b) => a.at - b.at).slice(-limit)
          : [];
      } catch { entries = []; }
    },
    /** 見積もり。{ tokens, source: 'same' | 'recent' } か、測った値が無ければ null */
    estimate({ cwd, model }) {
      const place = placeKey(cwd);
      const same = entries.findLast(e => placeKey(e.cwd) === place && e.model === (model ?? ''));
      if (same) return { tokens: same.tokens, source: 'same' };
      const last = entries.at(-1);
      return last ? { tokens: last.tokens, source: 'recent' } : null;
    },
    /** 測った値を覚える（同じ作業場所・同じモデルの前の値は置き換える）。保存の失敗は投げない */
    remember({ cwd, model, tokens }) {
      if (!validContextBase(tokens) || typeof cwd !== 'string' || !cwd) return chain;
      const place = placeKey(cwd);
      entries = entries.filter(e => !(placeKey(e.cwd) === place && e.model === (model ?? '')));
      entries.push({ cwd, model: model ?? '', tokens, at: now() });
      if (entries.length > limit) entries = entries.slice(-limit);
      return save();
    },
    entries: () => structuredClone(entries),
    /** 書き込みが終わるのを待つ（試験・終了時） */
    settled: () => chain,
  };
}
