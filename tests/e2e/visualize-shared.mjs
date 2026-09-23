import fs from 'node:fs/promises';
import path from 'node:path';

export async function checkVisualize(t, ctx, backend) {
  const html = path.join(ctx.work, 'sample.html');
  await fs.writeFile(html, '<button id="count">0</button><script>document.getElementById("count").onclick=e=>e.target.textContent=Number(e.target.textContent)+1</script><p>Pleiad visualize check</p>');
  const c = await ctx.open(); let sessionId;
  try {
    sessionId = (await c.cmd('newSession', { backend, cwd: ctx.work, mode: backend === 'claude' ? 'default' : backend === 'procway' ? 'always-ask' : 'readonly' })).sessionId;
    const first = await c.runTurn({sessionId, prompt:`表示の接続テストです。既存の ${JSON.stringify(html)} を変更せず、Pleiad の Visualize 形式で会話内に表示してください。タイトルは「HTML check」。MCPツールの呼び出しは不要です。説明は不要です。`}, {ms:180000});
    t.ok(`${backend}: first turn completes`, first.outcome==='ok', first.outcome === 'ok' ? 'ok' : JSON.stringify(first.events.filter(e=>e.type==='turnResult')));
    const visuals = first.events.filter(e=>e.kind==='visualization');
    t.ok(`${backend}: HTML snapshot routed to the host conversation`, visuals.length===1 && visuals[0].sessionId===sessionId && visuals[0].content?.includes('Pleiad visualize check'), JSON.stringify(visuals.map(e=>({kind:e.kind,error:e.error}))));
    await fs.writeFile(html,'<p>resumed-visualize</p>');
    const second = await c.runTurn({sessionId, prompt:`同じ ${JSON.stringify(html)} を再び Visualize 形式で表示してください。タイトルは「再開確認」。ファイル操作は不要です。`}, {ms:180000});
    t.ok(`${backend}: resumed session can visualize`, second.outcome==='ok' && second.events.some(e=>e.kind==='visualization'&&e.content==='<p>resumed-visualize</p>'));
    const saved = await c.cmd('loadSession',{sessionId});
    t.ok(`${backend}: each version survives reload`, saved.presents.length===2 && saved.presents[0].content.includes('Pleiad visualize check') && saved.presents[1].content.includes('resumed-visualize'));
    t.ok(`${backend}: no retired present call`, ![...first.events,...second.events].some(e=>e.type==='tool.start'&&/mcp__ply__present/.test(e.name)));
  } finally { if(sessionId) await c.cmd('abort',{sessionId}).catch(()=>{}); c.close(); }
}
