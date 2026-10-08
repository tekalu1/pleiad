import { N } from '../lib/dom-stub.mjs';
import { createChromeControlView, createChromeControlStore, statusText, actionsFor, durationText, renderChromeHandoverLine, setChromeHandoverAgentName, CONTROL_STATES } from '../../web/chrome-control.mjs';
import { renderPresent } from '../../web/render.mjs';
import * as history from '../../core/history.mjs';

export const name = 'chrome-control-ui';
export const title = 'エージェントの Chrome の窓の状態の一行（web/chrome-control.mjs）: 状態ごとの字とボタン・押した位置の輪・一時停止中の帯と膜・状態の置き場・会話の引き継ぎの行・記録（DOM の代役。ADR 0148・0154）';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const shownButtons = root => root.querySelectorAll('button').filter(b => !b.hidden).map(b => b.textContent);

export default async function (t) {
  // ---- 字とボタンの表
  t.ok('状態は 4 つ', CONTROL_STATES.join() === 'running,idle,stopped,paused');
  t.ok('状態の一行の語（ADR 0148）', statusText('running', 'Claude') === 'Claude が操作中' && statusText('idle') === '待機中' && statusText('paused') === 'あなたが操作中' && statusText('stopped') === '止めました' && statusText('none') === null);
  t.ok('ボタン: 操作中は止める・引き継ぐ / 待機中・止めた後は引き継ぐだけ（「Chrome で開く」は引き継ぐに一本化） / 一時停止中は戻すだけ',
    actionsFor('running').join() === 'stop,takeOver' && actionsFor('idle').join() === 'takeOver' && actionsFor('stopped').join() === 'takeOver' && actionsFor('paused').join() === 'resume' && actionsFor(null).length === 0);
  t.ok('経過時間: 1 分 12 秒・45 秒（負・不正は 0 秒）', durationText(72) === '1 分 12 秒' && durationText(45) === '45 秒' && durationText(60) === '1 分 0 秒' && durationText(-3) === '0 秒' && durationText('x') === '0 秒');

  // ---- 部品
  const calls = [];
  let reply = async () => ({});
  const errors = [];
  const view = createChromeControlView({ run: async action => { calls.push(action); return reply(action); }, getName: () => 'Claude', onError: (error, action) => errors.push(`${action}:${error.message}`) });
  t.ok('状態が無いうちは隠れている', view.root.hidden === true && view.banner.hidden === true && view.state() === null);
  t.ok('状態の一行は role=status', view.root.querySelector('.cc-status').getAttribute('role') === 'status');
  view.apply({ state: 'running', since: null });
  t.ok('running: 「Claude が操作中」と止める・引き継ぐ', view.root.hidden === false && view.root.querySelector('.cc-text').textContent === 'Claude が操作中' && shownButtons(view.root).join() === '止める,引き継ぐ', shownButtons(view.root).join());
  t.ok('操作中の印は data-state（色は CSS のトークン）', view.root.dataset.state === 'running' && view.overlay.dataset.state === 'running');
  t.ok('帯・膜は一時停止中だけ', view.banner.hidden === true && view.overlay.querySelector('.cc-veil').hidden === true);
  view.apply({ state: 'idle' });
  t.ok('idle: 「待機中」と引き継ぐ', view.root.querySelector('.cc-text').textContent === '待機中' && shownButtons(view.root).join() === '引き継ぐ');
  view.apply({ state: 'stopped' });
  t.ok('stopped: 「止めました」と引き継ぐ', view.root.querySelector('.cc-text').textContent === '止めました' && shownButtons(view.root).join() === '引き継ぐ');

  view.apply({ state: 'running' });
  view.root.querySelectorAll('button').find(b => b.textContent === '止める').onclick();
  await sleep(5);
  view.root.querySelectorAll('button').find(b => b.textContent === '引き継ぐ').onclick();
  await sleep(5);
  t.ok('ボタンは stop・takeOver を呼ぶ', calls.join() === 'stop,takeOver', calls.join());

  view.apply({ state: 'paused', since: 1 });
  t.ok('paused: 「あなたが操作中」と「Claude に戻す」だけ', view.root.querySelector('.cc-text').textContent === 'あなたが操作中' && shownButtons(view.root).join() === 'Claude に戻す' && view.root.dataset.state === 'paused');
  t.ok('一時停止中の帯（会話の中。role=status）に文と戻すボタン', view.banner.hidden === false && view.banner.getAttribute('role') === 'status' && view.banner.textContent.includes('一時停止中 · あなたが Chrome で操作しています') && view.banner.querySelector('button').textContent === 'Claude に戻す');
  const veil = view.overlay.querySelector('.cc-veil');
  t.ok('映像の上の薄い幕（読み上げない層の中）', veil.hidden === false && veil.textContent === '一時停止中' && view.overlay.getAttribute('aria-hidden') === 'true');
  view.banner.querySelector('button').onclick();
  await sleep(5);
  t.ok('帯の「Claude に戻す」は resume を呼ぶ', calls.at(-1) === 'resume');

  // 押している間は二重に押せない・失敗は onError
  let release;
  reply = () => new Promise(resolve => { release = resolve; });
  const before = calls.length;
  const resume = view.root.querySelectorAll('button').find(b => b.textContent === 'Claude に戻す');
  resume.onclick(); resume.onclick();
  await sleep(5);
  t.ok('実行中は二重に呼ばない・ボタンを無効にする', calls.length === before + 1 && resume.disabled === true && view.banner.querySelector('button').disabled === true);
  release({}); await sleep(5);
  t.ok('終われば押せる', resume.disabled === false);
  reply = async () => { throw new Error('boom'); };
  resume.onclick(); await sleep(5);
  t.ok('失敗は onError へ（投げない）', errors.join() === 'resume:boom' && resume.disabled === false, errors.join());

  view.apply({ state: 'bogus' });
  t.ok('知らない状態は隠す', view.root.hidden === true && view.banner.hidden === true);

  // 名前が替わったら描き直す
  let name = 'Codex';
  const named = createChromeControlView({ run: async () => {}, getName: () => name });
  named.apply({ state: 'running' });
  t.ok('エージェントの名前が入る', named.root.querySelector('.cc-text').textContent === 'Codex が操作中');
  name = 'Claude'; named.refresh();
  t.ok('refresh で名前を取り直す', named.root.querySelector('.cc-text').textContent === 'Claude が操作中');

  // ---- 押した位置の輪
  view.ring(250, 100, { width: 1000, height: 400 });
  const rings = () => view.overlay.querySelectorAll('.cc-ring');
  t.ok('輪はページの座標を割合で置く（25% / 25%）', rings().length === 1 && rings()[0].style.left === '25%' && rings()[0].style.top === '25%', JSON.stringify(rings().map(r => r.style)));
  view.ring(2000, -5, { width: 1000, height: 400 });
  t.ok('はみ出す座標は縁に収める', rings()[1].style.left === '100%' && rings()[1].style.top === '0%');
  const n = rings().length;
  view.ring(10, 10); view.ring(10, 10, { width: 0, height: 5 }); view.ring(NaN, 1, { width: 5, height: 5 });
  t.ok('映像の大きさが分からない・座標が数でないときは出さない（位置を偽らない）', rings().length === n);
  await sleep(760);
  t.ok('輪は一定時間で消える', rings().length === 0);

  // ---- 状態の置き場
  const store = createChromeControlStore();
  const seen = [], taps = [];
  store.onChange((sessionId, state, since) => seen.push(`${sessionId}:${state}:${since ?? ''}`));
  store.onTap(tap => taps.push(tap));
  t.ok('知らない会話は idle', store.get('a').state === 'idle');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'running', since: null });
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'running', since: null });
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'paused', since: 5 });
  t.ok('会話ごとに持ち、変わったときだけ聞き手へ', store.get('a').state === 'paused' && store.get('a').since === 5 && seen.join() === 'a:running:,a:paused:5', seen.join());
  store.event({ type: 'chromeControl', sessionId: 'b', state: 'stopped' });
  t.ok('別の会話の状態とは混ざらない', store.get('b').state === 'stopped' && store.get('a').state === 'paused');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'idle' });
  t.ok('idle は持たずに idle へ戻す', store.get('a').state === 'idle' && seen.at(-1) === 'a:idle:');
  store.event({ type: 'chromeControl', sessionId: 'a', state: 'weird' });
  store.event({ type: 'chromeControl', state: 'running' });
  t.ok('知らない状態・会話の id が無い便りは捨てる', store.get('a').state === 'idle' && seen.length === 4);
  store.event({ type: 'chromeTap', sessionId: 'b', x: 3, y: 4, windowId: 7 });
  store.event({ type: 'chromeTap', x: 3, y: 4 });
  t.ok('押した位置は会話の id つきで聞き手へ', taps.length === 1 && taps[0].sessionId === 'b' && taps[0].x === 3 && taps[0].windowId === 7);
  const off = store.onChange(() => { throw new Error('listener'); });
  store.event({ type: 'chromeControl', sessionId: 'c', state: 'running' });
  off();
  t.ok('聞き手が投げても置き場は壊れない', store.get('c').state === 'running');

  // ---- 会話の引き継ぎの行（present kind: chromeHandover）
  setChromeHandoverAgentName(() => 'Claude');
  const line = renderChromeHandoverLine({ kind: 'chromeHandover', chromeHandover: { seconds: 72 } });
  t.ok('「あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒」', line.textContent === 'あなたが引き継ぎ · Claude に戻しました · 1 分 12 秒', line.textContent);
  t.ok('印は読み上げない', line.querySelector('.cc-line-ic').getAttribute('aria-hidden') === 'true');
  t.ok('秒が無ければ 0 秒', renderChromeHandoverLine({ kind: 'chromeHandover' }).textContent.endsWith('0 秒'));
  t.ok('renderPresent が行へ回す（カードにしない）', renderPresent({ kind: 'chromeHandover', chromeHandover: { seconds: 5 } }).className === 'cc-line');
  setChromeHandoverAgentName(() => 'Codex');
  t.ok('名前は今の会話のエージェント', renderChromeHandoverLine({ chromeHandover: { seconds: 1 } }).textContent.includes('Codex に戻しました'));

  // ---- 記録（core/history.mjs recordPresent）
  const id = `chrome-control-ui-${Date.now()}`;
  const saved = await history.recordPresent(id, { kind: 'chromeHandover', chromeHandover: { seconds: 71.6 } });
  t.ok('引き継ぎの行は kind と秒（四捨五入）を残す。人の添付ではない（by: ai）', saved.kind === 'chromeHandover' && saved.chromeHandover.seconds === 72 && saved.by === 'ai' && saved.caption === null, JSON.stringify(saved));
  const odd = await history.recordPresent(id, { kind: 'chromeHandover', chromeHandover: { seconds: 'x' } });
  t.ok('秒が数でなければ 0', odd.chromeHandover.seconds === 0);
  const rows = (await history.readPresents(id)).filter(p => p.kind === 'chromeHandover');
  t.ok('読み戻せる', rows.length === 2 && rows[0].chromeHandover.seconds === 72);
  const other = await history.recordPresent(id, { kind: 'text', content: 'x', chromeHandover: { seconds: 9 } });
  t.ok('ほかの kind には載せない', !('chromeHandover' in other));
}
