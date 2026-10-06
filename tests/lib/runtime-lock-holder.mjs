// 実行場所の使用中の印（core/runtime-use.mjs）を、別のプロセスとして持つ試験用の子。
//   node tests/lib/runtime-lock-holder.mjs <root> <key>
// 印を付けたら標準出力に `held` を 1 行出し、標準入力が閉じる（親が終わる・stdin を end する）まで持ち続ける。
import { markRuntimeInUse } from '../../core/runtime-use.mjs';

const [root, key] = process.argv.slice(2);
const release = markRuntimeInUse({ root, key });
console.log(release ? 'held' : 'failed');
process.stdin.resume();
process.stdin.on('end', () => { release?.(); process.exit(0); });
