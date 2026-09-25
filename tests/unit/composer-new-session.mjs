// 新しい会話を作っている間の入力欄（web/client.mjs の startNew・select・submit を、最小の DOM と偽の cmd で流す）。
//   - 作っている間（newSession の応答待ち・一覧の読み直し・空の履歴の読み込み）に書いた字が、最後まで欄に残り、
//     作った会話の下書きとして保存される。欄は無効にも readonly にもならない（以前は一覧の読み直しの間に書いた字が消えた）
//   - "" の下書き（作っている間の仮置き）は、作った会話が引き取ったら消える
//   - 作っている間の送信は予約され、できしだい送る。取り消せば送らず、字は残る
//   - 別の会話を開く間は readonly + aria-busy。読み込みに失敗したら欄を書けるように戻し、「もう一度読む」で読み直す
// 見た目（150ms 後の弧・待機文言）は tests/unit/composer-wait.mjs、ブラウザーでは tests/browser/composer-loading.cjs。
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { N } from '../lib/dom-stub.mjs';
import { createSessionLoads } from '../../web/session-stream.mjs';
import { createComposerWait } from '../../web/composer-wait.mjs';

export const name = 'composer-new-session';
export const title = '新しい会話を作っている間に書いた字が消えない・作成中の送信の予約・読み込み失敗で欄が戻る';

