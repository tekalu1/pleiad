// 配布物に入れる実行場所の材料（scripts/pack-runtime.cjs・after-pack.cjs・node-runtime.json。無停止の更新 1-3）。
// Node の取得は注入した偽の取得元で行い、ネットワークは使わない。
//   - 公式の Node の取得: キャッシュ・SHA-256 と大きさの照合（合わなければ置かない・壊れたキャッシュは取り直す）
//   - resources\runtime と resources\app\manifest.json の中身（x64・arm64・Windows 以外）
//   - 固定の値（版・SHA-256 の形）と、afterPack の順序
//   - 動かさない OS・CPU の node-pty の prebuild は manifest の前に外す（NSIS が別 CPU の .exe・.dll を落とす。2026-10-06）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packRuntime = require('../../scripts/pack-runtime.cjs');
const manifestLib = require('../../desktop/runtime-manifest.cjs');
const runtime = require('../../desktop/runtime.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const name = 'pack-runtime';
export const title = '配布物の実行場所の材料: 公式の Node の取得と照合・runtime.json・manifest.json・afterPack の順序';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');

export default async function (t) {
  // ---- 固定の値
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'node-runtime.json'), 'utf8'));
  const archs = Object.entries(config.win32);
  t.ok('node-runtime.json: 版が 24 系（Electron の Node と同じメジャー版）で、x64 と arm64 がある', /^24\.\d+\.\d+$/.test(config.version) && archs.map(([arch]) => arch).sort().join() === 'arm64,x64');
  t.ok('node-runtime.json: どれも公式の URL（版と CPU を含む）・64 桁の SHA-256・大きさ', archs.every(([arch, entry]) => entry.url === `https://nodejs.org/dist/v${config.version}/win-${arch}/node.exe` && /^[0-9a-f]{64}$/.test(entry.sha256) && entry.size > 50_000_000));
  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  t.ok('electron-builder.yml: afterPack は scripts/after-pack.cjs', /^afterPack:\s*\.\/scripts\/after-pack\.cjs\s*$/m.test(yml));
  const after = fs.readFileSync(path.join(ROOT, 'scripts', 'after-pack.cjs'), 'utf8');
  t.ok('after-pack.cjs: agent-browser を置いた後で実行場所の材料を作る（agent-browser の SHA-256 を控えるため）', after.indexOf('await packAgentBrowser(context)') > 0 && after.indexOf('await packAgentBrowser(context)') < after.indexOf('await packRuntime(context)'));

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-host-pack-runtime-'));
  try {
    // ---- 取得と照合
    const good = Buffer.from('official-node-binary-'.repeat(100));
    const entry = { url: 'https://example.invalid/node.exe', size: good.length, sha256: sha(good) };
    const cacheDir = path.join(scratch, 'cache');
    let downloads = 0;
    const serve = body => async (url, file) => { downloads += 1; assertUrl(url); await fsp.writeFile(file, body); };
    const assertUrl = url => { if (url !== entry.url) throw new Error(`unexpected url ${url}`); };
    const first = await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir, download: serve(good) });
    t.ok('取得: 取って、SHA-256 を照合してキャッシュへ置く', downloads === 1 && fs.readFileSync(first).equals(good) && path.dirname(first) === cacheDir);
    const second = await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir, download: serve(Buffer.from('should not be called')) });
    t.ok('取得: キャッシュが合っていれば取り直さない', downloads === 1 && second === first);
    await fsp.writeFile(first, Buffer.concat([good.subarray(0, 50), Buffer.from('X'), good.subarray(51)]));   // 同じ大きさで 1 バイト違う
    const healed = await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir, download: serve(good) });
    t.ok('取得: キャッシュが壊れていれば（同じ大きさでも）取り直す', downloads === 2 && fs.readFileSync(healed).equals(good));
    const otherCache = path.join(scratch, 'cache2');
    let rejected;
    try { await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir: otherCache, download: serve(Buffer.concat([good.subarray(0, 50), Buffer.from('Y'), good.subarray(51)])) }); } catch (e) { rejected = e; }
    t.ok('取得: SHA-256 が固定の値と合わなければ失敗し、キャッシュに置かない・一時ファイルも残さない', /does not match scripts\/node-runtime\.json/.test(rejected?.message ?? '') && fs.readdirSync(otherCache).length === 0, String(rejected?.message));
    let truncated;
    try { await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir: otherCache, download: serve(good.subarray(0, 100)) }); } catch (e) { truncated = e; }
    t.ok('取得: 途中で切れた（大きさが違う）ものも置かない', truncated && fs.readdirSync(otherCache).length === 0);
    let failed;
    try { await packRuntime.ensureNodeExe(entry, { version: '24.21.0', arch: 'x64', cacheDir: otherCache, download: async () => { throw new Error('offline'); } }); } catch (e) { failed = e; }
    t.ok('取得: 取れなければそのまま失敗する（未確認の実行ファイルを入れない）', failed?.message === 'offline' && fs.readdirSync(otherCache).length === 0);

    // ---- afterPack の中身
    const makeOut = async (name, { agent = true } = {}) => {
      const out = path.join(scratch, name);
      const app = path.join(out, 'resources', 'app');
      for (const [rel, content] of Object.entries({ 'package.json': JSON.stringify({ name: 'agent-host', version: '7.1.0' }), 'core/server.mjs': 'export {};\n', 'web/a.js': 'a\n' })) {
        await fsp.mkdir(path.dirname(path.join(app, rel)), { recursive: true });
        await fsp.writeFile(path.join(app, rel), content);
      }
      for (const prebuild of ['win32-x64', 'win32-arm64', 'darwin-arm64']) {
        const dir = path.join(app, 'node_modules', 'node-pty', 'prebuilds', prebuild);
        await fsp.mkdir(path.join(dir, 'conpty'), { recursive: true });
        await fsp.writeFile(path.join(dir, 'pty.node'), prebuild);
        await fsp.writeFile(path.join(dir, 'conpty', 'conpty.dll'), prebuild);
      }
      if (agent) { await fsp.mkdir(path.join(out, 'resources', 'agent-browser'), { recursive: true }); await fsp.writeFile(path.join(out, 'resources', 'agent-browser', 'agent-browser.exe'), 'agent-bin'); }
      return out;
    };
    const armBytes = Buffer.concat([good, Buffer.from('!')]);
    const testConfig = { version: '24.21.0', win32: { x64: entry, arm64: { url: 'https://example.invalid/arm64/node.exe', size: armBytes.length, sha256: sha(armBytes) } } };
    const downloader = async (url, file) => { await fsp.writeFile(file, url.includes('arm64') ? armBytes : good); };
    const out = await makeOut('out-x64');
    const packed = await packRuntime.packRuntime({ electronPlatformName: 'win32', arch: 1, appOutDir: out }, { config: testConfig, cacheDir, download: downloader });
    const runtimeJson = JSON.parse(fs.readFileSync(path.join(out, 'resources', 'runtime', 'runtime.json'), 'utf8'));
    t.ok('afterPack（x64）: resources\\runtime\\node.exe は公式の Node と同じ中身', fs.readFileSync(path.join(out, 'resources', 'runtime', 'node.exe')).equals(good));
    t.ok('afterPack（x64）: runtime.json に Node の版・CPU・SHA-256・大きさと、agent-browser の SHA-256 を控える', runtimeJson.schema === 1 && runtimeJson.node.version === '24.21.0' && runtimeJson.node.arch === 'x64' && runtimeJson.node.sha256 === entry.sha256
      && runtimeJson.node.size === good.length && runtimeJson.agentBrowser.sha256 === sha('agent-bin') && runtimeJson.agentBrowser.size === 9 && runtimeJson.agentBrowser.dir === 'agent-browser');
    const manifest = await manifestLib.readManifest(path.join(out, 'resources', 'app'));
    t.ok('afterPack: resources\\app\\manifest.json は読めて、全ファイルが一致する（自身を含まない・版は package.json のもの）', manifest.appVersion === '7.1.0' && packed.manifest.buildHash === manifest.buildHash
      && Object.keys(manifest.files).join() === 'core/server.mjs,node_modules/node-pty/prebuilds/win32-x64/conpty/conpty.dll,node_modules/node-pty/prebuilds/win32-x64/pty.node,package.json,web/a.js' && (await runtime.verifyTree(path.join(out, 'resources', 'app'), manifest, { deep: true })).ok);
    const prebuilds = dir => fs.readdirSync(path.join(dir, 'resources', 'app', 'node_modules', 'node-pty', 'prebuilds')).sort().join();
    t.ok('afterPack（x64）: 動かさない node-pty の prebuild（win32-arm64・darwin-arm64）は manifest の前に外し、win32-x64 は残す', packed.pruned.join() === 'darwin-arm64,win32-arm64' && prebuilds(out) === 'win32-x64');
    const outArm = await makeOut('out-arm64');
    await packRuntime.packRuntime({ electronPlatformName: 'win32', arch: 3, appOutDir: outArm }, { config: testConfig, cacheDir, download: downloader });
    t.ok('afterPack（arm64）: arm64 の Node を入れる', fs.readFileSync(path.join(outArm, 'resources', 'runtime', 'node.exe')).equals(armBytes) && JSON.parse(fs.readFileSync(path.join(outArm, 'resources', 'runtime', 'runtime.json'), 'utf8')).node.arch === 'arm64');
    t.ok('afterPack（arm64）: arm64 の prebuild だけを残す', prebuilds(outArm) === 'win32-arm64');
    const outNoAgent = await makeOut('out-noagent', { agent: false });
    await packRuntime.packRuntime({ electronPlatformName: 'win32', arch: 1, appOutDir: outNoAgent }, { config: testConfig, cacheDir, download: downloader });
    t.ok('afterPack: agent-browser が無ければ runtime.json に載せない', !('agentBrowser' in JSON.parse(fs.readFileSync(path.join(outNoAgent, 'resources', 'runtime', 'runtime.json'), 'utf8'))));
    const outMac = await makeOut('out-mac');
    const mac = await packRuntime.packRuntime({ electronPlatformName: 'darwin', arch: 1, appOutDir: outMac }, { config: testConfig, cacheDir, download: async () => { throw new Error('mac は取らない'); } });
    t.ok('afterPack: Windows 以外は何もしない（macOS は対象の外）', mac === null && !fs.existsSync(path.join(outMac, 'resources', 'runtime')) && !fs.existsSync(path.join(outMac, 'resources', 'app', 'manifest.json')));
    // 配布物の形のまま、実行場所を組める（ビルドと main の部品の突き合わせ）
    const root = path.join(scratch, 'runtime-root');
    const installed = await runtime.install({ root, resourcesDir: path.join(out, 'resources') });
    t.ok('配布物の形から実行場所を組める: Node・木・agent-browser が揃う', fs.existsSync(installed.nodeExe) && (await runtime.verifyTree(installed.appDir, manifest, { deep: true })).ok && fs.existsSync(path.join(installed.agentBrowserDir, 'agent-browser.exe')));
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}
