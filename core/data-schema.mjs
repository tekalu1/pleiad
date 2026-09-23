import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_SCHEMA = 1;
// This release does not transform existing data. Future format changes must add
// an explicit migration with a backup before increasing DATA_SCHEMA.
export async function ensureDataSchema(directory) {
  const file = path.join(directory, 'data-schema.json');
  let schema;
  try { schema = JSON.parse(await fs.readFile(file, 'utf8')).schema; if (!Number.isInteger(schema)) throw new Error('Invalid schema'); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('保存データの形式を確認できません。data-schema.json を確認してください。'); }
  if (schema !== undefined && schema !== DATA_SCHEMA) throw new Error('この保存データは別の形式です。対応する新しい Pleiad を使用してください。データは変更していません。');
  if (schema === undefined) {
    await fs.mkdir(directory, { recursive: true });
    try { await fs.writeFile(file, JSON.stringify({ schema: DATA_SCHEMA }) + '\n', { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; return ensureDataSchema(directory); }
  }
}
