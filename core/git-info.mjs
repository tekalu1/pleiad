// ホストの git の問い合わせ（docs/design.md「git の動き」、ADR 0085）。
//
// execFile('git', …) でシェルを通さない。windowsHide・タイムアウト・GIT_OPTIONAL_LOCKS=0・読み取り系だけ。
// 書くのは隠し ref（refs/pleiad/turn/<会話 id>/<n>-start|end）と、そのための一時 index・commit オブジェクトだけで、
// ユーザーの index・HEAD・ブランチ・作業ツリーには触れない。git が無い・git 管理外・時間切れは、例外にせず ok: false を返す
// （画面は静かに「情報なし」にする）。
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 読み取りだけのサブコマンド */
const READ = new Set(['rev-parse', 'status', 'log', 'diff', 'diff-tree', 'for-each-ref', 'ls-files', 'rev-list', 'cat-file', 'merge-base']);
/** 隠し ref を作る側。read-tree・add・write-tree は GIT_INDEX_FILE が一時 index のときだけ、update-ref は refs/pleiad/ だけ */
const WRITE = new Set(['read-tree', 'add', 'write-tree', 'commit-tree', 'update-ref']);

export const REF_PREFIX = 'refs/pleiad/turn/';
/** worktree を退避して消すときの隠し ref（refs/pleiad/archive/<id>/<時刻>。ADR 0089） */
export const ARCHIVE_PREFIX = 'refs/pleiad/archive/';
const READ_TIMEOUT = 4_000;
const SNAPSHOT_TIMEOUT = 8_000;
const MAX_BUFFER = 8 * 1024 * 1024;

const IDENT = { GIT_AUTHOR_NAME: 'Pleiad', GIT_AUTHOR_EMAIL: 'pleiad@localhost', GIT_COMMITTER_NAME: 'Pleiad', GIT_COMMITTER_EMAIL: 'pleiad@localhost' };

/** git の実行ファイル。テストが差し替える */
let gitBin = process.env.AGENT_HOST_GIT_BIN || 'git';
export const setGitBin = (bin) => { gitBin = bin || 'git'; };

/**
 * git を 1 回走らせる。例外にしない。
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number|string|null, truncated?: boolean }>}
 */
function exec(cwd, args, { env = {}, timeout = READ_TIMEOUT, maxBuffer = MAX_BUFFER, input = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(gitBin, ['-c', 'core.quotepath=false', '-c', 'commit.gpgsign=false', '-c', 'log.showSignature=false', ...args], {
        cwd, encoding: 'utf8', windowsHide: true, timeout, maxBuffer,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1', ...env },
      }, (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 });
        resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error.code ?? null, truncated: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      });
    } catch { return resolve({ ok: false, stdout: '', code: 'SPAWN' }); }
    if (input !== null) { child.stdin?.on('error', () => {}); child.stdin?.end(input); }
  });
}

/** 許可表を通さない git。core/git-worktree.mjs（worktree の作成・削除。ADR 0089）だけが使う */
export const execGit = exec;

/** 読み取りだけの git。許可していないサブコマンドは投げる（呼び出す側の誤り） */
export function readGit(cwd, args, options) {
  if (!READ.has(args[0])) throw new Error(`git: ${args[0]} is not a read-only subcommand`);
  return exec(cwd, args, options);
}

/** 隠し ref を作る側の git（一時 index の上の操作と commit-tree・update-ref） */
function writeGit(cwd, args, options = {}) {
  if (!WRITE.has(args[0])) throw new Error(`git: ${args[0]} is not allowed`);
  if (['read-tree', 'add', 'write-tree'].includes(args[0]) && !options.env?.GIT_INDEX_FILE) throw new Error('git: the temporary index is required');
  if (args[0] === 'update-ref') {
    const ours = (ref) => ref.startsWith(REF_PREFIX) || ref.startsWith(ARCHIVE_PREFIX);
    const deletes = args.includes('--stdin') && (options.input ?? '').split('\n').filter(Boolean).every((line) => line.startsWith('delete ') && ours(line.slice(7)));
    if (!deletes && !args.some(ours)) throw new Error('git: update-ref is only for refs/pleiad/');
  }
  return exec(cwd, args, options);
}

