// run.mjs の summary.json を短く並べる。使い方: node brief.mjs <summary.json>...
import fs from 'node:fs';
for (const f of process.argv.slice(2)) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`== ${s.scenario} ${JSON.stringify(s.opt)} from=${s.from}`);
  for (const p of s.parents) {
    console.log(`  ${p.role}: canUseTool=${p.canUseTool.map(c => c.requestId.slice(0, 8) + '@' + c.ms).join(',') || '-'} allowed=${p.canUseToolAllowed} pushed=${p.pushed} redeliveredPush=${p.redeliveredPushes.length} hookPre=[${p.hookPre}] hookPost=[${p.hookPost}] mcp=[${p.mcp}]`);
    console.log(`     toolUses=${JSON.stringify(p.toolUses.map(t => t.tool_use))} toolResults=${JSON.stringify(p.toolResults.map(t => (t.is_error ? 'ERR:' : '') + t.tool_result.slice(0, 60)))} result=${JSON.stringify(p.result.map(r => r.result))} errors=${JSON.stringify(p.errors)} done=${p.done}`);
  }
  if (s.analysis) console.log('  analysis', JSON.stringify(s.analysis));
  console.log('  holder', JSON.stringify(s.holder), s.error ?? '');
}
