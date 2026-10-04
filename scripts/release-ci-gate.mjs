// タグのリリースが、同じ commit の main の CI（test.yml の push の run）の成功をそのまま使えるかを決める。
//
//   node scripts/release-ci-gate.mjs --tag v0.7.4 --repo tekalu1/pleiad [--wait-minutes 40] [--interval-seconds 30] [--missing-grace-minutes 5]
//
// 結果（GITHUB_OUTPUT の decision）:
//   reuse    … 同じ commit の test.yml（push・main）の最新の attempt で、必須のジョブがすべて success。release の npm test を省ける
//   fallback … 使える成功が無い（run が無い・cancelled・skipped・一部だけ・期限までに終わらない・API の失敗）。release の中で npm test を全部回す
//   失敗の終了コード … 同じ commit の CI が赤い（failure・timed_out・action_required・startup_failure）。公開しない
// 読むのは GitHub の API だけ（GET）。トークンは GITHUB_TOKEN（actions: read）。値はログに出さない。理由と規則は docs/release-ci-reuse.md
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOW_PATH = '.github/workflows/test.yml';
export const BRANCH = 'main';
// test.yml が main の push で必ず回すジョブ（3 つの Node / OS の npm test と、safe-storage の 3 つ）。
// 名前は GitHub が matrix の include から付けるもの。test.yml を変えたら合わせる（tests/unit/release-ci-gate.mjs が test.yml と突き合わせる）
export const REQUIRED_JOBS = Object.freeze([
  'test (ubuntu-latest, 22.13)',
  'test (ubuntu-latest, 24)',
  'test (windows-latest, 22.13)',
  'safe-storage (windows-dpapi)',
  'safe-storage (linux-gnome-keyring)',
  'safe-storage (linux-no-keyring)',
]);
// main が赤いとみなす結論。これがあれば、ほかの run が成功していても公開しない
const RED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);

/**
 * 1 回分の状態（workflow・run・最新の attempt の jobs）から判定する。API は呼ばない。
 * @returns {{ verdict: 'reuse'|'fail'|'pending'|'fallback', reason: string, run?: object, notes: string[] }}
 */
export function evaluate({ repo, sha, workflow, runs, jobsByRun, requiredJobs = REQUIRED_JOBS }) {
  const notes = [];
  if (!workflow) return { verdict: 'fallback', reason: 'workflow-missing', notes };
  if (workflow.path !== WORKFLOW_PATH) return { verdict: 'fallback', reason: `workflow-path:${workflow.path}`, notes };
  if (workflow.state !== 'active') return { verdict: 'fallback', reason: `workflow-state:${workflow.state}`, notes };
  // API の絞り込みに頼らず、自分でも同じ commit・同じ workflow・main への push・同じリポジトリかを確かめる
  const candidates = [];
  for (const run of runs ?? []) {
    const why = run.head_sha !== sha ? 'sha' : run.workflow_id !== workflow.id ? 'workflow-id' : run.path !== WORKFLOW_PATH ? 'path'
      : run.event !== 'push' ? 'event' : run.head_branch !== BRANCH ? 'branch'
      : run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ? 'repository' : null;
    if (why) notes.push(`run ${run.id}: ignored (${why})`);
    else candidates.push(run);
  }
  if (!candidates.length) return { verdict: 'fallback', reason: 'no-run', notes };

  const results = candidates.map(run => ({ run, ...evaluateRun(run, jobsByRun?.[run.id], sha, requiredJobs) }));
  for (const r of results) notes.push(`run ${r.run.id} attempt ${r.run.run_attempt}: ${r.verdict} (${r.reason})`);
  // 赤が 1 つでもあれば止める。次に、終わっていないものがあれば待つ。どれでもなく揃った成功があれば使う
  for (const verdict of ['fail', 'pending', 'reuse']) {
    const hit = results.find(r => r.verdict === verdict);
    if (hit) return { verdict, reason: hit.reason, run: hit.run, notes };
  }
  return { verdict: 'fallback', reason: results.map(r => r.reason).join(','), notes };
}

function evaluateRun(run, jobs, sha, requiredJobs) {
  if (RED.has(run.conclusion)) return { verdict: 'fail', reason: `run-${run.conclusion}` };
  // 最新の attempt の jobs だけを見る（再実行で成功した attempt 2 があれば、attempt 1 の失敗は見ない）
  if (!Array.isArray(jobs)) return run.status === 'completed' ? { verdict: 'fallback', reason: 'jobs-missing' } : { verdict: 'pending', reason: `run-${run.status}` };
  const own = [];
  for (const job of jobs) {
    if (job.run_id !== run.id || job.run_attempt !== run.run_attempt || job.head_sha !== sha) return { verdict: 'fallback', reason: `job-mismatch:${job.name}` };
    own.push(job);
  }
  const red = own.find(job => RED.has(job.conclusion));
  if (red) return { verdict: 'fail', reason: `job-${red.conclusion}:${red.name}` };
  if (run.status !== 'completed' || own.some(job => job.status !== 'completed')) return { verdict: 'pending', reason: `run-${run.status}` };
  for (const name of requiredJobs) {
    const same = own.filter(job => job.name === name);
    if (same.length !== 1) return { verdict: 'fallback', reason: `${same.length ? 'job-duplicated' : 'job-missing'}:${name}` };
    if (same[0].conclusion !== 'success') return { verdict: 'fallback', reason: `job-${same[0].conclusion}:${name}` };
  }
  // 必須のジョブが全部 success でも、run の結論が success でなければ使わない（逆に run の success だけでも使わない）
  if (run.conclusion !== 'success') return { verdict: 'fallback', reason: `run-${run.conclusion}` };
  return { verdict: 'reuse', reason: 'success' };
}

