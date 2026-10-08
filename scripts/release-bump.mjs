// 版上げを 1 本で行う: 版の書き換え → 原稿 → release:prepare → 原稿の検査 → 速い確認 → commit → タグ（→ --push のとき push）。
//
//   node scripts/release-bump.mjs <version> [--notes <file>] [--subject <text>] [--trailer <text>]… [--push] [--dry-run] [--offline] [--skip-checks]
//   npm run release:bump -- <version> …
//
//   <version>         出す版（0.12.0-beta.10 / 0.12.0。先頭の v は付けても付けなくてもよい）。版は人が決める。このスクリプトは決めない
//   --notes <file>    原稿の JSON を releases/<version>.json に取り込む。無ければ releases/<version>.json を使う。
//                     どちらも無いときは雛形を置いて止める（書いてから、同じコマンドをもう一度）
//   --subject <text>  commit の 1 行目。既定は `<version>: <原稿の見出し>`
//   --trailer <text>  commit の末尾に足す行（`Co-Authored-By: …`）。何回でも
//   --push            タグまで作ったら `git push --atomic origin main v<version>` で main とタグを一緒に送る。無ければ push せず、次に打つ命令を出す
//   --dry-run         前提の検査だけ（何も書かない・commit しない・push しない）
//   --offline         origin を見ない（fetch・タグの重複・main の CI の状態を飛ばす）。一時の clone での練習や試験用
//   --skip-checks     速い確認（tests/run.mjs release-ci-gate）を飛ばす
//
// 前提: ブランチが main・作業ツリーが clean（原稿 releases/<version>.json だけ未追跡でよい）・origin/main より遅れていない・
// 版が今までのどれより新しい・タグ v<version> がローカルにも origin にも無い。1 つでも外れたら何も書かずに止まる。
// 書いた後に失敗したら、版と生成物は元に戻す。CRLF のファイルは CRLF のまま保つ（1 行ずつの書き換えで、改行には触れない）。
// 手元の npm test 全部は走らせない: 赤い commit は CI の結果を読む ci-gate が公開を止める（docs/desktop-releases.md「バージョンと原稿」）。
// 終了コード: 0 できた / 1 前提か手順が失敗 / 2 引数が不正 / 3 原稿の雛形を置いた（書いてからもう一度）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions } from './release-info.mjs';

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
export const TEMPLATE_TITLE = '（見出しを書く）';
export const TEMPLATE_ITEM = '（利用者に見える変更を書く）';

const USAGE = 'usage: node scripts/release-bump.mjs <version> [--notes <file>] [--subject <text>] [--trailer <text>]… [--push] [--dry-run] [--offline] [--skip-checks]';

export class UsageError extends Error {}

