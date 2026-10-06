// Google Play へ上げるワークフロー（.github/workflows/android-play.yml、docs/android-releases.md「Google Play」）。
// GitHub Release へ APK を出す android-release.yml と、版の決め方・署名鍵・アクションの版がずれていないことを突き合わせ、
// 入力と Secrets を確かめる手順（Check inputs and secrets）を bash で実際に流す。Play も GitHub も呼ばない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const name = 'android-play-workflow';
export const title = 'Play へ上げるワークフローは APK と同じ版・同じ鍵で、入力と Secrets が足りなければ何も作らずに止まる';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const PLAY = parse(read('.github/workflows/android-play.yml'));
const APK = parse(read('.github/workflows/android-release.yml'));
const playSteps = PLAY.jobs.upload.steps;
const apkSteps = APK.jobs.release.steps;
const step = (steps, n) => steps.find((s) => s.name === n);
const uses = (steps) => steps.filter((s) => s.uses).map((s) => s.uses);

/** Git for Windows の bash（Windows の PATH の bash は WSL のことがある）。無ければ null */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const bash = path.resolve(exec, '../../../bin/bash.exe');
    return fs.existsSync(bash) ? bash : null;
  } catch { return null; }
}

const SA = JSON.stringify({ type: 'service_account', client_email: 'ci@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n' });
const APP_KEY = { KEYSTORE_BASE64: 'AAAA', KEYSTORE_PASSWORD: 'p', KEY_ALIAS: 'a', KEY_PASSWORD: 'k', CERT_SHA256: 'AB:CD' };
const UPLOAD_KEY = { UPLOAD_KEYSTORE_BASE64: 'BBBB', UPLOAD_KEYSTORE_PASSWORD: 'p', UPLOAD_KEY_ALIAS: 'u', UPLOAD_KEY_PASSWORD: 'k', UPLOAD_CERT_SHA256: 'EF:01' };
const BASE = { REF: 'refs/heads/main', TRACK: 'internal', STATUS: 'draft', FRACTION: '', PLAY_JSON: SA, ...APP_KEY };