const slash = (p) => String(p ?? '').replaceAll('\\', '/');
const sameDir = (a, b) => slash(a).replace(/\/+$/, '').toLowerCase() === slash(b).replace(/\/+$/, '').toLowerCase();

/** 会話の id を ref の名前に使える形にする（UUID 以外が来ても ref を壊さない） */
export function refSession(sessionId) {
  const safe = String(sessionId ?? '').replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').replace(/\.lock$/i, '_lock');
  return safe || '_';
}
export const refName = (sessionId, n, kind) => `${REF_PREFIX}${refSession(sessionId)}/${n}-${kind}`;

/**
 * cwd の git のルートと種類。git 管理外・git が無い・bare は null。
 * linked: worktree（git worktree add で作ったもの。.git が共有の本体を指す）
 */
export async function repoInfo(cwd) {
  if (!cwd) return null;
  const r = await readGit(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (!r.ok) return null;
  const [root, gitDir, commonDir] = r.stdout.split('\n').map((s) => s.trim());
  if (!root || !gitDir) return null;
  return { root: slash(root), gitDir: slash(gitDir), commonDir: slash(commonDir || gitDir), linked: Boolean(commonDir) && !sameDir(gitDir, commonDir) };
}

/**
 * `git status --porcelain=v2 --branch -z` の出力を読む。ブランチ・先頭の hash・upstream・ahead/behind・変更の数。
 * 未追跡の数は untracked、追跡している変更は changed、競合は conflicts。dirty はコミットしていない変更のあるファイルの数
 */
export function parseStatus(text) {
  const out = { branch: null, detached: false, oid: null, upstream: null, ahead: null, behind: null, changed: 0, untracked: 0, conflicts: 0, entries: [] };
  const tokens = String(text ?? '').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith('# branch.oid ')) { const v = line.slice(13); out.oid = v === '(initial)' ? null : v; }
    else if (line.startsWith('# branch.head ')) { const v = line.slice(14); out.detached = v === '(detached)'; out.branch = out.detached ? null : v; }
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ')) { out.changed++; out.entries.push({ kind: 'changed', xy: line.slice(2, 4), path: fieldsAfter(line, 8) }); }
    else if (line.startsWith('2 ')) { out.changed++; out.entries.push({ kind: 'renamed', xy: line.slice(2, 4), path: fieldsAfter(line, 9), orig: tokens[i + 1] ?? '' }); i++; }   // 名前の変更は元のパスが次の項目
    else if (line.startsWith('u ')) { out.conflicts++; out.entries.push({ kind: 'conflict', xy: line.slice(2, 4), path: fieldsAfter(line, 10) }); }
    else if (line.startsWith('? ')) { out.untracked++; out.entries.push({ kind: 'untracked', xy: '??', path: line.slice(2) }); }
  }
  out.dirty = out.changed + out.conflicts + out.untracked;
  return out;
}

/** 空白で区切った n 個の項目の後ろ（パスは空白を含みうるので、最初の n 個だけ割る） */
function fieldsAfter(line, n) {
  let at = 0;
  for (let k = 0; k < n; k++) { at = line.indexOf(' ', at) + 1; if (at === 0) return ''; }
  return line.slice(at);
}

/**
 * 今のブランチ・変更の数（コミットしていない分）。git 管理外・失敗は null。
 * 未追跡の走査が時間切れになったら、未追跡を数えないでもう一度だけ試す
 */
