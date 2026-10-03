import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

export const name = 'refresh-batch';
export const title = '会話一覧の更新: 起動時の重複と他会話の連続イベントをまとめる';

export default async function (t) {
  const source = await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('let refreshRun ='), source.indexOf('let refreshVersion ='));
  const runs = [], timers = [];
  const context = vm.createContext({
    runRefresh: () => new Promise((resolve) => runs.push(resolve)),
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); },
  });
  vm.runInContext(code, context);
  const call = (name) => vm.runInContext(`${name}()`, context);

  const first = call('refresh');
  assert.equal(vm.runInContext('refresh({ sharePending: true })', context), first);
  assert.equal(runs.length, 1, '一覧の応答前の重複は一度だけ取得する');
  runs.shift()();
  await first;
  t.ok('起動時の重複した取り直しは一度だけ', true);

  const batched = call('scheduleRefresh');
  assert.equal(call('scheduleRefresh'), batched);
  assert.equal(call('scheduleRefresh'), batched);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 400);
  assert.equal(runs.length, 0, '他会話のイベント直後はまだ取得しない');
  timers.shift().fn();
  assert.equal(runs.length, 1);
  runs.shift()();
  await batched;
  t.ok('他会話の連続イベントは 400ms に一度だけ', true);

  const active = call('refresh');
  const newer = call('refresh');
  assert.notEqual(newer, active, '自分の操作後は応答前でも次の写しを待つ');
  assert.equal(call('refresh'), newer);
  runs.shift()();
  await active;
  await Promise.resolve();
  assert.equal(runs.length, 1);
  runs.shift()();
  await newer;
  t.ok('自分の操作後の変更は一度だけ再取得する', true);

  const alreadyRunning = call('refresh');
  const eventDuringRun = call('scheduleRefresh');
  timers.shift().fn();
  assert.equal(runs.length, 1, '取得中の古い写しは共有しない');
  runs.shift()();
  await alreadyRunning;
  await Promise.resolve();
  assert.equal(runs.length, 1, '他会話の変更を次の写しで取得する');
  runs.shift()();
  await eventDuringRun;
  t.ok('取得の途中に届いた他会話の変更も取りこぼさない', true);
}
