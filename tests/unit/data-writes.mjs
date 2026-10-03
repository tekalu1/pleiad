// 再発防止（ADR 0106）: core/ がデータ置き場へファイルを丸ごと書く箇所は、許可リスト（tests/data-writes-allowlist.mjs）に
// 上限と理由を書いたものだけ。リストに無い書き込みを足すと落ちる。件数・会話の長さで増える記録は DB の行にする。
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { scanWrites, stripCode, WRITE_CALL } from '../lib/data-writes-scan.mjs';
import { DATA_WRITES, DB_ONLY } from '../data-writes-allowlist.mjs';

export const name = 'data-writes';
export const title = '再発防止: データ置き場への丸ごと書きは許可リスト（上限と理由）に載ったものだけ';

const count = source => [...stripCode(source).matchAll(WRITE_CALL)].length;

export default async function (t) {
  // ---- 走査の自己検査（コメント・文字列の中は数えず、書き込み呼び出しは数える）
  t.ok('走査: コメントと文字列の中の writeFile は数えない', count('// fs.writeFile(a)\n/* writeAtomic(b) */\nconst s = "fs.writeFile(c)"; const u = `writeAtomic(d)`;') === 0);
  t.ok('走査: 書き込みの呼び出しを数える', count('await fs.writeFile(a, b); await writeAtomic(c, d); fs.renameSync(e, f); io.rename(g, h); handle.writeFile(i); jsonFile(j); fsSync.writeFileSync(k, l);') === 7);
  t.ok('走査: 別の名前（rename という名前のメソッド）は数えない', count('plyMcp.rename(name, to); store.rename(x); statuses.moveStatus(a, b);') === 0);

  // ---- 本番: core/ の書き込みが全部、許可リストにある
  const found = scanWrites(ROOT);
  const listed = new Map(DATA_WRITES.map(entry => [entry.file, entry]));
  t.ok('許可リストに同じファイルが 2 回出ない', listed.size === DATA_WRITES.length);
  const unlisted = Object.keys(found).filter(file => !listed.has(file));
  t.ok('core/ の書き込み箇所はすべて許可リストにある（無ければ、DB の行にするか、上限と理由を書いて足す。AGENTS.md）', unlisted.length === 0, unlisted.map(file => `${file}（${found[file]} 箇所）`).join(' / '));
  const changed = Object.keys(found).filter(file => listed.has(file) && listed.get(file).sites !== found[file]);
  t.ok('許可リストの箇所数と一致する（書き込みを足した・減らした場合は、リストの targets と sites を見直す）', changed.length === 0,
    changed.map(file => `${file}: リスト ${listed.get(file).sites} / 実際 ${found[file]}`).join(' / '));
  const stale = DATA_WRITES.filter(entry => !(entry.file in found)).map(entry => entry.file);
  t.ok('許可リストに、もう書き込みの無いファイルが残っていない', stale.length === 0, stale.join(' / '));

  // ---- 許可リストの中身
  const lines = DATA_WRITES.flatMap(entry => entry.targets.map(target => ({ entry, target })));
  const incomplete = lines.filter(({ target }) => !target.name?.trim() || !target.limit?.trim() || !target.reason?.trim());
  t.ok('どの書き先にも、名前・上限・理由が書いてある', incomplete.length === 0, incomplete.map(({ entry }) => entry.file).join(' / '));
  const noTargets = DATA_WRITES.filter(entry => !entry.targets?.length || !Number.isInteger(entry.sites) || entry.sites < 1);
  t.ok('どのファイルにも書き先が 1 つ以上ある', noTargets.length === 0, noTargets.map(entry => entry.file).join(' / '));
  const named = lines.filter(({ target }) => DB_ONLY.some(file => target.name.split(/[・\s]/).includes(file)));
  t.ok('DB の行にした記録（sessions.json・agent-tasks.json・usage.json・conversations.json）を丸ごと書く許可は無い', named.length === 0, named.map(({ target }) => target.name).join(' / '));
  const unbounded = lines.filter(({ target }) => target.unbounded);
  t.ok('上限の無い書き先は既知の例外として印が付き、理由がある', unbounded.every(({ target }) => target.reason.length >= 8));
  // 既知の例外の数。増やさない（減らすときは、行へ移したときに数字を下げる）
  const KNOWN_UNBOUNDED = 9;
  t.ok(`上限の無い既知の例外は ${KNOWN_UNBOUNDED} 件を超えない（増やさず、DB の行へ移して減らす）`, unbounded.length <= KNOWN_UNBOUNDED, `${unbounded.length} 件: ${unbounded.map(({ target }) => target.name).join(' / ')}`);
  t.ok('許可リストのパスは core/ の下', DATA_WRITES.every(entry => entry.file.startsWith('core/') && path.posix.extname(entry.file) === '.mjs'));
}
