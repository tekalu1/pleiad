// 実行場所の使用中の印（core/runtime-use.mjs）を、別のプロセスとして持つ試験用の子。
//   node tests/lib/runtime-lock-holder.mjs <root> <key> [drop]
// 印を付けたら標準出力に `held` を 1 行出し、標準入力が閉じる（親が終わる・stdin を end する）まで持ち続ける。
// drop を付けると、外す関数を捨てて GC を回してから `held` を出す（core/server.mjs は戻り値を捨てる。GC で外れないことを見る）。
import v8 from 'node:v8';
import vm from 'node:vm';
import { markRuntimeInUse } from '../../core/runtime-use.mjs';

const [root, key, mode] = process.argv.slice(2);
let release = null;
if (mode === 'drop') {
  const marked = Boolean(markRuntimeInUse({ root, key }));
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  for (let i = 0; i < 5; i++) { gc(); await new Promise(resolve => setTimeout(resolve, 20)); }
  console.log(marked ? 'held' : 'failed');
} else {
  release = markRuntimeInUse({ root, key });
  console.log(release ? 'held' : 'failed');
}
process.stdin.resume();
process.stdin.on('end', () => { release?.(); process.exit(0); });
