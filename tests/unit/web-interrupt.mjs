// 中断と再開の画面の部品（web/interrupt.mjs、docs/design-system.md「中断と再開」）。
// 三角の未読・既読、理由の文言、再開ボタンの出し方、更新で止めた会話の数え方、更新の確認に並べる作業、中断の進み。
// 配線（client.mjs・side.mjs・updates.mjs・index.html・style.css・辞書）は文字列で確かめる。ブラウザーでは tests/browser/interrupt-resume.cjs
import { readFileSync } from 'node:fs';
import {
  REASONS, reasonOf, isInterrupted, interruptUnread, interruptReadPoint, showsReasonInMeta, interruptLabel, interruptLineText,
  warnMark, pausedCount, resumeLabel, resumeNoteText, resumeVisible, updateInterrupted, workRows, workCounts, interruptProgress,
  limitResumeState, limitLineNote, limitTime, resumeShortLabel,
} from '../../web/interrupt.mjs';

export const name = 'web-interrupt';
export const title = '中断と再開の画面: 三角の未読・理由の文言・再開ボタン・更新で止めた会話・更新の確認の作業一覧と進み';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- 状態と理由
  t.ok('interrupted が null なら中断ではない', !isInterrupted({ interrupted: null }) && !isInterrupted({}) && isInterrupted({ interrupted: { at: 1, reason: 'user' } }));
  t.ok('知らない理由・欠けた理由は user と読む', reasonOf({ reason: 'nope' }) === 'user' && reasonOf({}) === 'user' && reasonOf(null) === 'user' && reasonOf({ reason: 'update' }) === 'update');
  t.ok('更新・終了・再起動は行の 2 行目に理由の字も出す。自分の中断と接続切れは出さない',
    ['update', 'quit', 'restart'].every(r => showsReasonInMeta({ reason: r })) && !showsReasonInMeta({ reason: 'user' }) && !showsReasonInMeta({ reason: 'hostAway' }));
  t.ok('理由ごとの短い字（三角の title）', interruptLabel({ reason: 'user' }) === '中断' && interruptLabel({ reason: 'update' }) === '更新のため中断');
  t.ok('理由ごとの末尾の一行', interruptLineText({ reason: 'user' }) === '中断しました' && interruptLineText({ reason: 'update' }) === 'Pleiad の更新のため中断しました'
    && interruptLineText({ reason: 'restart' }) === 'Pleiad が再起動したため中断しました');

  // ---- 未読・既読（readAt はサーバーが completedAt までに丸める）
  const s = { id: 'a', completedAt: 1000, interrupted: { at: 1003, reason: 'user' } };
  t.ok('確認していなければ未読', interruptUnread(s, 0));
  t.ok('completedAt まで確認すれば既読（at が数 ms 後でも、丸められた readAt で既読になる）', !interruptUnread(s, 1000));
  t.ok('前の完了までしか確認していなければ未読', interruptUnread(s, 900));
  t.ok('中断でない会話は未読の三角を持たない', !interruptUnread({ completedAt: 5 }, 0));
  const restart = { id: 'b', completedAt: 5000, interrupted: { at: 5000, reason: 'restart' } };
  t.ok('再起動の中断（completedAt = at）も確認すれば既読', interruptUnread(restart, 4000) && !interruptUnread(restart, 5000));
  t.ok('確認として送る時刻は完了と中断の大きい方', interruptReadPoint(s) === 1003 && interruptReadPoint({ completedAt: 7 }) === 7);

  // ---- 三角の印
  const mark = warnMark('更新のため中断');
  t.ok('三角は 14×14・warn-mark・読み上げと title に理由', mark.attrs.viewBox === '0 0 14 14' && mark.attrs.class === 'warn-mark'
    && mark.attrs['aria-label'] === '更新のため中断' && mark.children[0].textContent === '更新のため中断');
  t.ok('既読は .read（--ink-weak）', warnMark('x', { read: true }).attrs.class === 'warn-mark read');

  // ---- 再開ボタン
  t.ok('保留の未送信だけを数える', pausedCount([{ status: 'paused' }, { status: 'queued' }, { status: 'paused' }, null]) === 2 && pausedCount(undefined) === 0);
  t.ok('保留が無ければ「再開」、あれば「保留中の N 件を送って再開」', resumeLabel(0) === '再開' && resumeLabel(2) === '保留中の 2 件を送って再開');
  t.ok('欄の下の一行: 保留があれば「保留中の N 件の後に」', resumeNoteText(0) === '送ると、この指示で続けます' && resumeNoteText(3) === '送ると、保留中の 3 件の後にこの指示で続けます');
  // 上限で止まった会話（docs/design-system.md「使用量の上限」）。自動で戻る間と、自動を外した会話の解除前は押せない時計、解除の後は普通の「再開」
  const nowMs = Date.parse('2026-10-04T10:00:00');
  const soon = nowMs + 2 * 3600_000;
  const week = Date.parse('2026-10-07T09:00:00');
  const auto = { reason: 'limit', at: nowMs, resetsAt: soon, autoResume: true };
  t.ok('上限の会話の状態: 自動 = auto、自動を外した解除前 = release、解除の後・時刻不明で外した = ready、上限でなければ null',
    limitResumeState(auto, nowMs) === 'auto' && limitResumeState({ ...auto, autoResume: false }, nowMs) === 'release'
    && limitResumeState({ ...auto, autoResume: false }, soon + 1) === 'ready' && limitResumeState({ ...auto, autoResume: false, resetsAt: null }, nowMs) === 'ready'
    && limitResumeState({ reason: 'user' }, nowMs) === null);
  t.ok('自動で戻る会話の入力欄は「◷ 時刻 に再開」', /に再開$/.test(resumeLabel(0, auto, nowMs)) && resumeLabel(0, auto, nowMs).includes(limitTime(soon)));
  t.ok('狭い幅の時計の字は時刻だけ（時刻不明は空＝アイコンだけ。解除の後・上限でないときも空）', /^\d{1,2}:\d{2}( ?[AP]M)?$/i.test(resumeShortLabel(auto, nowMs)) && resumeShortLabel({ ...auto, resetsAt: null }, nowMs) === ''
    && resumeShortLabel({ ...auto, autoResume: false }, soon + 1) === '' && resumeShortLabel({ reason: 'user' }, nowMs) === '');
  t.ok('解除時刻が分からない会話は「解除を確認中」の時計', resumeLabel(0, { ...auto, resetsAt: null }, nowMs) === '解除を確認中');
  t.ok('自動を外した会話は、解除前は「時刻 に解除」の時計、解除の後は普通の「再開」', /に解除$/.test(resumeLabel(0, { ...auto, autoResume: false }, nowMs))
    && resumeLabel(0, { ...auto, autoResume: false }, soon + 1) === '再開' && resumeLabel(2, { ...auto, autoResume: false }, soon + 1) === '保留中の 2 件を送って再開');
  t.ok('今日でない解除は日付つき（週の上限は「10/7（水）9:00」）', /^10\/7（水）/.test(limitTime(week, nowMs)) && /に自動で再開します$/.test(limitLineNote({ ...auto, resetsAt: week })) && limitLineNote({ ...auto, resetsAt: week }).includes('10/7（水）'));
  t.ok('末尾の 2 行目: 自動のとき「時刻 に自動で再開します」、時刻不明は 30 分ごとの確認、外したら「自動では再開しません。…」',
    limitLineNote(auto).endsWith('に自動で再開します') && limitLineNote({ ...auto, resetsAt: null }) === '解除時刻が分からないため、30 分ごとに確かめて再開します'
    && limitLineNote({ ...auto, autoResume: false }) === '自動では再開しません。解除の後に「再開」で続けられます');
  t.ok('解除の後の欄の下の一行は普通の再開と同じ（上限の解除を待つ文にしない）', resumeNoteText(0, { ...auto, autoResume: false }, soon + 1) === '送ると、この指示で続けます'
    && resumeNoteText(0, auto, nowMs).includes('上限の解除'));
  const base = { interrupted: true, running: false, waiting: false, text: '', attached: false };
  t.ok('中断状態・走っていない・欄が空なら出す', resumeVisible(base));
  t.ok('欄に字があれば隠す（空白だけなら出す）', !resumeVisible({ ...base, text: '別の指示' }) && resumeVisible({ ...base, text: '  \n' }));
  t.ok('添付があれば隠す', !resumeVisible({ ...base, attached: true }));
  t.ok('走っている・承認待ち・中断でないなら出さない', !resumeVisible({ ...base, running: true }) && !resumeVisible({ ...base, waiting: true }) && !resumeVisible({ ...base, interrupted: false }));

  // ---- 更新で止めた会話（脇の下の一行）
  const sessions = [
    { id: 'u1', interrupted: { at: 100, reason: 'update' } },
    { id: 'u2', interrupted: { at: 300, reason: 'update' } },
    { id: 'me', interrupted: { at: 400, reason: 'user' } },
    { id: 'child', delegation: { parent: 'u1' }, interrupted: { at: 500, reason: 'update' } },
    { id: 'none', interrupted: null },
  ];
  const u = updateInterrupted(sessions, 0);
  t.ok('更新による中断だけを数え、委譲の子（一覧に出ない）は数えない', JSON.stringify(u.ids) === '["u1","u2"]' && u.maxAt === 300 && u.show);
  t.ok('× で閉じた後は出さない', !updateInterrupted(sessions, 300).show);
  t.ok('閉じた後に新しい更新の中断があれば、また出す', updateInterrupted([...sessions, { id: 'u3', interrupted: { at: 900, reason: 'update' } }], 300).show);
  t.ok('無ければ出さない', !updateInterrupted([], 0).show);
  // 更新で Pleiad が再起動した後だけ出す（サーバーの起動より前の中断だけ。失敗・30 秒で止まらなかった更新の中断は出さない）
  t.ok('サーバーの起動より前の更新の中断だけを数える', JSON.stringify(updateInterrupted(sessions, 0, { startedAt: 200 }).ids) === '["u1"]');
  t.ok('起動の後の更新の中断（更新が失敗した）だけなら出さない', !updateInterrupted(sessions, 0, { startedAt: 50 }).show);
  t.ok('起動時刻が分からなければ出さない', !updateInterrupted(sessions, 0, { startedAt: null }).show && !updateInterrupted(sessions, 0, { startedAt: 0 }).show);

  // ---- 更新の確認に並べる作業
  const work = {
    count: 5,
    turns: [{ sessionId: 's1', backend: 'claude' }, { sessionId: 's2', backend: 'codex' }, { sessionId: 's3', backend: 'claude' }],
    permissions: [{ sessionId: 's3' }, { sessionId: 's4' }, { sessionId: 's1', relay: true }],
    subagents: [{ sessionId: 's1' }],
  };
  const rows = workRows(work);
  t.ok('会話ごとに 1 行（実行中・承認待ち・エージェント）', JSON.stringify(rows.map(r => [r.sessionId, r.state, r.backend]))
    === JSON.stringify([['s1', 'running', 'claude'], ['s2', 'running', 'codex'], ['s3', 'waiting', 'claude'], ['s4', 'waiting', null]]));
  t.ok('中継の複製は承認待ちに数えない', rows.find(r => r.sessionId === 's1').state === 'running');
  t.ok('脇の知らせの件数（実行中 2・承認待ち 2）', JSON.stringify(workCounts(work)) === '{"running":2,"waiting":2}');
  t.ok('running が無くても落ちない', workRows(null).length === 0 && JSON.stringify(workCounts(undefined)) === '{"running":0,"waiting":0}');

  // ---- 中断の進み（N / M）
  t.ok('止まった数を数える', JSON.stringify(interruptProgress(3, 1)) === '{"done":2,"total":3,"finished":false}');
  t.ok('進みは戻らない（一覧が一時的に増えても）', interruptProgress(3, 3, 2).done === 2);
  t.ok('0 件になったら終わり', interruptProgress(3, 0).finished && interruptProgress(3, 0).done === 3);

  // ---- 理由の辞書が全言語にある
  for (const lng of ['ja', 'en']) {
    const ui = JSON.parse(read(`web/locales/${lng}/ui.json`));
    t.ok(`${lng}: 理由ごとの短い字と一行`, REASONS.every(r => ui.interrupt.label[r] && ui.interrupt.line[r]));
    t.ok(`${lng}: 更新の確認の説明に {{mark}}（三角の位置）`, ui.updates.workAfter.includes('{{mark}}'));
    t.ok(`${lng}: 保留があるときの欄の下の一行（複数形）`, ui.interrupt.resumeNoteHeld_other?.includes('{{count}}') && (lng === 'ja' || ui.interrupt.resumeNoteHeld_one?.includes('{{count}}')));
    const server = JSON.parse(read(`web/locales/${lng}/server.json`));
    t.ok(`${lng}: 結果不明の未送信で再開を断る文`, Boolean(server.resume.outboxUnknown));
  }

  // ---- 配線
  const client = read('web/client.mjs'), side = read('web/side.mjs'), updates = read('web/updates.mjs');
  const html = read('web/index.html'), css = read('web/style.css');
  t.ok('再開は WS resume、更新の中断は abort {reason:"update"}', client.includes("cmd('resume', { sessionId })") && updates.includes("cmd('abort', { reason: 'update' })"));
  t.ok('turnEnd の interrupted を会話に写し、ターンが始まれば消す', client.includes("s.interrupted = ev.interrupted ?? null") && /running\.has\(s\.id\)\) \{ s\.interrupted = null/.test(client));
  t.ok('ライブの中断も保存された中断と同じ一行で描く（二重に出さない）', client.includes('paintInterruptLine({ at: ev.at ?? Date.now(),') && !client.includes('chat.sys.aborted'));
  t.ok('脇の行・畳んだ見出し・器の要約に三角', (side.match(/warnMark\(/g) ?? []).length >= 2 && side.includes('stoppedIn(rows)') && side.includes('stoppedIn(list)'));
  t.ok('index.html: 中断の隣に再開、欄の下の一行、脇の下の一行、更新の確認の作業一覧',
    ['id="resume"', 'id="resumeNote"', 'id="resumeStrip"', 'id="updateWork"', 'id="updateWorkAfter"', 'id="updatePromptWork"'].every(x => html.includes(x)));
  t.ok('style.css: 三角は --ink、既読は --ink-weak（差し色は使わない）', /\.warn-mark\{[^}]*color:var\(--ink\)/.test(css) && /\.warn-mark\.read\{color:var\(--ink-weak\)\}/.test(css) && !/\.warn-mark[^{]*\{[^}]*--ink-mark/.test(css));
  t.ok('30 秒で止まらなければやめる', updates.includes('STOP_WAIT_MS = 30000'));
  // 再開の後、中断の印はターンの開始（applyRunning・turnEnd）まで下ろさない。ボタンは送っている間押せない
  const resumeFn = client.slice(client.indexOf('async function resumeSession('), client.indexOf("$('resume').onclick"));
  t.ok('再開で中断の印を先に下ろさない', resumeFn.length > 0 && !resumeFn.includes('interrupted = null') && resumeFn.includes('resuming.set(sessionId'));
  t.ok('ターンの開始・終わりで再開の受け付けを解く', /for \(const id of running\) if \(resumeSettled\(id\)\)/.test(client) && client.includes('resumeSettled(ev.sessionId)'));
  const resumeAll = client.slice(client.indexOf("$('resumeAll').onclick"), client.indexOf("$('closeResumeStrip').onclick"));
  t.ok('まとめて再開は、もう続いた会話を飛ばし、失敗に数えない', resumeAll.includes('if (!isInterrupted(state.sessions.find(s => s.id === id)) || resuming.has(id)) continue;') && resumeAll.includes("e.code !== 'NOT_INTERRUPTED'"));
  t.ok('更新の後の一行は、サーバーの起動時刻より前の中断だけ・更新を進めている間は出さない',
    client.includes('startedAt: state.serverStartedAt ?? 0') && client.includes('updatesUi?.applying') && client.includes('state.serverStartedAt = Number.isFinite(m.startedAt)'));
  // 待つ間に始まったターンも止める: 残っている間は見るたびに abort を送り直す（画面の更新・デスクトップの終了）
  const stopLoop = updates.slice(updates.indexOf('async function stopWork'), updates.indexOf('async function action'));
  t.ok('更新: 待つ間は abort {reason:update} を送り直す', (stopLoop.match(/cmd\('abort', \{ reason: 'update' \}\)/g) ?? []).length === 2 && stopLoop.indexOf("cmd('abort', { reason: 'update' }).catch") > stopLoop.indexOf('for (;;)'));
  const main = read('desktop/main.cjs');
  const abortAll = main.slice(main.indexOf('async function abortAll'), main.indexOf('async function installUpdate'));
  t.ok('終了: 待つ間は abort {reason} を送り直す', abortAll.indexOf("workerRequest('abort'") > abortAll.indexOf('for (;;)') && abortAll.indexOf('for (;;)') > 0);
}
