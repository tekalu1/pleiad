// playwright-cli run-code --filename=tests/browser/preferences.cjs
// Use a fresh isolated fake,codex server with tests/lib/fake-codex.mjs. Open its authenticated URL first.
// 入力欄の設定はチップ（web/composer-controls.mjs）。値は data-value / data-backend に id で出る
async page => {
 const pick=async(chip,key)=>{await page.locator('#'+chip).click();await page.locator(`[data-key="${key}"]`).click();await page.keyboard.press('Escape');};
 const choose={backend:v=>pick('modelChip','backend:'+v),model:v=>pick('modelChip','model:'+v),mode:v=>pick('modeChip','mode:'+v)};
 const values=async()=>page.evaluate(()=>({backend:document.getElementById('modelChip').dataset.backend,model:document.getElementById('modelChip').dataset.value,mode:document.getElementById('modeChip').dataset.value}));
 const modeIs=v=>page.waitForFunction(v=>document.getElementById('modeChip').dataset.value===v,v);
 const fresh=async()=>{
  const before=await page.locator('.row.sel').getAttribute('data-session');
  await page.locator('#newSession').click();
  await page.waitForFunction(id=>document.querySelector('.row.sel')?.dataset.session!==id && !document.querySelector('#prompt').disabled,before);
 };
 await choose.backend('codex');
 await fresh(); // Agent changes are now reserved for the next turn; new sessions inherit the reserved agent.
 await page.waitForFunction(()=>document.getElementById('modelChip').dataset.backend==='codex');
 await choose.model('fake-model-2');
 await choose.mode('readonly');
 await modeIs('readonly');
 const expected=await values();
 if(expected.backend!=='codex'||expected.model!=='fake-model-2'||expected.mode!=='readonly') throw Error(JSON.stringify(expected));
 await page.locator('#newSession').click();
 await modeIs('readonly');
 if(JSON.stringify(await values())!==JSON.stringify(expected)) throw Error('new session lost preferences');
 await page.reload();
 await modeIs('readonly');
 if(JSON.stringify(await values())!==JSON.stringify(expected)) throw Error('reload lost preferences');
 await choose.backend('fake');
 await fresh();
 await page.waitForFunction(()=>document.getElementById('modeChip').dataset.value!=='readonly');
 await choose.mode('auto');
 await choose.backend('codex');
 await page.waitForFunction(()=>document.getElementById('modelChip').dataset.value!=='fake-model-2');
 const reservedModel=(await values()).model;
 await fresh();
 await modeIs('readonly');
 if((await values()).backend!==expected.backend || (await values()).mode!==expected.mode || (await values()).model!==reservedModel) throw Error('backend switch lost agent or mode');
 return {passed:true,settings:expected};
}
