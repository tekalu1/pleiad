// playwright-cli run-code --filename=tests/browser/git-panel.cjs
// git パネル（docs/design-system.md「git の動き」、ADR 0135）: Ctrl+Shift+G・タブ（線画 + 語）・範囲の切り替え・コミットの行を開く箱（同時に 1 つ・Esc）・
// 差分（左右は常に折り返す・新規のファイルは 1 列）・キーボード。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token git-panel-test, port 7433, AGENT_HOST_LOCALE=ja). Never run against live data.
// 「コミットしていない分」の一覧はグラフの下に出さず、「未コミットの変更」の行の箱にまとめる（作業場所に未コミットの変更があれば、その箱を初めから開く。
// 無いと、その節は「変更が無い」の 1 行を確かめる。両方を通すなら、ROOT に未コミットの変更（ステージ済みと変更の両方）がある状態と無い状態で 1 回ずつ流す）。
// 作業場所に使うのはこのリポジトリ自身（コミットが 2 つ以上あり、ファイルを足したコミットが直近 40 件のどこかにある git の作業場所なら何でもよい）。
async (page) => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  await page.setViewportSize({ width: 1280, height: 860 });
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
  await page.waitForTimeout(1500);   // 会話の id が付いて git の状態が揃うまで（揃う途中で開くとパネルは閉じる）
  await page.waitForFunction(() => !document.querySelector('#send').disabled);

  // 近道で開く
  await page.locator('#prompt').click();
  await page.keyboard.press('Control+Shift+G');
  await page.locator('.gp-tab').first().waitFor();
  check(await page.locator('.gp-tab').count() === 2, 'two tabs: graph and worktrees');
  check(await page.locator('.gp-tab[aria-selected="true"]').getAttribute('data-t') === 'changes', 'opens on the graph tab');

  // タブ: 線画 + 語。件数は画面に出さず、名前（読み上げ・ツールチップ）に持つ
  await page.waitForFunction(() => /件/.test(document.querySelector('.gp-tab')?.getAttribute('aria-label') ?? ''));
  const tabs = await page.evaluate(() => [...document.querySelectorAll('.gp-tab')].map((b) => ({
    word: b.querySelector('.tl')?.textContent, icon: b.querySelector('svg') ? [b.querySelector('svg').getBoundingClientRect().width, b.querySelector('svg').getBoundingClientRect().height] : null,
    count: b.querySelector('.n') !== null, label: b.getAttribute('aria-label'), title: b.getAttribute('title') })));
  check(tabs[0].word === 'グラフ' && tabs[1].word === 'Worktree', 'tab words are グラフ and Worktree');
  check(tabs.every((x) => x.icon && x.icon[0] === 18 && x.icon[1] === 18), 'both tabs have an 18px icon');
  check(tabs.every((x) => !x.count), 'the tabs show no count');
  check(/^グラフ、\d+ 件$/.test(tabs[0].label) && tabs[0].title === tabs[0].label, 'the graph tab keeps its count in the accessible name');
  check(await page.locator('.gp-tab svg path, .gp-tab svg circle').count() >= 4, 'the tab icons are drawn');

  await page.locator('.cg-row').first().waitFor();
  // 会話の始まりが HEAD なら、それより古い履歴は畳まれている。箱を開く試験のために先に広げる
  const older = page.locator('.cg-more[data-older]');
  if (await older.count() && await older.getAttribute('aria-expanded') === 'false') await older.click();
  await page.waitForFunction(() => [...document.querySelectorAll('.cg-row:not(.wt)')].filter((r) => r.getBoundingClientRect().height > 0).length >= 3);
  const hasSession = await page.locator('[data-rg="session"]').count();
  // 範囲の切り替えは「この会話の間」がある会話だけ（範囲が 1 つなら切り替えは出さない）
  check(hasSession ? await page.locator('.rbar [data-rg="uncommitted"][aria-pressed="true"]').count() === 1 : await page.locator('.rbar').count() === 0, 'range starts at uncommitted from the shortcut');
  const rowCount = await page.locator('.cg-row').count();
  check(rowCount >= 3, 'the graph has commit rows');
  check(await page.locator('.cg-row .chev').count() === rowCount, 'every row ends with a chevron');

  // 「コミットしていない分」の一覧はグラフの下に出さない。未コミットの変更があれば「未コミットの変更」の行が初めから開いている
  check(await page.locator('.cl .cl-h, .cl .tree, .cl .fr').count() === 0, 'no file list under the graph for the uncommitted range');
  const wt = page.locator('.cg-row.wt');
  const dirty = await wt.count() === 1;
  let wtBox = null;
  if (dirty) {
    wtBox = page.locator(`#${await wt.getAttribute('aria-controls')}`);
    check(await wt.getAttribute('aria-expanded') === 'true' && await page.locator('.cg-row[aria-expanded="true"]').count() === 1, 'the uncommitted row starts open');
    await wtBox.locator('.fr[data-key]').first().waitFor();
    check(/ファイル/.test(await wtBox.locator('.cl-tt').textContent()) && await wtBox.locator('[data-cuse]').count() === 1, 'its box has the file count and the use-in-chat button');
    check(await wtBox.locator('.grp').count() >= 1 && (await wtBox.locator('.grp').allTextContents()).some((x) => /^変更/.test(x)), 'the box keeps the staged / changes groups');
    check(await page.locator('[data-clean]').count() === 0, 'no "no changes" line while there are changes');
    await page.evaluate(() => document.querySelector('.cg-row.wt').click());
    check(await wt.getAttribute('aria-expanded') === 'false', 'the uncommitted row closes again');
    await page.waitForTimeout(450);
  } else {
    check(await page.locator('[data-clean]').count() === 1, 'a clean tree says so, in place of the uncommitted row');
  }
  check(await page.locator('.cg-row[aria-expanded="false"]').count() === rowCount, 'no box is open now');

  // コミットの行を押すと、その行のすぐ下に箱が開く（同時に 1 つ。札も薄くもならない）
  const commitRows = page.locator('.cg-row:not(.wt)');
  const a = commitRows.nth(0), b = commitRows.nth(1);
  // 箱の開閉の動きの途中は行が動くので、行は DOM の click で押す（範囲の帯が重なることもある）
  const tap = (loc) => loc.evaluate((x) => x.click());
  await tap(a);
  check(await a.getAttribute('aria-expanded') === 'true', 'the row opens (aria-expanded)');
  const boxA = page.locator(`#${await a.getAttribute('aria-controls')}`);
  await page.locator('.ins .fr[data-key]').first().waitFor();
  check(await boxA.evaluate((x) => !x.classList.contains('shut') && x.previousElementSibling.classList.contains('cg-row')), 'the box sits right under its row');
  check(await boxA.locator('.cl-meta').count() === 1 && /親/.test(await boxA.locator('.cl-meta').textContent()), 'the box shows author, date, hash and parents');
  check(await boxA.locator('[data-cuse]').count() === 1 && await boxA.locator('.cl-tt').textContent().then((x) => /ファイル/.test(x)), 'the box has the file count and the use-in-chat button');
  check(await boxA.locator('.ins-l svg line').count() >= 1, 'the graph lines continue to the left of the box');
  check(await page.locator('.cpill').count() === 0 && await page.locator('.cg-row.dim').count() === 0, 'no pill and no dimmed rows for a single open commit');
  await page.waitForTimeout(400);
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.cg-row[aria-expanded="true"] > .chev')).transform === 'matrix(0, 1, -1, 0, 0, 0)'), 'the chevron is rotated 90 degrees while open');

  const meta = await boxA.locator('.cl-meta time').evaluate((x) => ({ text: x.textContent, title: x.title }));
  check(/前|たった今/.test(meta.text) && /\d{4}/.test(meta.title) && !/\d{4}/.test(meta.text), 'the box shows a relative time and keeps the absolute one in its title');
  check(meta.text === (await a.locator('.cg-tm').textContent()), 'the box time is written like the graph row');
  // 小さいアイコンの大きさと面（13px / 12px・背景は透明・padding なし）。規則が潰れると灰色の丸い面が付く
  const iconBox = (sel) => page.evaluate((q) => [...document.querySelectorAll(q)].map((e) => { const c = getComputedStyle(e); return [c.width, c.height, c.backgroundColor, c.paddingLeft, c.display]; }), sel);
  const flat = (rows, size) => rows.length > 0 && rows.every(([w, h, bg, pad]) => w === size && h === size && bg === 'rgba(0, 0, 0, 0)' && pad === '0px');
  check(flat(await iconBox('.gp .ins .fr svg.i'), '13px'), 'file row icons are 13px with no face');
  check(flat(await iconBox('.gp .ins .fr .btn.sm svg.i'), '13px'), 'small button icons are 13px with no face');
  check(flat(await iconBox('.gp .cg-row .chev svg.i'), '12px'), 'row chevrons are 12px with no face');
  check(flat(await iconBox('.gp-tab svg.i'), '18px'), 'tab icons are 18px with no face');
  check(await page.evaluate(() => { const c = getComputedStyle(document.querySelector('.gp .rseg')); return c.backgroundColor !== 'rgba(0, 0, 0, 0)' && c.paddingLeft === '3px'; }), 'the segmented control keeps its face');

  // 別の行を押すと前の箱は閉じる。同じ行をもう一度で閉じる
  await tap(b);
  check(await a.getAttribute('aria-expanded') === 'false' && await b.getAttribute('aria-expanded') === 'true', 'another row closes the previous box');
  check(await page.locator('.cg-row[aria-expanded="true"]').count() === 1, 'only one box is open at a time');
  await tap(b);
  check(await page.locator('.cg-row[aria-expanded="true"]').count() === 0, 'the same row again closes the box');

  // Esc で閉じる（パネルは閉じない）
  await tap(a);
  await page.locator('.ins .fr[data-key]').first().waitFor();
  await page.keyboard.press('Escape');
  check(await page.locator('.cg-row[aria-expanded="true"]').count() === 0, 'Escape closes the open box');
  check(await page.locator('#filePreview').isVisible(), 'Escape on a box does not close the panel');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cg-row')), 'focus stays on the row after closing');

  // 差分: 開いた箱のファイルを押す → Esc で、開いたままの箱と押したファイルの行へ戻る
  await tap(a);
  await page.locator('.ins .fr[data-key]').first().waitFor();
  const second = page.locator('.ins .fr[data-key]').nth(1);
  const secondKey = await second.getAttribute('data-key');
  await second.locator('.nm').click();
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
  await page.locator('.ins .fr[data-key]').first().waitFor();
  check(await page.locator('.dv').count() === 0, 'Escape returns from the diff');
  check(await a.getAttribute('aria-expanded') === 'true', 'the box is still open after the diff');
  check(await page.evaluate((k) => document.activeElement?.dataset?.key === k, secondKey), 'focus returns to the clicked file row');

  // キーボード: ↑↓ は開いた箱の中のファイルも含めて見えている行を順に移る。← と Esc は親の行へ、もう一度で閉じる
  await page.locator('.ins .fr[data-key]').first().focus();
  await page.keyboard.press('ArrowDown');
  check(await page.evaluate(() => document.activeElement?.matches('.ins .fr[data-key]') && document.activeElement !== document.querySelector('.ins .fr[data-key]')), 'ArrowDown moves to the next file in the box');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cg-row')), 'ArrowUp from the first file goes to its row');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowLeft');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cg-row')), 'ArrowLeft on a file goes to the parent row');
  await page.keyboard.press('ArrowLeft');
  check(await a.getAttribute('aria-expanded') === 'false', 'ArrowLeft on the open row closes it');
  await page.keyboard.press('ArrowRight');
  check(await a.getAttribute('aria-expanded') === 'true', 'ArrowRight opens the row');
  await page.keyboard.press('ArrowRight');
  check(await page.evaluate(() => document.activeElement?.matches('.ins .fr[data-key], .ins .grp')), 'ArrowRight on the open row moves to its first file');
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => document.activeElement?.classList.contains('cg-row')) && await a.getAttribute('aria-expanded') === 'true', 'Escape on a file goes to the parent row');
  await page.keyboard.press('Escape');
  check(await a.getAttribute('aria-expanded') === 'false', 'Escape on the row closes the box');

  // 「未コミットの変更」の行も同じ形で開く。差分から戻ると、開いた箱とファイルの行へ戻る
  if (dirty) {
    await page.evaluate(() => document.querySelector('.cg-row.wt').click());
    check(await wt.getAttribute('aria-expanded') === 'true', 'the uncommitted row opens the same way');
    const wf = wtBox.locator('.fr[data-key]').first();
    await wf.waitFor();
    const wkey = await wf.getAttribute('data-key');
    await wf.locator('.nm').click();
    await page.locator('.dv .dl .ln, .dv .git-empty').first().waitFor();
    await page.keyboard.press('Escape');
    await wtBox.locator('.fr[data-key]').first().waitFor();
    check(await wt.getAttribute('aria-expanded') === 'true' && await page.evaluate((k) => document.activeElement?.dataset?.key === k, wkey), 'back from a diff: the uncommitted box is open and the file row has focus');
    await page.keyboard.press('ArrowUp');
    for (let i = 0; i < 6 && await page.evaluate(() => !document.activeElement?.classList.contains('cg-row')); i++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    check(await wt.getAttribute('aria-expanded') === 'false', 'ArrowLeft on the uncommitted row closes its box');
    await page.waitForTimeout(450);
  }

  // 範囲の切り替え（この会話の間は撮影のある会話だけ。無ければ切り替え自体を出さない）。複数のコミットにまたがる範囲だけは、箱でなくグラフの外の一覧
  if (hasSession) {
    await page.locator('[data-rg="session"]').click();
    check(await page.locator('[data-rg="session"][aria-pressed="true"]').count() === 1, 'switches to the session range');
    await page.locator('.cl .cl-h').waitFor();
    check(await page.locator('.cl .cl-h').count() === 1 && await page.locator('.cg-row[aria-expanded="true"]').count() === 0, 'the session range keeps its list under the graph, with no box beside it');
    await page.locator('[data-rg="uncommitted"]').click();
    check(await page.locator('.cl .cl-h, .cl .fr').count() === 0, 'back to the uncommitted range: the list under the graph is gone');
    check(dirty ? await wt.getAttribute('aria-expanded') === 'true' : await page.locator('.cg-row[aria-expanded="true"]').count() === 0, 'the uncommitted range opens the uncommitted row');
    if (dirty) {
      await page.locator('[data-rg="session"]').click();
      check(await wt.getAttribute('aria-expanded') === 'false', 'the session range closes the uncommitted box so the files are not listed twice');
      await page.evaluate(() => document.querySelector('.cg-row.wt').click());
      check(await page.locator('[data-rg="uncommitted"][aria-pressed="true"]').count() === 1 && await wt.getAttribute('aria-expanded') === 'true' && await page.locator('.cl .cl-h').count() === 0, 'opening the uncommitted row from the session range moves to the uncommitted range');
    }
  }

  // 左右の差分: 広げると選べ、常に折り返す。新規のファイルは 1 列にして理由を添える
  await page.locator('.gp-tab[data-t="changes"]').click();
  if (hasSession) await page.locator('[data-rg="uncommitted"]').click();
  await page.locator('#filePreview button[aria-label="広げる"]').click();
  await page.waitForFunction(() => document.querySelector('.gp-view')?.clientWidth >= 740);
  const openFiles = page.locator('.cg-row[aria-expanded="true"] + .fold .fr[data-key]');
  // 行は押した位置の上に範囲の帯（sticky）が重なることがあるので、DOM の click で押す
  const press = (loc) => loc.evaluate((x) => x.click());
  const openRow = async (i) => {
    if (await page.locator('.cg-row[aria-expanded="true"]').count()) await press(page.locator('.cg-row[aria-expanded="true"]'));
    await press(commitRows.nth(i));
    await page.waitForFunction(() => document.querySelector('.cg-row[aria-expanded="true"] + .fold .cl-h b'), null, { timeout: 8000 }).catch(() => null);
  };
  const backToList = async () => { if (await page.locator('.dv').count()) await page.keyboard.press('Escape'); await openFiles.first().waitFor(); };

  // 変わったファイル（左右にできる差分）
  await openRow(0);
  await openFiles.filter({ hasText: /\.(mjs|cjs|css|md|json)/ }).first().locator('.nm').click();
  await page.locator('.dv .dx').waitFor();
  const sideBtn = page.locator('.dv [data-da="side"]');
  if (await sideBtn.getAttribute('aria-pressed') !== 'true') await sideBtn.click();
  check(await page.locator('.dv .dx.side.wrap').count() === 1, 'side by side always wraps');
  const wrapBtn = page.locator('.dv [data-da="wrap"]');
  check(await wrapBtn.getAttribute('aria-pressed') === 'true' && await wrapBtn.getAttribute('aria-disabled') === 'true', 'the wrap button is pinned pressed in side by side');
  check((await wrapBtn.getAttribute('title')).includes('常に折り返'), 'the wrap button says why');
  await wrapBtn.click({ force: true });
  check(await page.locator('.dv .dx.side.wrap').count() === 1, 'the wrap button does nothing in side by side');
  check(await page.evaluate(() => { const v = document.querySelector('.dv'); return v.scrollWidth - v.clientWidth <= 1; }), 'side by side does not overflow sideways');
  await backToList();

  // 新規のファイルは 1 列にして理由を添える（ふつうの差分へ移れば左右に戻る）
  let sawNew = false;
  for (let i = 0; i < 40 && !sawNew; i++) {
    await openRow(i);
    const added = openFiles.and(page.locator('[aria-label*="新規"], [aria-label*="未追跡"]'));
    if (!await added.count()) continue;
    await added.first().locator('.nm').click();
    await page.locator('.dv .dx').waitFor();
    check(await page.locator('.dv .dx.side').count() === 0 && /1 列/.test(await page.locator('.dv .dnote').textContent()), 'a new file is shown in one column with the reason');
    sawNew = true;
    await backToList();
    await openFiles.filter({ hasText: /\.(mjs|cjs|css|md|json)/ }).and(page.locator('[aria-label*="変更"]')).first().locator('.nm').click().catch(() => null);
    if (await page.locator('.dv .dx.side').count()) check(true, 'moving to another file returns to side by side');
    await backToList();
  }
  check(sawNew, 'found a new file shown in one column');
  await page.locator('#filePreview button[aria-label="広げる"], #filePreview button[aria-label="会話と並べて表示"]').first().click();

  // 作業場所タブ
  await page.locator('.gp-tab[data-t="worktrees"]').click();
  await page.locator('.wrow').first().waitFor();
  check(/Worktree、\d+ 件/.test(await page.locator('.gp-tab[data-t="worktrees"]').getAttribute('aria-label')), 'the worktree tab keeps its count in the accessible name');
  check(await page.locator('.wrow .wbadge.here').count() === 1, 'the current worktree is marked');
  check(flat(await iconBox('.gp .wrow > svg.i'), '13px'), 'worktree row icons are 13px with no face');
  await page.locator('.wrow').first().click();
  check(await page.locator('.wrow[aria-expanded="true"]').count() === 1, 'a worktree row opens');

  // 作業場所のファイルを押すと差分が開く（行の識別子にパスを入れない）
  if (await page.locator('.wdet .fr').count()) {
    await page.locator('.wdet .fr .nm').first().click();
    await page.locator('.dv .dl .ln').first().waitFor();
    check(true, 'a file inside a worktree row opens its diff');
    await page.keyboard.press('Escape');
    await page.locator('.wrow').first().waitFor();
  }

  // 閉じる
  await page.keyboard.press('Control+Shift+G');
  await page.waitForFunction(() => document.querySelector('#filePreview')?.hidden === true);
  check(true, 'the shortcut closes the panel');
  return results;
}
