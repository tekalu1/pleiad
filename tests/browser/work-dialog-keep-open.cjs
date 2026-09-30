// playwright-cli run-code --filename=tests/browser/work-dialog-keep-open.cjs
// 作業ダイアログ（#workDialog）で走っている子の詳細を見ながらツールの行・まとまりを開くと、running の配信で詳細が読み直されても
// 開いたままになる（web/view-state.mjs）。読み直しは詳細の筋（.bg-thread）が作り直されることで見分ける。
// 認証済みの fake（AGENT_HOST_BACKENDS=fake）に、案内を閉じた新しいセッションから始める。子の台本は fake の `steps:`（core/backends/fake.mjs）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  await page.evaluate(() => document.getElementById('workDialog').close());
  await page.setViewportSize({ width: 1100, height: 520 });
  const steps = { steps: [
    { tool: 'Read', input: { file_path: 'D:/x/a.mjs' }, result: '1\ta', ms: 50 },
    { tool: 'Grep', input: { pattern: 'foo' }, result: 'No matches found', ms: 50 },
    { tool: 'Bash', input: { command: 'node a.mjs' }, result: 'hello from a', ms: 50 },
    { text: 'ここまで調べました。' },
    { tool: 'Read', input: { file_path: 'D:/x/b.mjs' }, result: '1\tb', ms: 50 },
    { tool: 'Bash', input: { command: 'node b.mjs' }, result: 'hello from b', ms: 50 },
    { tool: 'Bash', input: { command: 'sleep 600' }, result: 'done', ms: 600000 },
  ] };
  const call = { name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', title: '長い子', task: 'steps:' + JSON.stringify(steps) } };
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('ply:' + JSON.stringify(call));
  await page.locator('#prompt').press('Control+Enter');
  const allow = page.locator('.btn-primary').filter({ hasText: '許可' }).first();
  await allow.waitFor({ timeout: 4000 }).then(() => allow.click()).catch(() => {});

  // ダイアログを開いて、走っている子の詳細を出す
  await page.locator('#workEntryButton').waitFor({ timeout: 20000 });
  await page.locator('#workEntryButton').click();
  await page.waitForFunction(() => [...document.querySelectorAll('#workDialog .bg-row')].some(b => b.textContent.includes('長い子')));
  await page.evaluate(() => [...document.querySelectorAll('#workDialog .bg-row')].find(b => b.textContent.includes('長い子')).click());
  await page.waitForFunction(() => document.querySelectorAll('#workBody .bg-thread .tc').length >= 6);

  // 開く: まとまり（6 件）を全部開き、その中の行の詳細を開く
  const bundle = page.locator('#workBody .bg-thread .bundle');
  if (await bundle.count() !== 1) throw Error('bundles: ' + await bundle.count());
  await bundle.locator('.rhead').click();
  await page.waitForFunction(() => document.querySelector('#workBody .bundle .rhead').getAttribute('aria-expanded') === 'true');
  await bundle.locator('.tc').nth(2).locator('.tc-head').click();
  const shape = () => page.evaluate(() => {
    const b = document.querySelector('#workBody .bundle');
    return {
      expanded: b?.querySelector('.rhead')?.getAttribute('aria-expanded'),
      shown: b?.querySelectorAll('.hi:not(.hid)').length,
      detail: [...(b?.querySelectorAll('.tc') ?? [])].map(c => c.querySelector('.tc-details')?.open ? 1 : 0).join(''),
      top: document.getElementById('workBody').scrollTop,
    };
  });
  // 読んでいる位置: 下端から離れた所に置く。窓が低いので詳細の欄はスクロールする
  const reread = async () => {
    await page.evaluate(() => { document.querySelector('#workBody .bg-thread').dataset.stale = '1'; });
    await page.waitForFunction(() => !document.querySelector('#workBody .bg-thread')?.dataset.stale, null, { timeout: 15000 });
  };
  await page.waitForTimeout(600);   // 開く動き（240ms）が終わってから置く（動きの途中では高さが足りず、位置が丸められる）
  const scrollable = await page.evaluate(() => { const w = document.getElementById('workBody'); w.scrollTop = 90; return w.scrollHeight > w.clientHeight + 90 && w.scrollTop === 90; });
  if (!scrollable) throw Error('detail body should be scrollable');
  const before = await shape();
  if (before.expanded !== 'true' || before.shown !== 6 || before.detail !== '001000') throw Error('setup: ' + JSON.stringify(before));

  // 読み直し（筋の要素が作り直される）を 2 回待つ。そのたびに開いたまま・位置も同じ
  for (let i = 0; i < 2; i++) {
    await reread();
    const after = await shape();
    if (JSON.stringify(after) !== JSON.stringify(before)) throw Error(`round ${i}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  }

  // 閉じて 1 件だけ遡った範囲（Esc のあと ↑）も、読み直しの後に同じ
  await bundle.locator('.rhead').focus();
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('#workBody .bundle .hi:not(.hid)').length === 1);
  await page.waitForTimeout(600);   // 畳む動きが終わって、高さと位置が落ち着いてから
  const stepped = await shape();
  await reread();
  const afterStep = await shape();
  if (stepped.expanded !== 'false' || stepped.shown !== 1 || JSON.stringify(afterStep) !== JSON.stringify(stepped)) throw Error('step: ' + JSON.stringify(stepped) + ' -> ' + JSON.stringify(afterStep));

  // ダイアログを閉じて開き直したら持ち越さない（openWork が詳細を作り直す）
  await page.evaluate(() => document.getElementById('workDialog').close());
  await page.locator('#workEntryButton').click();
  await page.waitForFunction(() => document.querySelectorAll('#workBody .bg-thread .tc').length >= 6);
  const reopened = await shape();
  if (reopened.expanded !== 'false' || reopened.shown !== 0 || reopened.detail !== '000000') throw Error('reopen should start closed: ' + JSON.stringify(reopened));
  return 'ok ' + JSON.stringify({ before, stepped, reopened });
}
