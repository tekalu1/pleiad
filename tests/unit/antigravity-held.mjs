// agy を保持役に載せる部品（無停止の更新 段階 3。core/backends/antigravity-held.mjs・antigravity.mjs の adoptTurn・antigravity-context.mjs の置き場）。
//   - 載せるかの切り替え（AGENT_HOST_AGY_HOLDER。既定は実行場所の置き場があるとき on）・shell が要る .cmd は載せない
//   - agent の置き場: 保持役に載せる agy の置き場は held-<乱数>（持ち主の pid での掃除 sweep の対象にしない）。前のサーバーが残した分は sweepHeldHomes が消す
//     （このプロセスのものと、生きている子の札が指すものは残す）。付け直した札の home は adoptHome が受ける（形と場所を確かめる）
//   - 付け直し（adoptTurn。偽の source = 保持役の子の元）: 印から ack までの再生は emit の { replay: true }、続きは普通に流して行ごとに ack する。再生の中に result があれば
//     付け直しの直後に締まる。result の無いまま子が終わっていれば失敗。札に無い発言は控えを書き換えない。終わったら札と印を外す
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const name = 'antigravity-held';
export const title = 'agy を保持役に載せる部品: 切り替え・置き場（held-*）の掃除・付け直し（再生と続き・終わった子・札に無い発言）';

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-agy-held-')));
  const savedEnv = { data: process.env.AGENT_HOST_DATA, holder: process.env.AGENT_HOST_AGY_HOLDER, root: process.env.AGENT_HOST_RUNTIME_ROOT };
  process.env.AGENT_HOST_DATA = path.join(scratch, 'data');
  delete process.env.AGENT_HOST_AGY_HOLDER;
  delete process.env.AGENT_HOST_RUNTIME_ROOT;
  try {
    const held = await import('../../core/backends/antigravity-held.mjs');
    const context = await import('../../core/backends/antigravity-context.mjs');

    // ---- 載せるかの切り替え
    {
      // 起動用の変数は、サーバーが起動の時に process.env から外した値（core/boot-env.mjs）から読む。同じプロセスで走る別の試験の値を読まないよう、読み口を差し替える
      const enabled = env => held.heldEnabled(env, () => undefined);
      assert.equal(enabled({}), false, '置き場も指定も無ければ載せない');
      assert.equal(enabled({ AGENT_HOST_RUNTIME_ROOT: '/x' }), true, '実行場所の置き場があれば既定で載せる');
      assert.equal(enabled({ AGENT_HOST_RUNTIME_ROOT: '/x', AGENT_HOST_AGY_HOLDER: 'off' }), false, 'off は載せない');
      assert.equal(enabled({ AGENT_HOST_RUNTIME_ROOT: '/x', AGENT_HOST_AGY_HOLDER: 'OFF' }), false, '大小は問わない');
      assert.equal(enabled({ AGENT_HOST_AGY_HOLDER: 'on' }), true, 'on は載せる（置き場の確認は heldPlan）');
      assert.equal(held.heldEnabled({}, name => ({ AGENT_HOST_RUNTIME_ROOT: '/x' })[name]), true, '起動用の変数（サーバーが外した値）の置き場も見る');
      assert.deepEqual(held.heldAgyCommand(['C:/agy/agy.exe', '--x'], { platform: 'win32' }), { command: 'C:/agy/agy.exe', args: ['--x'] });
      assert.equal(held.heldAgyCommand(['C:/npm/agy.cmd'], { platform: 'win32' }), null, 'shell が要る .cmd は載せない');
      assert.deepEqual(held.heldAgyCommand(['/usr/bin/node', 'fake-agy.mjs'], { platform: 'linux' }), { command: '/usr/bin/node', args: ['fake-agy.mjs'] });
      assert.equal(held.heldAgyCommand(null), null);
      t.ok('切り替え: 置き場があれば既定で on・off と置き場なしは載せない・.cmd は載せない', true);
    }

    // ---- agent の置き場（held-*）
    {
      const root = path.join(process.env.AGENT_HOST_DATA, 'antigravity', 'context');
      const agent = await context.prepareAgent({ owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' }, prompt: 'p', cwd: scratch, url: 'http://127.0.0.1:1/mcp/context', authorization: `Bearer ${'b'.repeat(64)}`, locale: 'ja', held: true });
      const normal = await context.prepareAgent({ owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' }, prompt: 'p', cwd: scratch, url: 'http://127.0.0.1:1/mcp/context', authorization: `Bearer ${'b'.repeat(64)}`, locale: 'ja' });
      assert.ok(/^held-[0-9a-f]+$/.test(path.basename(agent.home)), '保持役に載せる agy の置き場は held-*');
      assert.ok(new RegExp(`^${process.pid}-`).test(path.basename(normal.home)), '載せない agy の置き場は今までどおり <pid>-*');
      // 前のサーバーが残した置き場（held-*。この会話のものではない）
      const stale = path.join(root, `held-${'0'.repeat(12)}`);
      const referenced = path.join(root, `held-${'1'.repeat(12)}`);
      const foreign = path.join(root, `9999999-${'2'.repeat(12)}`);   // 持ち主の pid が居ない（sweep の対象）
      for (const dir of [stale, referenced, foreign]) await fs.mkdir(path.join(dir, '.agents'), { recursive: true });
      context.sweep();
      assert.ok(await exists(stale) && await exists(referenced), 'sweep（持ち主の pid での掃除）は held-* に触れない');
      assert.ok(!await exists(foreign), 'sweep は持ち主の居ない <pid>-* を消す');
      context.sweepHeldHomes(new Set([referenced]));
      assert.ok(!await exists(stale), 'sweepHeldHomes は、生きている子が指さない held-* を消す');
      assert.ok(await exists(referenced), 'sweepHeldHomes は、生きている子の札が指す置き場を残す');
      assert.ok(await exists(agent.home), 'sweepHeldHomes は、このプロセスが作った置き場を残す');
      // 付け直した札の home
      assert.equal(context.adoptHome(path.join(root, 'not-held')), null, 'held-* でない場所は受けない');
      assert.equal(context.adoptHome(path.join(scratch, `held-${'3'.repeat(12)}`)), null, '置き場の外は受けない');
      assert.equal(context.adoptHome(undefined), null);
      const cleanup = context.adoptHome(referenced);
      assert.equal(typeof cleanup, 'function', '置き場の held-* は受けて、終わったら消す関数を返す');
      context.sweepHeldHomes(new Set());
      assert.ok(await exists(referenced), '付け直して引き継いだ置き場は、このプロセスのものとして残す');
      cleanup();
      assert.ok(!await exists(referenced), '引き継いだ置き場は agy が終わったら消える');
      agent.cleanup(); normal.cleanup();
      assert.ok(!await exists(agent.home), 'cleanup で置き場が消える');
      t.ok('置き場: 保持役に載せる agy は held-*（pid の掃除に触れない）。前のサーバーの分だけ掃除し、付け直した置き場は引き継ぐ', true);
    }

    // ---- 付け直し（偽の source）
    {
      const { backend } = await import('../../core/backends/antigravity.mjs');
      const transcript = await import('../../core/backends/antigravity-store.mjs');
      const conversationId = 'conv-adopt-unit';
      const sentAt = 1_700_000_000_000;
      const line = value => JSON.stringify(value);
      const step = body => line({ event: 'step_update', step_update: { conversation_id: conversationId, ...body } });
      // 控えを捨てる（forget は、この起動の間その会話の書き込みを止めるので使わない）
      const dropRecord = () => fs.rm(path.join(process.env.AGENT_HOST_DATA, 'antigravity', `${conversationId}.json`), { force: true });
      const lines = [
        line({ event: 'init', conversation_id: conversationId, init: { model: 'm' } }),
        step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '前置き。' }),
        step({ step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo x' } } }),
        step({ step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'echo x' }, output: 'out-x' } }),
        step({ step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: '終わり。' }),
        line({ event: 'result', result: { conversation_id: conversationId, status: 'SUCCESS', response: '前置き。終わり。', num_turns: 1, usage: { input_tokens: 5, output_tokens: 3, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 8 } } }),
      ];
      const sourceOf = ({ acked, exitAfter = false, alive = true }) => {
        const calls = { acks: [], released: 0, disposed: 0, labels: [], unmarks: [], kills: 0 };
        const client = { on() {}, off() {}, label: (id, label) => calls.labels.push(label), unmark: (id, name) => calls.unmarks.push(name), mark() {}, end() {}, kill: () => { calls.kills++; },
          // ターンの終わりの札と印の取り外しは 1 回の書き込みで送る
          sendBatch(frames) { for (const frame of frames) { if (frame.t === 'label') calls.labels.push(frame.label); if (frame.t === 'unmark') calls.unmarks.push(frame.name); } return true; } };
        const source = {
          id: 'agy-unit', client, attachable: true, acked, state: { id: 'agy-unit', alive, marks: { turn: 1 }, acked, seq: lines.length, truncated: false },
          async replay(from, to) { return lines.map((text, i) => [i + 1, text]).filter(([seq]) => seq >= from && seq <= to); },
          async *attach(from) {
            for (const [i, text] of lines.entries()) if (i + 1 >= from) yield { seq: i + 1, line: text };
            if (exitAfter) yield { exit: { code: 0, signal: null } };
            else await new Promise(() => {});   // 子は idle で次のターンを待つ（読みは終わらない）
          },
          ack(seq) { calls.acks.push(seq); source.acked = seq; },
          write() { return true; }, release() { calls.released++; }, dispose() { calls.disposed++; }, stop() {}, pause() {},
        };
        return { source, calls };
      };
      const runAdopt = async ({ acked, userText = 'adopt me', drop = [], resumed = true }) => {
        const messageStore = { events: [] };
        if (userText !== null) await transcript.appendMessages(conversationId, { cwd: scratch, messages: [{ role: 'user', text: userText, uuid: `${conversationId}:u${sentAt}`, at: new Date(sentAt).toISOString() }] });
        const { source, calls } = sourceOf({ acked });
        const control = { onReady() {}, touch() {} };
        const ac = new AbortController();
        let result, error = null;
        try {
          result = await backend.adoptTurn({
            sessionId: conversationId, cwd: scratch, mode: 'yolo', emit: (event, opts) => { if (!drop.includes(event?.type)) messageStore.events.push([event, opts ?? null]); },
            signal: ac, control, locale: 'ja', source,
            card: { held: true, agy: { sentAt, resumed, sentHash: userText === null ? 'f'.repeat(32) : null, home: null, keys: { context: null }, hookRuns: null } },
          });
        } catch (e) { error = e; }
        return { result, error, events: messageStore.events, calls, control };
      };
      // 再生だけ（印から result まで ack 済み）: result も再生。付け直しの直後に締まる
      {
        const { result, error, events, calls, control } = await runAdopt({ acked: lines.length });
        assert.equal(error, null);
        assert.deepEqual(result, { sessionId: conversationId });
        assert.ok(events.every(([, opts]) => opts?.replay === true), '再生の出来事は全て { replay: true }');
        assert.deepEqual(events.filter(([e]) => e.type === 'tool.result').map(([e]) => e.text), ['out-x'], 'ツールの結果は 1 回');
        assert.equal(events.filter(([e]) => e.type === 'text.delta').map(([e]) => e.text).join(''), '前置き。終わり。');
        assert.deepEqual(events.filter(([e]) => e.type === 'turnResult').map(([e]) => e.outcome), ['ok'], 'turnResult は 1 回');
        assert.equal(events.filter(([e]) => e.type === 'usage').length, 1, '使用量は 1 回');
        assert.equal(calls.labels.at(-1), null, '終わったら札を外す');
        assert.deepEqual(calls.unmarks, ['turn'], '終わったら印を外す');
        assert.equal(control.holder, null, '終わったら札の口を外す');
        const record = await transcript.getRecord(conversationId);
        const assistant = record.messages.filter(m => m.role === 'assistant');
        assert.equal(assistant.length, 1);
        assert.equal(assistant[0].text, '前置き。終わり。', '控えの本文は再生で作り直す');
        assert.equal(assistant[0].toolCalls?.length, 1, '控えにツールの結果が 1 つ');
        assert.equal(record.messages.filter(m => m.role === 'user').length, 1, '人の発言は控えに 1 回（同じ uuid）');
      }
      await dropRecord();
      // 再生（ack まで）と続き（ack の後）に分かれる: 続きは普通に流して行ごとに ack する
      {
        const { result, error, events, calls } = await runAdopt({ acked: 3 });
        assert.equal(error, null);
        assert.deepEqual(result, { sessionId: conversationId });
        assert.equal(events.filter(([, opts]) => opts?.replay === true).length > 0 && events.filter(([, opts]) => !opts?.replay).length > 0, true, '再生と続きの両方がある');
        assert.deepEqual(events.filter(([e, opts]) => e.type === 'tool.start' && opts?.replay).length, 1, 'ツールの開始は再生側');
        assert.deepEqual(events.filter(([e, opts]) => e.type === 'tool.result' && !opts).length, 1, 'ツールの結果は続き側（普通に流す）');
        assert.deepEqual(calls.acks, [4, 5, 6], '続きは処理し終えた行ごとに ack する');
        assert.deepEqual(events.filter(([e]) => e.type === 'turnResult').map(([e]) => e.outcome), ['ok']);
        assert.equal(events.filter(([e]) => e.type === 'text.delta').map(([e]) => e.text).join(''), '前置き。終わり。', '本文は再生と続きで欠けず重ならない');
      }
      await dropRecord();
      // 控えの発言（同じ uuid）をそのまま使う。控えに発言が無い（札のハッシュに合う本文を引けない）ときは、発言を作らない（本文は札に入れていない）
      {
        const { error } = await runAdopt({ acked: lines.length, userText: 'original' });
        assert.equal(error, null);
        const record = await transcript.getRecord(conversationId);
        assert.equal(record.messages.find(m => m.role === 'user')?.text, 'original', '控えの発言のまま');
        await dropRecord();
        const none = await runAdopt({ acked: lines.length, userText: null, resumed: false });
        assert.equal(none.error, null);
        const created = await transcript.getRecord(conversationId);
        assert.deepEqual(created.messages.map(m => m.role), ['assistant'], '本文が引けないときは人の発言を作らない（AI の発言だけ）');
      }
      await dropRecord();
      // result の無いまま子が終わっていた: 失敗として締める（付け直しは中断として残す側へ）
      {
        const partial = lines.slice(0, 4);
        const sink = { events: [] };
        const calls = { acks: [] };
        const source = {
          id: 'agy-gone', client: { on() {}, off() {}, label() {}, unmark() {}, mark() {}, end() {}, kill() {} }, attachable: true, acked: 2,
          state: { id: 'agy-gone', alive: false, marks: { turn: 1 }, acked: 2, seq: 4, truncated: false },
          async replay(from, to) { return partial.map((text, i) => [i + 1, text]).filter(([seq]) => seq >= from && seq <= to); },
          async *attach(from) { for (const [i, text] of partial.entries()) if (i + 1 >= from) yield { seq: i + 1, line: text }; yield { exit: { code: 3, signal: null } }; },
          ack(seq) { calls.acks.push(seq); }, write() { return true; }, release() {}, dispose() {}, stop() {}, pause() {},
        };
        let error = null;
        try {
          await backend.adoptTurn({ sessionId: conversationId, cwd: scratch, mode: 'yolo', emit: event => sink.events.push(event), signal: new AbortController(), control: { onReady() {}, touch() {} }, locale: 'ja', source,
            card: { held: true, agy: { sentAt, resumed: true, sentHash: null, home: null, keys: null, hookRuns: null } } });
        } catch (e) { error = e; }
        assert.ok(error && /exit=3/.test(String(error.message)), `子が result の前に終わったら失敗（${error?.message}）`);
        assert.ok(sink.events.some(e => e.type === 'turnResult' && e.outcome === 'error'), '失敗の turnResult を 1 回出す');
      }
      await dropRecord();
      // 札が無い・形が違う
      await assert.rejects(() => backend.adoptTurn({ sessionId: conversationId, source: { write() {} }, card: { held: true } }), /not on the holder/, 'agy の欄の無い札は付け直さない');
      await assert.rejects(() => backend.adoptTurn({ sessionId: conversationId, source: {}, card: { held: true, agy: {} } }), /not on the holder/, '書き込める子でなければ付け直さない');
      t.ok('付け直し: 再生は { replay: true }・続きは普通に流して行ごとに ack・result の再生で付け直しの直後に締まる・控えは再生で作り直す・終わったら札と印を外す・result の無いまま終わっていれば失敗', true);
    }
  } finally {
    for (const [key, name] of [['data', 'AGENT_HOST_DATA'], ['holder', 'AGENT_HOST_AGY_HOLDER'], ['root', 'AGENT_HOST_RUNTIME_ROOT']]) {
      if (savedEnv[key] === undefined) delete process.env[name]; else process.env[name] = savedEnv[key];
    }
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function exists(file) { return fs.stat(file).then(() => true, () => false); }