/** GitHub の API から 1 回分の状態を読む。request(path) は JSON を返す（404 は null）。 */
export async function readState({ request, repo, sha }) {
  const workflow = await request(`/repos/${repo}/actions/workflows/${WORKFLOW_PATH.split('/').pop()}`);
  if (!workflow) return { repo, sha, workflow: null, runs: [], jobsByRun: {} };
  const query = new URLSearchParams({ head_sha: sha, event: 'push', branch: BRANCH, per_page: '100' });
  const list = await request(`/repos/${repo}/actions/workflows/${workflow.id}/runs?${query}`);
  const runs = list?.workflow_runs ?? [];
  if ((list?.total_count ?? 0) > runs.length) throw new Error('Too many runs for one commit');
  const jobsByRun = {};
  for (const run of runs) {
    if (run.head_sha !== sha || run.workflow_id !== workflow.id) continue;
    const page = await request(`/repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    if (!page) continue;
    if (page.total_count > page.jobs.length) throw new Error(`Too many jobs in run ${run.id}`);
    jobsByRun[run.id] = page.jobs;
  }
  return { repo, sha, workflow, runs, jobsByRun };
}

/**
 * 終わるまで期限つきで読み直す。期限までに終わらなければ fallback（release の中で全部回す）。
 * API の失敗が続いたときも fallback（テストを省く方には倒さない）。
 * タグと main を同時に push すると、release が test.yml の run より先に始まることがある。始めの missingGraceMs の間は、run が無いのも待つ
 */
export async function waitForCi({ read, deadlineMs, intervalMs, missingGraceMs = 0, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), log = () => {}, maxErrors = 3 }) {
  const start = now();
  const until = start + deadlineMs;
  let errors = 0;
  for (;;) {
    let result;
    try {
      result = evaluate(await read());
      errors = 0;
    } catch (err) {
      errors += 1;
      log(`GitHub API error (${errors}/${maxErrors}): ${err.message}`);
      if (errors >= maxErrors) return { verdict: 'fallback', reason: 'api-error', notes: [err.message] };
      result = null;
    }
    if (result?.verdict === 'fallback' && result.reason === 'no-run' && now() - start < missingGraceMs) result = { ...result, verdict: 'pending' };
    if (result && result.verdict !== 'pending') return result;
    if (result) log(`CI not finished: ${result.reason}`);
    if (now() + intervalMs > until) return result ? { ...result, verdict: 'fallback', reason: `pending-deadline:${result.reason}` } : { verdict: 'fallback', reason: 'api-error', notes: [] };
    await sleep(intervalMs);
  }
}

/** タグが指す commit（注釈つきのタグは剥がした先の commit）。 */
export function resolveTagCommit(tag, cwd = process.cwd()) {
  if (!/^v\d+\.\d+\.\d+(-beta\.\d+)?$/.test(tag)) throw new Error('Expected release tag (vX.Y.Z or vX.Y.Z-beta.N)');
  const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { cwd, encoding: 'utf8' }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Tag does not resolve to a commit');
  return sha;
}

export function githubRequest({ token, apiUrl = 'https://api.github.com', fetchImpl = fetch }) {
  return async path => {
    const res = await fetchImpl(apiUrl + path, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'pleiad-release-ci-gate' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} returned ${res.status}`);
    return res.json();
  };
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) throw new Error(`Bad argument: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function summary(result, sha) {
  const lines = [`### CI result for ${sha}`, '', `decision: **${result.decision}** (${result.reason})`];
  if (result.run) lines.push('', `run: ${result.run.html_url} (attempt ${result.run.run_attempt})`);
  if (result.notes?.length) lines.push('', ...result.notes.map(n => `- ${n}`));
  return lines.join('\n') + '\n';
}

async function main() {
  const opt = args(process.argv.slice(2));
  const repo = opt.repo ?? process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '')) throw new Error('Pass --repo owner/repo');
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required (actions: read)');
  const sha = resolveTagCommit(opt.tag ?? '');
  const request = githubRequest({ token, apiUrl: process.env.GITHUB_API_URL || undefined });
  const result = await waitForCi({
    read: () => readState({ request, repo, sha }),
    deadlineMs: Number(opt['wait-minutes'] ?? 40) * 60_000,
    intervalMs: Number(opt['interval-seconds'] ?? 30) * 1000,
    missingGraceMs: Number(opt['missing-grace-minutes'] ?? 5) * 60_000,
    log: msg => console.log(msg),
  });
  const decision = result.verdict === 'reuse' ? 'reuse' : result.verdict === 'fail' ? 'fail' : 'fallback';
  const report = { ...result, decision };
  for (const note of result.notes ?? []) console.log(note);
  console.log(`decision=${decision} reason=${result.reason}`);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary(report, sha));
  if (decision === 'fail') {
    console.error(`::error::main CI is red for ${sha} (${result.reason}). Fix main or re-run the failed jobs; the release is not published.`);
    process.exitCode = 1;
    return;
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `decision=${decision}\nsha=${sha}\nreason=${result.reason}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`::error::${err.message}`); process.exitCode = 2; });
}
