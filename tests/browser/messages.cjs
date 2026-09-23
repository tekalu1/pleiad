// Run on an authenticated, isolated fake backend with onboarding completed.
async page => {
  await page.locator('.row[data-session]').first().waitFor();
  const target = await page.evaluate(() => localStorage.getItem('ply-test-session'));
  await page.locator(`.row[data-session="${target}"]`).click();
  await page.waitForFunction(id => document.querySelector('.row.sel')?.dataset.session === id && document.querySelector('#cwdChip').dataset.value, target);
  await page.locator('#newSession').click();
  await page.waitForFunction(id => document.querySelector('.row.sel')?.dataset.session !== id, target);
  await page.waitForFunction(() => !document.querySelector('#prompt').disabled && !document.querySelector('#send').disabled);
  await page.locator('#prompt').fill('slow');
  await page.locator('#send').click();
  await page.locator('#abort').waitFor({state:'visible'});
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  await page.locator('#prompt').fill('echo:queued-browser-message');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('#outbox .outbox-text').filter({hasText:'queued-browser-message'}).waitFor();
  await page.screenshot({path:'temporary/ui-check/messages-pending.png'});
  await page.waitForFunction(() => document.querySelector('#prompt').value === '');
  await page.reload();
  await page.locator('#outbox .outbox-text').filter({hasText:'queued-browser-message'}).waitFor();
  if (await page.locator('#send').isDisabled()) throw Error('send disabled during running turn');
  if (await page.locator('.m[data-role="user"]').count() !== 1) throw Error('initial message duplicated on reload');
  await page.locator('#outbox button').filter({hasText:'取り消す'}).click();
  await page.locator('#outbox').waitFor({state:'hidden'});
  await page.locator('#prompt').fill('echo:after-stop');
  await page.locator('#send').click();
  await page.locator('#outbox .outbox-text').waitFor();
  await page.locator('#abort').click();
  await page.locator('#outbox .outbox-status').filter({hasText:'送信を保留中'}).waitFor();
  await page.locator('#outbox button').filter({hasText:'再送する'}).click();
  await page.locator('#outbox').waitFor({state:'hidden'});
  await page.locator('.m[data-role="assistant"]').filter({hasText:'after-stop'}).waitFor();
  await page.screenshot({path:'temporary/ui-check/messages-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:'temporary/ui-check/messages-mobile.png'});
  return {passed:true, checks:['send while running','keyboard send','reload','cancel','pause on stop','retry','no duplicate initial message']};
}
