// playwright-cli run-code --filename=tests/browser/tool-bundle.cjs
// fake バックエンドの `steps:` 台本（core/backends/fake.mjs）で、ツールのまとまり（web/tool-bundle.mjs）を実ブラウザーで確かめる:
// 入れ替わり（薄い行・件数）・遡り（↑↓・Esc）・閉じた見出し（✕ n・n ファイルを変更）・承認待ちがまとまりの最新の行の場所に出て、決着したら行に戻る。
// 認証済みで、案内を閉じた fake の会話（新しいセッション）から始める。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const script = {
    steps: [
      { tool: 'Read', input: { file_path: 'D:/x/a.mjs' }, result: '1\ta', ms: 700 },
      { tool: 'Grep', input: { pattern: 'foo' }, result: 'No matches found', ms: 700 },
      { tool: 'Bash', input: { command: 'node bad.mjs' }, result: 'Error: boom\nExit code 1', error: true, ms: 700 },
      { tool: 'Write', input: { file_path: 'D:/x/b.mjs', content: 'a\nb\n' }, result: 'ok', ask: true, ms: 500 },
      { text: '終わりました' },
    ],
  };
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('steps:' + JSON.stringify(script));
  await page.locator('#prompt').press('Control+Enter');

  // 走っている間: 見出し + 薄い行 + 最新の行
  await page.locator('.bundle .rhead').waitFor();
  await page.waitForFunction(() => document.querySelector('.bundle')?.dataset.n === '3');
  const live = await page.evaluate(() => {
    const b = document.querySelector('.bundle');
    return { ghost: b.querySelectorAll('.hi.ghost').length, hidden: b.querySelectorAll('.hi.hid').length, latest: b.querySelectorAll('.latest .tc').length,
      inertHidden: [...b.querySelectorAll('.hi.hid')].every(h => h.hasAttribute('inert')), head: b.querySelector('.rhead').textContent };
  });
  if (live.ghost !== 1 || live.latest !== 1 || !live.inertHidden || !live.head.includes('3')) throw Error('live shape: ' + JSON.stringify(live));
  // 走っているツールは最新の行が語る。末尾の稼働表示は重ねない
  if (await page.locator('.m.activity').count()) throw Error('activity line shown while a tool row is running');

  // 承認待ち: まとまりの最新の行の場所に承認カード（まとまりは閉じない）
  await page.locator('.bundle .latest .tc-appr').waitFor();
  const waiting = await page.evaluate(() => ({ closed: !document.querySelector('.bundle .latest'), outside: !!document.querySelector('.mw.card'),
    row: document.querySelector('.bundle .latest .tc')?.classList.contains('tc-waiting') }));
  if (waiting.closed || waiting.outside || !waiting.row) throw Error('approval placement: ' + JSON.stringify(waiting));
  if (await page.locator('.m.activity').count()) throw Error('activity line shown while waiting for approval');
  await page.locator('.tc-appr .btn-primary').click();
  await page.locator('.tc-appr').waitFor({ state: 'detached' });
  const note = await page.locator('.bundle .latest .tc-note, .bundle .hi .tc-note').filter({ hasText: '許可した' }).count();
  if (!note) throw Error('allowed note missing');

  // ターンが終わったら見出しだけ。失敗は見出しの太字の「✕ 1」、変更は補足
  await page.waitForFunction(() => !document.querySelector('.bundle .latest .tc') && document.querySelector('.bundle .rhead .xm')?.textContent.includes('1'));
  const closed = await page.evaluate(() => {
    const b = document.querySelector('.bundle');
    return { note: b.querySelector('.rhead .nl')?.textContent, xm: b.querySelector('.rhead .xm')?.textContent, shown: b.querySelectorAll('.hi:not(.hid)').length, label: b.querySelector('.rhead').getAttribute('aria-label'), n: b.dataset.n };
  });
  if (closed.n !== '4' || closed.shown !== 0 || !closed.note?.includes('1') || closed.xm !== '✕ 1') throw Error('closed shape: ' + JSON.stringify(closed));

  // 遡る: ↑ で 1 件ずつ、Esc で閉じる（見出しにフォーカス）
  await page.locator('.bundle .rhead').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelectorAll('.bundle .hi:not(.hid)').length === 2);
  await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => document.querySelectorAll('.bundle .hi:not(.hid)').length === 1);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelectorAll('.bundle .hi:not(.hid)').length === 0);

  // 見出しを押すと全部を開く ⇄ 閉じる
  await page.locator('.bundle .rhead').click();
  await page.waitForFunction(() => document.querySelectorAll('.bundle .hi:not(.hid)').length === 4);
  if ((await page.locator('.bundle .rhead').getAttribute('aria-expanded')) !== 'true') throw Error('aria-expanded');
  await page.locator('.bundle .rhead').click();
  await page.waitForFunction(() => document.querySelectorAll('.bundle .hi:not(.hid)').length === 0);
  return { passed: true, checks: ['live shape', 'approval in bundle', 'closed heading', 'keyboard', 'toggle all'] };
}
