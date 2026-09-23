// safe-storage-smoke.cjs が utilityProcess として起動する側。core/server.mjs と同じく defaultCipher()（parentPort で main に頼む）を使い、
// 秘密の置き場に書いて・読んで、ファイルの中身と「暗号化できない起動（npm start）」からの見え方を調べて main に返す。
// 引数: <秘密のファイルを置くディレクトリ>
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SENTINEL = 'PLY_SAFE_STORAGE_SMOKE_SENTINEL';

(async () => {
  const result = {};
  try {
    const { createSecretStore, defaultCipher, plainCipher } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'core', 'secret-store.mjs')).href);
    const file = path.join(process.argv.at(-1), 'mcp-secrets.json');
    const store = createSecretStore({ file, cipher: defaultCipher() });
    result.status = await store.status();
    await store.set('mcp:smoke:oauth', { tokens: { access_token: SENTINEL } });
    const raw = await fs.readFile(file, 'utf8');
    result.plaintextOnDisk = raw.includes(SENTINEL);
    result.entryEnc = JSON.parse(raw).entries['mcp:smoke:oauth'].enc;
    result.roundtrip = (await store.get('mcp:smoke:oauth'))?.tokens?.access_token === SENTINEL;
    // 同じファイルを npm start（Electron なし）の置き場として開いたときの見え方
    try { await createSecretStore({ file, cipher: plainCipher }).get('mcp:smoke:oauth'); result.lockedCode = null; }
    catch (e) { result.lockedCode = e.code ?? e.message; }
    // npm start で平文として書かれた項目を、暗号化できる起動で暗号化し直す
    await createSecretStore({ file, cipher: plainCipher }).set('mcp:smoke:static', { bearer: SENTINEL });
    result.migrated = await store.migrate();
    const after = JSON.parse(await fs.readFile(file, 'utf8'));
    result.plainAfterMigrate = Object.values(after.entries).filter(e => e.enc === 'plain').length;
    result.migratedReadable = (await store.get('mcp:smoke:static'))?.bearer === SENTINEL;
  } catch (e) {
    result.error = String(e?.stack ?? e).slice(0, 1000);
  }
  process.parentPort.postMessage({ type: 'smoke-result', result });
})();
