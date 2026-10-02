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
import { syncRequest, joinReply, retainPlan } from '../../web/history-sync.mjs';

export const name = 'composer-new-session';
export const title = '新しい会話を作っている間に書いた字が消えない・作成中の送信の予約・作成中の作業場所の反映・読み込み失敗で欄が戻る';

const FUNCTIONS = ['startNew', 'select', 'loadHistory', 'loadAndPaint', 'paintSession', 'saveDraft', 'persistDraft', 'dropBlankDraft', 'loadDraft',
  'syncRunState', 'submit', 'clearSentDraft', 'uploadsHere', 'adoptUploads', 'uploadBlockReason', 'attachFiles', 'runUpload', 'saveDraftSoon', 'flushDraft',
  'reserveSettings', 'applyCwd'];

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
  let failSave = null;   // saveDraft をこのメッセージで失敗させる
  const cmd = (command, args = {}) => {
    calls.push({ command, args });
    if (command === 'saveDraft' && failSave) return Promise.reject(new Error(failSave));
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

  const uploading = [];
  const state = { current: 'old', busy: false, loadingSession: null, drafts: new Map(), attached: [], sessions: [], messages: [], presents: [],
    pendingPerms: new Map(), cwd: '', homeDir: 'C:/home', backendId: 'fake', prefs: {}, draft: {}, mode: 'default', runningIds: new Set(), stopping: new Set() };
  const storage = new Map();
  const context = vm.createContext({
    state, $, cmd, refresh, syncRequest, joinReply, retainPlan, retainThread: noop, holdReading: noop, t: (k, params) => params?.error ? `${k}: ${params.error}` : k, html: { t: k => k }, sys: noop, escText: x => x, NL: '\n',
    creatingSession: null, pendingNewSession: null, freshSessionId: null, draftTimer: null, draftSavedAt: 0, DRAFT_THROTTLE_MS: 400, queuedSend: null, settingsFailure: null, syncSettingsHold: noop,
    failedSettingsPatch: null, failedSettingsError: '', cwdSaving: 0,
    settingsWrite: Promise.resolve(), modeWrite: Promise.resolve(),
    DRAFT_STORE: 'drafts', draftWrites: new Map(), draftKey: () => state.current ?? '',
    localStorage: { setItem: (k, v) => storage.set(k, v), getItem: k => storage.get(k) ?? null },
    setDrawer: noop, randomId: () => Math.random().toString(36).slice(2), renderAttached: noop, fitPrompt: noop, clearThread: noop, prepareHistoryHeights: noop, syncTopbar: noop,
    syncWorkEntry: noop, restorePastSubagents: noop, paintContextStrip: noop, paintCompactions: noop,
    pendingRows: new Map(), renderSessions: noop, pendingAfterDelay: () => noop, side: { keep: noop, showUndo: noop },
    filePreview: { sessionChanged: noop }, setTimeout: () => 1, clearTimeout: noop, el: () => new N('div'), append: noop,
    activity: { show: noop, hide: noop }, sessionLoads: createSessionLoads(),
    branchSnapshots: () => [], paintOutbox: noop, refreshOutbox: async () => [], branches: { load: async () => {}, reset: noop, has: () => false, nameOf: () => '' }, scrollToEnd: noop, atBottom: () => false,
    log: { scrollTop: 0, scrollHeight: 0, clientHeight: 0 }, thread: { children: [], querySelectorAll: () => [], classList: { toggle: noop } },
    setUuid: noop, closeTurnEl: noop, paintHistory: () => [], syncOutboxRows: noop, outboxes: new Map(), onEvent: noop, paintPendingPerms: noop, paintComputerWait: noop,
    acknowledgeDisplayed: noop, placeJunctions: () => [], refreshContextEntry: async () => null,
    isRunningHere: () => false, behindHere: () => null, backgroundCounts: () => ({ live: 0, ended: 0 }), relayoutBranches: noop, branchIsFresh: () => true, promptPlaceholder: () => '',
    ACTIVITY_LABEL: {}, attachMenu: null, setDraftNote: noop,
    isWaitingHere: () => false, stoppingHere: () => false, controls: { fit: noop, paint: noop }, retiredHere: () => null, submittingMessages: new Set(),
    connStatus: { blocksSend: () => false },
    // 会話の移動（web/conversation-nav-view.mjs）。最新へのボタンの弧を合わせる呼び出しだけ受ける
    nav: { syncRunning: noop, reset: noop }, navSession: null, toc: { reset: () => {}, refresh: () => {} },
    // 入力欄の `!`（web/shell-composer.mjs）。tests/unit/shell-composer.mjs が見る。このテストでは使わない（ふつうの欄のまま）
    shellComposer: { active: false, blocked: false, draftText: () => prompt.value, reset: noop },
    completionNotifications: { requestPermission: noop }, slashSkills: { close: noop }, uiLang: 'ja', attachmentLine: (l, p) => p,
    // 入力欄の編集欄（web/md-editor.mjs）と添付（文中の札・送っている途中）。このテストでは添付は使わない
    composerEditor: { attachmentKeys: () => new Set(), hasAttachment: () => false }, uploads: new Map(), composerShellMode: null,
    uploadBlockReason: () => null, orderedAttachments: () => state.attached.slice(), attachedKey: p => `p:${p}`, notify: noop, flashAttachEntry: noop,
    receipts: new Map(), saveReceipts: noop, messageRow: () => true, ensureMessageRow: noop, markDelivery: noop,
    createComposerWait,
    // 添付を送る（runUpload）。sendAttachment は手で終わらせる
    sendAttachment: (o) => new Promise((res, rej) => uploading.push({ o, res, rej })), thumbnailOf: async () => null, whenOnline: async () => {},
    ATTACH_MAX_BYTES: 1e9, IMAGE_READ_HINT_BYTES: 1e9, formatBytes: String, paintUpload: noop, takeAttachAt: () => null,
    // 中断と再開（web/interrupt.mjs・client.mjs の syncResume / paintInterruptLine）。ここでは中断していない会話だけ
    syncResume: noop, paintInterruptLine: noop, isInterrupted: () => false, interruptReadPoint: () => 0, resumeSettled: () => false,
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

  // ---------------------------------------------------------------- 新しい会話を作っている間に始めた添付（会話ができても消えず、送信を止め、できた会話の本文の位置に入る）
  const resolved = [], pendingTouched = [], notices = [];
  let inserted = 0;
  context.composerEditor = { attachmentKeys: () => new Set(), hasAttachment: () => true, insertAttachment: () => { inserted++; return 'inserted'; },
    updatePending: (pid) => pendingTouched.push(pid), resolvePending: (pid, path) => resolved.push({ pid, path }) };
  context.sys = (text) => notices.push(text);
  context.notify = noop;
  state.attached = [];
  prompt.value = '';
  const makingUp = run('startNew()');
  t.ok('作り始めた（state.current は null）', state.current === null);
  const attaching = context.attachFiles([{ name: 'a.png', size: 10, type: 'image/png' }]);
  t.ok('作っている間に始めた添付は、この欄の送信中として数える', context.uploadsHere().length === 1 && inserted === 1);
  await reply('newSession', { sessionId: 'up1' });
  releaseRefresh(); releaseRefresh = null;
  for (let k = 0; k < 5; k++) await new Promise(setImmediate);
  const upload = [...context.uploads.values()][0];
  t.ok('会話ができたら持ち主がその会話になり、送っている途中の判定が途切れない', state.current === 'up1' && upload.sessionId === 'up1' && context.uploadsHere().length === 1 && Boolean(context.uploadBlockReason()));
  run('syncRunState()');
  t.ok('会話ができた後も送信ボタンは押せない', $('send').disabled === true);
  await reply('loadSession', { messages: [], presents: [], draft: { text: '', attached: [] } });
  await makingUp;
  const beforeUp = calls.filter(c => c.command === 'sendMessage').length;
  prompt.value = '添付を待つ字';
  await run('submit()');
  t.ok('届くまで送らない', calls.filter(c => c.command === 'sendMessage').length === beforeUp);
  await new Promise(setImmediate);
  uploading[0].res({ path: 'C:\\up\\up1.png', kind: 'image' });
  await attaching;
  t.ok('届いたら、できた会話の添付になり、札は同じ位置でパスを持つ札に替わる',
    state.attached.length === 1 && state.attached[0].path === 'C:\\up\\up1.png' && resolved.length === 1 && resolved[0].pid === upload.id && resolved[0].path === 'C:\\up\\up1.png' && context.uploads.size === 0);
  t.ok('できた会話の下書きに、本文の位置を保った添付として保存される', (() => { const d = calls.filter(c => c.command === 'saveDraft' && c.args.sessionId === 'up1').at(-1)?.args; return d?.attached?.length === 1 && d.text === '添付を待つ字'; })());
  run('syncRunState()');
  t.ok('届けば送信ボタンは押せる', $('send').disabled === false);

  // 送っている間に別の会話へ移った: その会話の下書きに積む。保存できなければ札は消さず、本当の理由を出す
  state.attached = []; state.current = 'up1'; resolved.length = 0; pendingTouched.length = 0; notices.length = 0; uploading.length = 0;
  const attaching2 = context.attachFiles([{ name: 'b.md', size: 5, type: 'text/markdown' }]);
  const upload2 = [...context.uploads.values()][0];
  state.current = 'elsewhere';
  failSave = 'disk full';
  await new Promise(setImmediate);
  uploading[0].res({ path: 'C:\\up\\b.md', kind: 'file' });
  await attaching2;
  t.ok('保存できなかったら札を消さず、失敗の理由は「disk full」', context.uploads.has(upload2.id) && upload2.failed === 'disk full' && pendingTouched.includes(upload2.id), String(upload2.failed));
  failSave = null;
  context.uploads.clear();
  state.current = 'existing';

  // ---------------------------------------------------------------- 文中の添付（ADR 0060）: 本文の印はそのまま送り、文中に無い添付だけ末尾に足す
  const A = 'C:\\up\\a.png', B = 'C:\\up\\b.md';
  state.attached = [{ path: B, name: 'b.md', kind: 'file', mime: '' }, { path: A, name: 'a.png', kind: 'image', mime: 'image/png' }];
  context.composerEditor = { attachmentKeys: () => new Set([context.attachedKey(A)]) };   // a.png だけ文中に置いてある
  context.orderedAttachments = () => [state.attached[1], state.attached[0]];             // 文中の位置の順（文中のものが先）
  prompt.value = `# 見出し\n[添付] ${A}\n説明`;
  const before = calls.filter(c => c.command === 'sendMessage').length;
  await run('submit()');
  const inline = calls.filter(c => c.command === 'sendMessage').slice(before);
  t.ok('本文の印は 1 回だけ（二重にしない）・文中に無い添付だけ末尾に印を足す',
    inline.length === 1 && inline[0].args.prompt === `# 見出し\n[添付] ${A}\n説明\n\n${B}` && inline[0].args.prompt.split(A).length === 2, JSON.stringify(inline.map(c => c.args.prompt)));
  t.ok('runTurn の attachments は今までどおり全件（文中の位置の順）', inline[0].args.attachments?.map(a => a.path).join() === `${A},${B}`, JSON.stringify(inline[0].args.attachments));

  // 送っている途中・失敗の添付があるうちは送らない
  state.attached = [];
  prompt.value = 'あとで送る';
  let told = null;
  context.uploadBlockReason = () => '添付を送っている間は送れません';
  context.notify = (text) => { told = text; };
  const held = calls.filter(c => c.command === 'sendMessage').length;
  await run('submit()');
  t.ok('送信中・失敗の添付があれば送らず、理由を知らせる', calls.filter(c => c.command === 'sendMessage').length === held && told === '添付を送っている間は送れません' && prompt.value === 'あとで送る');
  t.ok('送信ボタンは押せず、title に理由を出す', (run('syncRunState()'), $('send').disabled === true && $('send').getAttribute('title') === '添付を送っている間は送れません'));
  // シェルの形（!）の実行は添付の送信と関係ないので、送っている途中の添付があってもボタンは押せて、title にも理由を出さない
  context.composerShellMode = 'shell';
  run('syncRunState()');
  t.ok('シェルの形では、送っている途中の添付があっても送信ボタンは押せる（理由も出さない）', $('send').disabled === false && $('send').getAttribute('title') !== '添付を送っている間は送れません');
  context.composerShellMode = null;
  context.uploadBlockReason = () => null;
  run('syncRunState()');
  t.ok('添付が届けば送信ボタンと title は元に戻る', $('send').disabled === false && $('send').getAttribute('title') !== '添付を送っている間は送れません', `${$('send').disabled} ${$('send').getAttribute('title')}`);

  // 打鍵ごとの保存は間引く: 静かな間の最初の打鍵はすぐ、続く打鍵は 1 回にまとめ、最後の打鍵の分は必ず保存する。直ちに保存するときは待ちを捨てる
  const savesOf = () => calls.filter(c => c.command === 'saveDraft' && c.args.sessionId === 'existing');
  const settle = async () => { for (let k = 0; k < 4; k++) await new Promise(setImmediate); };
  let timer = null;
  context.setTimeout = (fn, ms) => { timer = { fn, ms }; return 7; };
  context.draftSavedAt = 0; context.draftTimer = null;
  state.attached = [];
  const savesBefore = savesOf().length;
  prompt.value = '打鍵 1'; run('saveDraftSoon()'); await settle();
  prompt.value = '打鍵 2'; run('saveDraftSoon()');
  prompt.value = '打鍵 3'; run('saveDraftSoon()'); await settle();
  t.ok('静かな間の最初の打鍵はすぐ保存し、続く打鍵は保存せず待つ', savesOf().length === savesBefore + 1 && savesOf().at(-1).args.text === '打鍵 1' && timer && timer.ms <= 400 && context.draftTimer === 7);
  timer.fn(); await settle();
  t.ok('待っていた分は最後の打鍵の字で 1 回だけ保存する', savesOf().length === savesBefore + 2 && savesOf().at(-1).args.text === '打鍵 3' && context.draftTimer === null);
  prompt.value = '打鍵 4'; run('saveDraftSoon()'); await settle();
  t.ok('間引く間に来た打鍵は flushDraft で直ちに保存できる（欄を離れる・ページを隠すとき）', context.draftTimer === 7 && (run('flushDraft()'), await settle(), savesOf().at(-1).args.text === '打鍵 4' && context.draftTimer === null));
  run('flushDraft()'); await settle();
  t.ok('待ちが無ければ flushDraft は何も保存しない', savesOf().at(-1).args.text === '打鍵 4' && savesOf().length === savesBefore + 3);
  context.setTimeout = () => 1;

  // 下書きは本文（印を含む Markdown）と添付の実体を version: 2 で保存する。印の無い古い下書きは添付だけ（文末に付く）
  state.attached = [{ path: A, name: 'a.png', kind: 'image', mime: 'image/png' }];
  prompt.value = `x\n[添付] ${A}\ny`;
  await run('saveDraft()');
  const draft = calls.filter(c => c.command === 'saveDraft').at(-1).args;
  t.ok('下書きは印を含む本文・添付の実体・version: 2 を保存する', draft.text === `x\n[添付] ${A}\ny` && draft.attached.length === 1 && draft.version === 2, JSON.stringify(draft));
  state.drafts.set('existing', { text: '古い下書き', attached: [{ path: B, name: 'b.md', kind: 'file' }] });
  run('loadDraft()');
  t.ok('古い下書き（本文に印が無い）は本文と添付の実体をそのまま読む（位置は推測しない）', prompt.value === '古い下書き' && state.attached.length === 1 && state.attached[0].path === B);

  // ---------------------------------------------------------------- 作成中に作業場所を選ぶ（新しい会話への反映・送信予約）
  context.orderedAttachments = () => state.attached.slice();
  context.composerEditor = { attachmentKeys: () => new Set(), hasAttachment: () => false };
  // 1. 作成中に作業場所を選んだら、できた会話に setTurnSettings で反映され、その後の送信もその場所で走る
  state.cwd = 'C:/home';
  state.attached = [];
  prompt.value = '';
  const makingCwd1 = run('startNew()');
  t.ok('作成開始時の draft.cwd は初期 cwd', state.draft.cwd === 'C:/home');
  run("applyCwd('D:/project-a')");
  t.ok('作成中に選んだ場所は draft.cwd に入る', state.draft.cwd === 'D:/project-a' && state.cwd === 'D:/project-a');
  await reply('newSession', { sessionId: 'cwd1' });
  const turnSettings1 = calls.filter(c => c.command === 'setTurnSettings' && c.args.sessionId === 'cwd1');
  t.ok('できた会話に setTurnSettings で作業場所を反映する', turnSettings1.length === 1 && turnSettings1[0].args.cwd === 'D:/project-a');
  releaseRefresh(); releaseRefresh = null;
  state.sessions.push({ id: 'cwd1', cwd: 'C:/home', nextSettings: { cwd: 'D:/project-a' } });
  await reply('loadSession', { messages: [], presents: [], draft: { text: '', attached: [] } });
  await makingCwd1;
  prompt.value = 'hello cwd';
  await run('submit()');
  const sentCwd1 = calls.filter(c => c.command === 'sendMessage' && c.args.sessionId === 'cwd1');
  t.ok('送信時の cwd は選んだ場所になる', sentCwd1.length === 1 && sentCwd1[0].args.cwd === 'D:/project-a');

  // 2. 作成中に作業場所を選び、作成中に送信を予約する（queuedSend）
  state.cwd = 'C:/home';
  state.attached = [];
  prompt.value = '';
  const makingCwd2 = run('startNew()');
  run("applyCwd('D:/project-b')");
  prompt.value = 'queued with cwd';
  const sendingCwd2 = run('submit()');
  await reply('newSession', { sessionId: 'cwd2' });
  const turnSettings2 = calls.filter(c => c.command === 'setTurnSettings' && c.args.sessionId === 'cwd2');
  t.ok('送信予約があっても setTurnSettings で作業場所を反映する', turnSettings2.length === 1 && turnSettings2[0].args.cwd === 'D:/project-b');
  releaseRefresh(); releaseRefresh = null;
  state.sessions.push({ id: 'cwd2', cwd: 'C:/home', nextSettings: { cwd: 'D:/project-b' } });
  await reply('loadSession', { messages: [], presents: [], draft: { text: '', attached: [] } });
  await makingCwd2; await sendingCwd2;
  const sentCwd2 = calls.filter(c => c.command === 'sendMessage' && c.args.sessionId === 'cwd2');
  t.ok('予約された送信も選んだ場所で走る', sentCwd2.length === 1 && sentCwd2[0].args.cwd === 'D:/project-b' && sentCwd2[0].args.prompt === 'queued with cwd');

  // 3. 作成中に別の会話へ移った場合も、作成中に選んだ場所はできた会話に反映する
  state.cwd = 'C:/home';
  state.attached = [];
  prompt.value = '';
  const makingCwd3 = run('startNew()');
  run("applyCwd('D:/project-c')");
  state.current = 'other-session';
  await reply('newSession', { sessionId: 'cwd3' });
  const turnSettings3 = calls.filter(c => c.command === 'setTurnSettings' && c.args.sessionId === 'cwd3');
  t.ok('作成中に別の会話へ移っても、できた会話に作業場所を反映する', turnSettings3.length === 1 && turnSettings3[0].args.cwd === 'D:/project-c');
  releaseRefresh(); releaseRefresh = null;
  await makingCwd3;

  // 4. 反映に失敗したときは、送信を止める
  state.cwd = 'C:/home';
  state.attached = [];
  prompt.value = '';
  let failTurnSettings = 'folder not found';
  const oldCmd = context.cmd;
  context.cmd = (command, args = {}) => {
    if (command === 'setTurnSettings' && failTurnSettings) return Promise.reject(new Error(failTurnSettings));
    return oldCmd(command, args);
  };
  const makingCwdFail = run('startNew()');
  run("applyCwd('D:/deleted-dir')");
  prompt.value = 'doomed send';
  const sendingCwdFail = run('submit()');
  await reply('newSession', { sessionId: 'cwd-fail' });
  releaseRefresh(); releaseRefresh = null;
  state.sessions.push({ id: 'cwd-fail', cwd: 'C:/home' });
  await reply('loadSession', { messages: [], presents: [], draft: { text: '', attached: [] } });
  await makingCwdFail; await sendingCwdFail;
  t.ok('反映に失敗したら settingsFailure が記録される', context.settingsFailure === 'cwd-fail');
  const sentFail = calls.filter(c => c.command === 'sendMessage' && c.args.sessionId === 'cwd-fail');
  t.ok('反映に失敗したときは送信しない', sentFail.length === 0);
  context.cmd = oldCmd;
  context.settingsFailure = null;
  context.failedSettingsPatch = null;
}