export async function readStatus(cwd) {
  const info = await repoInfo(cwd);
  if (!info) return null;
  let r = await readGit(info.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']);
  if (!r.ok) r = await readGit(info.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']);
  if (!r.ok) return null;
  const s = parseStatus(r.stdout);
  return {
    root: info.root, linked: info.linked,
    branch: s.branch, detached: s.detached, head: s.oid ? s.oid.slice(0, 7) : null,
    upstream: s.upstream, ahead: s.ahead, behind: s.behind,
    changed: s.changed, untracked: s.untracked, conflicts: s.conflicts, dirty: s.dirty,
  };
}

// ---------------------------------------------------------------- 差分

/** 空の tree。最初のコミットの「親」として比べる */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * `git diff --numstat -z` の出力 → [{ path, add, del, binary, orig? }]。
 * 名前の変更（-M のとき）は「追加\t削除\t」の後に元のパス・新しいパスが NUL 区切りで続く
 */
export function parseNumstat(text) {
  const files = [];
  const tokens = String(text ?? '').split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(tokens[i] ?? '');
    if (!m) continue;
    const binary = m[1] === '-';
    const counts = { add: binary ? 0 : Number(m[1]), del: binary ? 0 : Number(m[2]), binary };
    if (m[3] === '' && i + 2 < tokens.length) { files.push({ path: tokens[i + 2], ...counts, orig: tokens[i + 1] }); i += 2; }
    else files.push({ path: m[3], ...counts });
  }
  return files;
}

/** `git diff --name-status -z` の出力 → [{ state: 'A'|'M'|'D'|'R', path, orig? }]。R・C は元のパスと新しいパスの 2 つが続く */
export function parseNameStatusList(text) {
  const list = [];
  const tokens = String(text ?? '').split('\0');
  for (let i = 0; i < tokens.length;) {
    const letter = tokens[i]?.[0];
    if (!letter) { i++; continue; }
    if (letter === 'R' || letter === 'C') {
      if (i + 2 >= tokens.length) break;
      list.push({ state: letter === 'R' ? 'R' : 'A', path: tokens[i + 2], ...(letter === 'R' ? { orig: tokens[i + 1] } : {}) });
      i += 3;
    } else {
      if (i + 1 >= tokens.length) break;
      list.push({ state: letter === 'A' ? 'A' : letter === 'D' ? 'D' : 'M', path: tokens[i + 1] });
      i += 2;
    }
  }
  return list;
}

/** `git diff --name-status -z` の出力 → Map(path → 'A'|'M'|'D'|'R') */
export function parseNameStatus(text) {
  return new Map(parseNameStatusList(text).map((e) => [e.path, e.state]));
}

/**
 * 2 つの tree-ish の差。ファイルごとの状態（A 新規・M 変更・D 削除・R 名前の変更）と行数、合計。
 * 名前の変更は renames: true のときだけ見つける（既定は --no-renames で、移した 2 つを削除と新規で数える）
 */
export async function diffFiles(root, from, to, { renames = false } = {}) {
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', renames ? '-M' : '--no-renames', '--ignore-submodules=dirty'];
  const [num, status] = await Promise.all([
    readGit(root, [...base, '--numstat', '-z', from, to, '--']),
    readGit(root, [...base, '--name-status', '-z', from, to, '--']),
  ]);
  if (!num.ok || !status.ok) return null;
  const states = new Map(parseNameStatusList(status.stdout).map((e) => [e.path, e.state]));
  const files = parseNumstat(num.stdout).map((f) => ({ ...f, state: states.get(f.path) ?? 'M' })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, total: totals(files) };
}

export function totals(files) {
  return { files: files.length, add: files.reduce((a, f) => a + f.add, 0), del: files.reduce((a, f) => a + f.del, 0) };
}

const DIFF_MAX_BYTES = 512 * 1024;
const DIFF_MAX_LINES = 4000;
/** 畳んだ行を開くために返す、差分の後ろ側のファイルの上限 */
const AFTER_MAX_BYTES = 256 * 1024;
const AFTER_MAX_LINES = 6000;

/** `@@ -a,b +c,d @@ 節` → { oldStart, oldCount, newStart, newCount, section }。読めなければ null */
export function parseHunkHeader(header) {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(String(header ?? ''));
  if (!m) return null;
  return { oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]), section: m[5] ?? '' };
}

