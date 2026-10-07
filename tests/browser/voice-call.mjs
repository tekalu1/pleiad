// 通話モードの打鍵（実ブラウザー。承認済み 2026-10-06、docs/voice-call.md「確かめ方」）:
//   頭の通話ボタン → 準備中 → 聞いています → 声（偽のマイク）→ 片が吹き出しに足される → まとめ待ち（残りの線・［いま送る］［取り消す］）→ 1 通で送る → 返事 → 読んでいる場所の下線が伸びる →
//   止める（ここで止めました · 続きを読む）→ ミュート → 終える。さらに、取り消す・送信待ち（時計と［取り消す］）・差し込み待ち → AI に渡しました（承認済み 2026-10-07）。
//   Chats の会話とチャンネルのスレッドの両方。権限なし・キーなしの一行。ライト・ダーク・1280・360。
// 実行: node tests/browser/voice-call.mjs   （playwright-core は playwright-cli 同梱のものを使う。環境変数 PW_CORE・PW_CHROMIUM で替えられる）
//   VOICE_SHOTS=<ディレクトリ> を渡すと、場面ごとに撮る（temporary/screenshots/voice-call-<場面>.png）。
// 本物のサーバー（fake バックエンド・一時のデータ置き場・別ポート）と偽の OpenRouter（tests/lib/fake-openrouter.mjs）を立て、Chromium の
// --use-fake-device-for-media-stream・--use-file-for-fake-audio-capture（声のような音の WAV）・--use-fake-ui-for-media-stream で動かす。実データには触れず、本物の OpenRouter へは送らない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { startFakeOpenRouter } from '../lib/fake-openrouter.mjs';

const require = createRequire(import.meta.url);
const PW = process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core';
const { chromium } = require(PW);
const SHOTS = process.env.VOICE_SHOTS || '';
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const QUESTION = '署名の鍵はどこで更新するの？';
const REPLY = '署名の鍵は、リポジトリの Secrets にある SIGNING_KEY です。新しい鍵に差し替えて、release ジョブをもう一度実行してください。\n\n```\ngh secret set SIGNING_KEY < key.pem\n```\n';

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64/chrome-headless-shell.exe');
}

/** 声のような音: 4Hz で揺れる倍音。雑音抑制に消されないよう揺らす。既定は 無音 0.3 秒 → 声 1.4 秒 → 息継ぎ 0.25 秒 → 声 1.4 秒 → 無音。bursts で声の区間（秒）を替えられる */
function writeSpeechWav(file, bursts = [[0.3, 1.7], [1.95, 3.35]], secs = 24) {
  const rate = 16000, n = rate * secs, data = Buffer.alloc(n * 2);
  const burst = (t) => bursts.some(([a, b]) => t >= a && t < b);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    if (burst(t)) v = 0.35 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 540 * t)) / 1.8;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-voice-ui-')));
const wav = path.join(scratch, 'speech.wav');
writeSpeechWav(wav);
// 3 つの発言（間が 2.6 秒ずつ空いて、まとめ待ちの 1.2 秒を越える。1 つずつ別の通になる）。作業中に重なる送信の確認用
const wavThree = path.join(scratch, 'speech-three.wav');
writeSpeechWav(wavThree, [[0.3, 1.7], [4.3, 5.7], [8.3, 9.7]], 20);
const replyFile = path.join(scratch, 'reply.json');
fs.writeFileSync(replyFile, JSON.stringify({ when: QUESTION, steps: [{ text: REPLY }] }));

// 聞き取り: 1 つ目の片・2 つ目の片（前の片と重なる）・全体。少し遅らせて、実際の往復のように。場面ごとに、返す字を順に並べる（足りなくなったら最後の字）
const script = ['署名の鍵はどこで', 'どこで更新する', QUESTION];
const sttTexts = [...script];
let sttLast = QUESTION;
const api = await startFakeOpenRouter({ transcripts: () => { if (sttTexts.length) sttLast = sttTexts.shift(); return sttLast; }, sttDelay: () => 220, ttsMsPerChar: 110, ttsFirstByteDelayMs: 150 });
const server = await startServer({
  env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_VOICE_API: api.url, AGENT_HOST_FAKE_VOICE_REPLY: replyFile, AGENT_HOST_LOCALE: 'ja', AGENT_HOST_FAKE_STEER_CONFIRM_MS: '1500' },
  dataDir: path.join(scratch, 'data'), timeoutMs: 60_000,
});
const URL_ = `http://127.0.0.1:${server.port}/?token=${server.token}`;
const admin = await open({ port: server.port, token: server.token });
const launch = (file) => chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${file}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});
const browser = await launch(wav);
let browserThree = null;

