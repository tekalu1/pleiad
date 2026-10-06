// tests/run.mjs の最初の import。**どの import よりも前に**（import は書いた順に評価される）、テストのデータ置き場を決める。
//
// 1) AGENT_HOST_DATA が無ければ、新しい一時ディレクトリにする。core を同じプロセスに読み込むテスト（core/store・conversations など）は、
//    置き場を指定しないと既定の ~/.agent-host を使う。今の作りでは開いただけで形式の移行が走るので、テストが利用者の本物のデータを
//    書き換えてしまう（2026-10-03 に起きた。tests/unit/system-messages-leading.mjs が prepareMessages → store.get で既定の置き場を開いた）。
//    子プロセス（サーバー・worker）は環境変数を引き継ぐ。テストが自分の置き場を指定するときは、そちらが使われる。
// 2) PLEIAD_TEST_GUARD_HOME に本物の置き場（os.homedir()/.agent-host）を入れる。値がある間、core/test-guard.mjs が、その中を
//    DB・ロック・形式の移行・設定の JSON で開こうとすると例外にする。AGENT_HOST_DATA を本物に向けても、サーバーを子プロセスで立てても効く。
// 3) 実行元（Pleiad の会話のシェルなど）から継いだ Pleiad の環境変数（AGENT_HOST_・PLEIAD_・PLY_・AGENT_BROWSER_ で始まるもの）を外す
//    （tests/lib/inherited-env.mjs。テストの実行に要る利用者の変数だけ残す）。残すと、会話に束縛された CLI の接続情報が
//    テストの中の Claude の env へ引き継がれて control-delivery が落ち、ops-cli などが走っている本物の Pleiad につながり、
//    AGENT_HOST_SERVER_LOG でテストのサーバーの出力がインストール版の server.log へ流れて起動の合図が見えなくなる。
//    CI（これらが無い）と同じ条件にそろえる。テストが自分で渡す値（子プロセスの env へ明示するもの）は、ここより後なので影響を受けない。
//    tests/run.mjs の子プロセス worker も、最初にこのファイルを読むので同じ。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scrubInheritedEnv } from './inherited-env.mjs';

/** 実際に外したもの（名前だけ。値は持たない） */
export const scrubbedEnv = scrubInheritedEnv(process.env);

const guarded = new Set(String(process.env.PLEIAD_TEST_GUARD_HOME ?? '').split(path.delimiter).map(s => s.trim()).filter(Boolean));
guarded.add(path.join(os.homedir(), '.agent-host'));
process.env.PLEIAD_TEST_GUARD_HOME = [...guarded].join(path.delimiter);

/** このプロセスが作った一時の置き場（利用者が AGENT_HOST_DATA を渡したときは作らない） */
let created = null;
if (!process.env.AGENT_HOST_DATA) {
  created = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-test-data-'));
  process.env.AGENT_HOST_DATA = created;
}
// 4) Chrome の User Data を、存在しない一時ディレクトリへ向ける。テストが利用者の本物の Chrome の DevToolsActivePort を読まない（core/chrome/locate.mjs。
//    偽の Chrome を使うテストは、自分の一時ディレクトリを AGENT_HOST_CHROME_USER_DATA に渡す）
if (!process.env.AGENT_HOST_CHROME_USER_DATA) process.env.AGENT_HOST_CHROME_USER_DATA = path.join(os.tmpdir(), `pleiad-test-no-chrome-${process.pid}`);
export const testDataDir = process.env.AGENT_HOST_DATA;
/** このプロセスが作った一時の置き場か（利用者が AGENT_HOST_DATA を渡したときは false） */
export const testDataOwned = created !== null;

/** 終わりに、一時の置き場の DB の接続を離してから消す（Windows は開いたままのファイルを消せない）。消せなくても、残るだけ */
export async function cleanupTestData() {
  if (!created) return;
  try { (await import('../../core/store.mjs')).closeStore(); } catch { /* 開いていない */ }
  try { await (await import('../../core/conversations.mjs')).closeConversations(); } catch { /* 開いていない */ }
  try { fs.rmSync(created, { recursive: true, force: true }); } catch { /* 開いたままのものがあれば、残るだけ */ }
}
