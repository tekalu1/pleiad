// main の Job Object の制限の調べ方と、サーバーの起こし方の分岐（無停止の更新 1-4。desktop/job.cjs。docs/zero-downtime-update/design.md §3.2）。
//   - 分岐: KILL_ON_JOB_CLOSE の有無・SILENT_BREAKAWAY_OK・BREAKAWAY_OK の組み合わせ・Job に入っていない・調べられない・Windows 以外
//   - 調べ方: 偽の koffi で Job の外・中・読めない場合・koffi が読めない場合
//   - CreateProcessW の部品: コマンドラインの囲み・環境ブロック
//   - 本物（Windows）: この環境の Job を実際に調べ、抜け道があるなら CREATE_BREAKAWAY_FROM_JOB で起こした子が動き、渡した環境が届く
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const job = require('../../desktop/job.cjs');

export const name = 'desktop-job';
export const title = 'main の Job の制限の調べ方とサーバーの起こし方の分岐（detached・breakaway・今の utilityProcess）';

const { LIMIT } = job;
const KILL = LIMIT.KILL_ON_JOB_CLOSE, BREAKAWAY = LIMIT.BREAKAWAY_OK, SILENT = LIMIT.SILENT_BREAKAWAY_OK;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** koffi の身代わり。Job の中か・LimitFlags・失敗させるものを決める */
function fakeKoffi({ inJob = true, flags = 0, failQuery = false, failInJob = false } = {}) {
  const struct = () => ({});
  return {
    struct,
    load: () => ({
      func: signature => {
        if (signature.includes('IsProcessInJob')) return (_process, _job, out) => { if (failInJob) return 0; out[0] = inJob ? 1 : 0; return 1; };
        if (signature.includes('GetCurrentProcess')) return () => ({});
        if (signature.includes('QueryInformationJobObject')) return (_job, _cls, buffer) => { if (failQuery) return 0; buffer.writeUInt32LE(flags, 16); return 1; };
        if (signature.includes('GetLastError')) return () => 5;
        return () => 1;
      },
    }),
  };
}

