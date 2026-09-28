import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compaction-contract-'));
process.env.AGENT_HOST_DATA = scratch;
try {
  const { compactionContracts } = await import('../unit/conversations.mjs');
  await compactionContracts();
  console.log('compaction contracts passed');
} finally { await fs.rm(scratch, { recursive: true, force: true }); }
