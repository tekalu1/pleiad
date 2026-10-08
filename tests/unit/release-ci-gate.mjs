// タグのリリースが main の CI の結果を使う判定（scripts/release-ci-gate.mjs、docs/release-ci-reuse.md）。
// GitHub は呼ばない。run・jobs は API の形の fixture（2026-10-04 の run 37186441550 の形）で与え、CLI は手元の HTTP サーバーへ向ける。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { evaluate, readState, waitForCi, resolveTagCommit, githubRequest, parseArgs, parseDuration, oneLine, REQUIRED_JOBS, SKIPPED_ON_PUSH, WORKFLOW_PATH } from '../../scripts/release-ci-gate.mjs';

export const name = 'release-ci-gate';
export const title = 'リリースは同じ commit の main の CI の完全な成功だけを使い、赤なら公開しない・揃わなければ全部回す';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO = 'tekalu1/pleiad';
const SHA = '057e676f72f977c5019e827629d38f64fa58aaf1';
const OTHER = 'd0dbf70fae3bd6434b517a748421b7f8f91f72fb';
const WORKFLOW = { id: 364722610, name: 'test', path: WORKFLOW_PATH, state: 'active' };

function run(over = {}) {
  return { id: 37186441550, name: 'test', path: WORKFLOW_PATH, workflow_id: WORKFLOW.id, head_sha: SHA, head_branch: 'main', event: 'push',
    status: 'completed', conclusion: 'success', run_attempt: 2, html_url: 'https://github.com/tekalu1/pleiad/actions/runs/37186441550',
    repository: { full_name: REPO }, head_repository: { full_name: REPO }, ...over };
}
function jobs(r = run(), over = {}) {
  const names = [...REQUIRED_JOBS, 'safe-storage-macos'];
  return names.map((name, i) => ({ id: 111391832999 + i, run_id: r.id, run_attempt: r.run_attempt, head_sha: r.head_sha, name, status: 'completed',
    conclusion: name === 'safe-storage-macos' ? 'skipped' : 'success', ...(over[name] ?? {}) }));
}
const state = (runs, jobsByRun = Object.fromEntries(runs.map(r => [r.id, jobs(r)]))) => ({ repo: REPO, sha: SHA, workflow: WORKFLOW, runs, jobsByRun });

