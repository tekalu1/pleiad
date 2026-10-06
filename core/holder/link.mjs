// 保持役への接続を、プロセスに 1 本だけ持つ（無停止の更新 段階 2 の 2b-5。docs/zero-downtime-update/stage2-server-state.md §6）。
// 保持役の親は常に 1 つで、後から合格した方が勝ち、古い方は切られる（core/holder/protocol.mjs）。起動の付け直しの元（core/adopt.mjs の readHolderSources）と
// バックエンドが起こす子（fake の台本 held:。2c の Claude）が別々につなぐと取り合うので、同じ口を共有する。
//   launch: true  居なければ保持役を起こしてつなぐ（ensureHolder。バックエンドが子を起こすとき）
//   launch: false 居る保持役にだけつなぐ（connectHolder。起動の付け直しの元。居なければ code 'HOLDER_NONE'）
// つながりが切れていれば（保持役が終わった・つなぎ直し）、次の呼び出しがつなぎ直す。
import path from 'node:path';
import { ensureHolder, connectHolder } from './client.mjs';

let shared = null;   // { id, promise }

/** 同じデータ置き場・実行場所の保持役への口。残りの options は ensureHolder / connectHolder へ渡す */
export async function holderLink({ dataDir, root, launch = true, ...options } = {}) {
  if (!dataDir || !root) throw Object.assign(new Error('holderLink needs dataDir and root'), { code: 'HOLDER_CONFIG' });
  const id = `${path.resolve(dataDir)}\n${root}`;
  if (shared?.id === id) {
    const client = await shared.promise.catch(() => null);
    if (client?.connected) return client;
  }
  const promise = (launch ? ensureHolder({ dataDir, root, ...options }).then(found => found.client) : connectHolder({ dataDir, root, ...options }));
  const entry = { id, promise };
  shared = entry;
  // つなげなかった口は覚えない（次の呼び出しがやり直す）
  promise.catch(() => { if (shared === entry) shared = null; });
  return promise;
}