export default async function (t) {
  // ---- 分岐
  {
    const mode = info => job.decideLaunch(info, { platform: 'win32' }).mode;
    t.ok('分岐: Job に入っていなければ detached', mode({ inJob: false }) === 'detached');
    t.ok('分岐: Job にあっても KILL_ON_JOB_CLOSE が無ければ detached', mode({ inJob: true, flags: 0 }) === 'detached' && mode({ inJob: true, flags: BREAKAWAY }) === 'detached');
    t.ok('分岐: KILL_ON_JOB_CLOSE + SILENT_BREAKAWAY_OK は detached（黙って抜けられる）', mode({ inJob: true, flags: KILL | SILENT }) === 'detached' && mode({ inJob: true, flags: KILL | SILENT | BREAKAWAY }) === 'detached');
    t.ok('分岐: KILL_ON_JOB_CLOSE + BREAKAWAY_OK だけなら breakaway', mode({ inJob: true, flags: KILL | BREAKAWAY }) === 'breakaway');
    t.ok('分岐: KILL_ON_JOB_CLOSE だけで抜け道が無ければ unsupported（今の utilityProcess に落とす）', mode({ inJob: true, flags: KILL }) === 'unsupported');
    t.ok('分岐: 他の制限が混ざっても同じ（ACTIVE_PROCESS・PRIORITY_CLASS）', mode({ inJob: true, flags: KILL | 0x8 | 0x4 }) === 'unsupported' && mode({ inJob: true, flags: KILL | BREAKAWAY | 0x8 }) === 'breakaway');
    t.ok('分岐: 調べられなかった（Job の有無・制限が不明）は unsupported', mode({ inJob: null, error: 'x' }) === 'unsupported' && mode({ inJob: true, flags: null }) === 'unsupported' && mode(undefined) === 'unsupported');
    t.ok('分岐: Windows 以外は Job の話ではないので detached', job.decideLaunch({ inJob: null }, { platform: 'linux' }).mode === 'detached');
    t.ok('分岐: 理由の文が付く（updater.log に残す）', job.decideLaunch({ inJob: true, flags: KILL }, { platform: 'win32' }).reason.includes('no breakaway'));
  }

  // ---- 調べ方（偽の koffi）
  {
    const outside = job.inspectJob({ koffi: fakeKoffi({ inJob: false }), platform: 'win32' });
    t.ok('調べ方: Job の外なら inJob は false で制限は無い', outside.inJob === false && outside.flags === null && outside.limits.length === 0);
    const inside = job.inspectJob({ koffi: fakeKoffi({ flags: KILL | BREAKAWAY | 0x8 }), platform: 'win32' });
    t.ok('調べ方: Job の中なら LimitFlags と制限の名前が分かる', inside.inJob === true && inside.flags === (KILL | BREAKAWAY | 0x8) && inside.limits.join() === 'BREAKAWAY_OK,KILL_ON_JOB_CLOSE', JSON.stringify(inside));
    const unreadable = job.inspectJob({ koffi: fakeKoffi({ failQuery: true }), platform: 'win32' });
    t.ok('調べ方: 制限を読めなければ flags は null で理由が付く（分岐は unsupported）', unreadable.inJob === true && unreadable.flags === null && /QueryInformationJobObject/.test(unreadable.error) && job.decideLaunch(unreadable, { platform: 'win32' }).mode === 'unsupported');
    const unknown = job.inspectJob({ koffi: fakeKoffi({ failInJob: true }), platform: 'win32' });
    t.ok('調べ方: IsProcessInJob が失敗したら inJob は null', unknown.inJob === null && /IsProcessInJob/.test(unknown.error));
    const noKoffi = job.inspectJob({ loadKoffi: () => { throw new Error('koffi is missing'); }, platform: 'win32' });
    t.ok('調べ方: koffi を読めなければ inJob は null で理由が付く（分岐は unsupported）', noKoffi.inJob === null && /koffi is missing/.test(noKoffi.error) && job.decideLaunch(noKoffi, { platform: 'win32' }).mode === 'unsupported');
    t.ok('調べ方: Windows 以外は koffi を読まずに Job の外として扱う', job.inspectJob({ loadKoffi: () => { throw new Error('must not load'); }, platform: 'linux' }).inJob === false);
  }

  // ---- CreateProcessW の部品
  {
    t.ok('コマンドライン: 空白・引用符・末尾の \\ を CommandLineToArgvW の規則で囲む', job.quoteArg('plain') === 'plain' && job.quoteArg('a b') === '"a b"' && job.quoteArg('') === '""'
      && job.quoteArg('say "hi"') === '"say \\"hi\\""' && job.quoteArg('C:\\Program Files\\x\\') === '"C:\\Program Files\\x\\\\"' && job.quoteArg('C:\\a\\"b') === '"C:\\a\\\\\\"b"');
    t.ok('コマンドライン: 実行ファイルと引数を空白でつなぐ', job.commandLine('C:\\n o\\node.exe', ['C:\\app\\core\\server.mjs', '--flag']) === '"C:\\n o\\node.exe" C:\\app\\core\\server.mjs --flag');
    const block = job.environmentBlock({ zeta: '1', Alpha: 'あ', skip: undefined, nul: null, 'bad=name': 'x', Path: 'C:\\bin' }).toString('utf16le');
    t.ok('環境ブロック: UTF-16 の name=value\\0 …\\0\\0、名前の大小を無視した順、undefined・null・"=" を含む名前は入れない', block === 'Alpha=あ\0Path=C:\\bin\0zeta=1\0\0', JSON.stringify(block));
    t.ok('環境ブロック: 空でも終端が 2 つ', job.environmentBlock({}).toString('utf16le') === '\0\0');
  }

  // ---- 本物（Windows）
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    const real = job.inspectJob({ koffi });
    t.ok('本物: この環境の Job が調べられる（入っていないか、制限が読める）', real.inJob === false || (real.inJob === true && Number.isInteger(real.flags)), JSON.stringify(real));
    const free = real.inJob === false || Boolean(real.flags & (BREAKAWAY | SILENT));
    if (!free) {
      t.ok('本物: この環境の Job は抜け道を許さないので、CREATE_BREAKAWAY_FROM_JOB での起動は試さない（分岐は ' + job.decideLaunch(real).mode + '）', job.decideLaunch(real).mode === 'unsupported' || job.decideLaunch(real).mode === 'detached');
    } else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-job-'));
      try {
        const out = path.join(dir, 'child.json');
        const script = path.join(dir, 'child.mjs');
        fs.writeFileSync(script, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, marker: process.env.PLEIAD_JOB_MARKER, args: process.argv.slice(2) }));\n`);
        const started = job.launchBreakaway({ exe: process.execPath, args: [script, 'with space', 'plain'], env: { ...process.env, PLEIAD_JOB_MARKER: 'こんにちは' }, cwd: dir, koffi });
        t.ok('本物: CREATE_BREAKAWAY_FROM_JOB で起こすと PID が返る', Number.isInteger(started.pid) && started.pid > 0);
        const end = Date.now() + 15_000;
        while (!fs.existsSync(out) && Date.now() < end) await sleep(50);
        const seen = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
        t.ok('本物: 子が動き、PID・渡した環境（日本語を含む）・引数（空白を含む）が届く', seen?.pid === started.pid && seen.marker === 'こんにちは' && seen.args.join('|') === 'with space|plain', JSON.stringify(seen));
        t.ok('本物: 渡した環境のとおり（親の process.env を書き換えていない）', process.env.PLEIAD_JOB_MARKER === undefined);
        // 子は書いた後もまだ dir を作業場所に持っている。終わるのを待ってから消す（待たないと rmdir が EBUSY）
        const gone = Date.now() + 10_000;
        while (Date.now() < gone) { try { process.kill(started.pid, 0); } catch { break; } await sleep(50); }
      } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    }
    const failing = (() => { try { job.launchBreakaway({ exe: path.join(os.tmpdir(), 'pleiad-no-such-node.exe'), args: [], env: process.env, koffi }); return null; } catch (error) { return error; } })();
    t.ok('本物: 起こせなければ CREATE_PROCESS_FAILED と GetLastError が付く', failing?.code === 'CREATE_PROCESS_FAILED' && Number.isInteger(failing.winError), String(failing));
  } else {
    t.ok('本物: Windows 以外では起動の試験をしない', true);
  }
}
