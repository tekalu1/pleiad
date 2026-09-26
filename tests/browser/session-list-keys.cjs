// playwright-cli run-code --filename=tests/browser/session-list-keys.cjs
// 会話一覧のキー操作（docs/design-system.md §4.1「キーボード」）。一覧はひとつのツリーで、Tab 1 回で入って 1 回で抜ける。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token list-keys-test, port 7432). Never run against live data.
// 状態の付いた会話が 2 つ以上と、fork でできたグループ（器）が 1 つ要る。
async (page) => {
  const URL = 'http://127.0.0.1:7432/?token=list-keys-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const state = () => page.evaluate(() => {
    const g = document.getElementById('groups');
    const active = document.getElementById(g.getAttribute('aria-activedescendant') ?? '');
    return {
      focused: document.activeElement === g, inside: g.contains(document.activeElement),
      active: active?.dataset.key ?? null, activeClass: active?.className ?? '', level: active?.getAttribute('aria-level'),
      expanded: active?.getAttribute('aria-expanded'), sel: document.querySelector('#groups .row.sel')?.dataset.key ?? null,
      hint: !document.getElementById('keyHint').hidden, ring: active ? getComputedStyle(active).outlineWidth : null,
      menu: [...document.querySelectorAll('.pop.menu .li .lbl')].map(n => n.textContent),
    };
  });
  await page.goto(URL);
  await page.locator('#groups [role=treeitem]').first().waitFor();
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();

  const tree = await page.evaluate(() => { const g = document.getElementById('groups'); return { role: g.getAttribute('role'), tab: g.tabIndex, label: g.getAttribute('aria-label') }; });
  check(tree.role === 'tree' && tree.tab === 0 && tree.label, 'the list is one tree with one tab stop');
  check(await page.locator('#groups .row[tabindex="0"], #groups button:not([tabindex="-1"])').count() === 0, 'no row or button inside the list is in the tab order');

  // 開いている会話は白い面と aria-selected・aria-current
  await page.locator('#groups .row:not(.sel)[data-session]').first().click();
  await page.waitForFunction(() => document.querySelector('#groups .row.sel')?.getAttribute('aria-current') === 'page');
  const opened = (await state()).sel;
  check(await page.locator('#groups .row.sel[aria-selected="true"]').count() === 1, 'the open row has aria-selected=true');
  check(!(await state()).hint, 'no key hint after a mouse click');

  // 検索欄 → 漏斗 → 一覧（Tab 2 回）。入ると開いている行を指す
  await page.locator('#q').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  let s = await state();
  check(s.focused && s.active === opened, 'Tab enters the list at the open row');
  check(s.hint && s.ring === '2px', 'key hint and 2px ring while the keyboard is in the list');

  // 矢印は指すだけで開かない
  await page.keyboard.press('ArrowDown');
  s = await state();
  check(s.active !== opened && s.sel === opened, 'ArrowDown moves without opening');
  const pointed = s.active;

  // Tab 1 回で抜け、Shift+Tab で戻ると同じ項目を指している
  await page.keyboard.press('Tab');
  s = await state();
  check(!s.inside && !s.hint, 'one Tab leaves the list and hides the key hint');
  await page.keyboard.press('Shift+Tab');
  s = await state();
  check(s.focused && s.active === pointed, 'Shift+Tab returns to the same item');

  // Home は先頭（状態の見出し）。← で畳み、→ で開く
  await page.keyboard.press('Home');
  s = await state();
  check(s.activeClass.includes('grp-head') && s.level === '1' && s.expanded === 'true', 'Home goes to the first status heading');
  await page.keyboard.press('ArrowLeft');
  check((await state()).expanded === 'false', 'ArrowLeft collapses a heading');
  await page.keyboard.press('ArrowDown');
  s = await state();
  check(s.activeClass.includes('grp-head'), 'collapsed rows are skipped');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowRight');
  check((await state()).expanded === 'true', 'ArrowRight expands a heading');
  await page.keyboard.press('ArrowRight');
  s = await state();
  check(s.level === '2', 'ArrowRight on an open heading goes to its first child');
  await page.keyboard.press('ArrowLeft');
  check((await state()).activeClass.includes('grp-head'), 'ArrowLeft on a row goes to its heading');

  // 見出しの Shift+F10 に「この状態で新しいセッション」。Esc で一覧へ戻る
  await page.keyboard.press('Shift+F10');
  s = await state();
  check(s.menu.includes('この状態で新しいセッション'), 'heading menu offers a new session in the status');
  await page.keyboard.press('Escape');
  s = await state();
  check(s.focused && !s.menu.length, 'Escape closes the menu and returns to the list');

  // 器の見出し: → で開いて子へ、← で見出しへ
  for (let i = 0; i < 40 && !(await state()).activeClass.includes('fam-head'); i++) await page.keyboard.press('ArrowDown');
  s = await state();
  check(s.activeClass.includes('fam-head'), 'the group header is reachable with arrows');
  if (s.expanded === 'false') await page.keyboard.press('ArrowRight');
  check((await state()).expanded === 'true', 'ArrowRight opens the group');
  await page.keyboard.press('ArrowRight');
  s = await state();
  check(s.level === '3', 'ArrowRight moves into the group');
  await page.keyboard.press('ArrowLeft');
  check((await state()).activeClass.includes('fam-head'), 'ArrowLeft returns to the group header');

  // 行の Shift+F10 はその行のメニュー。Space で開く
  await page.keyboard.press('ArrowDown');
  const target = (await state()).active;
  await page.keyboard.press('Shift+F10');
  check((await state()).menu[0] === '開く', 'row menu opens with Shift+F10');
  await page.keyboard.press('Escape');
  await page.keyboard.press(' ');
  await page.waitForFunction(k => document.querySelector('#groups .row.sel')?.dataset.key === k, target);
  check(true, 'Space opens the pointed row');

  // 検索欄の ↓ は一覧の先頭の行へ
  await page.locator('#q').focus();
  await page.keyboard.press('ArrowDown');
  s = await state();
  const firstRow = await page.evaluate(() => document.querySelector('#groups .row')?.dataset.key);
  check(s.focused && s.active === firstRow, 'ArrowDown in the search field enters the list at the first row');

  // Enter で開く
  await page.keyboard.press('Enter');
  await page.waitForFunction(k => document.querySelector('#groups .row.sel')?.dataset.key === k, firstRow);
  check(true, 'Enter opens the pointed row');
  return { passed: true, results };
}
