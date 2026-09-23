import fs from 'node:fs/promises';
import path from 'node:path';
import { t } from './i18n.mjs';

export const DATA_SCHEMA = 1;
// This release does not transform existing data. Future format changes must add
// an explicit migration with a backup before increasing DATA_SCHEMA.
export async function ensureDataSchema(directory) {
  const file = path.join(directory, 'data-schema.json');
  let schema;
  try { schema = JSON.parse(await fs.readFile(file, 'utf8')).schema; if (!Number.isInteger(schema)) throw new Error('Invalid schema'); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(t('data.schemaUnreadable')); }
  if (schema !== undefined && schema !== DATA_SCHEMA) throw new Error(t('data.schemaMismatch'));
  if (schema === undefined) {
    await fs.mkdir(directory, { recursive: true });
    try { await fs.writeFile(file, JSON.stringify({ schema: DATA_SCHEMA }) + '\n', { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; return ensureDataSchema(directory); }
  }
}
