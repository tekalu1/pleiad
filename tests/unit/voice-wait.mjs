// 待っている間の声（承認済み 2026-10-07。ADR 0158、docs/voice-call.md「待っている間の声」）。時計を差し替えて、受け取りの一言・待ちの実況の出し分けを確かめる。
// 状態機械（core/voice/wait-voice.mjs）は決めた時刻で、通話 1 本（session.mjs）は偽の聞き取り・読み上げ・時計で、決まった文の音のキャッシュ（phrase-cache.mjs）は偽の TTS で見る。
import { ACK_AFTER_MS, NARRATE_GAP_MS, NARRATE_MAX, NARRATE_QUIET_MS, createWaitVoice, toolKindOf } from '../../core/voice/wait-voice.mjs';
import { createPhraseCache } from '../../core/voice/phrase-cache.mjs';
import { createVoiceSession } from '../../core/voice/session.mjs';
import { normalizeVoiceSettings } from '../../core/voice/settings.mjs';
import { toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-wait';
export const title = '待っている間の声: 受け取りの一言（1.5 秒・返事が先なら言わない・渡っていなければ言わない）・待ちの実況（無音 6 秒・間隔・回数・返事のあと・種類）・割り込み・音声のキャッシュ・設定';

const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';
const ACKS = ['はい、確認します', '少し待ってくださいね', 'はい、承知しました', 'ちょっと見てみますね'];
const TOOLS = { read: 'ファイルを読んでいます', search: '調べています', command: 'コマンドを動かしています', web: 'Web を見ています', delegate: '別のエージェントに任せています',
  edit: 'ファイルを直しています', computer: '画面を操作しています', other: '作業しています', still: 'まだ作業しています' };
const PHRASES = { code: 'コードは画面に出しました', table: '表は画面に出しました', log: 'ログは画面に出しました', wait: { ack: ACKS, tool: TOOLS } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(5); } return fn(); }

/** 時計つきの状態機械。said には読み上げに出した文（と種類）が入る */
function rig(opts = {}) {
  let clock = 10_000;
  const said = [];
  const w = createWaitVoice({ speak: (text, kind) => { if (opts.refuse) return false; said.push({ text, kind, at: clock }); return true; }, now: () => clock, phrases: { ack: ACKS, tool: TOOLS }, random: () => 0, ...opts.wait });
  // 本番の時計（session.mjs の WAIT_TICK_MS = 250ms）と同じ刻みで進める。途中の時刻で言うべきことを飛ばさない
  const advance = (ms) => { for (let left = ms; left > 0; left -= 250) { clock += Math.min(250, left); w.tick(); } };
  return { w, said, advance, get clock() { return clock; } };
}

