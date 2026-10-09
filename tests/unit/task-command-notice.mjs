import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentTasks } from '../../core/agent-tasks.mjs';
import { normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';
import { commandActivity } from '../../core/backends/codex-background.mjs';
import { normalizePlyInstructions, turnInstructions, withAdded } from '../../core/ply-instructions.mjs';
import { agentT } from '../../core/i18n.mjs';
import { readAgentTasks } from '../lib/data-store.mjs';

export const name = 'task-command-notice';
export const title = 'コマンドの時計・実際の終了・承認待ち・通知の配送・子だけの実行指示';
const minute = 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await sleep(5); } throw new Error('timeout'); }

async function fixture(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-command-'));
  const f = { dir, clock: 0, approval: false, ready: true, outcome: 'ok', notices: [], silent: [] };
  const manager = await createAgentTasks({ dataDir: dir, now: () => f.clock, log: () => {},
    prepare: async () => ({ sessionId: 'child', backend: 'fake', cwd: 'D:/work' }),
    execute: async (_r, _p, signal) => { await new Promise(resolve => { f.release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); return { outcome: 'ok' }; },
    ready: async () => f.ready, waiting: () => f.approval, deliver: async () => 'ok',
    deliverCommand: async (task, command) => { f.notices.push({ task, command }); return f.outcome; },
    deliverSilence: async (task, minutes) => { f.silent.push({ task, minutes }); return 'ok'; }, ...options });
  f.manager = manager;
  f.task = await manager.call('parent', 'ply_delegate', { backend: 'fake', task: 'work', title: 'Build' });
  await until(() => f.release);
  f.emit = event => manager.observe('child', event);
  f.sdk = message => normalizeSdkMessage(message).forEach(f.emit);
  f.codex = (method, params) => commandActivity(method, params).forEach(f.emit);
  f.start = (id, name = 'Bash', input = { command: 'npm test' }, extra = {}) => f.emit({ type: 'tool.start', id, name, input, ...extra });
  f.view = () => manager.get(f.task.taskId);
  f.tick = async n => { f.clock = n * minute; manager.checkSilence(); await sleep(25); };
  f.close = async () => { f.release(); await until(() => f.view().status === 'completed' && !manager.busy); manager.close(); await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }); };
  return f;
}

