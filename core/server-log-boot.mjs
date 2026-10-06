// core/server.mjs が最初に読み込む。AGENT_HOST_SERVER_LOG があれば、他のモジュールが読み込まれる前から出力をファイルへ向ける
// （import の失敗も記録に残すため。core/server-log.mjs）
import { redirectOutput } from './server-log.mjs';

if (process.env.AGENT_HOST_SERVER_LOG) redirectOutput({ file: process.env.AGENT_HOST_SERVER_LOG });