// CLI のログ（::error:: の行を含む）をそのまま詳細に出すと、test.yml の中で本物の注記になる。詳細は JSON.stringify で 1 行にする
export default async function (t) {
  // ===== 1 回分の判定（evaluate）=====
  {
    const ok = evaluate(state([run()]));
    t.ok('揃った成功（最新の attempt で必須の 6 ジョブが success）は reuse', ok.verdict === 'reuse' && ok.run.id === 37186441550, JSON.stringify(ok));

    const wrongSha = evaluate(state([run({ head_sha: OTHER })]));
    t.ok('別の commit の成功は使わない（no-run で fallback）', wrongSha.verdict === 'fallback' && wrongSha.reason === 'no-run' && wrongSha.notes.some(n => n.includes('(sha)')), JSON.stringify(wrongSha));

    const wrongWorkflowId = evaluate(state([run({ workflow_id: 1 })]));
    t.ok('別の workflow（id 違い）の成功は使わない', wrongWorkflowId.verdict === 'fallback' && wrongWorkflowId.notes.some(n => n.includes('(workflow-id)')), JSON.stringify(wrongWorkflowId));
    const wrongPath = evaluate(state([run({ path: '.github/workflows/desktop.yml' })]));
    t.ok('別の workflow（path 違い）の成功は使わない', wrongPath.verdict === 'fallback' && wrongPath.notes.some(n => n.includes('(path)')));
    const renamed = evaluate({ ...state([run()]), workflow: { ...WORKFLOW, path: '.github/workflows/ci.yml' } });
    t.ok('test.yml の名前が変わった workflow は使わない', renamed.verdict === 'fallback' && renamed.reason.startsWith('workflow-path'));
    t.ok('止めた workflow（disabled）は使わない', evaluate({ ...state([run()]), workflow: { ...WORKFLOW, state: 'disabled_manually' } }).verdict === 'fallback');
    t.ok('test.yml が見つからなければ fallback', evaluate({ ...state([]), workflow: null }).reason === 'workflow-missing');
    t.ok('PR・手動の起動は使わない（main への push だけ）', evaluate(state([run({ event: 'pull_request' })])).verdict === 'fallback' && evaluate(state([run({ event: 'workflow_dispatch' })])).verdict === 'fallback');
    t.ok('main 以外の枝は使わない', evaluate(state([run({ head_branch: 'feat/x' })])).verdict === 'fallback');
    t.ok('別のリポジトリ（fork）の run は使わない', evaluate(state([run({ head_repository: { full_name: 'someone/pleiad' } })])).verdict === 'fallback');

    const missing = evaluate(state([]));
    t.ok('同じ commit の run が無ければ fallback（no-run）', missing.verdict === 'fallback' && missing.reason === 'no-run');

    const r = run();
    const partial = evaluate(state([r], { [r.id]: jobs(r).filter(j => j.name !== 'test (windows-latest, 22.13)') }));
    t.ok('必須のジョブが 1 つ欠けた成功は使わない（job-missing）', partial.verdict === 'fallback' && partial.reason === 'job-missing:test (windows-latest, 22.13)', JSON.stringify(partial));
    const skipped = evaluate(state([r], { [r.id]: jobs(r, { 'safe-storage (linux-no-keyring)': { conclusion: 'skipped' } }) }));
    t.ok('必須のジョブが skipped の成功は使わない', skipped.verdict === 'fallback' && skipped.reason === 'job-skipped:safe-storage (linux-no-keyring)');
    const neutral = evaluate(state([r], { [r.id]: jobs(r, { 'test (ubuntu-latest, 24)': { conclusion: 'neutral' } }) }));
    t.ok('必須のジョブが neutral でも使わない', neutral.verdict === 'fallback');
    const empty = evaluate(state([r], { [r.id]: [] }));
    t.ok('jobs が空なら、run が success でも使わない（workflow の総合 success だけでは使わない）', empty.verdict === 'fallback' && empty.reason.startsWith('job-missing'));
    const noJobs = evaluate(state([r], {}));
    t.ok('jobs を読めなかった完了済みの run は使わない', noJobs.verdict === 'fallback' && noJobs.reason === 'jobs-missing');
    const dup = evaluate(state([r], { [r.id]: [...jobs(r), { ...jobs(r)[0], id: 1 }] }));
    t.ok('同じ名前の必須のジョブが 2 つあれば使わない（曖昧）', dup.verdict === 'fallback' && dup.reason.startsWith('job-duplicated'));
    const runNotSuccess = evaluate(state([run({ conclusion: 'neutral' })]));
    t.ok('ジョブが全部 success でも run の結論が success でなければ使わない', runNotSuccess.verdict === 'fallback' && runNotSuccess.reason === 'run-neutral');

    // 最新の attempt
    const rerun = run({ run_attempt: 2 });
    const staleJobs = jobs({ ...rerun, run_attempt: 1 });
    t.ok('古い attempt の jobs が混ざっていれば使わない', evaluate(state([rerun], { [rerun.id]: staleJobs })).reason.startsWith('job-mismatch'));
    const otherShaJobs = jobs({ ...rerun, head_sha: OTHER });
    t.ok('別の commit の jobs は使わない', evaluate(state([rerun], { [rerun.id]: otherShaJobs })).reason.startsWith('job-mismatch'));
    const latestFailed = run({ run_attempt: 2, conclusion: 'failure' });
    const lf = evaluate(state([latestFailed], { [latestFailed.id]: jobs(latestFailed, { 'test (windows-latest, 22.13)': { conclusion: 'failure' } }) }));
    t.ok('最新の attempt が failure なら fail（attempt 1 が成功していても公開しない）', lf.verdict === 'fail' && lf.reason === 'run-failure', JSON.stringify(lf));

    // 赤
    const jobFailed = evaluate(state([run({ conclusion: null, status: 'in_progress' })], { [r.id]: jobs(run({ conclusion: null, status: 'in_progress' }), { 'test (ubuntu-latest, 22.13)': { conclusion: 'failure' }, 'test (windows-latest, 22.13)': { status: 'in_progress', conclusion: null } }) }));
    t.ok('走っている途中でも、終わったジョブが failure なら待たずに fail', jobFailed.verdict === 'fail' && jobFailed.reason === 'job-failure:test (ubuntu-latest, 22.13)', JSON.stringify(jobFailed));
    t.ok('timed_out は fail', evaluate(state([r], { [r.id]: jobs(r, { 'test (windows-latest, 22.13)': { conclusion: 'timed_out' } }) })).verdict === 'fail');
    t.ok('action_required は fail', evaluate(state([run({ conclusion: 'action_required' })])).verdict === 'fail');
    t.ok('startup_failure は fail', evaluate(state([run({ conclusion: 'startup_failure', status: 'completed' })])).verdict === 'fail');
    t.ok('必須でないジョブの failure も fail（main が赤い）', evaluate(state([r], { [r.id]: jobs(r, { 'safe-storage-macos': { conclusion: 'failure' } }) })).verdict === 'fail');
    const two = evaluate(state([run(), run({ id: 2, conclusion: 'failure', html_url: 'x' })]));
    t.ok('同じ commit の run が 2 つあり、片方が赤なら成功があっても fail', two.verdict === 'fail', JSON.stringify(two));

    // 取り消し・未完了
    const cancelled = evaluate(state([run({ conclusion: 'cancelled' })], { [r.id]: jobs(r, { 'test (ubuntu-latest, 22.13)': { conclusion: 'cancelled' } }) }));
    t.ok('cancelled（次の push に取り消された）は fallback', cancelled.verdict === 'fallback', JSON.stringify(cancelled));
    const queued = run({ status: 'queued', conclusion: null });
    t.ok('queued は pending', evaluate(state([queued], {})).verdict === 'pending');
    const progress = run({ status: 'in_progress', conclusion: null });
    t.ok('in_progress は pending（成功したジョブがあっても使わない）', evaluate(state([progress], { [progress.id]: jobs(progress, { 'test (windows-latest, 22.13)': { status: 'in_progress', conclusion: null } }) })).verdict === 'pending');
    const done = run();
    const other = run({ id: 37186441599, status: 'in_progress', conclusion: null });
    const both = evaluate(state([done, other], { [done.id]: jobs(done), [other.id]: jobs(other, { 'test (windows-latest, 22.13)': { status: 'in_progress', conclusion: null } }) }));
    t.ok('揃った成功と、別の id の走っている run が並べば、待つ', both.verdict === 'pending' && both.run.id === other.id, JSON.stringify(both.notes));

    // 必須でないジョブ: push で飛ばすと決めたものの skipped と success だけを許す
    t.ok('push で飛ばすジョブ（safe-storage-macos）の skipped は reuse を妨げない', evaluate(state([r])).verdict === 'reuse');
    const extra = (conclusion, name = 'test (windows-latest, 24)') => evaluate(state([r], { [r.id]: [...jobs(r), { ...jobs(r)[0], id: 9, name, conclusion }] }));
    t.ok('test.yml に足したジョブが success なら reuse を妨げない', extra('success').verdict === 'reuse');
    for (const conclusion of ['cancelled', 'skipped', 'neutral', null]) {
      const x = extra(conclusion);
      t.ok(`test.yml に足した必須でないジョブが ${conclusion} なら reuse にしない`, x.verdict === 'fallback' && x.reason === `job-${conclusion}:test (windows-latest, 24)`, x.reason);
    }
    t.ok('push で飛ばすジョブでも cancelled なら reuse にしない', extra('cancelled', 'safe-storage-macos').verdict === 'fallback');
  }

  // ===== 期限つきの待ち（waitForCi）=====
  {
    const clock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
    const seq = list => { let i = 0; return async () => { const x = list[Math.min(i++, list.length - 1)]; if (x instanceof Error) throw x; return x; }; };
    const pending = state([run({ status: 'in_progress', conclusion: null })], {});
    const failed = state([run({ conclusion: 'failure' })]);
    const same = async r => r;

    let c = clock();
    const done = await waitForCi({ read: seq([pending, pending, state([run()])]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('終わるまで待ち、揃った成功になれば reuse', done.verdict === 'reuse' && c.now() === 60_000, `${done.verdict} ${c.now()}`);
    c = clock();
    const red = await waitForCi({ read: seq([pending, failed]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('待つ間に赤くなれば fail', red.verdict === 'fail');
    c = clock();
    const late = await waitForCi({ read: seq([pending]), confirm: same, deadlineMs: 120_000, intervalMs: 30_000, ...c });
    t.ok('期限までに終わらなければ fallback（pending-deadline）。reuse にはしない', late.verdict === 'fallback' && late.reason.startsWith('pending-deadline') && c.now() <= 120_000, `${late.reason} ${c.now()}`);
    c = clock();
    const appears = await waitForCi({ read: seq([state([]), state([]), state([run()])]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, missingGraceMs: 300_000, ...c });
    t.ok('始めの猶予の間は run が無いのも待ち、現れた成功を使う（タグと main を同時に push したとき）', appears.verdict === 'reuse' && c.now() === 60_000, `${appears.verdict} ${c.now()}`);
    c = clock();
    const never = await waitForCi({ read: seq([state([])]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, missingGraceMs: 300_000, ...c });
    t.ok('猶予を過ぎても run が無ければ fallback（no-run）', never.verdict === 'fallback' && never.reason === 'no-run' && c.now() >= 300_000 && c.now() < 600_000, `${never.reason} ${c.now()}`);
    c = clock();
    const errors = await waitForCi({ read: seq([new Error('GET x returned 502')]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('API の失敗が続けば fallback（api-error）。テストを省く方へは倒さない', errors.verdict === 'fallback' && errors.reason === 'api-error');
    c = clock();
    const blip = await waitForCi({ read: seq([new Error('GET x returned 502'), state([run()])]), confirm: same, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('一時の API の失敗の後に読めれば、その結果を使う', blip.verdict === 'reuse');
    c = clock();
    const errLate = await waitForCi({ read: seq([new Error('GET x returned 502')]), confirm: same, deadlineMs: 0, intervalMs: 30_000, ...c });
    t.ok('期限の時点で API が失敗していても fallback（api-error）', errLate.verdict === 'fallback' && errLate.reason === 'api-error', errLate.reason);

    // jobs を読んだ後に再実行が始まる（TOCTOU）: reuse の直前に run を読み直し、attempt が変わっていれば待ちに戻る
    const rerunning = r => ({ ...r, run_attempt: r.run_attempt + 1, status: 'in_progress', conclusion: null });
    c = clock();
    const confirms = [];
    const raced = await waitForCi({ read: seq([state([run()]), state([run({ run_attempt: 3, conclusion: 'failure' })])]), confirm: async r => { confirms.push(r.run_attempt); return rerunning(r); }, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('TOCTOU: 読み直した run の attempt が進んでいれば reuse にせず、新しい attempt が赤なら fail', raced.verdict === 'fail' && confirms.join() === '2' && c.now() === 30_000, `${raced.verdict} ${raced.reason} ${c.now()}`);
    c = clock();
    const racedOk = await waitForCi({ read: seq([state([run()]), state([run({ run_attempt: 3 })])]), confirm: async r => (r.run_attempt === 2 ? rerunning(r) : r), deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('TOCTOU: 新しい attempt が揃った成功になれば、その attempt で reuse', racedOk.verdict === 'reuse' && racedOk.run.run_attempt === 3, `${racedOk.verdict} ${racedOk.run?.run_attempt}`);
    c = clock();
    const racedLate = await waitForCi({ read: seq([state([run()])]), confirm: async r => rerunning(r), deadlineMs: 60_000, intervalMs: 30_000, ...c });
    t.ok('TOCTOU: 期限まで変わり続ければ fallback（pending-deadline:run-changed）', racedLate.verdict === 'fallback' && racedLate.reason.startsWith('pending-deadline:run-changed') && racedLate.notes.some(n => n.includes('changed after the jobs were read')), racedLate.reason);
    c = clock();
    const gone = await waitForCi({ read: seq([state([run()])]), confirm: async () => null, deadlineMs: 0, intervalMs: 30_000, ...c });
    t.ok('TOCTOU: 読み直しで run が見つからなければ reuse にしない', gone.verdict === 'fallback' && gone.reason.includes('run-changed'), gone.reason);
    for (const conclusion of ['failure', 'timed_out', 'action_required', 'startup_failure']) {
      c = clock();
      const confirmedRed = await waitForCi({ read: seq([state([run()])]), confirm: async r => ({ ...r, run_attempt: 3, conclusion }), deadlineMs: 0, intervalMs: 30_000, ...c });
      t.ok(`TOCTOU: 再照合で ${conclusion} を確認したら期限切れでも公開を止める`, confirmedRed.verdict === 'fail' && confirmedRed.run.run_attempt === 3 && c.now() === 0, confirmedRed.reason);
    }
    for (const latest of [{ workflow_id: 1 }, { path: '.github/workflows/other.yml' }, { event: 'workflow_dispatch' }, { head_branch: 'other' }, { repository: { full_name: 'other/repo' } }]) {
      c = clock();
      const wrongIdentity = await waitForCi({ read: seq([state([run()])]), confirm: async r => ({ ...r, ...latest }), deadlineMs: 0, intervalMs: 30_000, ...c });
      t.ok('TOCTOU: 再照合の workflow・イベント・ブランチ・リポジトリも一致が必要', wrongIdentity.verdict === 'fallback', JSON.stringify(latest));
    }
    for (const [label, latest] of [['結論が success でない', { conclusion: 'failure' }], ['別の commit', { head_sha: OTHER }], ['完了していない', { status: 'in_progress' }]]) {
      c = clock();
      const x = await waitForCi({ read: seq([state([run()])]), confirm: async r => ({ ...r, ...latest }), deadlineMs: 0, intervalMs: 30_000, ...c });
      t.ok(`TOCTOU: 読み直した run が${label}なら reuse にしない`, x.verdict !== 'reuse', x.reason);
    }
    c = clock();
    const confirmFails = await waitForCi({ read: seq([state([run()])]), confirm: async () => { throw new Error('GET x timed out after 20000 ms'); }, deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('TOCTOU: 読み直しの API が失敗し続ければ fallback（api-error）', confirmFails.verdict === 'fallback' && confirmFails.reason === 'api-error');

    // 直接呼ぶときも時間の値を検める（NaN・Infinity・負、間隔 0 の空回り）。期限 0 は許す
    const base = { read: seq([state([run()])]), confirm: same, deadlineMs: 1000, intervalMs: 1000 };
    const bad = [{ deadlineMs: NaN }, { deadlineMs: Infinity }, { deadlineMs: -1 }, { intervalMs: 0 }, { intervalMs: NaN }, { intervalMs: Infinity }, { intervalMs: -5 },
      { missingGraceMs: -1 }, { missingGraceMs: Infinity }, { deadlineMs: '1000' }, { maxErrors: 0 }, { confirm: undefined }];
    let rejected = 0;
    for (const over of bad) { try { await waitForCi({ ...base, ...over }); } catch { rejected += 1; } }
    t.ok('waitForCi: NaN・Infinity・負・文字列の時間、間隔 0、maxErrors 0、confirm 無しは例外', rejected === bad.length, `${rejected} / ${bad.length}`);
    t.ok('waitForCi: 期限 0 は許す', (await waitForCi({ ...base, deadlineMs: 0 })).verdict === 'reuse');
  }

  // ===== CLI の引数 =====
  {
    t.ok('parseArgs: 知っている引数を読む', JSON.stringify(parseArgs(['--tag', 'v1.0.0', '--wait-minutes', '3'])) === JSON.stringify({ tag: 'v1.0.0', 'wait-minutes': '3' }));
    const throws = fn => { try { fn(); return false; } catch { return true; } };
    t.ok('parseArgs: 知らない引数（綴りの間違い）は拒む', throws(() => parseArgs(['--wait-minute', '3'])) && throws(() => parseArgs(['tag', 'v1.0.0'])));
    t.ok('parseArgs: 同じ引数の 2 回目は拒む', throws(() => parseArgs(['--wait-minutes', '3', '--wait-minutes', '4'])));
    t.ok('parseArgs: 値の無い引数は拒む', throws(() => parseArgs(['--tag'])) && throws(() => parseArgs(['--tag', '--repo', 'a/b'])));
    t.ok('parseArgs: __proto__ などの名前も拒む', throws(() => parseArgs(['--__proto__', 'x'])) && throws(() => parseArgs(['--constructor', 'x'])));
    t.ok('parseDuration: 10 進の 0 以上の数・既定値', parseDuration('w', '0', 40) === 0 && parseDuration('w', '1.5', 40) === 1.5 && parseDuration('w', undefined, 40) === 40);
    const badText = ['NaN', 'Infinity', '-1', '', ' 1', '1e3', '0x10', '1.', 'abc'];
    t.ok('parseDuration: NaN・Infinity・負・空・指数・16 進は拒む', badText.every(x => throws(() => parseDuration('w', x, 40))), badText.filter(x => !throws(() => parseDuration('w', x, 40))).join(','));
    t.ok('parseDuration: 間隔などの正の値に 0 は拒む', throws(() => parseDuration('i', '0', 30, { positive: true })) && throws(() => parseDuration('i', '0.0', 30, { positive: true })));
  }

  // ===== API の読み方（readState）=====
  {
    const calls = [];
    const r = run();
    const responses = {
      [`/repos/${REPO}/actions/workflows/test.yml`]: WORKFLOW,
      [`/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`]: { total_count: 2, workflow_runs: [r, run({ id: 5, head_sha: OTHER })] },
      [`/repos/${REPO}/actions/runs/${r.id}/attempts/2/jobs?per_page=100`]: { total_count: 7, jobs: jobs(r) },
    };
    const request = async p => { calls.push(p); return p in responses ? responses[p] : null; };
    const s = await readState({ request, repo: REPO, sha: SHA });
    t.ok('workflow を名前で引き、その id・commit・push・main で run を絞る', calls[1] === `/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`, calls.join(' '));
    t.ok('jobs は run の最新の attempt の番号で読む', calls.includes(`/repos/${REPO}/actions/runs/${r.id}/attempts/2/jobs?per_page=100`));
    t.ok('別の commit の run の jobs は読まない', !calls.some(p => p.includes('/runs/5/')));
    t.ok('読んだ状態の判定は reuse', evaluate(s).verdict === 'reuse');
    const nothing = await readState({ request: async () => null, repo: REPO, sha: SHA });
    t.ok('workflow が 404 なら workflow-missing', evaluate(nothing).reason === 'workflow-missing');
    // 失敗したジョブだけの再実行（run 37186441550 の形）: attempt 1 は Windows の脚が failure、attempt 2 は 7 件すべて run_attempt 2 で success
    const rerun = run({ run_attempt: 2 });
    const attempt1 = jobs({ ...rerun, run_attempt: 1 }, { 'test (windows-latest, 22.13)': { conclusion: 'failure' } });
    const rerunCalls = [];
    const rerunResponses = {
      [`/repos/${REPO}/actions/workflows/test.yml`]: WORKFLOW,
      [`/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`]: { total_count: 1, workflow_runs: [rerun] },
      [`/repos/${REPO}/actions/runs/${rerun.id}/attempts/1/jobs?per_page=100`]: { total_count: 7, jobs: attempt1 },
      [`/repos/${REPO}/actions/runs/${rerun.id}/attempts/2/jobs?per_page=100`]: { total_count: 7, jobs: jobs(rerun) },
    };
    const rerunState = await readState({ request: async p => { rerunCalls.push(p); return p in rerunResponses ? rerunResponses[p] : null; }, repo: REPO, sha: SHA });
    t.ok('再実行: attempt 1 の失敗は読まず、最新の attempt 2 の jobs だけで reuse', evaluate(rerunState).verdict === 'reuse' && !rerunCalls.some(p => p.includes('/attempts/1/')) && rerunCalls.some(p => p.includes('/attempts/2/')), rerunCalls.join(' '));
    const stillRed = { ...rerunResponses, [`/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs?head_sha=${SHA}&event=push&branch=main&per_page=100`]: { total_count: 1, workflow_runs: [run({ run_attempt: 1, conclusion: 'failure' })] } };
    const redState = await readState({ request: async p => (p in stillRed ? stillRed[p] : null), repo: REPO, sha: SHA });
    t.ok('再実行の前（最新が attempt 1 の失敗）なら fail', evaluate(redState).verdict === 'fail' && evaluate(redState).reason === 'run-failure');

    let threw = false;
    try { await readState({ request: async p => p.endsWith('test.yml') ? WORKFLOW : { total_count: 101, workflow_runs: [] }, repo: REPO, sha: SHA }); } catch { threw = true; }
    t.ok('1 ページに収まらない件数は例外（一部だけで判定しない）', threw);

    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return { status: 500, ok: false, json: async () => ({}) }; };
    let message = '';
    try { await githubRequest({ token: 'secret-value', fetchImpl })('/repos/a/b/actions/runs?head_sha=x'); } catch (err) { message = err.message; }
    t.ok('API の失敗の文にトークンと問い合わせの値を入れない', message === 'GET /repos/a/b/actions/runs returned 500', message);
    t.ok('トークンは Authorization の見出しでだけ渡す', seen[0].init.headers.Authorization === 'Bearer secret-value' && !seen[0].url.includes('secret-value'));

    const stuck = http.createServer((req, res) => {
      if (req.url.startsWith('/body')) { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":'); }
      // /headers は何も返さない
    });
    await new Promise(r => stuck.listen(0, '127.0.0.1', r));
    try {
      const request = githubRequest({ token: 'secret-value', apiUrl: `http://127.0.0.1:${stuck.address().port}`, timeoutMs: 200 });
      for (const kind of ['headers', 'body']) {
        const t0 = Date.now();
        let err = null;
        try { await request(`/${kind}?head_sha=x`); } catch (e) { err = e; }
        const ms = Date.now() - t0;
        t.ok(`githubRequest: ${kind === 'headers' ? '応答の見出しが来ない' : '本文が終わらない'}ときは timeoutMs で打ち切る`, err && /timed out after 200 ms/.test(err.message) && ms < 5000, `${err?.message} ${ms} ms`);
        t.ok(`githubRequest: 時間切れの文に問い合わせの値とトークンを入れない（${kind}）`, err && !err.message.includes('head_sha') && !err.message.includes('secret-value'));
      }
      let rejected = 0;
      for (const timeoutMs of [0, -1, NaN, Infinity]) { try { githubRequest({ token: 'x', timeoutMs }); } catch { rejected += 1; } }
      t.ok('githubRequest: 0・負・NaN・Infinity の timeoutMs は例外', rejected === 4, rejected);
    } finally {
      stuck.closeAllConnections();
      stuck.close();
    }
  }

  // ===== タグを commit に解く（注釈つきのタグは剥がす）=====
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-release-gate-'));
  try {
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'a');
    const first = git('rev-parse', 'HEAD');
    git('tag', '-a', 'v1.2.3', '-m', 'release');
    git('commit', '-q', '--allow-empty', '-m', 'b');
    git('tag', 'v1.2.4-beta.1');
    const tagObject = git('rev-parse', 'refs/tags/v1.2.3');
    t.ok('注釈つきのタグは、タグのオブジェクトではなく指す commit', resolveTagCommit('v1.2.3', dir) === first && tagObject !== first, `${tagObject} → ${first}`);
    t.ok('軽量のタグもその commit', resolveTagCommit('v1.2.4-beta.1', dir) === git('rev-parse', 'HEAD'));
    let bad = 0;
    for (const tag of ['main', 'v1.2.3^{tree}', '--help', 'v9.9.9']) { try { resolveTagCommit(tag, dir); } catch { bad += 1; } }
    t.ok('リリースのタグの形でない・無いタグは例外', bad === 4, bad);

    // ===== CLI（手元の HTTP サーバーを GitHub の API の代わりにする）=====
    const sha = first;
    const BASE = ['--tag', 'v1.2.3', '--repo', REPO, '--wait-minutes', '0', '--interval-seconds', '1', '--missing-grace-minutes', '0'];
    const cli = async (scenario, extra = [], { args = [...BASE, ...extra] } = {}) => {
      const hits = [];
      const server = http.createServer((req, res) => {
        hits.push({ url: req.url, auth: req.headers.authorization, method: req.method });
        const body = scenario(req.url.split('?')[0], sha);
        if (body == null) { res.writeHead(body === null ? 404 : 500); return res.end('{}'); }
        if (body.hang === 'headers') return;
        if (body.hang === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); return res.write('{"id":'); }
        if (body.httpStatus) { res.writeHead(body.httpStatus); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const out = path.join(dir, `out-${hits.length}-${Math.random().toString(36).slice(2)}.txt`);
      await fs.writeFile(out, '');
      try {
        const t0 = Date.now();
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts/release-ci-gate.mjs'), ...args], {
          cwd: dir, env: { ...process.env, GITHUB_TOKEN: 'test-token-value', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
        });
        let log = '';
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        const code = await new Promise(r => child.on('close', r));
        return { code, log, output: await fs.readFile(out, 'utf8'), hits, ms: Date.now() - t0 };
      } finally {
        server.closeAllConnections();
        server.close();
      }
    };
    // latest(run) は reuse の直前の読み直し（GET /actions/runs/<id>）が返す run。既定は一覧と同じ
    const api = (runs, jobsFor = r => jobs(r), latest = r => r) => (p, s) => {
      if (p === `/repos/${REPO}/actions/workflows/test.yml`) return WORKFLOW;
      if (p === `/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs`) { const list = runs(s); return { total_count: list.length, workflow_runs: list }; }
      const m = p.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
      if (m) { const r = runs(s).find(x => String(x.id) === m[1]); return r ? { total_count: jobsFor(r).length, jobs: jobsFor(r) } : null; }
      const one = p.match(/\/actions\/runs\/(\d+)$/);
      if (one) { const r = runs(s).find(x => String(x.id) === one[1]); return r ? latest(r) : null; }
      return null;
    };

    const ok = await cli(api(s => [run({ head_sha: s })]));
    t.ok('CLI: 揃った成功なら decision=reuse と commit を出し、終了コード 0', ok.code === 0 && ok.output.includes('decision=reuse\n') && ok.output.includes(`sha=${sha}\n`), JSON.stringify(ok.log + ok.output));
    t.ok('CLI: reuse の直前に run を読み直す', ok.hits.some(h => h.url === `/repos/${REPO}/actions/runs/37186441550`));
    t.ok('CLI: トークンは見出しで渡し、ログ・出力に出さない', ok.hits.every(h => h.auth === 'Bearer test-token-value' && h.method === 'GET') && !ok.log.includes('test-token-value') && !ok.output.includes('test-token-value'));

    const red = await cli(api(s => [run({ head_sha: s, conclusion: 'failure' })]));
    t.ok('CLI: main の CI が赤なら終了コード 1、decision を出さない（release のジョブが走らない）', red.code === 1 && !red.output.includes('decision=') && /main CI is red/.test(red.log), JSON.stringify(red.log + red.output));
    const latestRed = await cli(api(s => [run({ head_sha: s, run_attempt: 3, conclusion: 'failure' })], r => jobs(r, { 'test (windows-latest, 22.13)': { conclusion: 'failure' } })));
    t.ok('CLI: 最新の attempt が赤なら終了コード 1', latestRed.code === 1 && latestRed.hits.some(h => h.url.includes('/attempts/3/jobs')));

    const cancelled = await cli(api(s => [run({ head_sha: s, conclusion: 'cancelled' })], r => jobs(r, { 'test (ubuntu-latest, 22.13)': { conclusion: 'cancelled' } })));
    t.ok('CLI: cancelled なら decision=fallback（release の中で全部回す）', cancelled.code === 0 && cancelled.output.includes('decision=fallback\n'), JSON.stringify(cancelled.output));
    const none = await cli(api(() => []));
    t.ok('CLI: run が無ければ decision=fallback', none.code === 0 && none.output.includes('decision=fallback\n') && none.output.includes('reason=no-run'));
    const wrong = await cli(api(() => [run({ head_sha: OTHER })]));
    t.ok('CLI: 別の commit の成功しか無ければ decision=fallback', wrong.code === 0 && wrong.output.includes('decision=fallback\n'));
    const partial = await cli(api(s => [run({ head_sha: s })], r => jobs(r).filter(j => !j.name.startsWith('safe-storage ('))));
    t.ok('CLI: 一部のジョブだけの成功なら decision=fallback', partial.code === 0 && partial.output.includes('decision=fallback\n'));
    const pending = await cli(api(s => [run({ head_sha: s, status: 'in_progress', conclusion: null })], () => []));
    t.ok('CLI: 期限までに終わらなければ decision=fallback（pending-deadline）', pending.code === 0 && pending.output.includes('decision=fallback\n') && pending.output.includes('reason=pending-deadline'), JSON.stringify(pending.output));
    const denied = await cli(() => ({ httpStatus: 403 }));
    t.ok('CLI: API が 403 を返し続ければ decision=fallback（api-error）。reuse にしない', denied.code === 0 && denied.output.includes('decision=fallback\n') && denied.output.includes('reason=api-error'), JSON.stringify(denied.output));
    const EVIL = 'x\r\ndecision=reuse\n::warning::injected\u2028::set-output name=decision::reuse';
    const evilJobs = conclusion => r => [...jobs(r), { ...jobs(r)[0], id: 9, name: EVIL, conclusion }];
    const injected = await cli(api(s => [run({ head_sha: s })], evilJobs('cancelled')));
    const outLines = injected.output.split('\n').filter(Boolean);
    t.ok('CLI: ジョブの名前に改行と decision=reuse が入っていても、GITHUB_OUTPUT の decision は最後の 1 行の fallback だけ', injected.code === 0 && outLines.filter(l => l.startsWith('decision=')).length === 1 && outLines.at(-1) === 'decision=fallback' && outLines.length === 3, JSON.stringify(outLines));
    t.ok('CLI: ログに行頭が :: の行（workflow command）を作らない', !injected.log.split(/\r?\n/).some(l => l.startsWith('::')), JSON.stringify(injected.log));
    const injectedRed = await cli(api(s => [run({ head_sha: s })], evilJobs('failure')));
    const redLines = injectedRed.log.split(/\r?\n/).filter(l => l.startsWith('::'));
    t.ok('CLI: 赤のときも、行頭が :: なのは自分の ::error:: の 1 行だけ', injectedRed.code === 1 && redLines.length === 1 && redLines[0].startsWith('::error::main CI is red') && !injectedRed.output.includes('decision='), JSON.stringify(redLines));
    t.ok('oneLine: CR・LF・U+2028 などの区切りを空白にする', oneLine('a\r\nb\u2028c\u0085d\te') === 'a b c d e');

    const raced = await cli(api(s => [run({ head_sha: s })], undefined, r => ({ ...r, run_attempt: 3, status: 'in_progress', conclusion: null })));
    t.ok('CLI: jobs を読んだ後に再実行が始まっていれば reuse にしない（期限 0 なので fallback）', raced.code === 0 && raced.output.includes('decision=fallback\n') && raced.output.includes('reason=pending-deadline:run-changed'), JSON.stringify(raced.output));
    for (const hang of ['headers', 'body']) {
      const stuck = await cli(() => ({ hang }), ['--request-timeout-seconds', '0.2']);
      t.ok(`CLI: API の${hang === 'headers' ? '応答' : '本文'}が止まっても、有限の時間で decision=fallback（api-error）`, stuck.code === 0 && stuck.output.includes('decision=fallback\n') && stuck.output.includes('reason=api-error') && stuck.ms < 15_000, `${JSON.stringify(stuck.output)} ${stuck.ms} ms`);
    }

    // 引数の誤りは終了コード 2（ジョブが落ちて公開しない）。GitHub は呼ばない
    const ARGS_REJECTED = [
      ['知らない引数', [...BASE, '--wait-minute', '3']],
      ['同じ引数の 2 回目', [...BASE, '--wait-minutes', '3']],
      ['NaN の期限', ['--tag', 'v1.2.3', '--repo', REPO, '--wait-minutes', 'NaN']],
      ['Infinity の期限', ['--tag', 'v1.2.3', '--repo', REPO, '--wait-minutes', 'Infinity']],
      ['負の猶予', ['--tag', 'v1.2.3', '--repo', REPO, '--missing-grace-minutes', '-1']],
      ['間隔 0', ['--tag', 'v1.2.3', '--repo', REPO, '--interval-seconds', '0']],
      ['時間切れ 0', ['--tag', 'v1.2.3', '--repo', REPO, '--request-timeout-seconds', '0']],
    ];
    for (const [label, args] of ARGS_REJECTED) {
      const x = await cli(api(s => [run({ head_sha: s })]), [], { args });
      t.ok(`CLI: ${label}は終了コード 2、decision を出さず GitHub を呼ばない`, x.code === 2 && !x.output.includes('decision=') && x.hits.length === 0, `${x.code} ${JSON.stringify(x.log)}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // ===== test.yml・evaluation-release.yml との突き合わせ =====
  {
    const testYml = parse(await fs.readFile(path.join(ROOT, WORKFLOW_PATH), 'utf8'));
    const onPush = job => job.if == null || job.if === "github.event_name != 'schedule'";
    const known = new Set([undefined, "github.event_name != 'schedule'", "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"]);
    const unknown = Object.entries(testYml.jobs).filter(([, job]) => !known.has(job.if)).map(([id]) => id);
    t.ok('test.yml の各ジョブの if は、push で走るかを判定できる形', unknown.length === 0, unknown.join(', '));
    const names = [];
    for (const [id, job] of Object.entries(testYml.jobs)) {
      if (!onPush(job)) continue;
      const include = job.strategy?.matrix?.include;
      if (!include) { names.push(job.name ?? id); continue; }
      for (const m of include) names.push(job.name ? job.name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g, (_, k) => m[k]) : `${id} (${Object.values(m).join(', ')})`);
    }
    t.ok('REQUIRED_JOBS は test.yml が main の push で回すジョブ全部と一致（matrix を変えたらここで落ちる）', JSON.stringify([...names].sort()) === JSON.stringify([...REQUIRED_JOBS].sort()), names.join(' | '));
    t.ok('test.yml は main の push で走る', testYml.on.push.branches.includes('main'));
    // 落ちた suite だけを 1 回流し直した run も、ジョブが success で終わる（注釈は結論を変えない）ので、evaluate はそのまま reuse と読む。流し直しの設定が外れていないことをここで固める
    const testSteps = testYml.jobs.test.steps.map(s => s.run).filter(Boolean);
    t.ok('test.yml の npm test の脚は、落ちた suite だけを 1 回流し直す（--retry-failed 1。docs/adr/0162）', testSteps.some(r => /^node tests\/run\.mjs.*--retry-failed 1/.test(r)), testSteps.join(' | '));
    const conc = testYml.concurrency;
    const groupOf = (event, ref, sha) => String(conc.group).replace(/\$\{\{[^}]*\}\}/, event === "pull_request" ? ref : sha);
    t.ok('test.yml: main への push は後の push で取り消さない（cancel-in-progress は PR だけ）', String(conc['cancel-in-progress']) === "${{ github.event_name == 'pull_request' }}", String(conc['cancel-in-progress']));
    t.ok('test.yml: push の group は commit ごと（待ちの run が次の push に取り消されない）・PR は PR ごと', groupOf('push', 'refs/heads/main', 'aaa') !== groupOf('push', 'refs/heads/main', 'bbb') && groupOf('pull_request', 'refs/pull/1/merge', 'aaa') === groupOf('pull_request', 'refs/pull/1/merge', 'bbb'), String(conc.group));
    const skipped = Object.entries(testYml.jobs).filter(([, job]) => !onPush(job)).map(([id, job]) => job.name ?? id);
    t.ok('SKIPPED_ON_PUSH は test.yml が push で飛ばすジョブと一致', JSON.stringify(skipped.sort()) === JSON.stringify([...SKIPPED_ON_PUSH].sort()), skipped.join(' | '));

    const rel = parse(await fs.readFile(path.join(ROOT, '.github/workflows/evaluation-release.yml'), 'utf8'));
    const gate = rel.jobs['ci-gate'];
    const release = rel.jobs.release;
    t.ok('照合のジョブは actions: read と contents: read だけ', JSON.stringify(gate.permissions) === JSON.stringify({ actions: 'read', contents: 'read' }), JSON.stringify(gate.permissions));
    t.ok('照合のジョブのトークンは github.token（秘密を渡さない）', JSON.stringify(gate.steps).includes('${{ github.token }}') && !JSON.stringify(gate).includes('secrets.'));
    t.ok('公開のジョブは照合のジョブを待つ（赤なら走らない）', release.needs === 'ci-gate' || (Array.isArray(release.needs) && release.needs.includes('ci-gate')));
    const steps = release.steps;
    const full = steps.findIndex(s => s.run === 'node tests/run.mjs --jobs 2 --retry-failed 1');
    const smoke = steps.findIndex(s => /Release environment smoke/.test(s.name ?? ''));
    const publish = steps.findIndex(s => /publish/i.test(s.name ?? ''));
    t.ok('全部のテストは reuse 以外のすべてで回る（空・想定外の値でも省かない）', steps[full]?.if === "needs.ci-gate.outputs.decision != 'reuse'", steps[full]?.if);
    t.ok('reuse のときは release の環境の短い検査を回す', steps[smoke]?.if === "needs.ci-gate.outputs.decision == 'reuse'" && /require\('koffi'\)/.test(steps[smoke].run));
    t.ok('テストと短い検査は公開の前', full >= 0 && smoke >= 0 && full < publish && smoke < publish);
    t.ok('公開のジョブは照合した commit と checkout が同じかを確かめる', steps.some(s => /CI_SHA/.test(s.run ?? '')) && /needs\.ci-gate\.outputs\.sha/.test(release.env.CI_SHA));
    const winNode = testYml.jobs.test.strategy.matrix.include.find(m => m.os === 'windows-latest').node;
    const relNode = steps.find(s => String(s.uses).startsWith('actions/setup-node'))?.with?.['node-version'];
    t.ok('release の Node は test.yml の Windows の脚と同じ版', String(relNode) === String(winNode), `${relNode} / ${winNode}`);
  }
}
