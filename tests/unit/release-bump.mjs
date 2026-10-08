// 版上げのスクリプト（scripts/release-bump.mjs）: 引数・版の書き換え（CRLF を保つ）・原稿の検査と、一時の git リポジトリ（origin は bare）での一連の流れ。
//   - 前提が外れたら何も書かずに止まる（clean でない・版が古い・タグがある・origin より遅れている・原稿の雛形のまま）
//   - 通れば package.json 1 か所・package-lock.json 2 か所・原稿・web/release-info.json の 4 ファイルだけを commit し、タグ v<版> を作る
//   - push は --push のときだけ（`git push --atomic origin main v<版>` で main とタグが一緒に届く）。既定は次に打つ命令を出すだけ
//   - release:prepare / 原稿の検査が落ちたら、版と生成物を元に戻して commit もタグも作らない
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib/server.mjs';
import { parseArgs, UsageError, bumpPackageJson, bumpPackageLock, checkNotes, notesTemplate, TEMPLATE_TITLE, TEMPLATE_ITEM } from '../../scripts/release-bump.mjs';

export const name = 'release-bump';
export const title = '版上げのスクリプト: 前提の検査・版の書き換え（CRLF のまま）・commit とタグ・--push のときだけ atomic に送る';

const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };
const CRLF = (s) => s.replace(/\n/g, '\r\n');
const noLoneLf = (s) => !/(^|[^\r])\n/.test(s);

const PKG = (v) => CRLF(`{\n  "name": "agent-host",\n  "private": true,\n  "version": "${v}",\n  "type": "module",\n  "scripts": {\n    "release:prepare": "node scripts/release-info.mjs"\n  }\n}\n`);
const LOCK = (v) => CRLF(`{\n  "name": "agent-host",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "agent-host",\n      "version": "${v}",\n      "license": "Apache-2.0",\n      "dependencies": {\n        "x": "^1.0.0"\n      }\n    },\n    "node_modules/x": {\n      "version": "1.0.0"\n    }\n  }\n}\n`);
const notes = (version, extra = {}) => JSON.stringify({ version, date: '2026-10-08', title: `${version} の見出し`, sections: [{ title: '変わったこと', items: [`${version} で変わったこと`] }], ...extra }, null, 2) + '\n';

