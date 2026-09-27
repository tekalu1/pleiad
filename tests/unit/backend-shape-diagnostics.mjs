import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordBackendShapeMismatch } from '../../core/backend-shape-diagnostics.mjs';
import { readTurnRejections } from '../../core/backends/codex-rejections.mjs';
import { invalidSubagentTranscript, invalidQueuedCommandTranscript } from '../../core/backends/claude-normalize.mjs';
import { invalidAgyEvent } from '../../core/backends/antigravity-cli.mjs';

export const name = 'backend-shape-diagnostics';
export const title = '外部エージェントの非公開形式の不一致を一度だけ安全に記録する';

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-backend-shape-'));
  const log = path.join(dir, 'backend-shape-errors.log');
  const turn = 'turn-1';
  const meta = JSON.stringify({ type: 'session_meta', payload: { cli_version: '0.156.1', cwd: 'C:/SECRET-PATH' } });
  const row = JSON.stringify({ type: 'response_item', payload: { type: 'message', internal_chat_message_metadata_passthrough: { turn_id: turn }, content: [] } });
  try {
    const file = path.join(dir, 'rollout.jsonl');
    await fs.writeFile(file, meta + '\n' + row + '\n');
    t.ok('正常な rollout は記録しない', (await readTurnRejections({ file, from: 0, turnId: turn, dataDir: dir, waits: [] })).length === 0 && !(await fs.stat(log).catch(() => null)));

    await fs.writeFile(file, row + '\n');
    await readTurnRejections({ file, from: 0, turnId: turn, dataDir: dir, waits: [] });
    await readTurnRejections({ file, from: 0, turnId: turn, dataDir: dir, waits: [] });
    let records = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    t.ok('session_meta 欠落は同じ版・種類につき一度', records.length === 1 && records[0].kind === 'rollout-session-meta');

    await fs.writeFile(file, meta + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', content: [] } }) + '\n');
    await readTurnRejections({ file, from: 0, turnId: turn, dataDir: dir, waits: [] });
    records = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    t.ok('このターンの turn_id が無ければ検知した版とともに記録', records.length === 2 && records[1].kind === 'rollout-turn-id' && records[1].detectedVersion === '0.156.1');

    await recordBackendShapeMismatch({ dataDir: dir, backend: 'claude', kind: 'subagent-shape', detectedVersion: 'SECRET C:/PRIVATE' });
    await recordBackendShapeMismatch({ dataDir: dir, backend: 'claude', kind: 'subagent-shape', detectedVersion: 'SECRET C:/PRIVATE' });
    const text = await fs.readFile(log, 'utf8');
    records = text.trim().split('\n').map(JSON.parse);
    t.ok('秘密とパスは記録されず版は検証される', records.length === 3 && records[2].detectedVersion === 'unknown' && !text.includes('SECRET') && !text.includes('PRIVATE') && !text.includes('C:/'));
    t.ok('記録項目は限定される', records.every(r => Object.keys(r).sort().join() === 'at,backend,detectedVersion,kind,verifiedVersion'));

    const goodSub = JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'secret' }, version: '2.1.282' }) + '\n';
    const goodQueued = JSON.stringify({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', prompt: 'secret' }, version: '2.1.282' }) + '\n';
    t.ok('Claude の正常な transcript の形は通す', !invalidSubagentTranscript(goodSub) && !invalidQueuedCommandTranscript(goodQueued));
    t.ok('Claude の壊れた transcript の形を検知する', invalidSubagentTranscript('{"type":"user","message":{}}\n') && invalidQueuedCommandTranscript('{"type":"attachment","attachment":{"type":"queued_command"}}\n'));
    t.ok('Antigravity の正常な stream-json は通し、形が違えば検知', !invalidAgyEvent({ event: 'result', result: { status: 'SUCCESS' } }) && invalidAgyEvent({ event: 'result', result: null }));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
