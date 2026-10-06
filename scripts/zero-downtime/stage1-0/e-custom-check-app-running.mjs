// 1-0 e: NSIS の `customCheckAppRunning` を定義すると、更新・アンインストールで何が止まり・何が生き残り・入れ替えは通るか。
//   env -u ELECTRON_RUN_AS_NODE node scripts/zero-downtime/stage1-0/e-custom-check-app-running.mjs <変種>... | build <変種>... | summary
//   変種: ctrl（定義しない。本物の build/installer.nsh のまま）・noop（定義して何もしない）・nameonly（定義して、実行ファイル名だけで止める）・mixed（旧版は ctrl・新版は noop）
// 段階 0 の試験用アプリ（PlyZdProbe。appId・製品名・実行ファイル名が本物と違う）と nsis-survival.mjs をそのまま使う。
// 子は A（$INSTDIR の外・detached）・A2（外・detached なし）・B（utilityProcess から detached）・C（$INSTDIR の中）・D（$INSTDIR の前方一致の兄弟）。
// インストール版 Pleiad（Ply.exe）・そのデータ置き場には触れない。止めるのはこの試験が起こしたプロセスだけ。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const runtime = path.join(root, 'scripts', 'zero-downtime', 'runtime');
const installerNsh = path.join(root, 'build', 'installer.nsh').replace(/\//g, '\\');

const MACROS = {
  noop: '!macro customCheckAppRunning\n!macroend\n',
  nameonly: '!macro customCheckAppRunning\n  nsExec::Exec `"$SYSDIR\\cmd.exe" /C taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"`\n  Pop $0\n  Sleep 1000\n!macroend\n',
};
const wrapper = (variant, dir) => {
  const file = path.join(dir, `${variant}.nsh`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `!include "${installerNsh}"\n${MACROS[variant]}`);
  return file;
};
const work = name => path.join(root, 'temporary', name);
const envOf = (name, extra = {}) => { const e = { ...process.env, ZD_WORK_NAME: name, ...extra }; delete e.ELECTRON_RUN_AS_NODE; return e; };
const node = (script, args, env) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });

function build(variant) {
  if (variant === 'mixed') {
    // 旧版は ctrl の 1.0.0、新版（配信の 1.0.1）は noop。出来合いの installer を組み合わせる
    const dir = work('zdprobe-e-mixed');
    fs.mkdirSync(path.join(dir, 'feed'), { recursive: true });
    fs.copyFileSync(path.join(work('zdprobe-e-ctrl'), 'PlyZdProbe-1.0.0.exe'), path.join(dir, 'PlyZdProbe-1.0.0.exe'));
    for (const f of fs.readdirSync(path.join(work('zdprobe-e-noop'), 'feed'))) fs.copyFileSync(path.join(work('zdprobe-e-noop'), 'feed', f), path.join(dir, 'feed', f));
    return;
  }
  const name = `zdprobe-e-${variant}`;
  const extra = {};
  if (variant !== 'ctrl') { const inc = wrapper(variant, work(name)); extra.ZD_INC_V1 = inc; extra.ZD_INC_V2 = inc; }
  const r = spawnSync(process.execPath, [path.join(runtime, 'build-stub.mjs')], { env: envOf(name, extra), stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`build ${variant} failed`);
}

function runVariant(variant) {
  const name = `zdprobe-e-${variant}`;
  const env = envOf(name);
  const survival = (...args) => { const r = node(path.join(runtime, 'nsis-survival.mjs'), args, env); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout?.slice(-2000), status: r.status }; } };
  const out = { variant };
  try {
    survival('prep');
    out.install = survival('install');
    out.update = survival('run-update');
    out.uninstall = survival('run-uninstall');
  } finally { out.cleanup = survival('cleanup'); }
  return out;
}

const compact = r => {
  const kids = c => Object.fromEntries(Object.entries(c ?? {}).map(([k, v]) => [k.split('-')[0], typeof v === 'object' ? (v.running ?? v.alive) : v]));
  return {
    variant: r.variant,
    installStatus: r.install?.status,
    updateV2Started: Boolean(r.update?.timeline?.v2Version),
    updateV2Version: r.update?.timeline?.v2Version,
    quitAndInstallToV2StartMs: r.update?.timeline?.quitAndInstallToV2StartMs,
    childrenAliveAfterUpdate: kids(r.update?.children),
    childrenSeenByV2: Object.fromEntries(Object.entries(r.update?.v2SawChildren?.beforeQuit ?? {}).map(([k, v]) => [k.split('-')[0], v.alive])),
    uninstall: { exeExists: r.uninstall?.uninstall?.exeExists, instDirLeft: r.uninstall?.uninstall?.instDirLeft, ms: r.uninstall?.uninstall?.ms, childrenAlive: kids(r.uninstall?.after) },
    raw: { install: r.install?.raw, update: r.update?.raw, uninstall: r.uninstall?.raw },
  };
};

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'build') for (const v of rest) build(v);
else if (cmd === 'summary') {
  for (const v of rest) { const f = path.join(work(`zdprobe-e-${v}`), 'e-result.json'); if (fs.existsSync(f)) console.log(JSON.stringify(compact(JSON.parse(fs.readFileSync(f, 'utf8'))), null, 1)); }
} else {
  for (const v of [cmd, ...rest].filter(Boolean)) {
    const r = runVariant(v);
    fs.writeFileSync(path.join(work(`zdprobe-e-${v}`), 'e-result.json'), JSON.stringify(r, null, 1));
    console.log(JSON.stringify(compact(r), null, 1));
  }
}