export default async function (t) {
  // ===== 形: 手動だけ・版の固定・APK の流れとの突き合わせ =====
  t.ok('起動は workflow_dispatch だけ（main への push では上げない）', Object.keys(PLAY.on).join(',') === 'workflow_dispatch', JSON.stringify(PLAY.on));
  const inputs = PLAY.on.workflow_dispatch.inputs;
  t.ok('入力は track・status・user_fraction・changes_not_sent_for_review',
    ['track', 'status', 'user_fraction', 'changes_not_sent_for_review'].every((k) => inputs[k]) && inputs.track.default === 'internal' && inputs.status.default === 'draft',
    JSON.stringify(Object.keys(inputs)));
  t.ok('status の選択肢は draft・completed・inProgress', JSON.stringify(inputs.status.options) === '["draft","completed","inProgress"]', JSON.stringify(inputs.status.options));
  t.ok('書く権限を持たない（contents: read）', PLAY.permissions?.contents === 'read' && !PLAY.jobs.upload.permissions, JSON.stringify(PLAY.permissions));

  for (const [label, steps] of [['android-play.yml', playSteps], ['android-release.yml', apkSteps]]) {
    const loose = uses(steps).filter((u) => !/@[0-9a-f]{40}$/.test(u));
    t.ok(`${label} のアクションはすべて commit の SHA で固定`, loose.length === 0, JSON.stringify(loose));
  }
  const shared = (u) => u.split('@')[0];
  const apkUses = new Map(uses(apkSteps).map((u) => [shared(u), u]));
  const drift = uses(playSteps).filter((u) => apkUses.has(shared(u)) && apkUses.get(shared(u)) !== u);
  t.ok('checkout・setup-java・setup-node は APK の流れと同じ版', drift.length === 0, JSON.stringify(drift));

  const versionLines = (s) => s.run.split('\n').map((l) => l.trim()).filter((l) => /^(code|base|name)=/.test(l));
  const playVersion = versionLines(step(playSteps, 'Decide version'));
  t.ok('versionCode・versionName の決め方は APK の流れと同じ行', playVersion.length === 3 && JSON.stringify(playVersion) === JSON.stringify(versionLines(step(apkSteps, 'Decide version'))),
    JSON.stringify(playVersion));
  t.ok('versionCode は git rev-list --count HEAD', playVersion[0] === 'code=$(git rev-list --count HEAD)', playVersion[0]);
  t.ok('履歴を全部取る（fetch-depth: 0。浅いと versionCode が小さくなる）', playSteps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'] === 0);

  const secretNames = (text) => [...new Set([...text.matchAll(/secrets\.(PLY_ANDROID_KEY\w*)/g)].map((m) => m[1]))].sort();
  const playText = read('.github/workflows/android-play.yml');
  t.ok('APK の署名鍵の Secrets を同じ名前で使う', JSON.stringify(secretNames(playText)) === JSON.stringify(secretNames(read('.github/workflows/android-release.yml'))),
    JSON.stringify(secretNames(playText)));

  const appId = read('mobile/android/app/build.gradle').match(/applicationId "([^"]+)"/)[1];
  const upload = playSteps.find((s) => s.uses?.startsWith('r0adkll/upload-google-play@'));
  t.ok('上げる先は applicationId と同じパッケージ', upload?.with?.packageName === appId, `${upload?.with?.packageName} / ${appId}`);
  t.ok('上げるのは bundleRelease の AAB', upload?.with?.releaseFiles === 'mobile/android/app/build/outputs/bundle/release/app-release.aab'
    && /\.\/gradlew bundleRelease /.test(step(playSteps, 'Build signed release bundle').run), upload?.with?.releaseFiles);
  t.ok('入力をそのまま渡す（tracks・status・userFraction）', upload?.with?.tracks === '${{ inputs.track }}' && upload?.with?.status === '${{ inputs.status }}'
    && upload?.with?.userFraction === '${{ inputs.user_fraction }}', JSON.stringify(upload?.with));
  const order = playSteps.map((s) => s.name ?? s.uses);
  t.ok('入力と Secrets の確かめが最初の手順', order[0] === 'Check inputs and secrets', JSON.stringify(order));
  t.ok('鍵は成否にかかわらず最後に消す', playSteps.at(-1).name === 'Remove signing key' && playSteps.at(-1).if === 'always()');
  const scripts = playSteps.filter((s) => s.run).map((s) => s.run).join('\n');
  t.ok('run の中に ${{ }} を書かない（入力は env で渡す）', !scripts.includes('${{'), scripts.match(/.*\$\{\{.*/)?.[0]);

  // ===== 入力と Secrets の確かめを bash で流す =====
  const bash = findBash();
  if (!bash) { t.skip('Git for Windows の bash が無い'); return; }
  const script = step(playSteps, 'Check inputs and secrets').run;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-play-check-'));
  try {
    const file = path.join(dir, 'check.sh');
    fs.writeFileSync(file, script);
    let n = 0;
    const check = (env) => {
      const out = path.join(dir, `out-${n++}`);
      fs.writeFileSync(out, '');
      const r = spawnSync(bash, [file], {
        encoding: 'utf8', windowsHide: true,
        env: { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`, SYSTEMROOT: process.env.SYSTEMROOT ?? '', GITHUB_OUTPUT: out, ...env },
      });
      return { code: r.status, log: `${r.stdout}${r.stderr}`, output: fs.readFileSync(out, 'utf8') };
    };

    const ok = check(BASE);
    t.ok('揃っていれば通り、APK の鍵で署名する（key=app）', ok.code === 0 && ok.output.includes('key=app'), JSON.stringify(ok));
    const up = check({ ...BASE, ...Object.fromEntries(Object.keys(APP_KEY).map((k) => [k, ''])), ...UPLOAD_KEY });
    t.ok('アップロード鍵を 5 つ全部入れたら、APK の鍵が無くても通る（key=upload）', up.code === 0 && up.output.includes('key=upload'), JSON.stringify(up));

    const fails = [
      ['main 以外では止まる', { REF: 'refs/heads/feature' }, 'Run this workflow on main'],
      ['サービスアカウントの JSON が無ければ名前を出して止まる', { PLAY_JSON: '' }, 'secrets.PLY_ANDROID_PLAY_SERVICE_ACCOUNT_JSON'],
      ['サービスアカウントの鍵でない JSON は止まる', { PLAY_JSON: '{"type":"authorized_user"}' }, 'is not a service account key'],
      ['JSON でなければ止まる', { PLAY_JSON: 'not json' }, 'is not a service account key'],
      ['署名鍵が無ければ、空のものを全部出して止まる', Object.fromEntries(Object.keys(APP_KEY).map((k) => [k, ''])),
        'Empty: secrets.PLY_ANDROID_KEYSTORE_BASE64 secrets.PLY_ANDROID_KEYSTORE_PASSWORD secrets.PLY_ANDROID_KEY_ALIAS secrets.PLY_ANDROID_KEY_PASSWORD vars.PLY_ANDROID_CERT_SHA256'],
      ['アップロード鍵が一部だけなら止まる', { UPLOAD_KEYSTORE_BASE64: 'BBBB' }, 'The upload key is only partly configured'],
      ['production には上げない', { TRACK: 'production' }, 'is not allowed here'],
      ['オープンテスト（beta）には上げない', { TRACK: 'beta' }, 'is not allowed here'],
      ['フォームファクターのトラックは使わない', { TRACK: 'wear:internal' }, 'Form factor tracks'],
      ['トラック名に使えない字は止まる', { TRACK: 'a b' }, 'Invalid track name'],
      ['段階公開に割合が無ければ止まる', { STATUS: 'inProgress' }, 'needs user_fraction'],
      ['段階公開の割合が 1 なら止まる', { STATUS: 'inProgress', FRACTION: '1' }, 'needs user_fraction'],
      ['段階公開の割合が数でなければ止まる', { STATUS: 'inProgress', FRACTION: 'half' }, 'needs user_fraction'],
      ['下書きに割合を付けたら止まる', { FRACTION: '0.5' }, 'only for status inProgress'],
    ];
    for (const [label, env, message] of fails) {
      const r = check({ ...BASE, ...env });
      t.ok(label, r.code !== 0 && r.log.includes(`::error::`) && r.log.includes(message) && !r.output.includes('key='), JSON.stringify(r));
    }
    for (const [label, env] of [
      ['自分で作ったクローズドテストのトラックへは上げられる', { TRACK: 'closed-12-testers' }],
      ['既定のクローズドテスト（alpha）へ上げられる', { TRACK: 'alpha', STATUS: 'completed' }],
      ['段階公開は 0 と 1 の間の割合で通る', { STATUS: 'inProgress', FRACTION: '0.2' }],
    ]) {
      const r = check({ ...BASE, ...env });
      t.ok(label, r.code === 0, JSON.stringify(r));
    }
    const wrongType = check({ ...BASE, PLAY_JSON: '{"type":"authorized_user","secret":"do-not-print"}' });
    const broken = check({ ...BASE, PLAY_JSON: 'do-not-print {"private_key":"x"' });
    t.ok('Secrets の値をログに出さない（壊れた JSON の例外も）', [ok, wrongType, broken].every((r) => !r.log.includes('do-not-print') && !r.log.includes('BEGIN PRIVATE KEY')),
      JSON.stringify([wrongType.log, broken.log]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
