// タグのリリースが main の CI の結果を使う判定（scripts/release-ci-gate.mjs、docs/release-ci-reuse.md）。
// GitHub は呼ばない。run・jobs は API の形の fixture（2026-10-04 の run 37186441550 の形）で与え、CLI は手元の HTTP サーバーへ向ける。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { evaluate, readState, waitForCi, resolveTagCommit, githubRequest, REQUIRED_JOBS, WORKFLOW_PATH } from '../../scripts/release-ci-gate.mjs';

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
    const recovered = run({ run_attempt: 2 });
    t.ok('attempt 1 が失敗でも、再実行した最新の attempt 2 が揃った成功なら reuse', evaluate(state([recovered])).verdict === 'reuse');

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
    t.ok('揃った成功と走っている run が並べば、待つ', evaluate(state([run(), progress], { [run().id]: jobs(run()) })).verdict === 'pending');
  }

  // ===== 期限つきの待ち（waitForCi）=====
  {
    const clock = () => { let now = 0; return { now: () => now, sleep: async ms => { now += ms; } }; };
    const seq = list => { let i = 0; return async () => { const x = list[Math.min(i++, list.length - 1)]; if (x instanceof Error) throw x; return x; }; };
    const pending = state([run({ status: 'in_progress', conclusion: null })], {});
    const failed = state([run({ conclusion: 'failure' })]);

    let c = clock();
    const done = await waitForCi({ read: seq([pending, pending, state([run()])]), deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('終わるまで待ち、揃った成功になれば reuse', done.verdict === 'reuse' && c.now() === 60_000, `${done.verdict} ${c.now()}`);
    c = clock();
    const red = await waitForCi({ read: seq([pending, failed]), deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('待つ間に赤くなれば fail', red.verdict === 'fail');
    c = clock();
    const late = await waitForCi({ read: seq([pending]), deadlineMs: 120_000, intervalMs: 30_000, ...c });
    t.ok('期限までに終わらなければ fallback（pending-deadline）。reuse にはしない', late.verdict === 'fallback' && late.reason.startsWith('pending-deadline') && c.now() <= 120_000, `${late.reason} ${c.now()}`);
    c = clock();
    const appears = await waitForCi({ read: seq([state([]), state([]), state([run()])]), deadlineMs: 600_000, intervalMs: 30_000, missingGraceMs: 300_000, ...c });
    t.ok('始めの猶予の間は run が無いのも待ち、現れた成功を使う（タグと main を同時に push したとき）', appears.verdict === 'reuse' && c.now() === 60_000, `${appears.verdict} ${c.now()}`);
    c = clock();
    const never = await waitForCi({ read: seq([state([])]), deadlineMs: 600_000, intervalMs: 30_000, missingGraceMs: 300_000, ...c });
    t.ok('猶予を過ぎても run が無ければ fallback（no-run）', never.verdict === 'fallback' && never.reason === 'no-run' && c.now() >= 300_000 && c.now() < 600_000, `${never.reason} ${c.now()}`);
    c = clock();
    const errors = await waitForCi({ read: seq([new Error('GET x returned 502')]), deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('API の失敗が続けば fallback（api-error）。テストを省く方へは倒さない', errors.verdict === 'fallback' && errors.reason === 'api-error');
    c = clock();
    const blip = await waitForCi({ read: seq([new Error('GET x returned 502'), state([run()])]), deadlineMs: 600_000, intervalMs: 30_000, ...c });
    t.ok('一時の API の失敗の後に読めれば、その結果を使う', blip.verdict === 'reuse');
    c = clock();
    const errLate = await waitForCi({ read: seq([new Error('GET x returned 502')]), deadlineMs: 0, intervalMs: 30_000, ...c });
    t.ok('期限の時点で API が失敗していても fallback（api-error）', errLate.verdict === 'fallback' && errLate.reason === 'api-error', errLate.reason);
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
    let threw = false;
    try { await readState({ request: async p => p.endsWith('test.yml') ? WORKFLOW : { total_count: 101, workflow_runs: [] }, repo: REPO, sha: SHA }); } catch { threw = true; }
    t.ok('1 ページに収まらない件数は例外（一部だけで判定しない）', threw);

    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url, init }); return { status: 500, ok: false, json: async () => ({}) }; };
    let message = '';
    try { await githubRequest({ token: 'secret-value', fetchImpl })('/repos/a/b/actions/runs?head_sha=x'); } catch (err) { message = err.message; }
    t.ok('API の失敗の文にトークンと問い合わせの値を入れない', message === 'GET /repos/a/b/actions/runs returned 500', message);
    t.ok('トークンは Authorization の見出しでだけ渡す', seen[0].init.headers.Authorization === 'Bearer secret-value' && !seen[0].url.includes('secret-value'));
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
    const cli = async (scenario, extra = []) => {
      const hits = [];
      const server = http.createServer((req, res) => {
        hits.push({ url: req.url, auth: req.headers.authorization, method: req.method });
        const body = scenario(req.url.split('?')[0], sha);
        if (body == null) { res.writeHead(body === null ? 404 : 500); return res.end('{}'); }
        if (body.status) { res.writeHead(body.status); return res.end('{}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
      const out = path.join(dir, `out-${hits.length}-${Math.random().toString(36).slice(2)}.txt`);
      await fs.writeFile(out, '');
      try {
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts/release-ci-gate.mjs'), '--tag', 'v1.2.3', '--repo', REPO, '--wait-minutes', '0', '--interval-seconds', '0', '--missing-grace-minutes', '0', ...extra], {
          cwd: dir, env: { ...process.env, GITHUB_TOKEN: 'test-token-value', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' },
        });
        let log = '';
        child.stdout.on('data', d => { log += d; });
        child.stderr.on('data', d => { log += d; });
        const code = await new Promise(r => child.on('close', r));
        return { code, log, output: await fs.readFile(out, 'utf8'), hits };
      } finally {
        server.close();
      }
    };
    const api = (runs, jobsFor = r => jobs(r)) => (p, s) => {
      if (p === `/repos/${REPO}/actions/workflows/test.yml`) return WORKFLOW;
      if (p === `/repos/${REPO}/actions/workflows/${WORKFLOW.id}/runs`) { const list = runs(s); return { total_count: list.length, workflow_runs: list }; }
      const m = p.match(/\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/);
      if (m) { const r = runs(s).find(x => String(x.id) === m[1]); return r ? { total_count: jobsFor(r).length, jobs: jobsFor(r) } : null; }
      return null;
    };

    const ok = await cli(api(s => [run({ head_sha: s })]));
    t.ok('CLI: 揃った成功なら decision=reuse と commit を出し、終了コード 0', ok.code === 0 && ok.output.includes('decision=reuse\n') && ok.output.includes(`sha=${sha}\n`), ok.log + ok.output);
    t.ok('CLI: トークンは見出しで渡し、ログ・出力に出さない', ok.hits.every(h => h.auth === 'Bearer test-token-value' && h.method === 'GET') && !ok.log.includes('test-token-value') && !ok.output.includes('test-token-value'));

    const red = await cli(api(s => [run({ head_sha: s, conclusion: 'failure' })]));
    t.ok('CLI: main の CI が赤なら終了コード 1、decision を出さない（release のジョブが走らない）', red.code === 1 && !red.output.includes('decision=') && /main CI is red/.test(red.log), red.log + red.output);
    const latestRed = await cli(api(s => [run({ head_sha: s, run_attempt: 3, conclusion: 'failure' })], r => jobs(r, { 'test (windows-latest, 22.13)': { conclusion: 'failure' } })));
    t.ok('CLI: 最新の attempt が赤なら終了コード 1', latestRed.code === 1 && latestRed.hits.some(h => h.url.includes('/attempts/3/jobs')));

    const cancelled = await cli(api(s => [run({ head_sha: s, conclusion: 'cancelled' })], r => jobs(r, { 'test (ubuntu-latest, 22.13)': { conclusion: 'cancelled' } })));
    t.ok('CLI: cancelled なら decision=fallback（release の中で全部回す）', cancelled.code === 0 && cancelled.output.includes('decision=fallback\n'), cancelled.output);
    const none = await cli(api(() => []));
    t.ok('CLI: run が無ければ decision=fallback', none.code === 0 && none.output.includes('decision=fallback\n') && none.output.includes('reason=no-run'));
    const wrong = await cli(api(() => [run({ head_sha: OTHER })]));
    t.ok('CLI: 別の commit の成功しか無ければ decision=fallback', wrong.code === 0 && wrong.output.includes('decision=fallback\n'));
    const partial = await cli(api(s => [run({ head_sha: s })], r => jobs(r).filter(j => !j.name.startsWith('safe-storage ('))));
    t.ok('CLI: 一部のジョブだけの成功なら decision=fallback', partial.code === 0 && partial.output.includes('decision=fallback\n'));
    const pending = await cli(api(s => [run({ head_sha: s, status: 'in_progress', conclusion: null })], () => []));
    t.ok('CLI: 期限までに終わらなければ decision=fallback（pending-deadline）', pending.code === 0 && pending.output.includes('decision=fallback\n') && pending.output.includes('reason=pending-deadline'), pending.output);
    const denied = await cli(() => ({ status: 403 }));
    t.ok('CLI: API が 403 を返し続ければ decision=fallback（api-error）。reuse にしない', denied.code === 0 && denied.output.includes('decision=fallback\n') && denied.output.includes('reason=api-error'), denied.output);
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

    const rel = parse(await fs.readFile(path.join(ROOT, '.github/workflows/evaluation-release.yml'), 'utf8'));
    const gate = rel.jobs['ci-gate'];
    const release = rel.jobs.release;
    t.ok('照合のジョブは actions: read と contents: read だけ', JSON.stringify(gate.permissions) === JSON.stringify({ actions: 'read', contents: 'read' }), JSON.stringify(gate.permissions));
    t.ok('照合のジョブのトークンは github.token（秘密を渡さない）', JSON.stringify(gate.steps).includes('${{ github.token }}') && !JSON.stringify(gate).includes('secrets.'));
    t.ok('公開のジョブは照合のジョブを待つ（赤なら走らない）', release.needs === 'ci-gate' || (Array.isArray(release.needs) && release.needs.includes('ci-gate')));
    const steps = release.steps;
    const full = steps.findIndex(s => s.run === 'npm test');
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
