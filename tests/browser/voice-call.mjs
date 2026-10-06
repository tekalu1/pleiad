// 通話モードの打鍵（実ブラウザー。承認済み 2026-10-06、docs/voice-call.md「確かめ方」）:
//   頭の通話ボタン → 準備中 → 聞いています → 声（偽のマイク）→ 片が吹き出しに足される → 確定して送る → 返事 → 読んでいる場所の下線が伸びる → 止める・ミュート → 終える。
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

/** 声のような音: 4Hz で揺れる倍音。雑音抑制に消されないよう揺らす。無音 0.3 秒 → 声 1.4 秒 → 息継ぎ 0.25 秒 → 声 1.4 秒 → 無音 */
function writeSpeechWav(file) {
  const rate = 16000, secs = 24, n = rate * secs, data = Buffer.alloc(n * 2);
  const burst = (t) => (t >= 0.3 && t < 1.7) || (t >= 1.95 && t < 3.35);
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
const replyFile = path.join(scratch, 'reply.json');
fs.writeFileSync(replyFile, JSON.stringify({ when: QUESTION, steps: [{ text: REPLY }] }));

// 聞き取り: 1 つ目の片・2 つ目の片（前の片と重なる）・全体。少し遅らせて、実際の往復のように
const script = ['署名の鍵はどこで', 'どこで更新する', QUESTION];
const api = await startFakeOpenRouter({ transcripts: (_rec, i) => script[Math.min(i, 2)], sttDelay: () => 220, ttsMsPerChar: 110, ttsFirstByteDelayMs: 150 });
const server = await startServer({
  env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_VOICE_API: api.url, AGENT_HOST_FAKE_VOICE_REPLY: replyFile, AGENT_HOST_LOCALE: 'ja' },
  dataDir: path.join(scratch, 'data'), timeoutMs: 60_000,
});
const URL_ = `http://127.0.0.1:${server.port}/?token=${server.token}`;
const admin = await open({ port: server.port, token: server.token });
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'],
});

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

async function newPage({ width = 1280, height = 820, scheme = 'light', reduced = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: reduced ? 'reduce' : 'no-preference', permissions: ['microphone'] });
  const page = await context.newPage();
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

    // 確定して送る → 本物の発言の行
    await until(async () => (await page.locator('#thread .m.user .body').filter({ hasText: QUESTION }).count()) === 1, 'real user row', 30000);
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
    await context.close();
  }

  // ===== チャンネルのスレッド =====
  {
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
  admin.close();
  await server.stop();
  await api.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
