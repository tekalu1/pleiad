// 既定のレジストリ。操作を足したら、領域のファイルに書いてここで集める（集め忘れは tests/unit/ops-coverage.mjs が落とす）。
// 設定は各設定のモジュールが `export const settings = [defineSetting(…)]` で出し、ここで集める（段階 1 以降）。
import { createRegistry } from './registry.mjs';
import { appOps } from './app.mjs';
import { sessionOps } from './sessions.mjs';

export const registry = createRegistry({
  ops: [...appOps, ...sessionOps],
  settings: [],
});

export { createRegistry, defineOp, defineSetting, OpError } from './registry.mjs';
