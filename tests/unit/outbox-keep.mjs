// 送り終わった（sent）outbox の項目は刈らない（ADR 0115）。
// sent の後にバックエンドから来る returned（受理した途中送信が読まれずに捨てられた）・undelivered（プロンプトを渡す前に失敗した）は、
// sent の項目を探して状態を変える。同じ ID の accept は、その項目を見つけて新しい送信にしない（二重送信を防ぐ）。
// 古い項目を捨てるとどちらも見失うので、件数が増えても残す（行ごとに書くので、性能のためには要らない）。
import { createMessageQueue } from '../../core/message-queue.mjs';

export const name = 'outbox-keep';
export const title = '送り終わった outbox の項目は刈らない: returned・undelivered・同じ ID の再試行が、古い項目でも見つかる';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** メモリの store。start は受理して終わる */
function harness() {
  const data = new Map();
  const starts = [];
  const store = {
    get: async id => ({ history: [], outbox: structuredClone(data.get(id) ?? []) }),
    getAll: async () => Object.fromEntries([...data].map(([id, outbox]) => [id, { outbox: structuredClone(outbox) }])),
    setSessionData: async (id, field, value) => { if (field === 'outbox') data.set(id, structuredClone(value)); return value; },
  };
  const queue = createMessageQueue({ store, active: () => null, changed: () => {}, delivered: async () => {},
    start: async (args, accepted) => { starts.push(args.messageId); await accepted(); return 'ok'; } });
  return { data, starts, queue };
}

export default async function (t) {
  const { data, starts, queue } = harness();
  const total = 45;
  for (let n = 1; n <= total; n++) { await queue.accept('s', `m${n}`, { prompt: `p${n}` }); await sleep(2); }
  await sleep(50);
  const saved = data.get('s');
  t.ok(`送り終わった ${total} 件は、件数が増えても全部残る（並びも保つ）`, saved.length === total && saved.every((m, i) => m.id === `m${i + 1}` && m.status === 'sent'), String(saved.length));
  t.ok('全部を 1 回ずつ送った', starts.length === total && new Set(starts).size === total);

  // 古い送信にも、後から returned・undelivered が来る
  await queue.returned('s', 'm2');
  await queue.undelivered('s', 'm3', 'before the prompt');
  const after = data.get('s');
  t.ok('returned: 受理した途中送信が捨てられたら、古い項目でも保留（paused）にする', after.find(m => m.id === 'm2')?.status === 'paused');
  t.ok('undelivered: プロンプトを渡す前の失敗は、古い項目でも失敗（failed）にする', after.find(m => m.id === 'm3')?.status === 'failed' && after.find(m => m.id === 'm3')?.error === 'before the prompt');
  t.ok('ほかの項目は変わらず、件数も変わらない', after.length === total && after.filter(m => m.status === 'sent').length === total - 2);

  // 同じ ID の再試行は、古い項目でも新しい送信にしない
  const before = starts.length;
  const again = await queue.accept('s', 'm1', { prompt: 'p1' });
  const alsoPaused = await queue.accept('s', 'm2', { prompt: 'p2' });
  await sleep(30);
  t.ok('同じ ID・同じ内容の accept は、送り終えた古い項目をそのまま返す（二重に送らない）', again.status === 'sent' && starts.length === before && data.get('s').length === total);
  t.ok('保留に変わった項目の ID の再試行も、新しい送信にしない', alsoPaused.status === 'paused' && starts.length === before && data.get('s').filter(m => m.id === 'm2').length === 1);

  // 起動時の整理（recover）も、送り終わった項目を落とさない
  await queue.recover();
  t.ok('recover は送り終わった項目を落とさない', data.get('s').length === total && data.get('s').filter(m => m.status === 'sent').length === total - 2);
}
