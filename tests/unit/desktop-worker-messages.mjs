// desktop/worker-messages.cjs: サーバーの message を 1 つの listener で受けて main の橋へ配る（受け手が 10 を超えても MaxListenersExceededWarning を出さない）
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createWorkerMessages } = createRequire(import.meta.url)('../../desktop/worker-messages.cjs');

export const name = 'desktop-worker-messages';
export const title = 'main の橋の message の受け手: worker の listener は 1 つのまま、付け外し・once・exit の受け渡し・postMessage';

export default async function (t) {
  const worker = new EventEmitter();
  const posted = [];
  worker.postMessage = message => posted.push(message);
  const warnings = [];
  const onWarning = warning => warnings.push(warning.name);
  process.on('warning', onWarning);
  try {
    const messages = createWorkerMessages(worker);
    const seen = Array.from({ length: 12 }, () => []);
    seen.forEach((list, i) => messages.on('message', message => list.push(`${i}:${message.type}`)));
    worker.emit('message', { type: 'a' });
    await new Promise(resolve => setImmediate(resolve));
    t.ok('受け手が 12 あっても worker の message の listener は 1 つ', worker.listenerCount('message') === 1 && messages.messageHandlers() === 12);
    t.ok('全員に、付けた順に配る', seen.every((list, i) => list.join() === `${i}:a`));
    t.ok('MaxListenersExceededWarning が出ない', !warnings.includes('MaxListenersExceededWarning'));

    const got = [];
    const once = message => got.push(`once:${message.type}`);
    messages.once('message', once);
    const selfRemoving = message => { got.push(`self:${message.type}`); messages.off('message', selfRemoving); };
    messages.on('message', selfRemoving);
    const later = message => got.push(`later:${message.type}`);
    // 配っている間に付けた受け手は、次の message から（EventEmitter と同じ）
    let added = false;
    messages.on('message', () => { if (!added) { added = true; messages.on('message', later); } });
    worker.emit('message', { type: 'b' });
    worker.emit('message', { type: 'c' });
    t.ok('once は 1 回だけ・自分を外す受け手は次から呼ばれない・配る間に付けた受け手は次から', got.join() === 'once:b,self:b,later:c', got.join());

    const exits = [];
    const onExit = () => exits.push('exit');
    messages.on('exit', onExit);
    messages.once('exit', () => exits.push('once-exit'));
    t.ok('message のほか（exit）は worker へそのまま付ける', worker.listenerCount('exit') === 2);
    worker.emit('exit');
    messages.off('exit', onExit);
    worker.emit('exit');
    t.ok('exit の on・once・off は worker のもの', exits.join() === 'exit,once-exit' && worker.listenerCount('exit') === 0);

    messages.postMessage({ type: 'out' });
    t.ok('postMessage は worker へ', posted.length === 1 && posted[0].type === 'out');
  } finally {
    process.off('warning', onWarning);
  }
}
