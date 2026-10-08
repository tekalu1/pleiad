// wait_until（ADR 0165、docs/computer-use.md「wait_until の待ち方」）。
// 待ち方（settle）は仮想の時計で、決定モデルへの問い（askDecider）は偽の OpenRouter（tests/lib/fake-openrouter.mjs）で、
// 橋越しの動き（キーが無い・前面が禁止のアプリ・聞けなかった・キーが出ない）は偽の driver で確かめる。本物の OpenRouter・画面には触れない。
import { createHarness, sleep } from '../lib/computer-harness.mjs';
import { startFakeOpenRouter } from '../lib/fake-openrouter.mjs';
import { FAKE_APPS } from '../../core/computer-use/driver.mjs';
import { computerDisplay } from '../../core/computer-use/display.mjs';
import { settle, changedRatio, SETTLE } from '../../core/computer-use/settle.mjs';
import { askDecider, decisionBody, parseDecision, DECIDER_MODEL, DECIDER_SHOT } from '../../core/computer-use/decider.mjs';
import { untilSeconds, UNTIL_MAX_SECONDS, UNTIL_GRACE_MS, BATCHABLE, LOCKING } from '../../core/computer-use/tools.mjs';

export const name = 'computer-wait-until';
export const title = 'wait_until: 画面の差分で静止を待つ・決定モデルに聞く・キーが無い／前面が禁止のアプリ／聞けなかったとき';

const KEY = 'sk-or-v1-wait-until-secret-0123456789abcdef';
const W = 320, H = 180;

/** 仮想の時計。眠ると進む。撮る（grab）は時刻から作るコマを返す */
function virtual(fill) {
  let now = 0;
  const frame = v => ({ gray: new Uint8Array(W * H).fill(v), width: W, height: H });
  return {
    now: () => now,
    sleep: async ms => { now += ms; },
    grab: async () => frame(fill(now)),
  };
}

