// run2.mjs の summary.json を短く並べる。使い方: node brief2.mjs <記録フォルダーか summary.json>...
import fs from 'node:fs';
import path from 'node:path';

const cut = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? s.slice(0, n) + '…' : s; };
for (const a of process.argv.slice(2)) {
  const f = a.endsWith('.json') ? a : path.join(a, 'summary.json');
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  const { scenario, opt, parents, holder, probe, ...extra } = s;
  console.log(`== ${scenario} ${JSON.stringify(opt)}  (${path.basename(path.dirname(f))})`);
  for (const p of parents) {
    const parts = [];
    if (p.attached) parts.push(`attached(seq=${p.attached.seq} pending=${cut(p.attached.pending?.map(x => x.sub), 80)})`);
    if (p.canUseTool.length) parts.push(`canUseTool=${p.canUseTool.map(c => c.requestId.slice(0, 8) + '@' + c.ms).join(',')}`);
    if (p.redeliveredPushes.length) parts.push(`redelivered=${cut(p.redeliveredPushes.map(r => r.sub))}`);
    if (p.hooks.length) parts.push(`hooks=${cut(p.hooks)}`);
    if (p.elicitation.length) parts.push(`elicitation=${cut(p.elicitation.map(e => e.ms))}`);
    if (p.userDialog.length) parts.push(`userDialog=${cut(p.userDialog)}`);
    if (p.oauthRefresh.length) parts.push(`oauthRefresh=${cut(p.oauthRefresh)}`);
    if (p.steer.length) parts.push(`steer=${cut(p.steer)}`);
    if (p.replays.length) parts.push(`replays=${cut(p.replays)}`);
    console.log(`  ${p.role}: pushed=${p.pushed} ${parts.join(' ')}`);
    console.log(`     toolUses=${cut(p.toolUses.map(t => (t.ptu ? 'sub:' : '') + t.tool_use + ' ' + t.input), 300)}`);
    console.log(`     toolResults=${cut(p.toolResults.map(t => (t.ptu ? 'sub:' : '') + (t.is_error ? 'ERR:' : '') + t.tool_result.slice(0, 80)), 400)}`);
    console.log(`     system=${cut(p.system, 300)}`);
    console.log(`     result=${cut(p.result.map(r => `${r.is_error ? 'ERR:' : ''}${r.result}@${r.ms}`), 300)} errors=${cut(p.errors, 300)} done=${p.done}`);
    if (p.stderr?.length) console.log(`     stderr=${cut(p.stderr, 300)}`);
  }
  if (probe?.length) console.log(`  probe=${cut(probe.map(e => `${e.ev}${e.count ? '#' + e.count : ''}${e.inits ? ' inits=' + e.inits : ''}${e.action ? ' ' + e.action : ''} pid=${e.pid}`), 500)}`);
  console.log(`  holder=${JSON.stringify(holder)}`);
  for (const [k, v] of Object.entries(extra)) console.log(`  ${k}=${cut(v, 700)}`);
}
