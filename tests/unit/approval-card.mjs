// 承認カード・質問カード（docs/design-system.md §4.5）。
//   - 押したらサーバーが受け取るまで「◯◯を送っています…」。受け取ってから決着の一行に畳む（先に「拒否した」にしない）
//   - 送れなかったら押す前の形に戻し、理由をカードの中に出す（会話の末尾のシステム行に逃がさない）。押し直せる
//   - 決着後の一行に対象の要約（web/approval-summary.mjs）。押すと承認したときの入力を開ける
// 画面の流れはブラウザーで確かめる（temporary の撮影）。ここでは要約の選び方と、client.mjs の順序を見る。
import { readFileSync } from 'node:fs';
import { approvalTarget } from '../../web/approval-summary.mjs';

export const name = 'approval-card';
export const title = '承認カード: 受け取られるまで送信中・失敗はカードの中・決着後の一行に対象と開閉';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  t.ok('対象は path → file_path → command → url → pattern の順に最初に見つかったもの',
    approvalTarget({ content: 'x', path: 'a.txt' }) === 'a.txt'
    && approvalTarget({ file_path: 'D:/x/b.md', content: 'y' }) === 'D:/x/b.md'
    && approvalTarget({ description: 'list', command: 'ls -la' }) === 'ls -la'
    && approvalTarget({ url: 'https://example.com', prompt: 'p' }) === 'https://example.com');
  t.ok('対象のキーが無ければ最初の文字列の値。無ければ空', approvalTarget({ n: 1, note: 'hello' }) === 'hello' && approvalTarget({ n: 1 }) === '' && approvalTarget(null) === '');
  t.ok('改行は 1 行に詰め、長いものは切る', approvalTarget({ command: 'a\n  b' }) === 'a b' && approvalTarget({ command: 'x'.repeat(300) }).length === 201);
  t.ok('配列の command（Codex）は空白でつなぐ', approvalTarget({ command: ['git', 'status'] }) === 'git status');

  const client = read('web/client.mjs');
  const perm = client.slice(client.indexOf('function permissionCard('), client.indexOf('function renderPermission('));
  const sendAt = perm.indexOf('await cmd("resolvePermission"');
  t.ok('承認: サーバーの受け取りを待ってから決着の形にする', sendAt > 0 && perm.indexOf('card.classList.add("done")') > sendAt
    && perm.indexOf('state.pendingPerms.delete(ev.id)') > sendAt);
  t.ok('承認: 送っている間は「◯◯を送っています…」、失敗はカードの中に理由（システム行に出さない）',
    /chat\.approval\.sending/.test(perm) && /chat\.approval\.sendFailedInline/.test(perm) && !/sys\(/.test(perm));
  t.ok('承認: 決着後は入力を畳んで一行から開ける（code を消さない）', /foldSettledCard\(card, head, code, approvalTarget\(ev\.input\)\)/.test(perm) && !/code\.remove\(\)/.test(perm));
  const ask = client.slice(client.indexOf('function questionCard('), client.indexOf('function foldSettledCard('));
  t.ok('質問: 同じく受け取りを待ち、失敗はカードの中に', ask.indexOf('await cmd("resolvePermission"') > 0
    && ask.indexOf('card.classList.add("done")') > ask.indexOf('await cmd("resolvePermission"') && /chat\.ask\.sendFailedInline/.test(ask) && !/sys\(/.test(ask));
}