/**
 * 統一差分を読んで { hunks: [{ header, oldStart, oldCount, newStart, newCount, section, lines: [{ t: '+'|'-'|' ', s }] }] } にする。
 * ヘッダー（diff --git・index・---・+++）は捨てる。行番号は見出しの oldStart / newStart から数える（web/git-diff.mjs）。
 * 「\ No newline at end of file」は直前の行の印として落とす
 */
export function parseUnifiedDiff(text) {
  const hunks = [];
  let current = null, count = 0, truncated = false;
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line);
      current = { header: line, oldStart: h?.oldStart ?? 1, oldCount: h?.oldCount ?? 0, newStart: h?.newStart ?? 1, newCount: h?.newCount ?? 0, section: h?.section ?? '', lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    const c = line[0];
    if (c === '+' || c === '-' || c === ' ') {
      if (++count > DIFF_MAX_LINES) { truncated = true; break; }
      current.lines.push({ t: c, s: line.slice(1) });
    }
  }
  return { hunks, truncated };
}

/**
 * 1 ファイルの差分。バイナリ・大きすぎるものは本文を返さない。path はルート相対。
 * orig は名前の変更の元のパス（あれば両方を指定して、名前の変更として読む）。context は前後の行数（既定 3）
 */
export async function diffFile(root, from, to, file, { orig = null, context = 3 } = {}) {
  const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', orig ? '-M' : '--no-renames', '--ignore-submodules=dirty', `-U${Math.min(Math.max(Number(context) || 0, 0), 1000)}`];
  const r = await readGit(root, [...base, from, to, '--', ...(orig ? [orig, file] : [file])], { maxBuffer: DIFF_MAX_BYTES });
  if (!r.ok && !r.truncated) return null;
  if (r.truncated) return { hunks: [], binary: false, truncated: true };
  const binary = /^Binary files .* differ$/m.test(r.stdout) || /^GIT binary patch$/m.test(r.stdout);
  if (binary) return { hunks: [], binary: true, truncated: false };
  const parsed = parseUnifiedDiff(r.stdout);
  return { hunks: parsed.hunks, binary: false, truncated: parsed.truncated };
}

/**
 * 差分の後ろ側のファイルの全行（畳んだ「変更なし」の行を開くため）。to は tree-ish（commit・tree）。
 * 無い（削除）・大きい・バイナリは null。lines は行の配列（末尾の改行は行を増やさない）
 */
export async function fileLines(root, to, file) {
  const r = await readGit(root, ['cat-file', '-p', `${to}:${file}`], { maxBuffer: AFTER_MAX_BYTES });
  if (!r.ok || r.truncated || r.stdout.includes('\0')) return null;
  const lines = r.stdout.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.length > AFTER_MAX_LINES ? null : lines;
}

// ---------------------------------------------------------------- 隠し ref

/**
 * 今の作業ツリー（未追跡を含む。.gitignore は守る）を tree にする。ユーザーの index は触らない:
 * 本物の index を一時ファイルへ写し、その上で add -A → write-tree。写しなので変更の無いファイルは再計算されない。
 * 失敗・時間切れは null
 */
export async function snapshotTree(root) {
  const tmp = path.join(os.tmpdir(), `pleiad-index-${crypto.randomUUID()}`);
  try {
    const idx = await readGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (idx.ok && idx.stdout.trim()) await fs.copyFile(idx.stdout.trim(), tmp).catch(() => {});
    const env = { GIT_INDEX_FILE: tmp };
    const added = await writeGit(root, ['add', '-A'], { env, timeout: SNAPSHOT_TIMEOUT });
    if (!added.ok) return null;
    const tree = await writeGit(root, ['write-tree'], { env });
    return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
  } catch { return null; } finally { fs.rm(tmp, { force: true }).catch(() => {}); }
}

/**
 * ユーザーの index（ステージした内容）を tree にする。本物の index を一時ファイルへ写し、その上で write-tree だけする（add -A はしない）。
 * 競合（unmerged）が残っているなど write-tree が断ったら null
 */
