// playwright-cli run-code --filename=tests/browser/git-panel.cjs
// git パネル（docs/design-system.md「git の動き」、ADR 0134）: Ctrl+Shift+G・タブ・範囲の切り替え・コミットを押す・差分の畳み・キーボード。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token git-panel-test, port 7433, AGENT_HOST_LOCALE=ja). Never run against live data.
// 作業場所に使うのはこのリポジトリ自身（コミットが 2 つ以上ある git の作業場所なら何でもよい）。
async (page) => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  await page.goto('http://127.0.0.1:7433/?token=git-panel-test');
  await page.waitForTimeout(800);
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(ROOT);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.locator('#prompt').fill('echo:git panel');
  await page.locator('#send').click();
  await page.locator('#gitEntry').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#send').disabled);

  // 近道で開く
  await page.locator('#prompt').click();
  await page.keyboard.press('Control+Shift+G');
  await page.locator('.gp-tab').first().waitFor();
  check(await page.locator('.gp-tab').count() === 2, 'two tabs: changes and worktrees');
  check(await page.locator('.gp-tab[aria-selected="true"]').getAttribute('data-t') === 'changes', 'opens on the changes tab');
  await page.locator('.cg-row').first().waitFor();
  check(await page.locator('.rbar [data-rg="uncommitted"][aria-pressed="true"]').count() === 1, 'range starts at uncommitted from the shortcut');
  const rows = await page.locator('.cg-row').count();
  check(rows >= 2, 'the graph has commit rows');

  // コミットを押すと 3 つ目の範囲になり、× で戻る
  const commitRow = page.locator('.cg-row[data-h]').first();
  const hash = (await commitRow.getAttribute('data-h')).slice(0, 7);
  await commitRow.click();
  await page.locator('.cpill').waitFor();
  check((await page.locator('.cpill').textContent()).includes(hash), 'the pill shows the picked commit');
  check(await commitRow.getAttribute('aria-pressed') === 'true', 'the picked row is pressed');
  check(await page.locator('.cg [data-n].on').count() >= 1, 'the picked node is filled');
  await page.locator('.cl .fr[data-key]').first().waitFor();
  check(await page.locator('.cl-meta').count() === 1, 'commit meta (author, parents) is shown');
  await page.locator('[data-clear]').click();
  check(await page.locator('.cpill').count() === 0, 'x clears the commit');

  // 差分: 行番号・Esc で一覧へ・畳みを開く
  await commitRow.click();
  await page.locator('.cl .fr[data-key]').first().waitFor();
  await page.locator('.cl .fr[data-key] .nm').first().click();
  await page.locator('.dv .dl .ln').first().waitFor();
  check(await page.locator('.dv .dl .ln.o').count() >= 1, 'the diff has line numbers');
  check(await page.locator('.dv [data-da="side"][aria-disabled="true"]').count() === 1, 'side by side is disabled while narrow');
  const gaps = await page.locator('.dgap:not([disabled])').count();
  if (gaps) {
    const before = await page.locator('.dv .dl').count();
    await page.locator('.dgap:not([disabled])').first().click();
    check(await page.locator('.dv .dl').count() > before, 'a folded gap opens into lines');
  }
  await page.keyboard.press('Escape');
  await page.locator('.cl .fr[data-key]').first().waitFor();
  check(await page.locator('.dv').count() === 0, 'Escape returns to the list');

  // キーボード: 行を上下で移る
  await page.locator('.cl .fr[data-key]').first().focus();
  const rowsInList = await page.locator('.cl .fr[data-key]').count();
  if (rowsInList > 1) {
    await page.keyboard.press('ArrowDown');
    check(await page.evaluate(() => document.activeElement?.matches('.cl .fr[data-key]') && document.activeElement !== document.querySelector('.cl .fr[data-key]')), 'ArrowDown moves to the next row');
  }

  // 範囲の切り替え（この会話の間は撮影のある会話だけ。無ければ札が出ない）
  const hasSession = await page.locator('[data-rg="session"]').count();
  if (hasSession) { await page.locator('[data-rg="session"]').click(); check(await page.locator('[data-rg="session"][aria-pressed="true"]').count() === 1, 'switches to the session range'); }

  // 作業場所タブ
  await page.locator('.gp-tab[data-t="worktrees"]').click();
  await page.locator('.wrow').first().waitFor();
  check(await page.locator('.wrow .wbadge.here').count() === 1, 'the current worktree is marked');
  await page.locator('.wrow').first().click();
  check(await page.locator('.wrow[aria-expanded="true"]').count() === 1, 'a worktree row opens');

  // 閉じる
  await page.keyboard.press('Control+Shift+G');
  await page.waitForFunction(() => document.querySelector('#filePreview')?.hidden === true);
  check(true, 'the shortcut closes the panel');
  return results;
}
