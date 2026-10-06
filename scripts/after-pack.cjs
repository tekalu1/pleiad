// electron-builder.yml の afterPack。順番が大事なので 1 つにまとめる:
// agent-browser を resources に置いた後で、実行場所の材料（公式の Node・manifest。agent-browser の SHA-256 も控える）を作る
const packAgentBrowser = require('./pack-agent-browser.cjs');
const packRuntime = require('./pack-runtime.cjs');

module.exports = async function afterPack(context) {
  await packAgentBrowser(context);
  await packRuntime(context);
};
