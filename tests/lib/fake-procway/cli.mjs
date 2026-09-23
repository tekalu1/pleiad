// procway-code の身代わりの置き場（tests/lib/fake-procway）。
//
// Pleiad は procway を必ず自前の起動口（core/procway-serve.mjs）で起こし、そこから
// `<src>/config/load-settings.mjs` `<src>/config/load-secrets.mjs` `<src>/adapters/serve/server.mjs` を読む。
// `<src>` は AGENT_HOST_PROCWAY_CODE（この cli.mjs）の置き場所。だからこのディレクトリに同じ名前の
// モジュールを置けば、LLM も procway 本体も無しに serve の WS プロトコルを台本で再現できる。
// このファイル自体は実行されない（serve 以外の使い方をされたら断る）。
console.error("fake procway-code: Pleiad の procway-serve.mjs 経由でだけ使う");
process.exit(1);
