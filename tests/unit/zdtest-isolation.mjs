// 無停止の更新 段階 1 の 1-7 の実機の確認（scripts/zero-downtime/stage1-7/）の守り: 試験用のインストール版が、利用者のインストール版
// （appId・インストール先・データ置き場・実行場所・userData・ポート）と重ならないこと。実機の確認はこの確かめを通ってからインストーラーを動かす。
import path from 'node:path';
import { ZD, USER_INSTALL, assertIsolated, overlaps, zdPaths, cleanEnv } from '../../scripts/zero-downtime/stage1-7/lib.mjs';

export const name = 'zdtest-isolation';
export const title = '無停止の更新の実機の確認: 試験用のインストール版が利用者のインストール版と重ならない（名前・場所・ポート）';

const throws = fn => { try { fn(); return null; } catch (error) { return error.message; } };

export default async function (t) {
  t.ok('既定の試験用の構成は、利用者のインストール版と重ならない', throws(() => assertIsolated(ZD, USER_INSTALL)) === null);
  t.ok('試験用の置き場（データ・実行場所・userData）は、試験用の home の下', Object.values(zdPaths(ZD.home)).every(dir => dir === ZD.home || path.relative(ZD.home, dir).split(path.sep)[0] !== '..'));
  t.ok('インストール先と実行場所は、NSIS が止める前方一致の関係にならない（どちらも相手を前方一致で含まない）', !overlaps(ZD.installDir, zdPaths(ZD.home).runtime));
  t.ok('overlaps: 同じ場所・親子・前方一致（大小文字を無視）は重なり、兄弟は重ならない', overlaps('C:\\a\\Ply', 'c:\\A\\ply\\') && overlaps('C:\\a\\Ply', 'C:\\a\\Ply\\x') && overlaps('C:\\a\\Ply-runtime', 'C:\\a\\Ply') && !overlaps('C:\\a\\Ply', 'C:\\a\\Pleiad'));
  const clash = overrides => throws(() => assertIsolated({ ...ZD, ...overrides }, USER_INSTALL));
  t.ok('appId が利用者のものと同じなら止まる', /appId/.test(clash({ appId: USER_INSTALL.appId }) ?? ''));
  t.ok('ポートが利用者の既定と同じなら止まる', /port/.test(clash({ port: USER_INSTALL.port }) ?? ''));
  t.ok('インストール先が利用者のインストール先と同じ・前方一致なら止まる', clash({ installDir: USER_INSTALL.installDir }) !== null && clash({ installDir: `${USER_INSTALL.installDir}-test` }) !== null);
  t.ok('home が利用者のデータ置き場・実行場所の中なら止まる', clash({ home: USER_INSTALL.data }) !== null && clash({ home: path.join(USER_INSTALL.runtime, 'x') }) !== null);
  const inherited = { PLEIAD_CONTROL_URL: 'http://127.0.0.1:1', AGENT_HOST_PORT: '7420', ELECTRON_RUN_AS_NODE: '1', AGENT_BROWSER_SESSION: 'x' };
  const saved = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  const env = cleanEnv({ KEEP: 'yes' });
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  t.ok('cleanEnv: Pleiad のシェルから引き継がれた変数（ポート・制御・ブラウザー・Node 化）を外し、ほかは残す', Object.keys(inherited).every(key => !(key in env)) && env.KEEP === 'yes');
}
