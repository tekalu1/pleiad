// 入力欄の待ち（web/composer-wait.mjs、承認済みのモック docs/mockups/composer-loading.html）。
//   - 書けない待ち（会話を開く・初めて接続するまで）は readonly + aria-busy。disabled にしない。150ms を越えてから見せる
//   - 読み込みの失敗で欄を書けるように戻し、欄の上に理由と「もう一度読む」。送信は押せない（理由を title に）
//   - 作成中の送信の予約: readonly、150ms を越えたら送信に弧と「会話ができしだい送ります · 取り消す」。取り消すと字はそのまま
// client.mjs の流れ（作っている間に書いた字が残る・失敗で欄が戻る）はブラウザーで tests/browser/composer-loading.cjs。
// ここではその配線がコードに載っているかも見る。
import { readFileSync } from 'node:fs';
import { N } from '../lib/dom-stub.mjs';
import { createComposerWait } from '../../web/composer-wait.mjs';

export const name = 'composer-wait';
export const title = '入力欄の待ち（書けない待ち・読み込みの失敗・作成中の送信の予約）';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function setup() {
  const box = new N('div'), prompt = new N('textarea'), send = new N('button'), note = new N('div'), busyLine = new N('div'), busyText = new N('span');
  busyText.id = 'composerBusyText';
  busyLine.append(busyText);
  busyLine.hidden = true; note.hidden = true;
  send.title = 'send';
  const icon = new N('svg');
  send.append(icon);
  prompt.value = '';
  let timers = [];
  const setTimer = (fn) => { const h = { fn }; timers.push(h); return h; };
  const clearTimer = (h) => { timers = timers.filter(x => x !== h); };
  const flush = () => { const run = timers; timers = []; for (const h of run) h.fn(); };
  let changes = 0;
  const w = createComposerWait({ box, prompt, send, note, busyLine, busyText, t: (k) => `[${k}]`,
    runMark: () => { const s = new N('span'); s.className = 'run'; return s; }, onChange: () => changes++, setTimer, clearTimer });
  return { w, box, prompt, send, note, busyLine, busyText, icon, flush, pending: () => timers.length, changes: () => changes };
}