export default async function (t) {
  // ---- 差分の判定 ----
  const base = { gray: new Uint8Array(W * H).fill(100), width: W, height: H };
  const withChanged = (count, delta) => { const g = base.gray.slice(); for (let i = 0; i < count; i++) g[i] = 100 + delta; return { gray: g, width: W, height: H }; };
  t.ok('閾値: 画素の差は 6 を超えたら変わった（6 は変わっていない）', changedRatio(base, withChanged(W * H, 6)) === 0 && changedRatio(base, withChanged(W * H, 7)) === 1);
  t.ok('閾値: 変わった画素が 2.0% 以上でそのコマは変わった', changedRatio(base, withChanged(1100, 50)) < SETTLE.changedRatio && changedRatio(base, withChanged(1152, 50)) >= SETTLE.changedRatio);
  t.ok('大きさの違うコマは全部変わったことにする', changedRatio(base, { gray: new Uint8Array(10), width: 5, height: 2 }) === 1);
  t.ok('既定の値: 差 6・面積 2.0%・静止 400ms・間隔 100ms・最初の変化を 1 秒待つ・長辺 320',
    SETTLE.pixelDelta === 6 && SETTLE.changedRatio === 0.02 && SETTLE.stillMs === 400 && SETTLE.intervalMs === 100 && SETTLE.firstChangeMs === 1000 && SETTLE.frameEdge === 320);

  // ---- 待ち方（仮想の時計） ----
  {
    // 300ms まで静止 → 700ms まで 100ms ごとに変化 → 以後静止
    const v = virtual(ms => ms < 300 ? 10 : ms < 700 ? (Math.floor(ms / 100) % 2 ? 200 : 10) : 50);
    const r = await settle({ grab: v.grab, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('変化してから静止: 最後の変化から 400ms で返す（success・stable・sawChange）', r.status === 'success' && r.screen === 'stable' && r.answer === 'none' && r.sawChange && r.waitedMs === 1100 && r.asks === 0, JSON.stringify(r));
  }
  {
    const v = virtual(() => 80);
    const r = await settle({ grab: v.grab, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('最初から静止: 1 秒変化が無ければ静止として返す（sawChange: false）', r.status === 'success' && r.screen === 'stable' && !r.sawChange && r.waitedMs === 1000, JSON.stringify(r));
  }
  {
    // 最初の 1 秒の間に 1 回だけ変わる
    const v = virtual(ms => ms < 500 ? 80 : 160);
    const r = await settle({ grab: v.grab, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('最初の 1 秒の中で変われば、その変化から 400ms 待つ', r.status === 'success' && r.sawChange && r.waitedMs === 900, JSON.stringify(r));
  }
  {
    const v = virtual(ms => (Math.floor(ms / 100) % 2 ? 0 : 255));
    const r = await settle({ grab: v.grab, timeoutMs: 3000, now: v.now, sleep: v.sleep });
    t.ok('止まらない画面は timeout・changing で返す（待った時間は timeout）', r.status === 'timeout' && r.screen === 'changing' && r.answer === 'none' && r.waitedMs === 3000 && r.asks === 0 && r.p === null && !('reason' in r), JSON.stringify(r));
  }
  {
    const v = virtual(() => 80);
    const r = await settle({ grab: v.grab, ask: async () => ({ ok: true, p: 0.91 }), timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('問いあり・はい: 静止したら 1 回聞いて返す（success・stable・yes）', r.status === 'success' && r.screen === 'stable' && r.answer === 'yes' && r.asks === 1 && r.p === 0.91 && r.waitedMs === 1000, JSON.stringify(r));
  }
  {
    // 止まらない画面: 呼んでから 2 秒ごとに聞き、3 回目で はい
    const v = virtual(ms => (Math.floor(ms / 100) % 2 ? 0 : 255));
    const answers = [{ ok: true, p: 0.1 }, { ok: true, p: 0.2 }, { ok: true, p: 0.85 }];
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); return answers.shift(); }, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('動き続ける画面: 2 秒静止が来なければ 1 回聞き、はい なら返す（success・changing・yes）',
      SETTLE.askEveryMs === 2000 && r.status === 'success' && r.screen === 'changing' && r.answer === 'yes' && r.asks === 3 && r.p === 0.85
      && at.join() === '2000,4000,6000' && r.waitedMs === 6000, JSON.stringify({ r, at }));
  }
  {
    // 止まらない画面・いいえのまま → 締め切り
    const v = virtual(ms => (Math.floor(ms / 100) % 2 ? 0 : 255));
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); return { ok: true, p: 0.05 }; }, timeoutMs: 5000, now: v.now, sleep: v.sleep });
    t.ok('動き続ける画面・いいえのまま: timeout・changing・no（2 秒ごとに聞いた回数と最後の確率）',
      r.status === 'timeout' && r.screen === 'changing' && r.answer === 'no' && r.asks === 2 && r.p === 0.05 && at.join() === '2000,4000' && r.waitedMs === 5000, JSON.stringify({ r, at }));
  }
  {
    // 動いている間に聞く（往復 700ms）→ いいえ → 3000ms に止まる → 静止で聞き直して はい。定期の起点は答えが返った時
    const v = virtual(ms => ms < 3000 ? (Math.floor(ms / 100) % 2 ? 0 : 255) : 50);
    const answers = [{ ok: true, p: 0.3 }, { ok: true, p: 0.9 }];
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); await v.sleep(700); return answers.shift(); }, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('動いている間の いいえ の後に止まれば、静止で聞き直す（success・stable）',
      r.status === 'success' && r.screen === 'stable' && r.asks === 2 && at[0] === 2000 && at[1] === 3400 && r.waitedMs === 4100, JSON.stringify({ r, at }));
  }
  {
    // 定期の問いの往復が締め切りをまたぐ: 答えを待ってから timeout（締め切りの超過は問いの往復の分だけ）
    const v = virtual(ms => (Math.floor(ms / 100) % 2 ? 0 : 255));
    const r = await settle({ grab: v.grab, ask: async () => { await v.sleep(1500); return { ok: true, p: 0.1 }; }, timeoutMs: 3000, now: v.now, sleep: v.sleep });
    t.ok('定期の問いが締め切りをまたぐ: 答えを待って timeout（超過は往復の分だけ）', r.status === 'timeout' && r.asks === 1 && r.waitedMs === 3500 && r.waitedMs - 3000 <= UNTIL_GRACE_MS, JSON.stringify(r));
  }
  {
    // 動いている間の skip（前面が禁止のアプリ）は聞かずに待ち続け、止まったときの skip で unverified
    const v = virtual(ms => ms < 4500 ? (Math.floor(ms / 100) % 2 ? 0 : 255) : 50);
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); return { skip: 'protected_app' }; }, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('動いている間の skip は聞かずに待ち続け、静止の skip で unverified・protected_app',
      r.status === 'unverified' && r.reason === 'protected_app' && r.screen === 'stable' && r.answer === 'none' && r.asks === 0 && at.join() === '2000,4000,4900' && r.waitedMs === 4900, JSON.stringify({ r, at }));
  }
  {
    // 静止 → いいえ → 1500〜1700ms に変化 → 静止 → はい
    const v = virtual(ms => ms >= 1500 && ms < 1800 ? (Math.floor(ms / 100) % 2 ? 200 : 10) : ms >= 1800 ? 120 : 80);
    const answers = [{ ok: true, p: 0.2 }, { ok: true, p: 0.8 }];
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); return answers.shift(); }, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('静止してから変化（いいえの後）: 今の静止をもう一度数えず、次の変化と静止を待って聞き直す',
      r.status === 'success' && r.screen === 'stable' && r.asks === 2 && r.p === 0.8 && at[0] === 1000 && at[1] === 2200 && r.waitedMs === 2200, JSON.stringify({ r, at }));
  }
  {
    // 静止 → 聞く（往復 700ms）の間の 1300ms に変わり、以後静止 → はい。聞く前のコマと比べるので、この変化を見落とさない
    const v = virtual(ms => ms >= 1300 ? 120 : 80);
    const answers = [{ ok: true, p: 0.2 }, { ok: true, p: 0.8 }];
    const at = [];
    const r = await settle({ grab: v.grab, ask: async () => { at.push(v.now()); await v.sleep(700); return answers.shift(); }, timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('聞いている間に変わって止まった画面: 聞く前のコマと比べて変化として数え、静止したら聞き直す',
      r.status === 'success' && r.asks === 2 && r.p === 0.8 && at[0] === 1000 && at[1] === 2200, JSON.stringify({ r, at }));
  }
  {
    // いいえが続き、変化も無い → timeout。止まった画面は聞き直さない。最後の確率を返す
    const v = virtual(() => 80);
    const r = await settle({ grab: v.grab, ask: async () => ({ ok: true, p: 0.12 }), timeoutMs: 4000, now: v.now, sleep: v.sleep });
    t.ok('いいえのまま締め切り（止まった画面）: timeout・stable・no・聞いた回数 1・最後の確率', r.status === 'timeout' && r.screen === 'stable' && r.answer === 'no' && r.asks === 1 && r.p === 0.12 && r.waitedMs === 4000, JSON.stringify(r));
  }
  {
    const v = virtual(() => 80);
    const r = await settle({ grab: v.grab, ask: async () => ({ ok: false, code: 'http_429' }), timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('聞けなかった: 黙って差分に落とさず error と reason を返す', r.status === 'error' && r.reason === 'http_429' && r.answer === 'none' && r.asks === 1, JSON.stringify(r));
  }
  {
    const v = virtual(() => 80);
    const r = await settle({ grab: v.grab, ask: async () => ({ skip: 'protected_app' }), timeoutMs: 15000, now: v.now, sleep: v.sleep });
    t.ok('聞かない（前面が禁止のアプリ）: 静止で unverified・protected_app、聞いた回数に数えない', r.status === 'unverified' && r.reason === 'protected_app' && r.screen === 'stable' && r.asks === 0, JSON.stringify(r));
  }
  {
    const v = virtual(ms => (Math.floor(ms / 100) % 2 ? 0 : 255));
    let thrown = null;
    try { await settle({ grab: v.grab, timeoutMs: 15000, now: v.now, sleep: v.sleep, check: () => { if (v.now() >= 500) throw new Error('stopped'); } }); } catch (e) { thrown = e; }
    t.ok('止めた印（check が投げる）で待ちの途中で打ち切る', thrown?.message === 'stopped');
  }

  // ---- 上限 ----
  t.ok('timeout: 省略は 15 秒、上限 30 秒、0 以下・数でないは invalid', untilSeconds(undefined) === 15 && untilSeconds(100) === UNTIL_MAX_SECONDS && untilSeconds(2.5) === 2.5 && untilSeconds(0) === null && untilSeconds('5') === null);
  t.ok('Antigravity（1 回 3 分）: ロックの待ち（最短 10 秒）＋最長の待ち＋最後の問いが、待ちの区切り 150 秒に収まる',
    Math.max(10_000, 150_000 - UNTIL_MAX_SECONDS * 1000 - UNTIL_GRACE_MS) + UNTIL_MAX_SECONDS * 1000 + UNTIL_GRACE_MS <= 150_000);
  t.ok('Claude・Codex（MCP の 660 秒）: ロックの待ち 600 秒＋最長の待ち＋最後の問いが収まる', 600_000 + UNTIL_MAX_SECONDS * 1000 + UNTIL_GRACE_MS < 660_000);
  t.ok('wait_until は computer_batch に入れられず、ロックを取る', !BATCHABLE.includes('wait_until') && LOCKING.has('wait_until'));

  // ---- 決定モデル（偽の OpenRouter） ----
  t.ok('送る本文: model・state（Screenshot と JPEG の data URL）・questions.done（noul・問い・Yes/No）', JSON.stringify(decisionBody('QUJD', 'Is it done?')) === JSON.stringify({
    model: 'perplexity/pplx-decider-v1.1-27b',
    state: [{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }],
    questions: { done: { type: 'noul', instructions: 'Is it done?', criteria: { true: 'Yes', false: 'No' } } },
  }));
  t.ok('応答の読み方: answers.done.noul（0〜1）だけを読み、形が違えば null', parseDecision({ answers: { done: { type: 'noul', noul: 0.83456 } } }) === 0.835
    && parseDecision({ answers: { done: { type: 'boolean', noul: 0.8 } } }) === null && parseDecision({ answers: { done: { type: 'noul', noul: 1.2 } } }) === null
    && parseDecision({ answers: {} }) === null && parseDecision(null) === null && parseDecision({ answers: { done: { type: 'noul', noul: '0.8' } } }) === null);
  t.ok('送る画面は長辺 1440', DECIDER_SHOT.maxEdge === 1440 && DECIDER_MODEL === 'perplexity/pplx-decider-v1.1-27b');

  const script = [];
  const fake = await startFakeOpenRouter({ decisions: (rec, i) => (script.length ? script.shift() : 0.9) });
  const env = { AGENT_HOST_OPENROUTER_API: fake.url };
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  try {
    const outs = [];
    const one = async (answer, extra = {}) => { if (answer !== undefined) script.push(answer); const r = await askDecider({ key: KEY, jpeg, until: 'Has it finished?', env, ...extra }); outs.push(r); return r; };
    const yes = await one(0.83);
    const rec = fake.records.decisions.at(-1);
    t.ok('はい: 確率を返す。POST /alpha/decisions に model・問い・JPEG・Bearer のキーで送る', yes.ok && yes.p === 0.83 && rec.model === DECIDER_MODEL && rec.until === 'Has it finished?'
      && rec.type === 'noul' && rec.text === 'Screenshot' && rec.imageType === 'image/jpeg' && rec.imageBytes === 4 && rec.auth === `Bearer ${KEY}`, JSON.stringify({ ...rec, auth: rec.auth === `Bearer ${KEY}` }));
    t.ok('いいえ: 低い確率をそのまま返す', (await one(0.04)).p === 0.04);
    t.ok('429・503・401・402 は http_<状態> で返す', (await one({ status: 429 })).code === 'http_429' && (await one({ status: 503 })).code === 'http_503'
      && (await one({ status: 401 })).code === 'http_401' && (await one({ status: 402 })).code === 'http_402');
    t.ok('形の違う応答は bad_response', (await one({ body: { answers: { done: { type: 'boolean', boolean: true } } } })).code === 'bad_response' && (await one({ body: { error: 'x' } })).code === 'bad_response');
    t.ok('時間内に返らなければ timeout', (await one({ delayMs: 600, p: 0.9 }, { timeoutMs: 150 })).code === 'timeout');
    t.ok('つながらなければ network', (await askDecider({ key: KEY, jpeg, until: 'x', env: { AGENT_HOST_OPENROUTER_API: 'http://127.0.0.1:9' } })).code === 'network');
    t.ok('返り値にキーは入らない', !JSON.stringify(outs).includes(KEY));
  } finally { await fake.close(); }

  // ---- 橋越し（偽の driver） ----
  const mark = r => computerDisplay(r.content[0].text)?.computer;
  const body = r => computerDisplay(r.content[0].text)?.text ?? '';
  // n 回目（100ms ごと）のコマ: 3 回目まで静止 → 6 回目まで変化 → 静止
  const settling = n => n < 3 ? 10 : n < 6 ? (n % 2 ? 200 : 10) : 50;

  // キーを選んでいない（既定）
  const h = await createHarness({ waitMs: 400 });
  try {
    const a = h.connect({ sessionId: 'u1' });
    const list = (await a.rpc('tools/list', {})).body.result.tools;
    const tool = list.find(x => x.name === 'wait_until');
    t.ok('tools/list: wait_until は until（上限 500 字）と timeout（上限 30）。説明は until が「はい = 終わった」の向きで英語が望ましいと書く',
      tool && tool.inputSchema.properties.until.maxLength === 500 && tool.inputSchema.properties.timeout.maximum === 30 && tool.inputSchema.required.join() === 'title'
      && tool.description.includes('英語') && tool.description.includes('はい') && tool.description.includes('2 秒ごと') && tool.description.includes('success 以外は終わったことを確かめていない') && list.find(x => x.name === 'wait').inputSchema.properties.duration.maximum === 10);
    t.ok('computer_batch の動作に wait_until は無い', !list.find(x => x.name === 'computer_batch').inputSchema.properties.actions.items.properties.action.enum.includes('wait_until'));

    h.driver.setFrames(settling);
    const t0 = Date.now();
    const r1 = await a.call('wait_until', { title: '読み込みを待つ', timeout: 10 });
    const m1 = mark(r1);
    t.ok('問いなし: 変化してから静止で返す（success・stable・none、p_yes と reason は無い）。画像は返さない', m1.state === 'ok' && m1.tool === 'wait_until'
      && JSON.stringify(Object.keys(m1.wait)) === '["status","screen","answer","checks","waited_ms"]' && m1.wait.status === 'success' && m1.wait.screen === 'stable' && m1.wait.answer === 'none' && m1.wait.checks === 0
      && r1.content.length === 1 && !m1.shot && body(r1).includes('画面が動いた後、止まりました') && Date.now() - t0 < 5000, JSON.stringify(m1.wait) + ' ' + body(r1));
    t.ok('人に読む文は会話の言語の 1 文（「終わった: …」の行は無い）。固定の語は [ply_computer] の印の行の wait に 1 行の JSON で入る',
      !body(r1).includes('\n') && !body(r1).includes('終わった') && r1.content[0].text.split('\n').at(-1).startsWith('[ply_computer] {') && r1.content[0].text.split('\n').length === 2, r1.content[0].text);
    const shots = h.driver.calls.filter(c => c.op === 'screenshot');
    t.ok('比べるコマは今の対象のディスプレイを灰色・長辺 320 で撮る（JPEG を作らない）', shots.length >= 7 && shots.every(c => c.args.gray === true && c.args.maxEdge === 320 && c.args.display === 'fake-1'));
    t.ok('ロックを取る（持ち主はターン）', h.lock.holder()?.turnId === a.turnId);

    h.driver.setFrames(() => 90);
    const r2 = await a.call('wait_until', { title: 'x' });
    t.ok('最初から静止: 「画面は最初から止まっていました」（約 1 秒）', mark(r2).wait.status === 'success' && body(r2).includes('最初から止まっていました') && mark(r2).wait.waited_ms >= 900 && mark(r2).wait.waited_ms < 3000, body(r2));

    h.driver.calls.length = 0;
    h.driver.setFrames(settling);
    const r3 = await a.call('wait_until', { title: 'x', until: 'Has the page finished loading?' });
    t.ok('キーを選んでいない: 差分だけで待ち、問いは確かめていないので unverified・no_key。画面を送る撮影はしない',
      mark(r3).wait.status === 'unverified' && mark(r3).wait.reason === 'no_key' && mark(r3).wait.screen === 'stable' && mark(r3).wait.answer === 'none' && mark(r3).wait.checks === 0
      && body(r3).includes('キーが選ばれていない') && body(r3).includes('決定モデルには聞いていません')
      && !h.driver.calls.some(c => c.op === 'screenshot' && !c.args.gray), JSON.stringify(mark(r3).wait) + ' ' + body(r3));

    h.driver.setFrames(n => (n % 2 ? 0 : 255));
    const r4 = await a.call('wait_until', { title: 'x', timeout: 1.2 });
    t.ok('止まらない画面: 「画面は止まりませんでした」・timeout・changing（state は ok）', mark(r4).state === 'ok' && mark(r4).wait.status === 'timeout' && mark(r4).wait.screen === 'changing'
      && !('reason' in mark(r4).wait) && body(r4).includes('止まりませんでした') && !body(r4).includes('終わった'), body(r4));

    t.ok('引数の形が違えば invalid（timeout 0・until が文字でない）', mark(await a.call('wait_until', { title: 'x', timeout: 0 })).reason === 'invalid' && mark(await a.call('wait_until', { title: 'x', until: 5 })).reason === 'invalid');
    h.driver.setFrames(() => 90);
    const r5 = await a.call('wait_until', { timeout: 100 });
    t.ok('title が無ければ「画面が落ち着くまで待つ（最長 30 秒）」（上限を超える timeout は 30 秒に丸める）', mark(r5).title === '画面が落ち着くまで待つ（最長 30 秒）', mark(r5).title);

    a.newTurn('u1-turn2');
    const en = h.connect({ sessionId: 'u-en', locale: 'en' });
    const r6 = await en.call('wait_until', { title: 'x', until: 'Is it done?' });
    const r7 = await en.call('wait_until', { title: 'x' });
    t.ok('英語の会話では英語の文。印の固定の語は言語によらず同じ', body(r6).includes('no key is chosen') && body(r7).includes('already still')
      && mark(r6).wait.status === 'unverified' && mark(r6).wait.reason === 'no_key' && mark(r7).wait.status === 'success', body(r6) + ' / ' + body(r7));
    en.end();

    h.driver.setFrames(n => (n % 2 ? 0 : 255));
    const long = a.call('wait_until', { title: 'x', timeout: 20 });
    await sleep(300);
    h.driver.pressEscape(a.turnId);
    const t1 = Date.now();
    const cut = await long;
    t.ok('Esc で待ちの途中で打ち切る（stopped / escape）', mark(cut).state === 'stopped' && mark(cut).reason === 'escape' && Date.now() - t1 < 2000);
  } finally { await h.close(); }

  // キーを選んでいる（偽の OpenRouter へ送る）
  const answers = [];
  const or = await startFakeOpenRouter({ decisions: () => (answers.length ? answers.shift() : 0.9) });
  const keyCalls = [];
  const h2 = await createHarness({ waitMs: 400, decider: {
    key: async () => { keyCalls.push(1); return KEY; },
    ask: o => askDecider({ ...o, env: { AGENT_HOST_OPENROUTER_API: or.url } }),
  } });
  try {
    const b = h2.connect({ sessionId: 'u2' });
    const all = [];
    const callB = async args => { const r = await b.call('wait_until', { title: 'x', ...args }); all.push(r); return r; };

    h2.driver.setFrames(() => 90);
    const r0 = await callB({});
    t.ok('問いが無ければキーを読まず、何も送らない（success）', keyCalls.length === 0 && or.records.decisions.length === 0 && mark(r0).wait.status === 'success' && mark(r0).wait.answer === 'none');

    h2.driver.calls.length = 0;
    h2.driver.setFrames(settling);
    answers.push(0.93);
    const r1 = await callB({ until: '  Has the   download finished?  ' });
    const rec = or.records.decisions.at(-1);
    const sent = h2.driver.calls.filter(c => c.op === 'screenshot' && !c.args.gray);
    t.ok('はい: 静止で 1 回聞いて返す（success・stable・yes・checks 1・p_yes）', JSON.stringify(Object.keys(mark(r1).wait)) === '["status","screen","answer","p_yes","checks","waited_ms"]'
      && mark(r1).wait.status === 'success' && mark(r1).wait.screen === 'stable' && mark(r1).wait.answer === 'yes' && mark(r1).wait.checks === 1 && mark(r1).wait.p_yes === 0.93
      && body(r1).includes('画面が止まり、決定モデルは「はい」と答えました') && !body(r1).includes('0.93') && !body(r1).includes('\n') && r1.content.length === 1, JSON.stringify(mark(r1).wait) + ' ' + body(r1));
    t.ok('送るのは長辺 1440 の JPEG と、空白を詰めた問い', sent.length === 1 && sent[0].args.maxEdge === 1440 && rec.until === 'Has the download finished?' && rec.imageType === 'image/jpeg' && rec.model === DECIDER_MODEL);

    // 最初は静止 → いいえ → 変化 → 静止 → はい
    h2.driver.setFrames(n => n >= 14 && n < 18 ? (n % 2 ? 200 : 10) : n >= 18 ? 120 : 80);
    answers.push(0.2, 0.7);
    const r2 = await callB({ until: 'Is the dialog closed?', timeout: 10 });
    t.ok('いいえの後は次の変化と静止を待って聞き直す（checks 2・最後の p_yes）', mark(r2).wait.status === 'success' && mark(r2).wait.checks === 2 && mark(r2).wait.p_yes === 0.7, body(r2));

    h2.driver.setFrames(() => 80);
    answers.push(0.1);
    const r3 = await callB({ until: 'Is it done?', timeout: 2 });
    t.ok('いいえのまま締め切り: timeout・no・最後の p_yes。「1 回聞きましたが、「はい」とは答えませんでした」', mark(r3).wait.status === 'timeout' && mark(r3).wait.answer === 'no' && mark(r3).wait.p_yes === 0.1
      && mark(r3).wait.checks === 1 && body(r3).includes('決定モデルに 1 回聞きましたが、「はい」とは答えませんでした'), body(r3));

    for (const [status, words] of [[429, '回数の上限に達しました（HTTP 429）'], [503, 'OpenRouter 側の障害です（HTTP 503）'], [401, 'キーが受け付けられませんでした（HTTP 401）']]) {
      answers.push({ status });
      const r = await callB({ until: 'Is it done?' });
      t.ok(`聞けなかった（${status}）: 差分に黙って落とさず error・http_${status}、「決定モデルに聞けなかった」と理由を書く（state は ok）`, mark(r).state === 'ok' && mark(r).wait.status === 'error'
        && mark(r).wait.reason === `http_${status}` && mark(r).wait.answer === 'none' && !('p_yes' in mark(r).wait) && body(r).includes('決定モデルに聞けなかった') && body(r).includes(words), JSON.stringify(mark(r).wait) + ' ' + body(r));
    }
    answers.push({ body: { nope: true } });
    t.ok('読めない応答: error・bad_response', mark(await callB({ until: 'Is it done?' })).wait.reason === 'bad_response');

    // 動き続ける画面: 2 秒で 1 回聞き、はい なら止まるのを待たずに返す
    h2.driver.setFrames(n => (n % 2 ? 0 : 255));
    answers.push(0.88);
    const moving = await callB({ until: 'Has the progress bar reached the end?', timeout: 10 });
    t.ok('動き続ける画面: 2 秒ごとに聞き、はい なら success・changing・yes', mark(moving).wait.status === 'success' && mark(moving).wait.screen === 'changing' && mark(moving).wait.answer === 'yes'
      && mark(moving).wait.checks === 1 && mark(moving).wait.waited_ms >= 1900 && mark(moving).wait.waited_ms < 4000 && body(moving).includes('画面は動き続けていますが、決定モデルは「はい」と答えました'),
      JSON.stringify(mark(moving).wait) + ' ' + body(moving));
    answers.push(0.1, 0.1, 0.1);
    const movingNo = await callB({ until: 'Is it done?', timeout: 3 });
    t.ok('動き続ける画面・いいえのまま: timeout・changing・no', mark(movingNo).wait.status === 'timeout' && mark(movingNo).wait.screen === 'changing' && mark(movingNo).wait.answer === 'no'
      && mark(movingNo).wait.checks === 1 && body(movingNo).includes('1 回聞きましたが'), JSON.stringify(mark(movingNo).wait) + ' ' + body(movingNo));
    answers.length = 0;

    h2.driver.setFrames(settling);
    const before = or.records.decisions.length;
    h2.driver.calls.length = 0;
    h2.driver.setForeground(FAKE_APPS.terminal);
    const r4 = await callB({ until: 'Is it done?' });
    t.ok('前面が操作できないアプリ: 画面を送らず、unverified・protected_app', or.records.decisions.length === before && mark(r4).wait.status === 'unverified' && mark(r4).wait.reason === 'protected_app'
      && mark(r4).wait.screen === 'stable' && mark(r4).wait.checks === 0 && body(r4).includes('Windows Terminal') && !h2.driver.calls.some(c => c.op === 'screenshot' && !c.args.gray), JSON.stringify(mark(r4).wait) + ' ' + body(r4));
    h2.driver.setForeground(FAKE_APPS.pleiad);
    t.ok('Pleiad 自身が前面でも送らない', mark(await callB({ until: 'Is it done?' })).wait.reason === 'protected_app' && or.records.decisions.length === before);
    h2.driver.setFrames(n => (n % 2 ? 0 : 255));
    const r4b = await callB({ until: 'Is it done?', timeout: 3 });
    t.ok('前面が操作できないアプリ・動き続ける画面: 定期の問いも送らず timeout（「前面が操作できないアプリ」と書く）', or.records.decisions.length === before && mark(r4b).wait.status === 'timeout'
      && mark(r4b).wait.checks === 0 && body(r4b).includes('前面が操作できないアプリ（Pleiad'), body(r4b));
    h2.driver.setForeground(FAKE_APPS.notepad);

    const r5 = await callB({ until: 'Is it done?', timeout: 1.2 });
    t.ok('止まらない画面・2 秒より前の締め切り: 聞かずに timeout（「画面が止まらなかったので」）', mark(r5).wait.status === 'timeout' && mark(r5).wait.checks === 0 && mark(r5).wait.answer === 'none' && body(r5).includes('画面が止まらなかったので'), body(r5));

    t.ok('結果の文・印（JSON）にキーは出ない', all.every(r => !JSON.stringify(r).includes(KEY) && !r.content[0].text.includes(KEY)) && all.length >= 14);
  } finally { await h2.close(); await or.close(); }
}