export function parseArgs(argv) {
  const o = { version: null, notes: null, subject: null, trailers: [], push: false, dryRun: false, offline: false, skipChecks: false, help: false };
  const need = (i, key) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${key} に値が無い`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--notes': o.notes = need(i, a); i++; break;
      case '--subject': o.subject = need(i, a); i++; break;
      case '--trailer': o.trailers.push(need(i, a)); i++; break;
      case '--push': o.push = true; break;
      case '--dry-run': o.dryRun = true; break;
      case '--offline': o.offline = true; break;
      case '--skip-checks': o.skipChecks = true; break;
      case '--help': case '-h': o.help = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`知らないオプション: ${a}`);
        if (o.version !== null) throw new UsageError(`版が 2 つ指定されている: ${o.version} と ${a}`);
        o.version = a.replace(/^v/, '');
    }
  }
  if (o.help) return o;
  if (o.version === null) throw new UsageError('版を指定する（例 0.12.0-beta.10）。版は人が決める');
  if (!VERSION_RE.test(o.version)) throw new UsageError(`版の形が違う: ${o.version}（X.Y.Z か X.Y.Z-beta.N）`);
  if (o.push && o.dryRun) throw new UsageError('--push と --dry-run は一緒に使えない');
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------
// 版の書き換え（行の中だけを置き換える。改行・字下げには触れない）

const TOP_VERSION = /^(  "version": ")([^"\r\n]*)(")/m;
const LOCK_ROOT_VERSION = /("packages": \{\r?\n    "": \{\r?\n(?:      [^\r\n]*\r?\n)*?      "version": ")([^"\r\n]*)(")/;

function replaceOnce(raw, re, from, to, what) {
  const m = re.exec(raw);
  if (!m) throw new Error(`${what}: version の行が見つからない`);
  if (m[2] !== from) throw new Error(`${what}: version が ${from} でない（${m[2]}）`);
  return raw.slice(0, m.index) + m[1] + to + m[3] + raw.slice(m.index + m[0].length);
}

/** package.json の version（1 か所）を from から to に */
export const bumpPackageJson = (raw, from, to) => replaceOnce(raw, TOP_VERSION, from, to, 'package.json');
/** package-lock.json の version（先頭と packages[""] の 2 か所）を from から to に */
export const bumpPackageLock = (raw, from, to) => replaceOnce(replaceOnce(raw, TOP_VERSION, from, to, 'package-lock.json（先頭）'), LOCK_ROOT_VERSION, from, to, 'package-lock.json（packages[""]）');

// ---------------------------------------------------------------------------------------------------------------------
// 原稿

export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function notesTemplate(version, date, eol = '\n') {
  return JSON.stringify({ version, date, title: TEMPLATE_TITLE, sections: [{ title: '変わったこと', items: [TEMPLATE_ITEM] }] }, null, 2).replace(/\n/g, eol) + eol;
}

/** 原稿の中身の検査。{ errors, warnings, notes } */
export function checkNotes(text, version, today) {
  const errors = [];
  const warnings = [];
  let notes = null;
  try { notes = JSON.parse(text); } catch (e) { return { errors: [`原稿が JSON として読めない: ${e.message}`], warnings, notes }; }
  if (notes.version !== version) errors.push(`原稿の version が ${version} でない（${notes.version}）`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notes.date ?? '')) errors.push(`原稿の date が YYYY-MM-DD でない（${notes.date}）`);
  else if (notes.date !== today) warnings.push(`原稿の date が今日（${today}）でない: ${notes.date}`);
  if (!notes.title || notes.title === TEMPLATE_TITLE) errors.push('原稿の title（見出し）が空か雛形のまま');
  if (!Array.isArray(notes.sections) || !notes.sections.length) errors.push('原稿の sections が空');
  else {
    for (const s of notes.sections) {
      if (!s?.title || !Array.isArray(s.items) || !s.items.every((i) => typeof i === 'string' && i)) errors.push(`原稿の節が不正: ${JSON.stringify(s?.title)}`);
      else if (s.items.includes(TEMPLATE_ITEM) || !s.items.length) errors.push(`原稿の節「${s.title}」が空か雛形のまま`);
    }
  }
  return { errors, warnings, notes };
}

// ---------------------------------------------------------------------------------------------------------------------

const EXPECTED_FILES = (version) => ['package.json', 'package-lock.json', `releases/${version}.json`, 'web/release-info.json'];

export async function main(argv, { root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), out = (s) => console.log(s), err = (s) => console.error(s), today = localDate() } = {}) {
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (o.help) { out(USAGE); return 0; }
  const { version } = o;
  const tag = `v${version}`;
  const notesRel = `releases/${version}.json`;
  const notesPath = path.join(root, notesRel);

  const run = (cmd, args, { allowFail = false, inherit = false } = {}) => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' && cmd === 'npm' });
    if (r.error) { if (allowFail) return { ok: false, out: '', err: String(r.error.message) }; throw r.error; }
    const raw = String(r.stdout ?? '');
    const res = { ok: r.status === 0, raw, out: raw.trim(), err: String(r.stderr ?? '').trim() };
    if (!res.ok && !allowFail) throw new Error(`${cmd} ${args.join(' ')} が失敗した（exit ${r.status}）${res.err ? `\n${res.err}` : ''}`);
    return res;
  };
  const git = (args, opts) => run('git', args, opts);

  // ---- 前提 ----
  const errors = [];
  const warnings = [];
  const info = [];
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (branch !== 'main') errors.push(`ブランチが main でない（${branch}）。main の上で版を上げる`);
  const status = git(['status', '--porcelain', '--untracked-files=all']).raw.split(/\r?\n/).filter(Boolean);
  const dirty = status.filter((l) => l !== `?? ${notesRel}`);
  if (dirty.length) errors.push(`作業ツリーが clean でない（原稿 ${notesRel} だけ未追跡でよい）:\n    ${dirty.join('\n    ')}`);

  const pkgRaw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const current = JSON.parse(pkgRaw).version;
  const eol = pkgRaw.includes('\r\n') ? '\r\n' : '\n';
  const known = [current];
  for (const f of fs.readdirSync(path.join(root, 'releases')).filter((f) => f.endsWith('.json') && f !== `${version}.json`)) known.push(f.slice(0, -'.json'.length));
  const newest = known.filter((v) => VERSION_RE.test(v)).sort(compareVersions).pop();
  if (compareVersions(version, newest) <= 0) errors.push(`版 ${version} が今までの最新（${newest}）より新しくない`);

  if (git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { allowFail: true }).ok) errors.push(`タグ ${tag} がローカルにもう有る`);
  if (!o.offline) {
    const remote = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { allowFail: true });
    if (!remote.ok) errors.push(`origin のタグを読めない（${remote.err}）。つながらないなら --offline`);
    else if (remote.out) errors.push(`タグ ${tag} が origin にもう有る`);
    const fetch = git(['fetch', 'origin', 'main'], { allowFail: true });
    if (!fetch.ok) errors.push(`git fetch origin main に失敗した（${fetch.err}）`);
    else {
      const behind = Number(git(['rev-list', '--count', 'HEAD..origin/main']).out);
      const ahead = Number(git(['rev-list', '--count', 'origin/main..HEAD']).out);
      if (behind > 0) errors.push(`main が origin/main より ${behind} commit 遅れている。git pull --ff-only してから`);
      else if (ahead > 0) info.push(`main は origin/main より ${ahead} commit 進んでいる（push するとこれも一緒に送られる）`);
      const ci = run('gh', ['run', 'list', '--workflow', 'test.yml', '--branch', 'main', '--limit', '1', '--json', 'status,conclusion,headSha,url'], { allowFail: true });
      if (ci.ok) {
        try {
          const [r] = JSON.parse(ci.out);
          if (r) {
            const state = r.status === 'completed' ? r.conclusion : r.status;
            (state === 'success' ? info : warnings).push(`origin/main の最新の CI（${String(r.headSha).slice(0, 8)}）: ${state}${state === 'success' ? '' : '（赤い commit の上に版を上げることになる。ci-gate は赤い commit を公開しない）'} ${r.url}`);
          }
        } catch { /* gh の出力が読めなければ知らせない */ }
      }
    }
  }

  // 原稿
  let notesText = null;
  let importNotes = false;
  if (o.notes) {
    if (!fs.existsSync(o.notes)) errors.push(`--notes のファイルが無い: ${o.notes}`);
    else {
      notesText = fs.readFileSync(o.notes, 'utf8');
      importNotes = true;
      if (fs.existsSync(notesPath) && fs.readFileSync(notesPath, 'utf8').replace(/\r\n/g, '\n') !== notesText.replace(/\r\n/g, '\n')) errors.push(`${notesRel} がもう有り、--notes と中身が違う（どちらを使うか決めて、片方を消す）`);
    }
  } else if (fs.existsSync(notesPath)) notesText = fs.readFileSync(notesPath, 'utf8');
  if (notesText !== null) {
    const c = checkNotes(notesText, version, today);
    errors.push(...c.errors);
    warnings.push(...c.warnings);
    o.title = c.notes?.title;
  }

  for (const line of info) out(`  ${line}`);
  for (const line of warnings) out(`  注意: ${line}`);
  if (errors.length) {
    err(`止めた（何も書いていない）:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
    return 1;
  }
  if (notesText === null) {
    if (o.dryRun) { out(`  ${notesRel} が無い。dry-run でなければ雛形を置いて止まる`); return 0; }
    fs.writeFileSync(notesPath, notesTemplate(version, today, eol));
    out(`${notesRel} に雛形を置いた。見出し（title）と本文（items）を書いてから、同じコマンドをもう一度打つ。`);
    return 3;
  }
  if (o.dryRun) {
    out(`dry-run: 前提は全部通った。実行すると package.json・package-lock.json を ${current} → ${version} にし、${notesRel}${importNotes ? ' を取り込み' : ' を使い'}、release:prepare・原稿の検査${o.skipChecks ? '' : '・速い確認'}の後に commit とタグ ${tag} を作る${o.push ? '（push まで）' : '（push はしない）'}。`);
    return 0;
  }

  // ---- 書く ----
  const tracked = ['package.json', 'package-lock.json', 'web/release-info.json'];
  const rollback = () => {
    git(['checkout', '--', ...tracked], { allowFail: true });
    if (importNotes) fs.rmSync(notesPath, { force: true });
    err('版と生成物を元に戻した。');
  };
  try {
    if (importNotes) fs.writeFileSync(notesPath, notesText);
    fs.writeFileSync(path.join(root, 'package.json'), bumpPackageJson(pkgRaw, current, version));
    const lockPath = path.join(root, 'package-lock.json');
    fs.writeFileSync(lockPath, bumpPackageLock(fs.readFileSync(lockPath, 'utf8'), current, version));
    for (const [f, get] of [['package.json', (j) => j.version], ['package-lock.json', (j) => j.version], ['package-lock.json（packages[""]）', (j) => j.packages[''].version]]) {
      const j = JSON.parse(fs.readFileSync(path.join(root, f.startsWith('package-lock') ? 'package-lock.json' : f), 'utf8'));
      if (get(j) !== version) throw new Error(`${f} の version が ${version} にならなかった`);
    }
    out(`版: ${current} → ${version}（package.json 1 か所・package-lock.json 2 か所）`);

    out('npm run release:prepare');
    run('npm', ['run', 'release:prepare'], { inherit: true });
    out('node scripts/release-info.mjs --require-new-notes');
    run(process.execPath, ['scripts/release-info.mjs', '--require-new-notes'], { inherit: true });
    if (!o.skipChecks && fs.existsSync(path.join(root, 'tests/run.mjs'))) {
      out('node tests/run.mjs release-ci-gate（速い確認。手元の npm test 全部は走らせない。CI の結果を ci-gate が読む）');
      run(process.execPath, ['tests/run.mjs', 'release-ci-gate'], { inherit: true });
    }
    const changed = git(['status', '--porcelain', '--untracked-files=all']).raw.split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
    const stray = changed.filter((f) => !EXPECTED_FILES(version).includes(f));
    if (stray.length) throw new Error(`想定外のファイルが変わっている: ${stray.join(', ')}`);
  } catch (e) {
    err(`失敗: ${e.message}`);
    rollback();
    return 1;
  }

  // ---- commit とタグ ----
  const subject = o.subject ?? `${version}: ${o.title}`;
  const message = [subject, ...(o.trailers.length ? ['', ...o.trailers] : [])].join('\n') + '\n';
  const msgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'release-bump-')), 'message.txt');
  fs.writeFileSync(msgFile, message);
  try {
    git(['add', '--', ...EXPECTED_FILES(version)]);
    git(['commit', '-F', msgFile]);
  } catch (e) {
    err(`commit に失敗した: ${e.message}\n版と生成物は作業ツリーに残してある（直してから git commit。やり直すなら git checkout -- ${tracked.join(' ')}）`);
    return 1;
  } finally { fs.rmSync(path.dirname(msgFile), { recursive: true, force: true }); }
  git(['tag', tag]);
  const sha = git(['rev-parse', '--short=8', 'HEAD']).out;
  out(`できた: commit ${sha} とタグ ${tag}`);

  const pushCmd = `git push --atomic origin main ${tag}`;
  if (o.push) {
    out(pushCmd);
    const r = git(['push', '--atomic', 'origin', 'main', tag], { allowFail: true, inherit: true });
    if (!r.ok) { err(`push に失敗した。commit とタグはローカルに残っている。直してから ${pushCmd}`); return 1; }
    out(`送った。Evaluation release が同じ commit の CI の結果を待って公開する。見る: gh run list -w evaluation-release.yml -L 3`);
  } else {
    out(`まだ push していない。送るなら:\n  ${pushCmd}\n（main とタグが一緒に通るか一緒に落ちる。送ると Evaluation release が起動し、CI の結果を待って公開する）`);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