const FUNCTIONS = ['startNew', 'select', 'loadAndPaint', 'paintSession', 'saveDraft', 'persistDraft', 'dropBlankDraft', 'loadDraft',
  'syncRunState', 'submit', 'clearSentDraft'];

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const code = FUNCTIONS.map(name => {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');

  const noop = () => {};
  const els = new Map();
  const $ = (id) => { if (!els.has(id)) { const n = new N(id === 'prompt' ? 'textarea' : 'div'); n.id = id; if (id === 'prompt') n.value = ''; els.set(id, n); } return els.get(id); };
  $('send').append(new N('svg'));
  $('composerBusyText');
  $('composerBusy').append($('composerBusyText'));
  let timers = [];
  const flushTimers = () => { const run = timers; timers = []; for (const h of run) h.fn(); };

  // 偽の cmd。newSession・loadSession は手で返す。saveDraft・sendMessage は記録してすぐ返す
  const calls = [];
  const waiting = [];
  const cmd = (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'newSession' || command === 'loadSession') return new Promise((res, rej) => waiting.push({ command, args, res, rej }));
    return Promise.resolve(command === 'listMessages' ? [] : {});
  };
  const reply = async (command, value, fail = false) => {
    for (let i = 0; i < 20 && !waiting.some(w => w.command === command); i++) await new Promise(setImmediate);
    const i = waiting.findIndex(w => w.command === command);
    if (i < 0) throw new Error(`${command} が呼ばれていない`);
    const [w] = waiting.splice(i, 1);
    if (fail) w.rej(new Error(value)); else w.res(value);
    for (let k = 0; k < 5; k++) await new Promise(setImmediate);
  };
  let releaseRefresh = null;
  const refresh = () => new Promise(r => { releaseRefresh = r; });

  const state = { current: 'old', busy: false, loadingSession: null, drafts: new Map(), attached: [], sessions: [], messages: [], presents: [],
    pendingPerms: new Map(), cwd: '', homeDir: 'C:/home', backendId: 'fake', prefs: {}, draft: {}, mode: 'default', runningIds: new Set(), stopping: new Set() };
  const storage = new Map();
  const context = vm.createContext({
    state, $, cmd, refresh, t: k => k, html: { t: k => k }, sys: noop, escText: x => x, NL: '\n',
    creatingSession: null, pendingNewSession: null, freshSessionId: null, queuedSend: null, settingsFailure: null,
    settingsWrite: Promise.resolve(), modeWrite: Promise.resolve(),
    DRAFT_STORE: 'drafts', draftWrites: new Map(), draftKey: () => state.current ?? '',
    localStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) ?? null },
    setDrawer: noop, randomId: () => Math.random().toString(36).slice(2), renderAttached: noop, fitPrompt: noop, clearThread: noop, syncTopbar: noop,
    pendingRows: new Map(), renderSessions: noop, pendingAfterDelay: () => noop, side: { keep: noop, showUndo: noop },
    filePreview: { sessionChanged: noop }, setTimeout: () => 1, clearTimeout: noop, el: () => new N('div'), append: noop,
    activity: { show: noop, hide: noop }, sessionLoads: createSessionLoads(),
    branchSnapshots: () => [], paintOutbox: noop, refreshOutbox: async () => [], branches: { load: async () => {}, has: () => false, nameOf: () => '' },
    log: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, thread: { children: [], querySelectorAll: () => [], classList: { toggle: noop } },
    setUuid: noop, closeTurnEl: noop, paintHistory: () => [], syncOutboxRows: noop, outboxes: new Map(), onEvent: noop, paintPendingPerms: noop,
    acknowledgeDisplayed: noop, placeJunctions: () => [], paintContextLine: noop, refreshContextEntry: async () => null,
    isRunningHere: () => false, behindHere: () => null, backgroundCounts: () => ({ live: 0, ended: 0 }), relayoutBranches: noop, branchIsFresh: () => true, promptPlaceholder: () => '',
    ACTIVITY_LABEL: {}, attachMenu: null, setDraftNote: noop,
    isWaitingHere: () => false, stoppingHere: () => false, controls: { fit: noop }, retiredHere: () => null, submittingMessages: new Set(),
    completionNotifications: { requestPermission: noop }, slashSkills: { close: noop }, uiLang: 'ja', attachmentLine: (l, p) => p,
    receipts: new Map(), saveReceipts: noop, messageRow: () => true, ensureMessageRow: noop, markDelivery: noop,
    createComposerWait,
  });
  vm.runInContext(code, context);
  context.composerWait = createComposerWait({ box: $('cbox'), prompt: $('prompt'), send: $('send'), note: $('composerNote'),
    busyLine: $('composerBusy'), busyText: $('composerBusyText'), t: k => k, runMark: () => { const s = new N('span'); s.className = 'run'; return s; },
    onChange: () => context.syncRunState(),
    setTimer: (fn) => { const h = { fn }; timers.push(h); return h; }, clearTimer: (h) => { timers = timers.filter(x => x !== h); } });
  const run = (js) => vm.runInContext(js, context);
  const prompt = $('prompt');
  // 打鍵: 欄が受け付けるときだけ字が増える（readonly・disabled なら捨てられる）。input で下書きを保存する（client.mjs と同じ）
  const type = (text) => { if (prompt.readOnly || prompt.disabled) return false; prompt.value += text; run('saveDraft()'); return true; };

  // ---------------------------------------------------------------- 作っている間に書いた字
  prompt.value = '前の会話の下書き';
  state.drafts.set('', { text: '古い仮置き', attached: [] });
  const making = run('startNew()');
  t.ok('別の会話から移ったら欄を空にする', prompt.value === '');
  t.ok('作り始めても欄は書ける（無効にも readonly にもしない）', !prompt.disabled && !prompt.readOnly && !$('cbox').hasAttribute('aria-busy'));
  type('あ');
  await reply('newSession', { sessionId: 'new' });
  t.ok('一覧を読み直している（newSession の応答の後）', typeof releaseRefresh === 'function');
  const typedInRefresh = type('い');
  t.ok('一覧を読み直している間も書ける', typedInRefresh && prompt.value === 'あい');
  releaseRefresh(); releaseRefresh = null;
  for (let k = 0; k < 5; k++) await new Promise(setImmediate);
  t.ok('空の履歴を読んでいる間も書ける（select の fresh）', type('う') && !prompt.readOnly && !prompt.disabled && state.current === 'new');
  t.ok('作ったばかりの会話は送信を押せる（予約になる）', $('send').disabled === false);
  await reply('loadSession', { messages: [], presents: [], draft: { text: '', attached: [] } });
  await making;
  t.ok('作り終えても欄の字はそのまま（写しで上書きしない）', prompt.value === 'あいう', prompt.value);
  const saved = calls.filter(c => c.command === 'saveDraft' && c.args.sessionId === 'new').at(-1);
  t.ok('欄の字が作った会話の下書きとして保存される', saved?.args.text === 'あいう', JSON.stringify(saved?.args));
  t.ok('"" の仮置きは消える（後で current が null に戻っても古い字が出ない）', !state.drafts.has('') && !JSON.parse(storage.get('drafts') ?? '[]').some(([k]) => k === ''));

  // ---------------------------------------------------------------- 作っている間の送信
  prompt.value = '';
  const making2 = run('startNew()');
  type('送る字');
  const sending = run('submit()');
  t.ok('作っている間に送信を押すと欄を readonly にして字を保つ', prompt.readOnly === true && prompt.value === '送る字' && !prompt.disabled);
  flushTimers();
  t.ok('150ms を越えたら「会話ができしだい送ります」と送信ボタンの弧', !$('composerNote').hidden && $('composerNote').shown.includes('chat.composer.queued') && $('send').querySelector('.run'));
  await reply('newSession', { sessionId: 'new2' });
  releaseRefresh(); releaseRefresh = null;
  await reply('loadSession', { messages: [], presents: [] });
  await making2; await sending;
  const sent = calls.filter(c => c.command === 'sendMessage');
  t.ok('できしだい、作った会話へ送る', sent.length === 1 && sent[0].args.sessionId === 'new2' && sent[0].args.prompt === '送る字', JSON.stringify(sent.map(s => s.args)));
  t.ok('送った後は欄が空で書ける・一行も消える', prompt.value === '' && !prompt.readOnly && $('composerNote').hidden && !$('send').classList.contains('wait'));

  // ---------------------------------------------------------------- 取り消す
  const making3 = run('startNew()');
  type('やめる字');
  const sending3 = run('submit()');
  flushTimers();
  $('composerNote').querySelector('button').onclick();
  t.ok('取り消すと書けるように戻り、字はそのまま', !prompt.readOnly && prompt.value === 'やめる字');
  type('+');
  await reply('newSession', { sessionId: 'new3' });
  releaseRefresh(); releaseRefresh = null;
  await reply('loadSession', { messages: [], presents: [] });
  await making3; await sending3;
  t.ok('取り消した送信は送らない', calls.filter(c => c.command === 'sendMessage').length === 1);
  t.ok('取り消した後に書き足した字も下書きに残る', prompt.value === 'やめる字+' && state.drafts.get('new3')?.text === 'やめる字+');

  // ---------------------------------------------------------------- 別の会話を開く・読み込みの失敗
  state.drafts.set('existing', { text: '既存の下書き', attached: [] });
  const opening = run("select('existing')");
  t.ok('別の会話を開く間は readonly + aria-busy（disabled にしない）', prompt.readOnly && !prompt.disabled && $('cbox').getAttribute('aria-busy') === 'true');
  t.ok('開いている間は打鍵を受け付けず、送信も押せない', !type('x') && $('send').disabled === true);
  await reply('loadSession', 'forced failure', true);
  await opening;
  t.ok('読み込みに失敗したら欄を書けるように戻す（以前は無効のまま）', !prompt.readOnly && !prompt.disabled && !$('cbox').hasAttribute('aria-busy'));
  t.ok('失敗したら欄の上に「もう一度読む」、送信は押せず理由を title に', !$('composerNote').hidden && $('composerNote').querySelector('button')?.textContent === 'chat.composer.historyRetry'
    && $('send').disabled === true && $('send').getAttribute('title') === 'chat.composer.historyNotLoaded');
  t.ok('失敗の後に書いた字は残る', type('!') && prompt.value === '既存の下書き!');
  $('composerNote').querySelector('button').onclick();
  t.ok('「もう一度読む」で読み直す（書けない待ちに戻る）', prompt.readOnly && calls.filter(c => c.command === 'loadSession' && c.args.sessionId === 'existing').length === 2);
  await reply('loadSession', { messages: [], presents: [], draft: { text: '既存の下書き', attached: [] } });
  for (let k = 0; k < 5; k++) await new Promise(setImmediate);
  t.ok('読めたら書けて送れる。失敗の前に書いた字は残る', !prompt.readOnly && $('send').disabled === false && $('composerNote').hidden && prompt.value === '既存の下書き!', prompt.value);
}