export default async function (t) {
  // ---- 受け取りの一言
  {
    const r = rig();
    r.w.handed();
    r.advance(ACK_AFTER_MS - 1);
    t.ok('受け取りの一言: 渡ってから 1.5 秒に届かないうちは言わない', r.said.length === 0);
    r.advance(1);
    t.ok('受け取りの一言: 1.5 秒たっても返事の読み上げが始まっていなければ、決まった一言を言う', r.said.length === 1 && r.said[0].kind === 'ack' && ACKS.includes(r.said[0].text) && r.said[0].at === 10_000 + ACK_AFTER_MS);
    r.advance(5000);
    t.ok('受け取りの一言: 1 回の発言につき 1 回だけ（ツールが動いていなければ、続けて言わない）', r.said.length === 1);

    const early = rig();
    early.w.handed();
    early.advance(1000);
    early.w.replySpoke('調べました。');
    early.advance(2000);
    t.ok('返事が先: 1.5 秒前に返事の読み上げが始まったら、一言を言わない', early.said.length === 0);

    const delta = rig();
    delta.w.handed();
    delta.advance(1000);
    delta.w.textDelta();
    delta.advance(2000);
    t.ok('返事が先: 返事の本文が流れ始めた（文はまだ閉じていない）ときも、一言を言わない（返事がすぐ来る）', delta.said.length === 0);

    const unsent = rig();
    unsent.advance(10_000);
    t.ok('受け取られていない（送信待ち・差し込み待ち。渡った合図 handed が来ていない）うちは言わない', unsent.said.length === 0);

    const late = rig();
    late.advance(8000);
    late.w.handed();
    late.advance(ACK_AFTER_MS - 1);
    t.ok('起点は「AI に渡しました」: 送った時刻ではなく、渡った合図から数える', late.said.length === 0);
    late.advance(1);
    t.ok('起点は「AI に渡しました」: 渡った合図の 1.5 秒後に言う', late.said.length === 1);

    const hearing = rig();
    hearing.w.handed();
    hearing.advance(500);
    hearing.w.setHearing(true);
    hearing.advance(3000);
    t.ok('話している最中（聞き取りの busy）は言わない。話し終えても、取り消した一言は戻らない', hearing.said.length === 0 && (hearing.w.setHearing(false), hearing.advance(3000), hearing.said.length === 0));

    const hearingAtDue = rig();
    hearingAtDue.w.handed();
    hearingAtDue.w.setHearing(true);
    hearingAtDue.advance(ACK_AFTER_MS + 100);
    hearingAtDue.w.setHearing(false);
    hearingAtDue.advance(ACK_AFTER_MS);
    t.ok('一言の時刻に話している最中なら、言わずに捨てる（話に割り込まない）', hearingAtDue.said.length === 0);

    const stopped = rig();
    stopped.w.handed();
    stopped.advance(1000);
    stopped.w.halt();
    stopped.advance(3000);
    t.ok('割り込み・止めるのあとは、一言を言わない', stopped.said.length === 0);

    const ended = rig();
    ended.w.handed();
    ended.advance(1000);
    ended.w.turnEnd();
    ended.advance(3000);
    t.ok('そのターンが終わったあとは、一言を言わない', ended.said.length === 0);

    const off = rig({ wait: { ack: false } });
    off.w.handed();
    off.advance(5000);
    t.ok('設定でオフなら一言を言わない', off.said.length === 0);

    const refused = rig({ refuse: true });
    refused.w.handed();
    refused.advance(ACK_AFTER_MS);
    refused.advance(1000);
    t.ok('読み上げに出せない（スピーカーのミュート・止めている）ときは、言ったことにせず、あとからも言わない', refused.said.length === 0);

    // 同じ文が続かない（順に回る）
    const seq = rig();
    const spoken = [];
    for (let i = 0; i < 5; i++) { seq.w.handed(); seq.advance(ACK_AFTER_MS); spoken.push(seq.said.at(-1).text); seq.w.turnEnd(); seq.advance(60_000); }
    t.ok('一言は順に回り、同じ文が続かない（キャッシュが効く数個の文）', spoken.every((s, i) => i === 0 || s !== spoken[i - 1]) && new Set(spoken).size === ACKS.length, spoken.join('|'));
  }

  // ---- 待ちの実況
  {
    const r = rig();
    r.w.handed();
    r.w.toolStart('Read');
    r.advance(ACK_AFTER_MS);                                   // 一言（1.5 秒）
    const ackAt = r.clock;
    t.ok('実況の前提: 一言が先に出ている', r.said.length === 1 && r.said[0].kind === 'ack');
    r.advance(NARRATE_QUIET_MS - 1000);
    t.ok('実況: 一言（鳴り終わりの見積もり）から無音が 6 秒続くまでは言わない', r.said.length === 1);
    r.advance(NARRATE_QUIET_MS);
    const first = r.said[1];
    t.ok('実況: 無音が 6 秒続き、その間にツールが動いていたら、ツールの種類から決まった文を言う（Read → ファイルを読んでいます）', first?.kind === 'status' && first.text === TOOLS.read && first.at > ackAt + NARRATE_QUIET_MS);

    // 間隔・回数
    const times = [first.at];
    for (let i = 0; i < 400 && r.said.length < 8; i++) { r.w.toolStart('Bash'); r.advance(1000); if (r.said.at(-1).at !== times.at(-1)) times.push(r.said.at(-1).at); }
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    t.ok(`実況: 間隔は最低 ${NARRATE_GAP_MS / 1000} 秒`, gaps.length > 0 && gaps.every((g) => g >= NARRATE_GAP_MS), gaps.join(','));
    const statuses = r.said.filter((s) => s.kind === 'status');
    t.ok(`実況: 1 ターンに最大 ${NARRATE_MAX} 回（ツールが動き続けても、無音が続いても）`, statuses.length === NARRATE_MAX, String(statuses.length));
    r.advance(120_000);
    t.ok('実況: 上限のあとは、いくら待っても言わない', r.said.filter((s) => s.kind === 'status').length === NARRATE_MAX);
    t.ok('実況: 新しいツールが動いたときはその種類（コマンド）の文', statuses[1].text === TOOLS.command);

    // 次の発言が渡れば、また数え直す
    r.w.turnEnd();
    r.w.handed();
    r.w.toolStart('Grep');
    r.advance(ACK_AFTER_MS + NARRATE_QUIET_MS + 5000);
    t.ok('実況: 次のターン（次の発言が渡った）では回数を数え直す', r.said.filter((s) => s.kind === 'status').length === NARRATE_MAX + 1 && r.said.at(-1).text === TOOLS.search);

    const still = rig();
    still.w.handed();
    still.w.toolStart('Read');
    still.advance(60_000);
    const stillSaid = still.said.filter((s) => s.kind === 'status').map((s) => s.text);
    t.ok('実況: ツールが新しく動かないまま待ち続けるときは、同じ文を繰り返さず「まだ作業しています」', stillSaid[0] === TOOLS.read && stillSaid.slice(1).every((s) => s === TOOLS.still) && stillSaid.length === NARRATE_MAX, stillSaid.join('|'));

    const noTool = rig();
    noTool.w.handed();
    noTool.advance(120_000);
    t.ok('実況: ツールが動いていない（考えているだけ）なら、一言のあとは言わない', noTool.said.length === 1 && noTool.said[0].kind === 'ack');

    const replying = rig();
    replying.w.handed();
    replying.w.toolStart('Read');
    replying.advance(ACK_AFTER_MS);
    replying.w.replySpoke('これから調べます。');
    replying.advance(3000);
    replying.w.replySpoke('ファイルを開きました。');
    replying.advance(4000);
    t.ok('返事が始まったら実況しない: 返事の読み上げが鳴っている間（無音が 6 秒続かない間）は言わない', replying.said.filter((s) => s.kind === 'status').length === 0);
    replying.advance(NARRATE_QUIET_MS + 3000);
    t.ok('返事のあとで無音が 6 秒続き、ツールが動いていれば言う（前置きの返事のあとの長い作業で、無音のまま待たせない）', replying.said.filter((s) => s.kind === 'status').length === 1);

    const hear = rig();
    hear.w.handed(); hear.w.toolStart('Read');
    hear.w.setHearing(true);
    hear.advance(60_000);
    t.ok('実況: 利用者が話している最中は言わない', hear.said.filter((s) => s.kind === 'status').length === 0);
    hear.w.setHearing(false);
    hear.advance(100);
    t.ok('実況: 話し終えたら、数えていた無音のあとで言う', hear.said.filter((s) => s.kind === 'status').length === 1);

    const halted = rig();
    halted.w.handed(); halted.w.toolStart('Read');
    halted.advance(2000);
    halted.w.halt();
    halted.advance(60_000);
    t.ok('割り込み・止めるのあとは、そのターンの残りの実況を言わない', halted.said.filter((s) => s.kind === 'status').length === 0);
    halted.w.userMessage(); halted.w.handed(); halted.w.toolStart('Read');
    halted.advance(ACK_AFTER_MS + NARRATE_QUIET_MS + 5000);
    t.ok('次の発言が渡れば、また言う', halted.said.filter((s) => s.kind === 'status').length === 1);

    const typed = rig();
    typed.w.toolStart('Read');
    typed.advance(120_000);
    t.ok('声で送ったターンではない（handed が無い）ときは、ツールが動いても実況しない', typed.said.length === 0);

    const early = rig();
    early.w.toolStart('Bash');
    early.advance(30_000);
    t.ok('実況（前提）: 発言が渡る前に動いたツールだけでは、言わない（声で送ったターンではない）', early.said.length === 0);
    early.w.handed();
    early.advance(ACK_AFTER_MS + NARRATE_QUIET_MS + 3000);
    t.ok('実況: ツールが渡った合図より先に動き始めていても（長いツールの最中に差し込んだ・合図がツールの開始より遅れた）、その種類で言う', early.said.at(-1)?.text === TOOLS.command && early.said.at(-1).kind === 'status', JSON.stringify(early.said));

    const off = rig({ wait: { narrate: false } });
    off.w.handed(); off.w.toolStart('Read');
    off.advance(60_000);
    t.ok('設定でオフなら実況を言わない（一言は言う）', off.said.length === 1 && off.said[0].kind === 'ack');
  }

  // ---- ツールの種類（名前だけ。引数は見ない）
  {
    const kinds = Object.fromEntries(['Read', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Edit', 'Write', 'mcp__ply_agents__ply_delegate', 'mcp__ply_computer__screenshot',
      'commandExecution', 'fileChange', 'webSearch', 'subAgentActivity', 'read_file', 'run_command', 'search_web', 'mcp__github__list_issues', 'SomethingNew'].map((n) => [n, toolKindOf(n)]));
    t.ok('ツールの種類: ファイルを読む系・検索・コマンド・Web・委譲・編集・画面操作（Claude・Codex・agy の名前）', kinds.Read === 'read' && kinds.read_file === 'read' && kinds.Glob === 'search' && kinds.Grep === 'search'
      && kinds.Bash === 'command' && kinds.PowerShell === 'command' && kinds.commandExecution === 'command' && kinds.run_command === 'command' && kinds.WebFetch === 'web' && kinds.webSearch === 'web' && kinds.search_web === 'web'
      && kinds.Task === 'delegate' && kinds.Agent === 'delegate' && kinds.subAgentActivity === 'delegate' && kinds.mcp__ply_agents__ply_delegate === 'delegate'
      && kinds.Edit === 'edit' && kinds.Write === 'edit' && kinds.fileChange === 'edit' && kinds.mcp__ply_computer__screenshot === 'computer', JSON.stringify(kinds));
    t.ok('ツールの種類: 分からないもの（ほかの MCP・新しいツール）は「作業しています」の種類', kinds.mcp__github__list_issues === 'other' && kinds.SomethingNew === 'other');
    t.ok('ツールの種類: 画面の見出し・TODO の更新・ツール検索は実況の対象にしない', toolKindOf('mcp__host__set_status') === null && toolKindOf('TodoWrite') === null && toolKindOf('ToolSearch') === null && toolKindOf('') === null && toolKindOf(undefined) === null);
    t.ok('文言の表: どの種類にも文がある（種類 8 つ + まだ作業しています）', ['read', 'search', 'command', 'web', 'delegate', 'edit', 'computer', 'other', 'still'].every((k) => TOOLS[k]));
  }

  // ---- 決まった文の音のキャッシュ
  {
    let calls = 0, fail = false;
    const tts = { sampleRate: 24000, synthesize: async (text, { onChunk, signal }) => {
      calls++;
      const a = new Uint8Array(4); a[0] = calls;
      onChunk(a);
      if (fail) throw Object.assign(new Error('boom'), { kind: 'transient' });
      if (signal?.aborted) throw new Error('aborted');
      return { firstChunkMs: 5, tookMs: 9, audioMs: 120, bytes: 4, chars: text.length };
    } };
    const cache = createPhraseCache(tts, ['はい、確認します']);
    const got = [];
    const first = await cache.synthesize('はい、確認します', { onChunk: (b) => got.push([...b]) });
    const second = await cache.synthesize('はい、確認します', { onChunk: (b) => got.push([...b]) });
    t.ok('キャッシュ: 決まった文は 1 回だけ合成し、2 回目は同じ音を返す（TTS を呼ばない）', calls === 1 && got.length === 2 && got[0][0] === got[1][0] && cache.size === 1);
    t.ok('キャッシュ: 使い回した音の費用の計上（chars）は 0・最初のバイトは待たない。最初の 1 回は本物の値', first.chars === 8 && second.chars === 0 && second.firstChunkMs === 0 && second.audioMs === 120);
    await cache.synthesize('これは返事の文です', { onChunk() {} });
    await cache.synthesize('これは返事の文です', { onChunk() {} });
    t.ok('キャッシュ: 返事の文（決まった文でないもの）は毎回合成する', calls === 3 && cache.size === 1);
    const flaky = createPhraseCache(tts, ['少し待ってくださいね']);
    fail = true;
    await flaky.synthesize('少し待ってくださいね', { onChunk() {} }).catch(() => {});
    fail = false;
    t.ok('キャッシュ: 失敗・中断した合成は覚えない（欠けた音を使い回さない）', flaky.size === 0 && (await flaky.synthesize('少し待ってくださいね', { onChunk() {} }), flaky.size === 1));
  }

  // ---- 通話 1 本: 偽の聞き取り・読み上げ・時計
  function harness({ settings = {}, wait = true } = {}) {
    const sent = [], binary = [];
    let clock = 1_000_000, ttsCalls = [];
    const usage = { add: async () => {}, flush: async () => {}, today: async () => ({ callSeconds: 0, sttSeconds: 0, ttsChars: 0 }) };
    const stt = { cooling: () => false, hasFallback: false, transcribe: async () => ({ text: '聞き取った言葉', model: 'stt/m', tookMs: 4, audioMs: 1000, route: 'primary', fallback: false }) };
    const tts = { sampleRate: 24000, synthesize: async (text, { onChunk, signal }) => {
      ttsCalls.push(text);
      await sleep(2);
      if (signal.aborted) throw Object.assign(new Error('aborted'), { kind: 'transient' });
      onChunk(new Uint8Array(4800));
      return { audioMs: 100, bytes: 4800, chars: text.length, firstChunkMs: 3, tookMs: 5 };
    } };
    const session = createVoiceSession({
      send: (o) => sent.push(o), sendBinary: (b) => binary.push(b), close() {}, log() {}, now: () => clock, tickMs: 100_000, waitTickMs: 5, clients: { stt, tts },
      hello: async () => ({ settings: normalizeVoiceSettings(settings), config: { baseUrl: 'http://x', apiKey: KEY }, uiLang: 'ja', phrases: wait ? PHRASES : { ...PHRASES, wait: undefined }, usage, todayCallSeconds: 0 }),
    });
    const msg = (type, extra = {}) => session.onMessage(JSON.stringify({ t: type, ...extra }), false);
    const segs = () => sent.filter((m) => m.t === 'seg');
    return { session, sent, binary, msg, segs, ttsCalls: () => ttsCalls, advance: (ms) => { clock += ms; }, settle: () => sleep(40) };
  }
  const start = async (h) => { await h.session.onMessage(JSON.stringify({ t: 'hello', target: { kind: 'chat', sessionId: 's1' } }), false); };

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: 'これを見て' });
    await h.msg('handed');
    h.advance(ACK_AFTER_MS - 100);
    await h.settle();
    t.ok('通話 1 本: 渡ってから 1.5 秒に届かなければ、読み上げを出さない', h.segs().length === 0);
    h.advance(200);
    await waitFor(() => h.segs().length === 1);
    const ack = h.segs()[0];
    t.ok('通話 1 本: 1.5 秒たって返事が無ければ、決まった一言を seg で送る（skip: notice。読んでいる場所の印・「考え中」の終わりにしない印）', ACKS.includes(ack?.text) && ack.skip === 'notice' && ack.first === false);
    await waitFor(() => h.sent.some((m) => m.t === 'seg.end' && m.id === ack.id));
    t.ok('通話 1 本: 一言の音も流れる（最初は本物の合成）', h.binary.length === 1 && h.ttsCalls().length === 1);
    t.ok('通話 1 本: 一言は返事の最初の音ではない（遅延の計測 lat を出さない）', !h.sent.some((m) => m.t === 'lat'));
    h.session.onAgentEvent({ type: 'turnEnd' });
    t.ok('通話 1 本: 一言だけで終わったターンは spoke: false（返事を読んでいない）', h.sent.at(-1).t === 'turn.end' && h.sent.at(-1).spoke === false);

    // 2 ターン目: 同じ文は TTS を呼ばない
    for (let i = 0; i < ACKS.length; i++) {
      h.session.onAgentEvent({ type: 'userMessage', messageId: `n${i}`, text: '次' });
      await h.msg('handed');
      h.advance(ACK_AFTER_MS + 100);
      await waitFor(() => h.segs().length === 2 + i);
      h.session.onAgentEvent({ type: 'turnEnd' });
      await h.settle();
    }
    const texts = h.segs().map((s) => s.text);
    t.ok('通話 1 本: 決まった文の音は通話の中で 1 回だけ合成する（4 つの文を 1 回ずつ。5 回目は作り直さない）', h.segs().length === 5 && h.ttsCalls().length === ACKS.length && new Set(texts).size === ACKS.length, `${texts.join('|')} / ${h.ttsCalls().length}`);
    t.ok('通話 1 本: 同じ文が続かない', texts.every((x, i) => i === 0 || x !== texts[i - 1]));
    h.session.close();
  }

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: 'これを見て' });
    await h.msg('handed');
    h.advance(1000);
    h.session.onAgentEvent({ type: 'text.delta', text: '見ました。' });
    h.session.onAgentEvent({ type: 'text.end' });
    h.advance(3000);
    await h.settle();
    t.ok('通話 1 本: 1.5 秒前に返事が来たら、一言を言わない。返事だけを読む', h.segs().length === 1 && h.segs()[0].text === '見ました。' && h.segs()[0].skip === undefined);
    h.session.close();
  }

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: 'これを見て' });
    h.advance(20_000);
    await h.settle();
    t.ok('通話 1 本: 受け取られていない（handed が来ていない = 送信待ち・差し込み待ち）うちは、何秒たっても言わない', h.segs().length === 0);
    await h.msg('handed');
    h.advance(ACK_AFTER_MS + 100);
    await waitFor(() => h.segs().length === 1);
    t.ok('通話 1 本: 渡った合図が来たら、そこから数えて言う', h.segs().length === 1);
    h.session.close();
  }

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: 'これを見て' });
    await h.msg('handed');
    h.advance(ACK_AFTER_MS + 100);
    await waitFor(() => h.segs().length === 1);
    h.sent.length = 0;
    await h.msg('barge', { id: 1 });
    t.ok('割り込み（話して止める）: 鳴っている一言も止める（cancel を送り、合成を捨てる）', h.sent.some((m) => m.t === 'cancel'));
    await h.settle();
    t.ok('割り込みのあと: 止めた一言の音・seg.end は流れてこない', !h.sent.some((m) => m.t === 'seg.end' || m.t === 'seg.fail') && h.binary.length <= 1);
    h.session.close();
  }

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: '調べて' });
    await h.msg('handed');
    h.session.onAgentEvent({ type: 'tool.start', name: 'Read' });
    h.advance(ACK_AFTER_MS + 100);
    await waitFor(() => h.segs().length === 1);
    h.advance(NARRATE_QUIET_MS + 3000);
    await waitFor(() => h.segs().length === 2);
    t.ok('通話 1 本: ツールが動いていて無音が続けば、ツールの種類の文を seg（skip: notice）で送る。ファイル名・引数は文に出ない', h.segs()[1].text === TOOLS.read && h.segs()[1].skip === 'notice');
    h.session.close();
  }

  {
    const h = harness({ settings: { ackPhrase: false, narration: false } });
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: '調べて' });
    await h.msg('handed');
    h.session.onAgentEvent({ type: 'tool.start', name: 'Read' });
    h.advance(60_000);
    await h.settle();
    t.ok('設定: 受け取りの一言と待ちの実況の両方をオフにすると、何も言わない', h.segs().length === 0);
    h.session.close();
    const w = harness({ wait: false });
    await start(w);
    await w.msg('handed');
    w.advance(60_000);
    await w.settle();
    t.ok('辞書が無ければ何も言わない（古い呼び出し元・テスト用の hello）', w.segs().length === 0);
    w.session.close();
  }

  {
    const h = harness();
    await start(h);
    await h.msg('spk', { on: true });
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: '調べて' });
    await h.msg('handed');
    h.advance(ACK_AFTER_MS + 100);
    await h.settle();
    t.ok('スピーカーのミュート中は一言を言わない（合成も頼まない）', h.segs().length === 0 && h.ttsCalls().length === 0);
    h.session.close();
  }

  {
    const h = harness();
    await start(h);
    h.session.onAgentEvent({ type: 'userMessage', messageId: 'm1', text: '調べて' });
    await h.msg('handed');
    for (let i = 0; i < 6; i++) h.session.onMessage(toneFrame(true), true);
    h.advance(ACK_AFTER_MS + 100);
    await h.settle();
    t.ok('話している最中（聞き取りの busy）は、時刻が来ても一言を言わない', h.segs().length === 0);
    h.session.close();
  }

  // ---- 設定
  {
    const d = normalizeVoiceSettings({});
    t.ok('設定の既定: 受け取りの一言・待ちの実況はどちらもオン', d.ackPhrase === true && d.narration === true);
    t.ok('設定: 読むとき、不正な値は既定（オン）に戻す。書くとき、真偽値でなければ invalid で断る', normalizeVoiceSettings({ ackPhrase: 'no', narration: 0 }).ackPhrase === true
      && normalizeVoiceSettings({ ackPhrase: false, narration: false }, { strict: true }).narration === false
      && ['ackPhrase', 'narration'].every((k) => { try { normalizeVoiceSettings({ [k]: 'x' }, { strict: true }); return false; } catch (e) { return e.code === 'invalid'; } }));
  }
}