export default function (t) {
  {
    const s = setup();
    s.w.busy('history');
    t.ok('書けない待ちは readonly（disabled ではない。キーボードを閉じず IME を切らない）', s.prompt.readOnly === true && !s.prompt.disabled);
    t.ok('箱に aria-busy、欄の説明に待機文言', s.box.getAttribute('aria-busy') === 'true' && s.prompt.getAttribute('aria-describedby') === 'composerBusyText'
      && s.busyText.textContent === '[chat.composer.historyLoading]');
    t.ok('150ms までは見た目を変えない（ちらつかせない）', s.busyLine.hidden === true && !s.box.hasAttribute('data-wait') && s.pending() === 1);
    t.ok('送信は押せない', s.w.blocksSend() && !s.w.accepts());
    s.flush();
    t.ok('150ms を越えたら弧・流れる棒・data-wait', s.busyLine.hidden === false && s.box.getAttribute('data-wait') === 'history'
      && s.busyLine.querySelector('.run') && s.busyLine.querySelector('.composer-busy-bar'));
    s.w.idle();
    t.ok('解くと書ける・aria-busy と弧を外す', s.prompt.readOnly === false && !s.box.hasAttribute('aria-busy') && !s.box.hasAttribute('data-wait')
      && s.busyLine.hidden && !s.busyLine.querySelector('.run') && s.busyLine.children.length === 1 && !s.w.blocksSend());
  }
  {
    const s = setup();
    s.w.busy('connect');
    t.ok('初めての接続は「接続しています…」', s.busyText.textContent === '[chat.composer.connecting]');
    s.w.idle();
    t.ok('150ms より前に終われば何も出さない', s.pending() === 0 && s.busyLine.hidden);
  }
  {
    const s = setup();
    s.w.busy('history');
    s.flush();
    let retried = 0;
    s.w.failed(() => retried++);
    t.ok('読み込みに失敗したら欄を書けるように戻す', s.prompt.readOnly === false && !s.prompt.disabled && !s.box.hasAttribute('aria-busy') && s.w.accepts());
    t.ok('送信は押せないまま、理由を title に', s.w.blocksSend() && s.send.getAttribute('title') === '[chat.composer.historyNotLoaded]');
    const button = s.note.querySelector('button');
    t.ok('欄の上に理由と「もう一度読む」', !s.note.hidden && s.note.shown.includes('[chat.composer.historyNotLoaded]') && button?.textContent === '[chat.composer.historyRetry]');
    button.onclick();
    t.ok('「もう一度読む」で読み直す', retried === 1);
    s.w.busy('history');
    t.ok('読み直し始めたら理由を消し、title を戻す', s.note.hidden && s.send.getAttribute('title') === 'send');
    s.w.idle();
    t.ok('読めたら送信できる', !s.w.blocksSend());
  }
  {
    const s = setup();
    s.prompt.value = 'hello';
    let cancelled = 0;
    s.w.queue(() => cancelled++);
    t.ok('予約した送信の間は readonly（字は保つ）', s.prompt.readOnly === true && s.prompt.value === 'hello' && !s.w.accepts() && !s.w.blocksSend());
    t.ok('150ms までは弧も一行も出さない', s.note.hidden && s.send.children[0] === s.icon);
    s.flush();
    t.ok('150ms を越えたら送信ボタンに弧', s.send.classList.contains('wait') && s.send.querySelector('.run'));
    t.ok('欄の上に「会話ができしだい送ります」と「取り消す」', !s.note.hidden && s.note.shown.includes('[chat.composer.queued]')
      && s.note.querySelector('button')?.textContent === '[chat.composer.queuedCancel]');
    s.w.busy('history'); s.w.idle();
    t.ok('待ちを解いても予約中は readonly のまま', s.prompt.readOnly === true);
    s.note.querySelector('button').onclick();
    t.ok('取り消すと書けるように戻り、字はそのまま', cancelled === 1 && s.prompt.readOnly === false && s.prompt.value === 'hello'
      && s.note.hidden && s.send.children[0] === s.icon && !s.send.classList.contains('wait'));
  }
  {
    const s = setup();
    s.w.queue(() => {});
    s.w.unqueue();
    t.ok('150ms より前に作り終えたら何も出さない', s.pending() === 0 && s.note.hidden && s.send.children[0] === s.icon && !s.prompt.readOnly);
  }

  // ---------------------------------------------------------------- 配線（client.mjs・index.html・style.css・辞書）
  const client = read('web/client.mjs');
  const startNew = client.slice(client.indexOf('async function startNew('), client.indexOf('function branchIsFresh('));
  t.ok('新しい会話: 作成後に欄を写しで上書きしない（refresh の間に書いた字が消えていた）', !/draftText/.test(startNew) && !/\$\('prompt'\)\.value = draft/.test(startNew));
  t.ok('新しい会話: select は fresh（欄に触らない）で開き、欄の字をこの会話の下書きにする', /select\(result\.sessionId, \{ fresh: true \}\)/.test(startNew) && /saveDraft\(\)/.test(startNew) && /dropBlankDraft\(\)/.test(startNew));
  t.ok('新しい会話: 別の会話から移ったときだけ欄を空にする', /if \(source\) \{\s*\$\('prompt'\)\.value = ''/.test(startNew));
  const select = client.slice(client.indexOf('async function select('), client.indexOf('async function paintSession('));
  t.ok('会話を開く: disabled ではなく readonly + aria-busy（composerWait.busy）', !/prompt"\)\.disabled = true/.test(select) && /composerWait\.busy\("history"\)/.test(select));
  t.ok('会話を開く: fresh では下書きを読み直さない', /if \(!fresh\) loadDraft\(\)/.test(select));
  t.ok('読み込みの失敗: 欄を戻して「もう一度読む」（composerWait.failed → select retry）', /composerWait\.failed\(\(\) => select\(id, \{ retry: true \}\)\)/.test(select));
  t.ok('初めての接続まで「接続しています…」', /composerWait\.busy\("connect"\);\s*connect\(\);/.test(client));
  t.ok('作成中の送信は予約する', /composerWait\.queue\(/.test(client) && /creatingSession \?\? startNew\(\)/.test(client));
  const html = read('web/index.html');
  t.ok('index.html に欄の上の一行と欄の中の待機表示', /id="composerNote"[^>]*role="status"/.test(html) && /id="composerBusy"/.test(html) && /id="composerBusyText"/.test(html));
  const css = read('web/style.css');
  t.ok('style.css: 待ちは 150ms 後の data-wait で字を隠し、流れる棒は reduced-motion で止める', /\.cbox\[data-wait\] textarea/.test(css) && /\.composer-busy-bar\{animation:none\}/.test(css));
  const keys = ['queued', 'queuedCancel', 'historyLoading', 'connecting', 'historyNotLoaded', 'historyRetry'];
  const missing = ['ja', 'en'].flatMap(lang => { const c = JSON.parse(read(`web/locales/${lang}/ui.json`)).chat.composer; return keys.filter(k => !c[k]).map(k => `${lang}:${k}`); });
  t.ok('文言は ja・en の辞書にある', missing.length === 0, missing.join(' '));
}
