import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compaction-contract-'));
process.env.AGENT_HOST_DATA = scratch;
try {
  const { compactionContracts, hiddenDeleteContracts, botContextContracts, abandonedSessionContracts, missingTranscriptContracts, deleteContracts } = await import('../unit/conversations.mjs');
  await compactionContracts();
  console.log('compaction contracts passed');
  await botContextContracts();
  console.log('bot context contracts passed');
  await hiddenDeleteContracts();
  console.log('hidden delete contracts passed');
  await abandonedSessionContracts();
  console.log('abandoned session contracts passed');
  await missingTranscriptContracts();
  console.log('missing transcript contracts passed');
  await deleteContracts();
  console.log('delete contracts passed');
} finally {
  // データ置き場を消す前に DB の接続を離す（Windows は開いたままのファイルを消せない）
  await (await import('../../core/conversations.mjs')).closeConversations();
  (await import('../../core/store.mjs')).closeStore();
  await fs.rm(scratch, { recursive: true, force: true });
}