export default async function (t) {
  // ---- 引数 ---------------------------------------------------------------------------------------------------------
  {
    const a = parseArgs(['v0.12.0-beta.10', '--notes', 'n.json', '--trailer', 'A: 1', '--trailer', 'B: 2', '--push', '--offline', '--skip-checks', '--subject', 'S']);
    t.ok('引数: 版（先頭の v は外す）・--notes・--trailer（何回でも）・--push・--offline・--skip-checks・--subject', a.version === '0.12.0-beta.10' && a.notes === 'n.json' && a.trailers.join() === 'A: 1,B: 2' && a.push && a.offline && a.skipChecks && a.subject === 'S');
    const p = parseArgs(['1.0.0']);
    t.ok('既定は push しない・dry-run でない', p.version === '1.0.0' && !p.push && !p.dryRun && !p.offline && !p.skipChecks);
    const bad = [[[], '版が無い'], [['abc'], '版の形'], [['1.0'], '版の形'], [['1.0.0-rc.1'], 'beta 以外'], [['1.0.0', '1.0.1'], '版が 2 つ'], [['1.0.0', '--wat'], '知らないオプション'], [['1.0.0', '--notes'], '値が無い'], [['1.0.0', '--notes', '--push'], '値が無い（次が別のオプション）'], [['1.0.0', '--push', '--dry-run'], '同時に使えない']];
    for (const [argv, why] of bad) t.ok(`不正な引数は UsageError: ${argv.join(' ')}（${why}）`, throws(() => parseArgs(argv)) instanceof UsageError);
  }

  // ---- 版の書き換え --------------------------------------------------------------------------------------------------
  {
    const pj = bumpPackageJson(PKG('0.1.0-beta.2'), '0.1.0-beta.2', '0.1.0-beta.3');
    t.ok('package.json: version の 1 行だけが変わり、CRLF のまま', pj === PKG('0.1.0-beta.3') && noLoneLf(pj));
    const lk = bumpPackageLock(LOCK('0.1.0-beta.2'), '0.1.0-beta.2', '0.1.0-beta.3');
    const parsed = JSON.parse(lk);
    t.ok('package-lock.json: 先頭と packages[""] の 2 か所だけが変わり（依存の version は変えない）、CRLF のまま', lk === LOCK('0.1.0-beta.3') && parsed.version === '0.1.0-beta.3' && parsed.packages[''].version === '0.1.0-beta.3' && parsed.packages['node_modules/x'].version === '1.0.0' && noLoneLf(lk));
    t.ok('LF のファイルは LF のまま', bumpPackageJson(PKG('1.0.0').replace(/\r\n/g, '\n'), '1.0.0', '1.0.1').includes('"version": "1.0.1",\n') && !bumpPackageJson(PKG('1.0.0').replace(/\r\n/g, '\n'), '1.0.0', '1.0.1').includes('\r'));
    t.ok('今の版と違う・version の行が無いときは例外（別の版のファイルを黙って書き換えない）', throws(() => bumpPackageJson(PKG('1.0.0'), '0.9.0', '1.0.1')) !== null && throws(() => bumpPackageLock('{}', '1.0.0', '1.0.1')) !== null);
  }

  // ---- 原稿 ---------------------------------------------------------------------------------------------------------
  {
    const ok = checkNotes(notes('1.0.0'), '1.0.0', '2026-10-08');
    t.ok('原稿: 正しい原稿は問題なし・日付が今日でなければ注意（止めない）', ok.errors.length === 0 && ok.warnings.length === 0 && checkNotes(notes('1.0.0'), '1.0.0', '2026-10-09').warnings.length === 1 && checkNotes(notes('1.0.0'), '1.0.0', '2026-10-09').errors.length === 0);
    const tpl = checkNotes(notesTemplate('1.0.0', '2026-10-08'), '1.0.0', '2026-10-08');
    t.ok('原稿: 雛形のまま（見出し・本文）は止める', tpl.errors.some((e) => e.includes('title')) && tpl.errors.some((e) => e.includes('雛形のまま')), tpl.errors.join(' | '));
    t.ok('原稿の雛形は版・日付・雛形の字を持ち、CRLF を指定すれば CRLF', JSON.parse(notesTemplate('1.0.0', '2026-10-08')).title === TEMPLATE_TITLE && notesTemplate('1.0.0', 'd').includes(TEMPLATE_ITEM) && noLoneLf(notesTemplate('1.0.0', 'd', '\r\n')));
    t.ok('原稿: 版の不一致・日付の形・JSON でない・節が空は止める', checkNotes(notes('1.0.1'), '1.0.0', 'x').errors.length === 1 && checkNotes(notes('1.0.0', { date: '10/08' }), '1.0.0', 'x').errors.length === 1 && checkNotes('{', '1.0.0', 'x').errors.length === 1 && checkNotes(notes('1.0.0', { sections: [] }), '1.0.0', 'x').errors.length === 1);
  }

  // ---- 一時の git リポジトリで一連の流れ -------------------------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-release-bump-'));
  try {
    const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' };
    for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE)$/.test(k)) delete env[k];
    const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env, windowsHide: true }); return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: String(r.stdout ?? '').trim() }; };
    const git = (cwd, ...args) => { const r = sh('git', args, cwd); if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.out}`); return r.stdout; };
    const origin = path.join(tmp, 'origin.git');
    const work = path.join(tmp, 'work');
    const other = path.join(tmp, 'other');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '--bare', '-b', 'main');
    fs.mkdirSync(path.join(work, 'releases'), { recursive: true });
    fs.mkdirSync(path.join(work, 'web'));
    fs.mkdirSync(path.join(work, 'scripts'));
    git(work, 'init', '-q', '-b', 'main');
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) git(work, 'config', k, v);
    for (const f of ['release-info.mjs', 'release-bump.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(work, 'scripts', f));
    fs.writeFileSync(path.join(work, '.gitignore'), 'temporary/\n');
    fs.writeFileSync(path.join(work, 'package.json'), PKG('0.1.0-beta.2'));
    fs.writeFileSync(path.join(work, 'package-lock.json'), LOCK('0.1.0-beta.2'));
    fs.writeFileSync(path.join(work, 'releases', '0.1.0-beta.1.json'), CRLF(notes('0.1.0-beta.1')));
    fs.writeFileSync(path.join(work, 'releases', '0.1.0-beta.2.json'), CRLF(notes('0.1.0-beta.2')));
    fs.writeFileSync(path.join(work, 'other.txt'), 'x\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'base');
    sh(process.execPath, ['scripts/release-info.mjs'], work);
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'generated');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', '-u', 'origin', 'main');
    const baseSha = git(work, 'rev-parse', 'HEAD');
    const bump = (args) => sh(process.execPath, ['scripts/release-bump.mjs', ...args], work);
    const untouched = (extra = []) => git(work, 'status', '--porcelain', '--untracked-files=all').split(/\r?\n/).filter(Boolean).every((l) => extra.includes(l));
    const files = (sha) => git(work, 'show', '--name-only', '--format=', sha).split(/\r?\n/).filter(Boolean).sort();

    // 原稿が無い: 雛形を置いて 3 で止まる。書き換えない。雛形のまま打ち直しても止まる
    {
      const r = bump(['0.1.0-beta.3', '--skip-checks']);
      const tpl = path.join(work, 'releases', '0.1.0-beta.3.json');
      t.ok('原稿が無いと、雛形（CRLF のリポジトリでは CRLF）を置いて終了コード 3・版は書き換えない', r.code === 3 && fs.existsSync(tpl) && noLoneLf(fs.readFileSync(tpl, 'utf8')) && fs.readFileSync(path.join(work, 'package.json'), 'utf8') === PKG('0.1.0-beta.2') && untouched(['?? releases/0.1.0-beta.3.json']), `${r.code} ${r.out}`);
      const again = bump(['0.1.0-beta.3', '--skip-checks']);
      t.ok('雛形のまま打ち直すと、何も書かずに止まる（終了コード 1・版は元のまま）', again.code === 1 && again.out.includes('雛形のまま') && fs.readFileSync(path.join(work, 'package.json'), 'utf8') === PKG('0.1.0-beta.2'), again.out);
      fs.rmSync(tpl);
    }

    // 前提が外れたら何も書かない
    {
      const check = (label, r, needle) => t.ok(`前提: ${label}は止まる（終了コード 1・何も書かない）`, r.code === 1 && r.out.includes(needle) && fs.readFileSync(path.join(work, 'package.json'), 'utf8') === PKG('0.1.0-beta.2'), `${r.code} ${r.out}`);
      fs.writeFileSync(path.join(work, 'other.txt'), 'changed\n');
      check('作業ツリーが clean でない', bump(['0.1.0-beta.3', '--offline', '--dry-run']), 'clean でない');
      git(work, 'checkout', '--', 'other.txt');
      check('版が今までの最新と同じか古い', bump(['0.1.0-beta.2', '--offline', '--dry-run']), '新しくない');
      check('最新より古い版（0.0.9）', bump(['0.0.9', '--offline', '--dry-run']), '新しくない');
      git(work, 'tag', 'v0.1.0-beta.3');
      check('タグがローカルにもう有る', bump(['0.1.0-beta.3', '--offline', '--dry-run']), 'ローカルにもう有る');
      git(work, 'tag', '-d', 'v0.1.0-beta.3');
      git(work, 'checkout', '-q', '-b', 'topic');
      check('ブランチが main でない', bump(['0.1.0-beta.3', '--offline', '--dry-run']), 'main でない');
      git(work, 'checkout', '-q', 'main');
      git(work, 'branch', '-q', '-D', 'topic');
      // origin に別の commit・タグがある
      git(tmp, 'clone', '-q', origin, other);
      for (const [k, v] of [['user.name', 'T'], ['user.email', 't@example.com'], ['core.autocrlf', 'false'], ['commit.gpgsign', 'false']]) git(other, 'config', k, v);
      fs.writeFileSync(path.join(other, 'ahead.txt'), 'a\n');
      git(other, 'add', '-A');
      git(other, 'commit', '-q', '-m', 'ahead');
      git(other, 'tag', 'v0.1.0-beta.3');
      git(other, 'push', '-q', 'origin', 'main', 'v0.1.0-beta.3');
      check('タグが origin にもう有る', bump(['0.1.0-beta.3', '--dry-run']), 'origin にもう有る');
      const tagsGone = sh('git', ['push', '-q', 'origin', ':refs/tags/v0.1.0-beta.3'], other);
      check('main が origin/main より遅れている', bump(['0.1.0-beta.3', '--dry-run']), '遅れている');
      t.ok('（準備）origin のタグを消せた', tagsGone.code === 0, tagsGone.out);
      git(work, 'pull', '-q', '--ff-only', 'origin', 'main');
      sh('git', ['tag', '-d', 'v0.1.0-beta.3'], work);   // pull が、消す前に origin にあったタグを取ってくることがある
    }

    // dry-run は何も書かない
    {
      const r = bump(['0.1.0-beta.3', '--dry-run']);
      t.ok('--dry-run: 原稿が無くても雛形を置かない・何も変えない（終了コード 0）', r.code === 0 && untouched() && !fs.existsSync(path.join(work, 'releases', '0.1.0-beta.3.json')), `${r.code} ${r.out}`);
    }

    // 版上げ 1 回目: --notes で取り込み、push しない
    {
      const src = path.join(tmp, 'notes-3.json');
      fs.writeFileSync(src, notes('0.1.0-beta.3'));
      const r = bump(['0.1.0-beta.3', '--notes', src, '--skip-checks', '--trailer', 'Co-Authored-By: Someone <s@example.com>']);
      const head = git(work, 'rev-parse', 'HEAD');
      const pkg = fs.readFileSync(path.join(work, 'package.json'), 'utf8');
      const lock = fs.readFileSync(path.join(work, 'package-lock.json'), 'utf8');
      t.ok('版上げ: commit は版・原稿・生成物の 4 ファイルだけ（package.json・package-lock.json・releases/<版>.json・web/release-info.json）', r.code === 0 && head !== baseSha && files(head).join() === ['package-lock.json', 'package.json', 'releases/0.1.0-beta.3.json', 'web/release-info.json'].join(), `${r.code} ${files(head)} ${r.out}`);
      t.ok('package.json は 1 行・package-lock.json は 2 行だけが変わり、CRLF のまま', pkg === PKG('0.1.0-beta.3') && lock === LOCK('0.1.0-beta.3') && git(work, 'diff', '--numstat', 'HEAD~1', 'HEAD', '--', 'package.json').startsWith('1\t1') && git(work, 'diff', '--numstat', 'HEAD~1', 'HEAD', '--', 'package-lock.json').startsWith('2\t2') && noLoneLf(pkg) && noLoneLf(lock));
      t.ok('commit の題は `<版>: <原稿の見出し>`・末尾に --trailer', git(work, 'log', '-1', '--format=%s').startsWith('0.1.0-beta.3: 0.1.0-beta.3 の見出し') && git(work, 'log', '-1', '--format=%B').includes('\n\nCo-Authored-By: Someone <s@example.com>'));
      t.ok('タグ v<版> が commit に付く', git(work, 'rev-parse', 'v0.1.0-beta.3^{commit}') === head);
      const web = JSON.parse(fs.readFileSync(path.join(work, 'web', 'release-info.json'), 'utf8'));
      t.ok('web/release-info.json は新しい版の原稿を先頭に持つ', web.version === '0.1.0-beta.3' && web.releases[0].version === '0.1.0-beta.3');
      t.ok('既定では push しない（origin の main もタグも動かない）・次に打つ命令を出す', git(origin, 'rev-parse', 'main') !== head && sh('git', ['rev-parse', '-q', '--verify', 'refs/tags/v0.1.0-beta.3'], origin).code !== 0 && r.out.includes('git push --atomic origin main v0.1.0-beta.3') && r.out.includes('まだ push していない'), r.out);
      t.ok('作業ツリーは clean', untouched());
    }

    // 版上げ 2 回目: 手で書いた原稿（未追跡）を使い、--push で main とタグが一緒に届く
    {
      fs.writeFileSync(path.join(work, 'releases', '0.1.0-beta.4.json'), CRLF(notes('0.1.0-beta.4')));
      const r = bump(['0.1.0-beta.4', '--skip-checks', '--push']);
      const head = git(work, 'rev-parse', 'HEAD');
      t.ok('--push: main とタグ v<版> が origin に一緒に届く（push の命令は --atomic）', r.code === 0 && git(origin, 'rev-parse', 'main') === head && git(origin, 'rev-parse', 'v0.1.0-beta.4^{commit}') === head && r.out.includes('git push --atomic origin main v0.1.0-beta.4'), r.out);
      t.ok('origin に届いた版上げ commit（beta.3 を含む 1 つ前も）が先に作ったタグ無しの commit を押し流さない', git(origin, 'rev-parse', 'main~1') === git(work, 'rev-parse', 'v0.1.0-beta.3^{commit}'));
    }

    // 失敗したら元に戻す: 前の版と同じ原稿は release:prepare の検査（--require-new-notes）で落ちる
    {
      const headBefore = git(work, 'rev-parse', 'HEAD');
      fs.writeFileSync(path.join(work, 'releases', '0.1.0-beta.5.json'), notes('0.1.0-beta.5', { title: '0.1.0-beta.4 の見出し', sections: [{ title: '変わったこと', items: ['0.1.0-beta.4 で変わったこと'] }] }));
      const r = bump(['0.1.0-beta.5', '--skip-checks', '--offline']);
      t.ok('前の版と同じ原稿は検査で落ち、版と生成物を元に戻す（commit もタグも作らない。手で書いた原稿は残す）', r.code === 1 && r.out.includes('元に戻した') && git(work, 'rev-parse', 'HEAD') === headBefore && sh('git', ['rev-parse', '-q', '--verify', 'refs/tags/v0.1.0-beta.5'], work).code !== 0 && fs.readFileSync(path.join(work, 'package.json'), 'utf8') === PKG('0.1.0-beta.4') && untouched(['?? releases/0.1.0-beta.5.json']), `${r.code} ${r.out}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