export async function indexTree(root) {
  const tmp = path.join(os.tmpdir(), `pleiad-index-${crypto.randomUUID()}`);
  try {
    const idx = await readGit(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (!idx.ok || !idx.stdout.trim()) return null;
    await fs.copyFile(idx.stdout.trim(), tmp).catch(() => {});   // index がまだ無い（最初のコミット前）なら空の index
    const tree = await writeGit(root, ['write-tree'], { env: { GIT_INDEX_FILE: tmp } });
    return tree.ok && /^[0-9a-f]{40,64}$/.test(tree.stdout.trim()) ? tree.stdout.trim() : null;
  } catch { return null; } finally { fs.rm(tmp, { force: true }).catch(() => {}); }
}

/** HEAD のコミット（無ければ null。まだコミットが無い） */
export async function headCommit(root) {
  const r = await readGit(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * tree から commit を作る（親は HEAD。start の親が「始めた時の HEAD」になるので、そこからコミット数を数えられる）。
 * ブランチには載らない。失敗は null
 */
export async function commitTree(root, tree, parent, message = 'pleiad turn snapshot') {
  const r = await writeGit(root, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message], { env: IDENT });
  return r.ok && /^[0-9a-f]{40,64}$/.test(r.stdout.trim()) ? r.stdout.trim() : null;
}

export async function updateRef(root, ref, commit) {
  if (!ref.startsWith(REF_PREFIX) && !ref.startsWith(ARCHIVE_PREFIX)) throw new Error('git: refs/pleiad/ only');
  return (await writeGit(root, ['update-ref', ref, commit])).ok;
}

/** 会話の隠し ref の一覧 [{ ref, n, kind: 'start'|'end', commit, at }]（n の小さい順） */
export async function listTurnRefs(root, sessionId = null) {
  const pattern = sessionId == null ? REF_PREFIX : `${REF_PREFIX}${refSession(sessionId)}/`;
  const r = await readGit(root, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(committerdate:unix)', pattern]);
  if (!r.ok) return [];
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const [ref, commit, at] = line.split('\0');
    const m = /^refs\/pleiad\/turn\/([^/]+)\/(\d+)-(start|end)$/.exec(ref ?? '');
    if (m) out.push({ ref, session: m[1], n: Number(m[2]), kind: m[3], commit, at: Number(at) * 1000 });
  }
  return out.sort((a, b) => a.n - b.n || (a.kind === 'start' ? -1 : 1));
}

/** ref を消す（まとめて 1 回）。消した数 */
export async function deleteRefs(root, refs) {
  const list = refs.filter((r) => r.startsWith(REF_PREFIX) || r.startsWith(ARCHIVE_PREFIX));
  if (!list.length) return 0;
  const r = await writeGit(root, ['update-ref', '--stdin'], { input: list.map((ref) => `delete ${ref}\n`).join('') });
  return r.ok ? list.length : 0;
}

/** 古い隠し ref を消す。maxAgeMs より前のもの */
export async function pruneTurnRefs(root, maxAgeMs, now = Date.now()) {
  const old = (await listTurnRefs(root)).filter((r) => now - r.at > maxAgeMs).map((r) => r.ref);
  return deleteRefs(root, old);
}

/** 会話の隠し ref を全部消す（会話を消したとき） */
export async function forgetSession(root, sessionId) {
  return deleteRefs(root, (await listTurnRefs(root, sessionId)).map((r) => r.ref));
}

/** from の後に増えたコミットの数と、新しい順の先頭 limit 件 [{ hash, subject }]。from が HEAD の祖先でなくても「HEAD にあって from に無い」を数える */
export async function commitsSince(root, from, limit = 20) {
  const range = from ? `${from}..HEAD` : 'HEAD';
  const [count, log] = await Promise.all([
    readGit(root, ['rev-list', '--count', range]),
    readGit(root, ['log', `--max-count=${limit}`, '--format=%h%x00%s', range]),
  ]);
  if (!count.ok) return { count: 0, commits: [] };
  const commits = log.ok ? log.stdout.split('\n').filter(Boolean).map((l) => { const [hash, subject] = l.split('\0'); return { hash, subject: subject ?? '' }; }) : [];
  return { count: Number(count.stdout.trim()) || 0, commits };
}
