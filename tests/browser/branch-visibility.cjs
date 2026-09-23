// Run against an isolated fake server. The oldest session must have 12 turns,
// each echoing five paragraphs, so m:11 sits above later scrollable content.
// Repeat at desktop and narrow viewport sizes; sample both animation phases.
async page => {
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.locator('.row').last().click();
  await page.waitForFunction(()=>document.querySelectorAll('.mw[data-key]').length>=24);
  const m=page.locator('.m[data-role=assistant]').nth(5);
  await page.evaluate(()=>{
    const log=document.querySelector('#log'), row=[...document.querySelectorAll('.mw')].find(r=>r.dataset.key==='m:11');
    log.scrollTop=row.offsetTop-log.clientHeight+90;
    window.branchFrames=[];window.watchBranch=true;
    const sample=()=>{
      for(const r of document.querySelectorAll('.branch-row[data-phase="growing"],.branch-row[data-phase="switching"]')) {
        const b=r.getBoundingClientRect(),v=log.getBoundingClientRect();
        window.branchFrames.push({phase:r.dataset.phase,top:b.top-v.top,bottom:b.bottom-v.bottom,scroll:log.scrollTop});
      }
      if(window.watchBranch)requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
  });
  await m.locator('.forkbtn').click();
  await page.waitForFunction(()=>!!document.querySelector('.branch-row[data-phase="growing"]'));
  await page.waitForFunction(()=>window.branchFrames.some(f=>f.phase==='switching')&&!document.querySelector('.branch-tip:disabled'));
  return await page.evaluate(()=>{
    window.watchBranch=false;
    const frames=window.branchFrames;
    const node=document.querySelector('.mw.node .mw-gutter');
    const nodeColor=getComputedStyle(node,'::before').backgroundColor;
    const edgeColor=getComputedStyle(document.querySelector('.spine path')).stroke;
    const ringColor=getComputedStyle(document.querySelector('.branch-tip[aria-pressed=true] circle')).fill;
    if(!frames.some(f=>f.phase==='growing')||!frames.some(f=>f.phase==='switching'))throw Error('animation phases missing');
    if(frames.some(f=>f.top<0||f.bottom>0))throw Error('branch animation outside viewport');
    if(nodeColor!==edgeColor||ringColor!==edgeColor)throw Error('selected nodes must match blue edges');
    return {samples:frames.length,phases:[...new Set(frames.map(f=>f.phase))],outside:frames.filter(f=>f.top<0||f.bottom>0).length,minTop:Math.min(...frames.map(f=>f.top)),maxBottom:Math.max(...frames.map(f=>f.bottom)),nodeColor,edgeColor};
  });
}
