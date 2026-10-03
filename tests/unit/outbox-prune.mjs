// 送り終わった（sent）・取り消した（cancelled）outbox の項目は、会話あたり直近 OUTBOX_KEEP_FINISHED 件だけ残す（ADR 0106）。
// 二重送信・送り漏れを防ぐ判定（accept の同じ送信 ID の照合・kick の先頭の選び方・recover）が、捨てた項目に頼っていないことを確かめる。
import { createMessageQueue, pruneOutbox, OUTBOX_KEEP_FINISHED } from '../../core/message-queue.mjs';

export const name = 'outbox-prune';
export const title = '送り終わった outbox の項目は直近だけ残す: 並び・未送の項目・二重送信の判定を保つ';

const item = (n, status) => ({ id: `m${n}`, args: { prompt: `p${n}` }, at: '2026-10-01T00:00:00Z', status });
const ids = list => list.map(m => m.id).join(',');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** メモリの store（setSessionData は同じ値なら書かない・複製して持つ）。start は受理して終わる */
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
  const pure = [item(1, 'sent'), item(2, 'cancelled'), item(3, 'sent'), item(4, 'failed'), item(5, 'sent'), item(6, 'queued'), item(7, 'sent')];
  t.ok('純粋な関数: 落とすものが無ければ同じ配列を返す', pruneOutbox(pure, 10) === pure);
  t.ok('純粋な関数: 終わった項目の古い順に落とし、未送の項目（failed・queued）と並びは保つ', ids(pruneOutbox(pure, 2)) === 'm4,m5,m6,m7', ids(pruneOutbox(pure, 2)));
  t.ok('純粋な関数: 直近 0 件なら終わった項目をすべて落とす', ids(pruneOutbox(pure, 0)) === 'm4,m6');
  t.ok('純粋な関数: 2 度かけても同じ（冪等）', ids(pruneOutbox(pruneOutbox(pure, 3), 3)) === ids(pruneOutbox(pure, 3)));

  // ---- 送るたびに増える outbox が、直近の件数で止まる
  {
    const { data, starts, queue } = harness();
    const total = OUTBOX_KEEP_FINISHED + 15;
    for (let n = 1; n <= total; n++) { await queue.accept('s', `m${n}`, { prompt: `p${n}` }); await sleep(2); }
    await sleep(50);
    const saved = data.get('s');
    t.ok(`送り終わった項目は直近 ${OUTBOX_KEEP_FINISHED} 件だけ残る（${total} 件送って ${saved.length} 件）`, saved.length === OUTBOX_KEEP_FINISHED && saved.every(m => m.status === 'sent')
      && saved[0].id === `m${total - OUTBOX_KEEP_FINISHED + 1}` && saved.at(-1).id === `m${total}`, ids(saved));
    t.ok('全部を 1 回ずつ送り、捨てた項目を送り直さない', starts.length === total && new Set(starts).size === total, `${starts.length}`);

    // 直近の再試行（同じ送信 ID）は、残っている項目で二重に送らない
    const before = starts.length;
    const again = await queue.accept('s', `m${total}`, { prompt: `p${total}` });
    await sleep(30);
    t.ok('直近の送信の再試行（同じ ID・同じ内容）は、新しく送らず今の項目を返す', again.id === `m${total}` && again.status === 'sent' && starts.length === before && data.get('s').length === OUTBOX_KEEP_FINISHED);
    const conflict = await queue.accept('s', `m${total}`, { prompt: 'changed' }).then(() => null, e => e.message);
    t.ok('同じ ID で内容が違えば断る', typeof conflict === 'string' && /送信ID|send ID/i.test(conflict), String(conflict));
  }

  // ---- 未送の項目（queued・paused・failed・unknown）は件数に関係なく残り、先頭の判定を変えない
  {
    const { data, starts, queue } = harness();
    data.set('s', [item(1, 'failed'), ...Array.from({ length: 30 }, (_, k) => item(k + 2, 'sent')), item(40, 'paused'), item(41, 'unknown')]);
    await queue.recover();
    const saved = data.get('s');
    t.ok('起動時の整理で、古い sent を落とし、failed・paused・unknown は残す', saved.length === 1 + OUTBOX_KEEP_FINISHED + 2 && saved[0].id === 'm1' && saved.at(-2).id === 'm40' && saved.at(-1).id === 'm41', ids(saved));
    await queue.kick('s');
    await sleep(20);
    t.ok('先頭が failed の間は、後ろを順序を守って送らない', starts.length === 0);
    await queue.accept('s', 'm99', { prompt: 'p99' });
    await sleep(20);
    t.ok('新しい項目は先頭の failed を待つ（送り漏れも順序の入れ替えも起きない）', starts.length === 0 && data.get('s').at(-1).status === 'queued' && data.get('s').at(-1).id === 'm99');
    await queue.action('s', 'm1', 'cancel');
    await sleep(40);
    t.ok('先頭を取り消せば、保留（paused）は動かさず、順序どおり先頭の paused で止まる', starts.length === 0, JSON.stringify(starts));
  }

  // ---- 取り消した項目も同じ枠で数える
  {
    const { data, queue } = harness();
    data.set('s', [...Array.from({ length: 10 }, (_, k) => item(k + 1, 'cancelled')), ...Array.from({ length: 15 }, (_, k) => item(k + 11, 'sent'))]);
    await queue.recover();
    const saved = data.get('s');
    t.ok('cancelled と sent を合わせて直近だけ残す', saved.length === OUTBOX_KEEP_FINISHED && saved[0].id === 'm6', ids(saved));
  }
}