/** 足された語の溶け込み（180ms）が終わってから撮る */
const settled = (page) => page.waitForFunction(() => [...document.querySelectorAll('.vc-words .lw')].every((w) => w.getAnimations().length === 0), null, { timeout: 3000 }).catch(() => {});
const shot = async (page, name) => {
  if (/hearing/.test(name)) await settled(page); if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `voice-call-${name}.png`) }); } };
let lastPage = null;
const msOf = (page, scope) => page.locator(`${scope} .vc-micwrap`).first().getAttribute('data-ms');
async function until(fn, label, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(60); }
  throw new Error(`timeout: ${label} ${JSON.stringify(last ?? null)}`);
}

async function newPage({ width = 1280, height = 820, scheme = 'light', reduced = false, on = browser, beeps = false } = {}) {
  const context = await on.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference', permissions: ['microphone'] });
  const page = await context.newPage();
  // 効果音の確認: 鳴らした音の高さ（効果音は OscillatorNode。周波数の列）を window.__beeps に控える
  if (beeps) await page.addInitScript(() => {
    const create = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      const osc = create.call(this);
      const set = osc.frequency.setValueAtTime.bind(osc.frequency);
      osc.frequency.setValueAtTime = (value, at) => { (window.__beeps ||= []).push(value); return set(value, at); };
      return osc;
    };
  });
  lastPage = page;
  page.on('pageerror', (e) => { throw e; });
  if (process.env.VOICE_DEBUG_DOM) page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text()); });
  await page.addInitScript(() => { try { localStorage.setItem('ply-voice-debug', '1'); } catch {} });
  await page.goto(URL_);
  await page.getByRole('button', { name: 'あとで', exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('send') && document.querySelector('.vc-call'));
  return { page, context };
}

