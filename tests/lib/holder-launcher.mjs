// サーバー役の身代わり: 保持役を起こして（ensureHolder）つなぎ、保持役の pid を出して、保持役を残したまま終わる。
// node tests/lib/holder-launcher.mjs <データ置き場> <実行場所の置き場> [idleMs]。標準出力は {"pid":…,"started":…}
import { ensureHolder } from '../../core/holder/client.mjs';

const [dataDir, root, idleMs] = process.argv.slice(2);
const { client, started, pid } = await ensureHolder({ dataDir, root, key: '', appVersion: 'launcher', mode: 'detached', ...(idleMs ? { idleMs: Number(idleMs) } : {}) });
console.log(JSON.stringify({ pid, started }));
client.close();