export default async function(t) {
  const f = await fixture({ silenceMinutes: 0 });
  try {
    f.start('a', 'run_command', { CommandLine: 'curl https://host/?token=private --token another-secret', Cwd: 'D:/agy' });
    await f.tick(1);
    f.start('b', 'PowerShell', { command: 'Start-Process app' });
    f.start('ignored', 'Read', { file: 'x' });
    await f.tick(4.99);
    f.emit({ type: 'text.delta', text: 'working' });
    f.sdk({ type: 'tool_progress', tool_use_id: 'b', elapsed_time_seconds: 200 });
    t.ok('5分未満は通知しない・コマンドだけを複数保持する', f.notices.length === 0 && f.view().activeCommands.length === 2);
    await f.tick(5); await until(() => f.notices.length === 1);
    t.ok('他の活動・heartbeatがあっても（出力でなければ）最初のコマンドは5分で通知', f.notices[0].command.toolCallId === 'a' && f.notices[0].command.elapsedMinutes === 5);
    await f.tick(6); await until(() => f.notices.length === 2);
    await f.tick(30);
    t.ok('複数コマンドは個別に一度だけ通知し、子を止めない', f.notices.map(n => n.command.toolCallId).join() === 'a,b' && f.view().status === 'running');
    const status = await f.manager.call('parent', 'ply_task_status', { taskId: f.task.taskId });
    const list = await f.manager.call('parent', 'ply_task_list');
    t.ok('status/listに本文・cwd・観測時間・開始の確かさ・経過を載せる', status.activeCommands[0].cwd === 'D:/agy'
      && status.activeCommands[0].observedAt === 0 && status.activeCommands[0].startedAt === null
      && !status.activeCommands[0].startKnown && list.tasks[0].activeCommands[1].elapsedMinutes === 29);
    t.ok('通知・保存・公開値は秘密値を伏せる', !JSON.stringify([f.notices, status, list]).includes('private')
      && !JSON.stringify(readAgentTasks(f.dir)).includes('private')
      && !JSON.stringify(status).includes('another-secret'));
    for (const lang of ['en', 'ja']) {
      const text = agentT(lang, 'delegation.commandNotice', { taskId: f.task.taskId, noticeId: 'command-a', title: 'Build', command: 'npm test', minutes: 5 });
      t.ok(`${lang}: 題・コマンド・分数・独立ID・確認と停止の手段`, ['Build', 'npm test', '5', 'command-a', 'ply_task_status', 'ply_task_cancel'].every(x => text.includes(x)));
    }
    f.emit({ type: 'tool.result', id: 'a', text: 'DONE' });
    f.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'exit 0' }] } });
    t.ok('agy DONE と Claude 前景結果は終了', f.view().activeCommands.length === 0);
  } finally { await f.close(); }

  const bg = await fixture({ silenceMinutes: 0 });
  try {
    bg.sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bash', name: 'Bash', input: { command: 'server', run_in_background: true } }] } });
    bg.sdk({ type: 'user', tool_use_result: { backgroundTaskId: 'native' }, message: { content: [{ type: 'tool_result', tool_use_id: 'bash', content: 'launched' }] } });
    await bg.tick(5); await until(() => bg.notices.length === 1);
    t.ok('明示的 background の tool_result は完了ではない', bg.view().activeCommands[0].nativeTaskId === 'native' && bg.view().activeCommands[0].state === 'background');
    bg.sdk({ type: 'system', subtype: 'task_notification', task_id: 'native', status: 'completed' });
    t.ok('task_notification で本当の完了を取る', bg.view().activeCommands.length === 0);
    bg.start('auto');
    bg.sdk({ type: 'system', subtype: 'task_started', task_id: 'auto-task', tool_use_id: 'auto', task_type: 'local_bash' });
    bg.sdk({ type: 'system', subtype: 'task_updated', task_id: 'auto-task', patch: { is_backgrounded: true } });
    bg.emit({ type: 'tool.result', id: 'auto', text: 'background' });
    t.ok('自動 background への更新も完了扱いしない', bg.view().activeCommands[0].state === 'background');
    bg.sdk({ type: 'system', subtype: 'task_notification', task_id: 'auto-task', status: 'stopped' });
    bg.start('patch');
    bg.sdk({ type: 'system', subtype: 'task_started', task_id: 'patch-task', tool_use_id: 'patch', is_backgrounded: true });
    bg.sdk({ type: 'system', subtype: 'task_updated', task_id: 'patch-task', patch: { is_backgrounded: true, status: 'completed' } });
    t.ok('終了状態とbackground印が同時に来ても終了を優先', bg.view().activeCommands.length === 0);
    bg.start('text-bg');
    bg.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'text-bg', content: 'Command running in background with ID: txt-1. Output file: /x' }] } });
    t.ok('構造化結果がない場合も background の起動結果を識別', bg.view().activeCommands[0].nativeTaskId === 'txt-1');
    bg.sdk({ type: 'system', subtype: 'task_notification', task_id: 'txt-1', status: 'failed' });
    bg.start('terminal', 'commandExecution', { command: 'serve codex', cwd: 'D:/codex' }, { startedAt: 4 * minute, turnId: 'turn', processId: 'process' });
    bg.release(); await until(() => bg.view().status === 'completed');
    await bg.tick(9); await until(() => bg.notices.length === 2);
    t.ok('Codex: 既知の開始から数え、ターン・子の完了後も監視する', bg.view().activeCommands[0].startKnown && bg.notices[1].command.toolCallId === 'terminal');
    bg.codex('item/completed', { item: { id: 'terminal', type: 'commandExecution' } });
    t.ok('Codex: ターン外の item/completed で閉じる', bg.view().activeCommands.length === 0);
  } finally { await bg.close(); }

  const approval = await fixture({ silenceMinutes: 0 });
  try {
    approval.start('a'); await approval.tick(2);
    approval.approval = true; approval.manager.wake();
    await approval.tick(100);
    t.ok('承認待ちを含めず通知も保留する', approval.notices.length === 0 && approval.view().activeCommands[0].elapsedMinutes === 2 && approval.view().activeCommands[0].state === 'approval');
    approval.approval = false; approval.manager.wake();
    await approval.tick(102.99); t.ok('承認後も残り3分を待つ', approval.notices.length === 0);
    await approval.tick(103); await until(() => approval.notices.length === 1);
    t.ok('承認待ちを除く5分で通知する', approval.notices[0].command.elapsedMinutes === 5);
  } finally { await approval.close(); }

  const delivery = await fixture({ silenceMinutes: 0 });
  try {
    delivery.start('a'); delivery.ready = false; await delivery.tick(5);
    t.ok('親が忙しい間は通知を保留', delivery.notices.length === 0);
    delivery.ready = true; delivery.outcome = 'requeue'; await delivery.tick(6);
    await until(() => delivery.notices.length === 1);
    delivery.outcome = 'error'; await delivery.tick(7); await until(() => delivery.notices.length === 2);
    await delivery.tick(8);
    t.ok('未受領だけ再送し、配送不明なら再送しない。同じIDを使う', delivery.notices.length === 2 && delivery.notices[0].command.noticeId === delivery.notices[1].command.noticeId);
  } finally { await delivery.close(); }

  const quiet = await fixture({ commandMinutes: 0 });
  try {
    quiet.start('a'); await quiet.tick(4);
    quiet.sdk({ type: 'tool_progress', tool_use_id: 'a', elapsed_time_seconds: 240 });
    await quiet.tick(8);
    t.ok('Claude tool_progress で無音の時計だけが進む', quiet.silent.length === 0 && quiet.view().lastActivityAt === 4 * minute);
    quiet.codex('item/commandExecution/outputDelta', { itemId: 'a', delta: 'output' });
    await quiet.tick(12.99); t.ok('Codex outputDelta でも無音を数え直す', quiet.silent.length === 0);
    await quiet.tick(13); await until(() => quiet.silent.length === 1);
    t.ok('既定の無音は5分・コマンド設定0で無効', quiet.silent[0].minutes === 5 && quiet.notices.length === 0);
  } finally { await quiet.close(); }

  const restored = await fixture({ silenceMinutes: 0 });
  try {
    restored.start('survivor', 'commandExecution');
    restored.release(); await until(() => !restored.manager.busy);
    restored.manager.close();
    let count = 0;
    const reloaded = await createAgentTasks({ dataDir: restored.dir, now: () => 100 * minute,
      prepare: async () => ({}), execute: async () => ({}), deliver: async () => 'ok',
      deliverCommand: async () => { count++; return 'ok'; } });
    try {
      reloaded.checkSilence(); await sleep(25);
      const command = reloaded.get(restored.task.taskId).activeCommands[0];
      t.ok('再起動後は生存不明・経過不明で通知を再送しない', command.state === 'unknown' && command.elapsedMinutes === null && count === 0);
    } finally { reloaded.close(); }
  } finally { await restored.close(); }

  // 待っている先が動いている・明らかに待つためのコマンドは知らせない。知らせるのは同じ子の同じコマンドで 1 回だけ（ADR 0138）
  const moving = await fixture({ silenceMinutes: 0 });
  try {
    moving.start('a', 'commandExecution', { command: 'npm test' });
    await moving.tick(4.9);
    moving.codex('item/commandExecution/outputDelta', { itemId: 'a', delta: 'ok 1' });
    await moving.tick(5);
    t.ok('出力が伸びている間は5分たっても知らせない', moving.notices.length === 0 && moving.view().activeCommands.length === 1);
    moving.codex('item/commandExecution/outputDelta', { itemId: 'a', delta: 'ok 2' });
    await moving.tick(5.9); t.ok('最後の出力から1分未満は動いているとみなす', moving.notices.length === 0);
    await moving.tick(6); await until(() => moving.notices.length === 1);
    t.ok('出力が止まって1分たち、なお終わらなければ1回だけ知らせる', moving.notices[0].command.toolCallId === 'a' && moving.notices[0].command.elapsedMinutes === 6);
  } finally { await moving.close(); }

  const loops = await fixture({ silenceMinutes: 0 });
  try {
    loops.start('w1', 'Bash', { command: 'until gh run view 123 --exit-status; do sleep 30; done' });
    loops.start('w2', 'PowerShell', { command: 'gh run watch 123' });
    loops.start('w3', 'commandExecution', { command: 'Start-Sleep -Seconds 900' });
    await loops.tick(30);
    t.ok('until / sleep / gh run watch など待つためのコマンドは知らせない', loops.notices.length === 0 && loops.view().activeCommands.length === 3);
    loops.emit({ type: 'tool.result', id: 'w1', text: 'done' });
    loops.start('w4', 'Bash', { command: 'npm test' });
    await loops.tick(40); await until(() => loops.notices.length === 1);
    t.ok('待つコマンドの後の普通の長いコマンドは知らせる', loops.notices[0].command.toolCallId === 'w4');
  } finally { await loops.close(); }

  // 出力の途中に「Command running in background with ID: …」が出てきただけ（ファイルを cat・grep した結果）で、終わったコマンドを裏に残さない（2026-10-04、5 分後に誤って通知が出た）
  const echoed = await fixture({ silenceMinutes: 0 });
  try {
    echoed.start('cat', 'Bash', { command: 'cat tests/unit/task-command-notice.mjs' });
    echoed.sdk({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'cat', content: 'text\nbg.start(x)\nCommand running in background with ID: txt-1. Output file: /x\nend' }] } });
    t.ok('結果の途中の文字では background にせず、終わったコマンドとして外す', echoed.view().activeCommands.length === 0);
    await echoed.tick(30);
    t.ok('終わったコマンドを根拠に長時間通知を出さない', echoed.notices.length === 0);
  } finally { await echoed.close(); }

  // 裏のコマンドが残っていても、子が別の道具で動いている間は「止まっている」とは知らせない。子が黙れば 1 回だけ知らせる
  const busy = await fixture({ silenceMinutes: 0 });
  try {
    busy.sdk({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'srv', name: 'Bash', input: { command: 'node server.mjs', run_in_background: true } }] } });
    busy.sdk({ type: 'user', tool_use_result: { backgroundTaskId: 'native-srv' }, message: { content: [{ type: 'tool_result', tool_use_id: 'srv', content: 'launched' }] } });
    await busy.tick(4.9);
    busy.emit({ type: 'text.delta', text: 'working' });
    await busy.tick(5.5);
    t.ok('裏のコマンドがあっても子が別の作業で動いている間は知らせない', busy.notices.length === 0 && busy.view().activeCommands[0].state === 'background');
    await busy.tick(6); await until(() => busy.notices.length === 1);
    t.ok('子が1分黙ったら裏のコマンドを1回だけ知らせる', busy.notices[0].command.toolCallId === 'srv');
  } finally { await busy.close(); }

  const repeat = await fixture({ silenceMinutes: 0 });
  try {
    repeat.start('first', 'Bash', { command: 'npm   test' });
    await repeat.tick(5); await until(() => repeat.notices.length === 1);
    repeat.emit({ type: 'tool.result', id: 'first', text: 'fail' });
    repeat.start('second', 'Bash', { command: 'npm test' });
    await repeat.tick(11);
    t.ok('同じ子が同じコマンドをやり直しても繰り返し知らせない', repeat.notices.length === 1);
    repeat.start('third', 'Bash', { command: 'npm run build' });
    await repeat.tick(17); await until(() => repeat.notices.length === 2);
    t.ok('別のコマンドなら知らせる', repeat.notices[1].command.toolCallId === 'third');
  } finally { await repeat.close(); }

  for (const locale of ['en', 'ja']) for (const supported of [true, false]) {
    const args = { list: normalizePlyInstructions(), locale, supported, routing: true, canDelegate: true };
    const child = withAdded('', turnInstructions({ ...args, child: true }));
    const parent = withAdded('', turnInstructions({ ...args, child: false }));
    t.ok(`${locale}/${supported}: 子だけに時間上限・PIDの管理・無期限待機禁止を入れる`, child.includes(agentT(locale, 'guide.commandLifetime')) && !parent.includes('Start-Process -Wait'));
    t.ok(`${locale}/${supported}: 子の指示にさらに委譲しない旨は入れない（委譲の深さに上限は無い）`, !/さらに委譲しない|do not delegate further/.test(child));
  }
}