try {
  // ---- 準備: fake のログイン・キー・設定（エコー除去を切って、偽のマイクの音を素通しにする）
  await admin.cmd('authLogin', { backend: 'fake' }).catch(() => {});
  await admin.cmd('setVoiceKey', { key: KEY });
  await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { echoCancellation: false } } });

  // ===== Chats の会話 =====
  {
    const { page, context } = await newPage();
    const call = page.locator('header.top .vc-call');
    check(await call.isVisible(), '頭に通話ボタンがある（通話していないときは無彩色の電話）');
    check((await call.getAttribute('aria-label')) === '通話を始める' && !(await call.evaluate((n) => n.classList.contains('on'))), '通話ボタンの名前は「通話を始める」');
    check(!(await page.locator('#composer .vc-micwrap').first().isVisible()), '通話していないときは入力欄にマイクもスピーカーも出ない');
    check(!(await page.locator('main[data-vc-call]').count()), '通話していないときは背景（光）も出ない');
    await shot(page, 'chat-idle-1280-light');

    await call.click();
    check(['starting', 'listening'].includes(await msOf(page, '#composer')), '押すと準備中（マイクの縁を弧が回る）か聞いています');
    await until(async () => (await msOf(page, '#composer')) === 'listening', 'listening');
    check(await call.evaluate((n) => n.classList.contains('on')), '通話中は通話ボタンが塗りのピルになる');
    check(/^通話を終える · \d+:\d\d$/.test(await call.getAttribute('aria-label')), '名前は「通話を終える · 経過時間」');
    check(await page.locator('#composer .vc-micwrap').isVisible() && await page.locator('#composer .vc-spk').isVisible(), '入力欄にマイクとスピーカーが出る');
    check(await page.locator('main[data-vc-call]').count() === 1, '通話中はメインに data-vc-call（背景の光）');
    check((await page.locator('#composer .vc-mic').getAttribute('aria-label')).startsWith('マイクをミュート · '), 'マイクの名前に状態の語（ボタンの名前と title）');
    await shot(page, 'chat-listening-1280-light');

    // 声 → 聞き取り中 → 片
    await until(async () => (await msOf(page, '#composer')) === 'hearing', 'hearing', 20000);
    const bubble = page.locator('#thread .vc-live');
    await until(async () => (await bubble.count()) === 1 && (await bubble.locator('.lw').count()) > 0, 'live words', 20000);
    check((await bubble.locator('.vc-body .vmark').count()) === 1, '吹き出しの左に小さなマイクの印');
    // 普通のあなたの発言と同じ位置・同じ幅の規則（細い列に潰れない）。ぼかしは足された語の 180ms の間だけ
    await sleep(350);
    const geo = await bubble.evaluate((n) => { const b = n.querySelector('.body'), w = n.querySelector('.who'); const br = b.getBoundingClientRect(), wr = w.getBoundingClientRect(); return { left: br.left, width: br.width, whoH: wr.height, whoW: wr.width, logLeft: document.querySelector('#thread').getBoundingClientRect().left }; });
    check(geo.whoH < 30 && geo.width >= 90 && geo.left - geo.logLeft >= 60, '声の吹き出しは潰れない（「あなた」は 1 行・本文は内容に合わせた幅・筋の右の列）', geo);
    const blur = await bubble.locator('.lw').evaluateAll((words) => words.filter((w) => !w.classList.contains('out') && w.getAnimations().length === 0).map((w) => [getComputedStyle(w).filter, getComputedStyle(w).opacity]));
    check(blur.length > 0 && blur.every(([f, o]) => f === 'none' && o === '1'), '溶け込みの終わった字（途中の弱い字を含む）は常にくっきり読める（filter なし・不透明）', blur);
    global.__liveLeft = geo.left;
    check((await bubble.locator('.lw.p').count()) > 0, '途中の文字は弱い字（.p）');
    await shot(page, 'chat-hearing-1280-light');
    await until(async () => (await bubble.innerText()).includes('更新する') || (await bubble.count()) === 0, 'second piece', 20000);

    // まとめ待ち: 話し終えても吹き出しは 1 つのまま、下に残りの線と「あと N 秒で送ります」［いま送る］［取り消す］。マイクの縁の弧も同じ長さで減る
    await until(async () => (await bubble.locator('.vc-hold').count()) === 1 && /あと [0-9.]+ 秒で送ります/.test(await bubble.locator('.vc-ht').innerText().catch(() => '')), 'hold ui', 20000);
    check(await bubble.locator('.vc-hold .vc-bar').isVisible() && await bubble.getByRole('button', { name: 'いま送る' }).isVisible() && await bubble.getByRole('button', { name: '取り消す' }).isVisible(), 'まとめ待ち: 吹き出しの下に残りの線と［いま送る］［取り消す］');
    check((await bubble.locator('.vc-body').getAttribute('role')) === 'group' && (await bubble.locator('.vc-body').getAttribute('aria-label')) === 'あなたの声（まとめ待ち）', 'まとめ待ちの吹き出しは role=group（名前「あなたの声（まとめ待ち）」）');
    const left1 = await bubble.locator('.vc-hold').evaluate((n) => parseFloat(n.style.getPropertyValue('--left')));
    await until(async () => (await bubble.locator('.vc-hold').evaluate((n) => parseFloat(n.style.getPropertyValue('--left')))) < left1 - 0.05, 'bar shrinks', 5000);
    check((await msOf(page, '#composer')) === 'hold' || (await msOf(page, '#composer')) === 'hearing', 'まとめ待ちの間、マイクは hold の姿（縁の弧が残り時間で短くなる）か聞き取り中。「考え中」には戻らない');
    check((await page.locator('#thread .mw:not(.vc-live) .m.user').count()) === 0, 'まとめ待ちの間は、まだ会話へ 1 通も送っていない');
    await shot(page, 'chat-hold-1280-light');

    // 1 通にまとめて送る → 本物の発言の行（声の吹き出しとは別）
    await until(async () => (await page.locator('#thread .mw:not(.vc-live) .m.user .body').filter({ hasText: QUESTION }).count()) === 1, 'real user row', 30000);
    check((await page.locator('#thread .mw:not(.vc-live) .m.user').count()) === 1, '話し終えて待ち時間が過ぎたら、1 通だけが会話に出る');
    await until(async () => /AI に渡しました/.test(await page.locator('#thread .mw:not(.vc-live) .m.user .outbox-status').first().innerText().catch(() => '')), 'delivered label', 15000);
    check(await page.locator('#thread .mw:not(.vc-live) .m.user .outbox-status.vc-dl').count() === 1, '声で送った行の配送の一行は「AI に渡しました」（3 つの言い方）');
    check((await page.locator('#thread .vc-live').count()) === 0, '本物の発言の行が現れたら声の吹き出しは消える（重ならない）');
    const realLeft = await page.locator('#thread .m.user .body').first().evaluate((n) => n.getBoundingClientRect().left);
    check(Math.abs(realLeft - global.__liveLeft) <= 2, '声の吹き出しは本物の発言の行と同じ左の位置（行が入れ替わっても動かない）', [realLeft, global.__liveLeft]);
    check((await page.locator('#thread .m.user .vmark').count()) === 1, '本物の発言の行にマイクの印');
    check((await msOf(page, '#composer')) === 'thinking' || (await msOf(page, '#composer')) === 'speaking', '送ったあとは考え中（縁を点が回る）');
    await shot(page, 'chat-thinking-1280-light');

    // 返事（通常の出方）→ 読み上げ → 下線
    await until(async () => (await msOf(page, '#composer')) === 'speaking', 'speaking', 30000);
    check((await page.locator('#thread .m.ai').last().innerText()).includes('署名の鍵は'), '返事の文字は通話していないときと同じ出方で表示される');
    check(await page.locator('#thread .vc-hint').isVisible(), '読み上げ中は返事の下に［止める］の一行');
    check((await page.locator('#thread .vc-hint').innerText()).includes('エコー除去がオフ'), 'エコー除去なしで始めた通話では、ヒントは「いまはマイクを閉じています（エコー除去がオフのとき）」');
    // 通話中にエコー除去を入れても、この通話の録音の制約は変わらない。ヒントも変わらず（割り込みが有効に見えない）、次の通話から効く
    await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { echoCancellation: true } } });
    await sleep(700);
    check((await page.locator('#thread .vc-hint').innerText()).includes('エコー除去がオフ') && (await msOf(page, '#composer')) === 'speaking', '通話中に設定のエコー除去を入れても、この通話の表示（閉じている）は変わらない');
    await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { echoCancellation: false } } });
    await until(async () => (await page.locator('.vc-underlay .vc-ul').count()) > 0, 'underline', 15000);
    const widths = [];
    for (let i = 0; i < 4; i++) { widths.push(await page.locator('.vc-underlay .vc-ul').first().evaluate((n) => new DOMMatrix(getComputedStyle(n).transform).a)); await sleep(350); }
    check(widths[3] > widths[0], '下線は再生位置に合わせて伸びる（scaleX が増える）', widths);
    const ul = await page.locator('.vc-underlay .vc-ul').first().evaluate((n) => ({ h: n.getBoundingClientRect().height, bg: getComputedStyle(n).backgroundColor }));
    check(ul.h >= 1.5 && ul.h <= 2.5, '下線は 2px', ul);
    await shot(page, 'chat-speaking-1280-light');
    check((await page.locator('#thread .m.ai').last().evaluate((n) => n.querySelectorAll('.vc-ul').length)) === 0, '返事の本文の DOM は触らない（線は本文の外の層）');
    check((await page.locator('#composer .vc-spk').getAttribute('aria-label')).includes('話しています'), 'スピーカーの名前に「話しています」');
    check(parseFloat(await page.locator('main').evaluate((n) => n.style.getPropertyValue('--vc-olv') || '0')) >= 0, '出力レベルが CSS 変数に出る');

    // 止める → 「ここで読み上げを止めました · 続きを読む」→ 続きを読む
    await page.locator('#thread .vc-hint .btn', { hasText: '止める' }).click();
    await until(async () => (await page.locator('#thread .vc-hint[data-mode=cut]').count()) === 1 && await page.locator('#thread .vc-hint[data-mode=cut]').isVisible(), 'cut hint');
    const cutInfo = [await page.evaluate(() => [...document.querySelectorAll('.vc-hint')].map((n) => n.outerHTML).join('||')), await page.getByRole('button', { name: '続きを読む' }).isVisible()];
    check(cutInfo[0].includes('ここで読み上げを止めました') && cutInfo[1], '止めた場所に「ここで読み上げを止めました」と［続きを読む］', cutInfo);
    await until(async () => (await page.locator('.vc-underlay .vc-ul').count()) === 0, 'underline gone after stop', 3000);
    check(true, '止めたら下線は静かに消える（500ms の消え方のあと、線が 1 本も残らない）');
    await shot(page, 'chat-cut-1280-light');
    await page.getByRole('button', { name: '続きを読む' }).click();
    await until(async () => (await msOf(page, '#composer')) === 'speaking' && (await page.locator('#thread .vc-hint[data-mode=reading]').count()) === 1, 'resumed speaking', 20000);
    check(true, '［続きを読む］で、止めた文から読み直す（読み上げ中の一行に戻る）');

    // スピーカーのミュート → 印は静かに消える
    await page.locator('#composer .vc-spk').click();
    check((await page.locator('#composer .vc-spk').getAttribute('aria-pressed')) === 'true', 'スピーカーのミュートを押すと aria-pressed');
    await until(async () => (await page.locator('.vc-underlay .vc-ul').count()) === 0, 'underline gone', 4000);
    check(true, 'スピーカーのミュートで読み上げの印は静かに消える');
    await page.locator('#composer .vc-spk').click();

    // マイクのミュート
    await until(async () => ['listening', 'thinking'].includes(await msOf(page, '#composer')), 'quiet', 30000);
    await page.locator('#composer .vc-mic').click();
    await until(async () => (await msOf(page, '#composer')) === 'muted', 'muted');
    check((await page.locator('#composer .vc-mic').getAttribute('aria-pressed')) === 'true' && (await page.locator('#composer .vc-mic').getAttribute('aria-label')).startsWith('ミュートを解除'), 'マイクを押すとミュート（斜線のマイク・aria-pressed・名前は解除）');
    await shot(page, 'chat-muted-1280-light');
    await page.locator('#composer .vc-mic').click();

    // 終える
    await call.click();
    await until(async () => !(await page.locator('main[data-vc-call]').count()), 'ended');
    check(!(await call.evaluate((n) => n.classList.contains('on'))) && !(await page.locator('#composer .vc-micwrap').isVisible()), '終えると通話ボタンは電話に戻り、マイクとスピーカーは消える');
    check((await page.locator('#thread .vc-live').count()) === 0 && (await page.locator('.vc-underlay .vc-ul').count()) === 0, '終えたあと、声の吹き出しも下線も残らない');
    await context.close();
  }

  // ===== まとめ待ちを［取り消す］: 送らず、吹き出しも消える =====
  {
    sttTexts.push(...script);
    const { page, context } = await newPage();
    await page.evaluate(() => document.getElementById('newSession').click());   // 新しい会話（前の場面の発言が履歴に出ているため）
    await page.waitForFunction(() => document.querySelectorAll('#thread .m.user').length === 0);
    await page.locator('header.top .vc-call').click();
    const bubble = page.locator('#thread .vc-live');
    await until(async () => (await bubble.locator('.vc-hold').count()) === 1 && /あと [0-9.]+ 秒で送ります/.test(await bubble.locator('.vc-ht').innerText().catch(() => '')), 'hold ui (cancel)', 30000);
    await bubble.getByRole('button', { name: '取り消す' }).click();
    await until(async () => (await page.locator('#thread .vc-live').count()) === 0, 'bubble gone', 4000);
    await sleep(2500);
    check((await page.locator('#thread .m.user').count()) === 0, '［取り消す］: 送らない（会話に 1 通も出ず、吹き出しも消える）');
    check(['listening', 'hearing'].includes(await msOf(page, '#composer')), '取り消したあとは聞き取りに戻る（考え中にならない）');
    await context.close();
    await sleep(500);
  }

  // ===== 作業中に 3 回話す（間は 2.6 秒）: 差し込み待ち → AI に渡しました / 送信待ち ＋ 取り消す =====
  browserThree = await launch(wavThree);
  const threeTexts = ['鍵の更新を調べて', QUESTION, 'それと lint も', 'あ、ブランチは main から切って', 'それも', 'それも頼む'];
  for (const scenario of ['steer', 'queued']) {
    // 2 回目・3 回目は作業中に届く。steer: 途中送信を受ける台本（bg）→ 差し込み待ち（1.5 秒）→ 渡しました。queued: 受けない台本（長いツール）→ 送信待ち
    fs.writeFileSync(replyFile, JSON.stringify(scenario === 'steer'
      ? { when: QUESTION, script: 'bg 1 16' }
      : { when: QUESTION, steps: [{ tool: 'Grep', input: { pattern: 'x' }, result: 'x', ms: 14000 }, { text: '調べ終わりました。' }] }));
    sttTexts.length = 0;
    sttTexts.push('鍵の更新を', QUESTION, 'それと lint も', 'それと lint も', 'ブランチは main から', 'ブランチは main から切って');
    // 効果音: steer の場面はオフ（鳴らない）、queued の場面は「すべて」（待ちの音が鳴る）
    await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { sounds: scenario === 'queued' ? 'all' : 'off' } } });
    const { page, context } = await newPage(scenario === 'steer' ? { on: browserThree, width: 360, height: 760, scheme: 'dark', beeps: true } : { on: browserThree, beeps: true });
    await page.evaluate(() => document.getElementById('newSession').click());
    await page.waitForFunction(() => document.querySelectorAll('#thread .m.user').length === 0);
    await page.locator('header.top .vc-call').click();
    const rows = page.locator('#thread .mw:not(.vc-live) .m.user');
    const label = (i) => rows.nth(i).locator('.outbox-status').innerText().catch(() => '');
    if (scenario === 'steer') {
      await until(async () => (await rows.count()) === 3, 'three rows (steer)', 60000);
      check((await rows.nth(0).innerText()).includes(QUESTION) && (await rows.nth(1).innerText()).includes('lint') && (await rows.nth(2).innerText()).includes('main'), '3 回話した言葉は、話した順に 3 通、会話の行に出る（入力欄に残らない・混ざらない）');
      check((await page.evaluate(() => document.getElementById('prompt').value)) === '', '入力欄は空のまま（声の送信は入力欄を通らない）');
      const seen = new Set();
      await until(async () => { for (let i = 0; i < 3; i++) { const l = await label(i); if (/差し込み待ち/.test(l)) seen.add(`p${i}`); } return seen.size >= 1; }, 'pending label', 30000);
      check([...seen].length >= 1, '作業中に重ねて送ったものは「差し込み待ち · 次の区切りで渡します」（回る弧）');
      await shot(page, 'chat-delivery-pending-360-dark');
      await until(async () => { for (let i = 0; i < 3; i++) if (!/AI に渡しました/.test(await label(i))) return false; return true; }, 'all delivered', 40000);
      check(true, '渡った瞬間に、3 通とも「AI に渡しました」へ（✓）。ずっと「次の区切り」のまま残らない');
      await shot(page, 'chat-delivery-sent-360-dark');
      check((await page.evaluate(() => window.__beeps ?? [])).length === 0, '効果音がオフ（既定）なら、通話の開始も送信も何も鳴らさない');
    } else {
      await until(async () => (await rows.count()) === 3, 'three rows (queued)', 60000);
      await until(async () => (await rows.nth(2).locator('.vc-dl-queued').count()) === 1, 'queued label', 30000);
      const beeps = await page.evaluate(() => window.__beeps ?? []);
      check(beeps.filter((v) => v === 400).length >= 2 && beeps.includes(520) && beeps.includes(660), '効果音「すべて」: 送信待ちに入ったら「待ち」（同じ 400Hz を 2 回）、送ったら「送った」（520Hz）、通話の開始（660→880Hz）が鳴る', beeps);
      check(/送信待ち · この作業が終わると送ります/.test(await label(1)) && /送信待ち · この作業が終わると送ります/.test(await label(2)), '作業中に渡せないものは「送信待ち · この作業が終わると送ります」（時計）。会話の中の同じ場所に置く');
      check(await rows.nth(1).getByRole('button', { name: '取り消す' }).isVisible() && await rows.nth(2).getByRole('button', { name: '取り消す' }).isVisible(), '送信待ちの行に［取り消す］');
      check(await page.locator('#thread .mw.vc-queued').count() === 2 && /AI に渡しました/.test(await label(0)), '送信待ちは面を一段薄くし、先に渡ったものは「AI に渡しました」');
      check((await page.locator('#outbox .outbox-message').count()) === 0, '入力欄の脇の送信待ちの一覧には二重に出ない');
      await shot(page, 'chat-delivery-queued-1280-light');
      await rows.nth(2).getByRole('button', { name: '取り消す' }).click();
      await until(async () => (await rows.count()) === 2, 'cancelled row gone', 8000);
      check(true, '［取り消す］で、その 1 通だけが会話から消える');
      await until(async () => /AI に渡しました/.test(await label(1)), 'queued then delivered', 45000);
      check(true, '作業が終わると、送信待ちだった 1 通が自動で送られ「AI に渡しました」になる');
    }
    await context.close();
    await sleep(500);
  }
  await admin.cmd('invoke', { op: 'settings.set', args: { key: 'voice', value: { sounds: 'off' } } });
  void threeTexts;
  await browserThree.close().catch(() => {});
  // 以降の場面は最初の台本に戻す
  fs.writeFileSync(replyFile, JSON.stringify({ when: QUESTION, steps: [{ text: REPLY }] }));
  sttTexts.length = 0; sttTexts.push(...script); sttLast = QUESTION;

  // ===== 権限なし =====
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await context.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    });
    const page = await context.newPage();
    await page.goto(URL_);
    await page.getByRole('button', { name: 'あとで', exact: true }).click({ timeout: 5000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.vc-call'));
    await page.locator('header.top .vc-call').click();
    await until(async () => await page.locator('#composer .vc-note.show').count(), 'deny note');
    check((await page.locator('#composer .vc-note').innerText()).includes('マイクが許可されていません') && await page.locator('#composer .vc-note button').isVisible(), '権限なし: 入力欄の下に 1 行「マイクが許可されていません · 設定を開く」');
    check((await msOf(page, '#composer')) === 'denied' && await page.locator('#composer .vc-micwrap .vc-mbang').isVisible(), '権限なし: 斜線のマイクに「!」');
    check(!(await page.locator('#composer .vc-spk').isVisible()), '権限なし: スピーカーは出ない');
    check(!(await page.locator('header.top .vc-call').evaluate((n) => n.classList.contains('on'))), '権限なし: 通話は始まらない');
    await shot(page, 'chat-denied-1280-light');
    await page.locator('#composer .vc-note button').click();
    await page.locator('#voicePanel').waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    check(await page.locator('#voicePanel').isVisible(), '「設定を開く」で設定 › 通話が開く');
    await page.waitForSelector('#voicePanel .nf-card', { timeout: 8000 }).catch(async (e) => { console.error(await page.locator('#voicePanel').innerHTML()); throw e; });
    check((await page.locator('#voicePanel').innerText()).includes('OpenRouter のキー') && (await page.locator('#voicePanel').innerText()).includes('登録済み'), '設定 › 通話: キーは登録済みと出る（キーそのものは出ない）');
    check(!(await page.locator('#voicePanel').innerHTML()).includes(KEY), '設定 › 通話の DOM にキーが無い');
    await shot(page, 'settings-voice-1280-light');
    const settingsText = await page.locator('#voicePanel').innerText();
    check(['話の区切り', '短め', '標準', '長め', '割り込み', '話して読み上げを止める', '効果音', '少なめ'].every((w) => settingsText.includes(w)), '設定 › 通話に、話の区切り・割り込み・効果音が足されている');
    check((await page.locator('#voicePanel .vc-seg[aria-label="区切りの長さ"] button[aria-checked=true]').innerText()) === '標準' && (await page.locator('#voicePanel .vc-seg[aria-label="効果音"] button[aria-checked=true]').innerText()) === 'オフ', '既定は区切り 標準・効果音 オフ（承認済み）');
    check(await page.locator('#voicePanel input[type=checkbox]').first().isDisabled(), 'エコー除去がオフの間は「話して読み上げを止める」を選べない（効かないので）');
    await page.locator('#voicePanel .vc-seg[aria-label="区切りの長さ"] button', { hasText: '長め' }).click();
    await until(async () => (await page.locator('#voicePanel .vc-seg[aria-label="区切りの長さ"] button[aria-checked=true]').innerText()) === '長め' && /約 2\.0 秒/.test(await page.locator('#voicePanel .vc-est').innerText()), 'turn hold saved');
    check(true, '区切りを「長め」にすると、その場で保存され、待つ長さの説明が替わる');
    await page.locator('#voicePanel .vc-seg[aria-label="区切りの長さ"] button', { hasText: '標準' }).click();
    await until(async () => (await page.locator('#voicePanel .vc-seg[aria-label="区切りの長さ"] button[aria-checked=true]').innerText()) === '標準', 'turn hold back');
    await page.setViewportSize({ width: 360, height: 900 });
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), '設定 › 通話は 360 幅で横にはみ出さない');
    await shot(page, 'settings-voice-360-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'settings-voice-360-dark');
    await context.close();
  }

  // ===== チャンネルのスレッド =====
  {
    await sleep(1500);   // 前の場面の聞き取りの返事が出尽くしてから、この場面の字を並べる
    sttTexts.length = 0; sttTexts.push(...script); sttLast = QUESTION;
    const owl = (await admin.cmd('invoke', { op: 'bots.create', args: { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' } }));
    const ch = await admin.cmd('invoke', { op: 'channels.create', args: { name: 'release-ci', purpose: 'リリースの CI を見張る', members: [owl.id] } });
    const root = await admin.cmd('invoke', { op: 'channels.post', args: { channelId: ch.id, text: '@Owl echo:了解です' } });
    for (let i = 0; i < 100; i++) {
      const posts = (await admin.cmd('invoke', { op: 'channels.read', args: { channelId: ch.id, threadId: root.id } })).posts ?? [];
      if (posts.some((p) => p.turn && p.state === 'done')) break;
      await sleep(150);
    }
    const { page, context } = await newPage({ width: 1280, height: 820, scheme: 'dark' });
    await page.locator('#sideOrder [data-order="channel"]').click();
    await page.evaluate(([id, threadId]) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id, threadId } })), [ch.id, root.id]);
    await page.waitForSelector('#chThread .th-top .vc-call', { timeout: 15000 });
    const call = page.locator('#chThread .th-top .vc-call');
    check(await call.isVisible(), 'スレッドの頭にも通話ボタン（目次の前）');
    await call.click();
    await until(async () => (await msOf(page, '#thComposer')) === 'listening', 'thread listening');
    check(await page.locator('#chThread[data-vc-call]').count() === 1, 'スレッドの面に背景の印');
    await shot(page, 'thread-listening-1280-dark');
    await until(async () => (await page.locator('#chThread .vc-live .lw').count()) > 0, 'thread live words', 20000);
    await sleep(350);
    const tgeo = await page.locator('#chThread .vc-live').evaluate((n) => { const b = n.querySelector('.post-body'), h = n.querySelector('.post-head'), a = n.querySelector('.post-av'); const br = b.getBoundingClientRect(); return { left: br.left, width: br.width, headH: h.getBoundingClientRect().height, avLeft: a.getBoundingClientRect().left, otherBody: document.querySelector('#chThread .th-replies .post .post-body')?.getBoundingClientRect().left }; });
    check(tgeo.headH < 30 && tgeo.width >= 90 && Math.abs(tgeo.avLeft - (await page.locator('#chThread .th-replies .post .post-av').first().evaluate((n) => n.getBoundingClientRect().left))) <= 2, 'スレッドの声の吹き出しも潰れず、ほかの投稿と同じ列', tgeo);
    const tblur = await page.locator('#chThread .vc-live .lw').evaluateAll((words) => words.filter((w) => !w.classList.contains('out') && w.getAnimations().length === 0).map((w) => getComputedStyle(w).filter));
    check(tblur.every((f) => f === 'none'), 'スレッド: 溶け込みの終わった字はくっきり');
    await shot(page, 'thread-hearing-1280-dark');
    await until(async () => (await page.locator('#chThread .vc-live .vc-hold').count()) === 1 && /あと [0-9.]+ 秒で送ります/.test(await page.locator('#chThread .vc-live .vc-ht').innerText().catch(() => '')), 'thread hold ui', 20000);
    check(await page.locator('#chThread .vc-live').getByRole('button', { name: 'いま送る' }).isVisible() && await page.locator('#chThread .vc-live').getByRole('button', { name: '取り消す' }).isVisible(), 'スレッドでもまとめ待ちの吹き出しの下に［いま送る］［取り消す］');
    await shot(page, 'thread-hold-1280-dark');
    await until(async () => (await page.locator('#chThread .th-replies .post').filter({ hasText: QUESTION }).count()) >= 1, 'thread real post', 30000);
    check((await page.locator('#chThread .vc-live').count()) === 0, 'スレッド: 本物の投稿が現れたら吹き出しは消える');
    check((await page.locator('#chThread .th-replies .post .vmark').count()) >= 1, 'スレッド: 投稿にマイクの印');
    await until(async () => (await msOf(page, '#thComposer')) === 'speaking', 'thread speaking', 40000);
    await until(async () => (await page.locator('#chThread .vc-underlay .vc-ul').count()) > 0, 'thread underline', 20000);
    await sleep(900);
    await shot(page, 'thread-speaking-1280-dark');
    await call.click();
    await context.close();
  }

  // ===== 360・動きを減らす =====
  {
    const { page, context } = await newPage({ width: 360, height: 760, reduced: true });
    await page.evaluate(() => document.querySelector('.vc-call')?.click());
    await until(async () => (await msOf(page, '#composer')) === 'listening', 'narrow listening');
    check(await page.locator('#composer .vc-micwrap').isVisible() && await page.locator('#composer .vc-spk').isVisible(), '360 幅でも入力欄にマイクとスピーカー');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(!overflow, '360 幅で横にはみ出さない');
    await shot(page, 'chat-listening-360-light-reduced');
    await until(async () => (await msOf(page, '#composer')) === 'speaking', 'narrow speaking', 60000);
    await sleep(600);
    await shot(page, 'chat-speaking-360-light-reduced');
    check((await page.locator('.vc-underlay .vc-ul').count()) >= 0, '動きを減らす設定でも通話は動く（線は伸びず静止して出る）');
    await context.close();
  }
  // ===== 360・ダーク（動きあり）と 1280 ダークの Chats =====
  {
    const { page, context } = await newPage({ width: 360, height: 760, scheme: 'dark' });
    await page.evaluate(() => document.querySelector('.vc-call')?.click());
    await until(async () => (await msOf(page, '#composer')) === 'hearing', 'dark hearing', 30000);
    await until(async () => (await page.locator('#thread .vc-live .lw').count()) > 0, 'dark live words', 20000);
    await shot(page, 'chat-hearing-360-dark');
    await until(async () => (await page.locator('#thread .vc-live .vc-hold').count()) === 1 && /あと [0-9.]+ 秒で送ります/.test(await page.locator('#thread .vc-live .vc-ht').innerText().catch(() => '')), 'dark hold ui', 20000);
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)) && (await page.getByRole('button', { name: 'いま送る' }).boundingBox()).height >= 20, '360・ダークのまとめ待ちも、はみ出さず［いま送る］が押せる');
    await shot(page, 'chat-hold-360-dark');
    await until(async () => (await msOf(page, '#composer')) === 'speaking', 'dark speaking', 60000);
    await until(async () => (await page.locator('.vc-underlay .vc-ul').count()) > 0, 'dark underline', 20000);
    await sleep(900);
    await shot(page, 'chat-speaking-360-dark');
    check(!(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), '360・ダークでも横にはみ出さない');
    await context.close();
    const wide = await newPage({ width: 1280, height: 820, scheme: 'dark' });
    await wide.page.locator('header.top .vc-call').click();
    await until(async () => (await msOf(wide.page, '#composer')) === 'hearing', 'wide dark hearing', 30000);
    await shot(wide.page, 'chat-hearing-1280-dark');
    await until(async () => (await wide.page.locator('#thread .vc-live .vc-hold').count()) === 1 && /あと [0-9.]+ 秒で送ります/.test(await wide.page.locator('#thread .vc-live .vc-ht').innerText().catch(() => '')), 'wide dark hold', 20000);
    await shot(wide.page, 'chat-hold-1280-dark');
    await until(async () => (await msOf(wide.page, '#composer')) === 'speaking', 'wide dark speaking', 60000);
    await sleep(1200);
    await shot(wide.page, 'chat-speaking-1280-dark');
    await wide.context.close();
  }
  console.log(`通過 ${results.length} 件`);
  for (const r of results) console.log('  OK ', r);
} catch (e) {
  console.error('失敗:', e.message);
  if (lastPage && process.env.VOICE_DEBUG_DOM) console.error(await lastPage.evaluate(() => [...document.querySelector('#thread')?.children ?? []].map((n) => `${n.tagName}.${n.className}`).join('\n')).catch(() => ''));
  console.error(server.tail(40));
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await browserThree?.close().catch(() => {});
  admin.close();
  await server.stop();
  await api.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
