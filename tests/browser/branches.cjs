// playwright-cli run-code --filename=tests/browser/branches.cjs
// Open an isolated AGENT_HOST_BACKENDS=fake server first. Never run against live data.
async (page) => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  await page.goto('http://127.0.0.1:7432/?token=parallel-branches-test');
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(`${ROOT}/temporary/parallel-test-data`);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.locator('#prompt').fill('echo:Shared context');
  await page.locator('#send').click();
  await page.locator('.mw[data-key="m:1"] .forkbtn').waitFor({state:'attached'});
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  check(await page.locator('.spine path').count() > 0, 'initial live turn has an edge without reload');
  for (let i = 0; i < 3; i++) {
    await page.locator('.mw[data-key="m:1"] .m').hover();
    await page.locator('.mw[data-key="m:1"] .forkbtn').click();
    await page.waitForFunction(() => !!document.querySelector('.branch-row[data-phase="growing"]'));
    await page.waitForFunction(n => document.querySelectorAll('.branch-tip').length === n && !document.querySelector('.branch-tip:disabled'), i+2);
    const ys=await page.locator('.branch-ring').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));
    check(new Set(ys).size===1, `fork ${i+1}: same-height nodes`);
  }
  const selected = await page.locator('.branch-tip[aria-pressed=true]').getAttribute('data-session');
  await page.locator('#prompt').fill('echo:Only in this branch');
  await page.locator('#send').click();
  await page.locator('.mw[data-key="m:3"]').waitFor({state:'attached'});
  const chosen = page.locator('.branch-tip[aria-pressed=false]').first();
  const target = await chosen.getAttribute('data-session');
  await chosen.click();
  await page.waitForFunction(() => !!document.querySelector('.branch-row[data-phase="switching"]'));
  check((await page.locator('.branch-lower').first().getAttribute('d')).includes(' C'), 'lower edge stays curved during switching');
  await page.waitForFunction(() => !document.querySelector('.branch-tip:disabled'));
  check(await page.locator('.branch-tip[aria-pressed=true]').getAttribute('data-session')===target && target!==selected, 'picked session becomes main');
  check(!(await page.locator('#thread').textContent()).includes('Only in this branch'), 'conversation belongs to the picked branch');
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.locator(`.branch-tip[data-session="${selected}"]`).click();
  await page.waitForFunction(() => !document.querySelector('.branch-tip:disabled'));
  check((await page.locator('#thread').textContent()).includes('Only in this branch'), 'independent continuation survives switching back');
  await page.emulateMedia({reducedMotion:'no-preference'});
  return results;
}
