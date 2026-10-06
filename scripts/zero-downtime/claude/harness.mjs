// 段階 2-0 の探りの共通の台: 保持役（holder.mjs）を起こし、親（parent.mjs）を別プロセスで起こして見張り、taskkill /F で捨てる。
// run.mjs（段階 0）と同じ作り。記録は <リポジトリ>/temporary/zdu-stage2/<場面>-<時刻>/ に出す（コミットしない）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectHolder, holderRequest, pipePath, sleep } from './common.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(here, '..', '..', '..');
export const tempRoot = path.join(repoRoot, 'temporary', 'zdu-stage2');
export { sleep };

export async function createRun(scenario, opt = {}) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const runDir = path.join(tempRoot, `${scenario}-${stamp}-${process.pid}`);
  const workDir = path.join(runDir, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  const T0 = Date.now();
  const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(6)}s]`, ...a);
  const pipe = pipePath(`zdu2-holder-${process.pid}-${stamp}`);
  const holder = spawn(process.execPath, [path.join(here, 'holder.mjs'), pipe], { env: { ...process.env, HOLDER_LOG_DIR: runDir }, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  await new Promise(r => holder.stdout.once('data', r));
  const hc = await connectHolder(pipe);
  const parents = [];
  const run = { scenario, opt, runDir, workDir, pipe, hc, holder, parents, log, T0 };

  run.startParent = over => {
    const n = parents.length;
    const cfgFile = path.join(runDir, `parent-${n}.json`);
    const cfg = { pipe, id: 'c1', cwd: workDir, probeLog: path.join(runDir, 'probe-mcp.jsonl'), ...over };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const proc = spawn(process.execPath, [path.join(here, 'parent.mjs'), cfgFile], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const events = [];
    const out = fs.createWriteStream(path.join(runDir, `parent-${n}-${cfg.role}.jsonl`));
    let buf = '';
    const waiters = [];
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        out.write(line + '\n');
        let e; try { e = JSON.parse(line); } catch { continue; }
        events.push(e);
        for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
      }
    });
    proc.stderr.on('data', d => out.write(`STDERR ${d}`));
    const p = {
      proc, events, cfg, exited: false, n,
      waitFor(pred, ms = 120_000) {
        const hit = events.find(pred);
        if (hit) return Promise.resolve(hit);
        return new Promise(resolve => {
          const w = { pred, resolve };
          waiters.push(w);
          setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); resolve(null); } }, ms);
        });
      },
      kill() { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); p.killedAt = Date.now(); },
      lastPushSeq: () => events.filter(e => e.ev === 'push').reduce((m, e) => Math.max(m, e.seq), 0),
      lastMsgSeq: () => events.filter(e => e.ev === 'msg' && e.seq).reduce((m, e) => Math.max(m, e.seq), 0),
      results: () => events.filter(e => e.ev === 'msg' && e.type === 'result'),
    };
    proc.on('exit', () => { p.exited = true; });
    parents.push(p);
    return p;
  };

  run.dump = () => holderRequest(hc, { t: 'dump', id: 'c1' }, 'dump').catch(() => null);
  run.info = () => holderRequest(hc, { t: 'info' }, 'info').catch(() => null);
  run.probeEvents = () => { try { return fs.readFileSync(path.join(runDir, 'probe-mcp.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

  run.finish = async (extra = {}) => {
    const dump = await run.dump();
    const summary = { scenario, opt, parents: parents.map(summarize), holder: dump && { lines: dump.lines.length, alive: dump.alive, exit: dump.exit }, probe: run.probeEvents().map(e => ({ ev: e.ev, pid: e.pid, count: e.count, action: e.action, inits: e.inits })), ...extra };
    fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    for (const p of parents) if (!p.exited) p.kill();
    hc.send({ t: 'shutdown' });
    await sleep(500);
    spawnSync('taskkill', ['/PID', String(holder.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    log('run dir:', runDir);
    process.exit(0);
  };
  log('scenario', scenario, JSON.stringify(opt), 'run dir', runDir);
  return run;
}

export function summarize(p) {
  const ev = p.events;
  const by = name => ev.filter(e => e.ev === name);
  const msgs = ev.filter(e => e.ev === 'msg');
  return {
    role: p.cfg.role,
    canUseTool: by('canUseTool').map(e => ({ ms: e.ms, tool: e.toolName, requestId: e.requestId })),
    pushed: by('push').length,
    redeliveredPushes: by('push').filter(e => e.redelivered).map(e => ({ seq: e.seq, rid: e.rid, type: e.type, sub: e.sub })),
    attached: by('attached')[0] ?? null,
    hooks: ev.filter(e => e.ev.startsWith('hook.')).map(e => `${e.ev}@${e.ms}`),
    elicitation: by('elicitation').map(e => ({ ms: e.ms, requestId: e.requestId })), userDialog: by('userDialog').map(e => ({ ms: e.ms, kind: e.kind })), oauthRefresh: by('oauthRefresh').map(e => e.ms),
    steer: by('steer.push').map(e => e.uuid),
    replays: msgs.filter(e => e.type === 'user' && e.isReplay).map(e => ({ uuid: e.uuid, text: e.text })),
    toolUses: msgs.filter(e => e.type === 'assistant').flatMap(e => (e.blocks ?? []).filter(b => 'tool_use' in b).map(b => ({ ...b, ptu: e.ptu }))),
    toolResults: msgs.filter(e => e.type === 'user').flatMap(e => (e.blocks ?? []).filter(b => 'tool_result' in b).map(b => ({ ...b, ptu: e.ptu }))),
    system: msgs.filter(e => e.type === 'system').map(e => e.subtype),
    result: msgs.filter(e => e.type === 'result').map(e => ({ ms: e.ms, is_error: e.is_error, result: e.result, cost: e.cost })),
    errors: by('error').concat(by('unhandledRejection')).map(e => e.error),
    stderr: by('cli.stderr').map(e => e.d).slice(-5),
    done: by('done').length > 0,
  };
}

/** 保持役の記録の uuid を持つ行が、どの親のアプリにも届いたか（取りこぼし・重複） */
export async function coverage(run, ps) {
  const dump = await run.dump();
  const uuidLines = dump.lines.filter(l => l.uuid && l.type !== 'system/session_state_changed');
  const sets = ps.map(p => new Set(p.events.filter(e => e.ev === 'msg' && e.seq).map(e => e.seq)));
  const missing = uuidLines.filter(l => !sets.some(s => s.has(l.seq))).map(l => `${l.seq}:${l.type}`);
  const dup = [];
  for (let i = 0; i < sets.length; i++) for (let j = i + 1; j < sets.length; j++) for (const s of sets[i]) if (sets[j].has(s)) dup.push(s);
  return { holderLines: dump.lines.length, uuidLines: uuidLines.length, missing, dup };
}
