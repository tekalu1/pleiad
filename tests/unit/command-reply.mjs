import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

export const name = 'command-reply';
export const title = '画面のコマンドの返事: 操作が投げても返事をし、画面の取り直しは返事が来なければ時間切れにする';

// 返事の来ないコマンドが 1 本あると、画面の refresh() は走っている分の終わりを待つので以後ずっと止まり、
// 脇の「移動中」が消えず、新しい会話の最初の送信も「会話ができしだい送ります」のまま進まなかった（0.12.0-beta.4）
export default async function (t) {
  const server = await fs.readFile(new URL('../../core/server.mjs', import.meta.url), 'utf8');
  // `return viaOp(...)` は try の catch と finally（更新の門）を素通りする
  const bare = server.split(/\r?\n/).map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bviaOp\(/.test(line) && !/await viaOp\(/.test(line) && !/const viaOp =/.test(line) && !/^\s*\/\//.test(line));
  t.ok('WS のコマンドの viaOp はすべて await して返す', bare.length === 0, bare.map(({ n, line }) => `${n}: ${line.trim()}`).join(' / '));
  const viaOpBody = server.slice(server.indexOf('const viaOp = async'), server.indexOf('let releaseUpdateGate;'));
  t.ok('viaOp は操作が投げたときも返事をする', /catch \(err\)[\s\S]*reply\(false/.test(viaOpBody));

  const client = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const start = client.indexOf('function cmd(command');
  const code = client.slice(start, client.indexOf('\n}\n', start) + 3);
  const sent = [], timers = new Map();
  let timerSeq = 0;
  const context = vm.createContext({
    seq: 0, pending: new Map(), t: (key) => key, WebSocket: { OPEN: 1 },
    ws: { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) },
    setTimeout: (fn, ms) => { const id = ++timerSeq; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(`${code}\nthis.cmd = cmd;`, context);
  const pending = context.pending;

  const late = context.cmd('listSessions', {}, { timeoutMs: 60_000 });
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].ms, 60_000);
  const [[firstId, first]] = timers;
  timers.delete(firstId);
  first.fn();
  await assert.rejects(late, /app\.noReply/);
  t.ok('時間内に返事が無ければ失敗にし、待ちの記録を消す', pending.size === 0);

  const answered = context.cmd('listSessions', {}, { timeoutMs: 60_000 });
  const entry = pending.get(sent.at(-1).id);
  pending.delete(sent.at(-1).id);   // 返事を受けた側（ws.onmessage）と同じく消してから解く
  entry.res(['row']);
  assert.deepEqual(await answered, ['row']);
  t.ok('返事が来れば時間切れの見張りを外す', timers.size === 0);

  context.cmd('setStatus', {});
  t.ok('timeoutMs を渡さないコマンドは今までどおり待つ（見張りを付けない）', timers.size === 0 && pending.size === 1);

  const refresh = client.slice(client.indexOf('async function runRefresh()'), client.indexOf('refreshSnapshotReady = true;'));
  t.ok('取り直しの一覧・状態・設定は時間切れ付きで読む', /cmd\("listSessions", \{\}, wait\)/.test(refresh)
    && /cmd\("listStatuses", \{\}, wait\)/.test(refresh) && /cmd\("prefs", \{\}, wait\)/.test(refresh));
}
