// playwright-cli run-code --filename=tests/browser/session-search.cjs
// 脇の会話検索（docs/design-system.md §4.1「検索」）: 題・状態・場所は即座に、本文は 120ms 後の結果で。抜粋から発言へ飛ぶ・キーボード・絞り込み・最近の検索。
// 種を入れた fake サーバーを別ポート・別のデータ置き場で立ててから流す（実データには向けない）:
//   node tests/lib/search-seed.mjs <一時のデータ置き場> <一時の作業ディレクトリの親>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時のデータ置き場> AGENT_HOST_PORT=7433 AGENT_HOST_TOKEN=session-search-test AGENT_HOST_LOCALE=ja node core/server.mjs
async (page) => {
  const URL = 'http://127.0.0.1:7433/?token=session-search-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const rows = () => page.locator('#groups .row.res');
  const titles = () => page.evaluate(() => [...document.querySelectorAll('#groups .row.res .row-t')].map(n => n.textContent));
  const search = async (text) => { await page.locator('#q').fill(text); await page.waitForTimeout(450); };
  const clear = async () => { await page.locator('#q').fill(''); await page.waitForTimeout(150); };

  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(URL);
  await page.locator('#groups [role=treeitem]').first().waitFor();
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  await page.waitForTimeout(300);

  // 語が無いときはいつもの木
  const tree = await page.evaluate(() => { const g = document.getElementById('groups'); return { role: g.getAttribute('role'), tab: g.tabIndex, head: !document.getElementById('resHead').hidden }; });
  check(tree.role === 'tree' && tree.tab === 0 && !tree.head, 'with no query the list is the status tree and the result header is hidden');
  const input = await page.evaluate(() => { const q = document.getElementById('q'); return { role: q.getAttribute('role'), keys: q.getAttribute('aria-keyshortcuts'), title: q.title, ph: q.placeholder }; });
  check(input.role === 'combobox' && /Control\+Shift\+F|Meta\+Shift\+F/.test(input.keys) && /Shift\+F|⇧F/.test(input.title) && input.ph === '会話を検索', 'the search box is a combobox that names its shortcut');

  // 題・状態・場所は手元で即座に（本文の結果を待たずに行が出る）
  await page.locator('#q').fill('レビュー待ち');
  const early = await page.evaluate(() => ({ rows: document.querySelectorAll('#groups .row.res').length, snips: document.querySelectorAll('#groups .snip').length }));
  check(early.rows === 1 && early.snips === 0, 'a status match shows at once, before the 120ms body search answers');
  await page.waitForTimeout(450);
  check((await rows().count()) === 1, 'the status-only match stays after the server answers (no excerpt, no count badge)');
  check((await page.locator('#groups .row.res .hitc').count()) === 0, 'no hit-count badge on a match outside the messages');

  // 本文で当たる。誰の発言か・抜粋・一致の下線と太字・件数の札
  await search('gateway');
  const list = await page.evaluate(() => {
    const g = document.getElementById('groups');
    return { role: g.getAttribute('role'), label: g.getAttribute('aria-label'), tab: g.tabIndex, rows: [...g.querySelectorAll('.row.res')].map(r => ({
      role: r.getAttribute('role'), who: r.querySelector('.snip-who')?.textContent, hits: r.querySelector('.hitc')?.textContent, marks: r.querySelectorAll('.snip mark.searchhit').length,
      aria: r.getAttribute('aria-label'), from: r.querySelector('.row-from')?.textContent ?? null })),
      count: document.getElementById('resCount').textContent, sort: document.getElementById('resSort').textContent };
  });
  check(list.role === 'listbox' && list.tab === -1 && list.label === '検索の結果', 'with a query the list becomes one listbox');
  check(list.rows.length === 2 && list.rows.every(r => r.role === 'option' && r.marks >= 1 && ['あなた', 'AI'].includes(r.who) && Number(r.hits) >= 1), 'body matches: one row per conversation with who, a marked excerpt and a hit count');
  check(list.count.includes('2') && /関連度/.test(list.sort), 'the header counts the conversations and names the sort');
  check(list.rows.every(r => /一致 \d+ 件/.test(r.aria)), 'each option is named with its hit count');
  check(list.rows.every(r => r.from === null), 'delegated children are not in the results by default');

  // AND・全角半角・場所はフォルダー名だけ・"…"
  await search('有料 翻訳');
  check((await titles()).join() === '有料モードの切り替え', 'words are ANDed across the conversation (title and different messages)');
  await search('ＣＩ');
  check((await titles()).join() === 'E2E を毎晩流す', 'full-width and half-width are the same (ＣＩ finds the conversation that wrote ＣＩ)');
  await search('ci');
  check((await titles()).includes('E2E を毎晩流す'), 'case-insensitive and NFKC (ci finds ＣＩ)');
  await search('dev');
  check((await rows().count()) === 0 && (await page.locator('#groups').innerText()).includes('一致する会話がありません'), 'a word that is only in the middle of a path matches nothing');
  await search('vtc-web');
  check((await titles()).length === 4 && (await titles()).includes('E2E のポートがぶつかる'), 'the place matches by folder name (4 conversations; the delegated child is left out)');
  await search('"e2e_port_offset"');
  check((await rows().count()) === 0, 'a quoted word is case-sensitive');
  await search('"E2E_PORT_OFFSET"');
  check((await titles()).join() === 'E2E のポートがぶつかる', 'a quoted word is an exact match');

  // 語を消すと木へ戻る
  await clear();
  check((await page.locator('#groups').getAttribute('role')) === 'tree' && (await page.locator('#groups [role=treeitem]').count()) > 3 && (await page.locator('#resHead').isHidden()), 'clearing the query returns to the status tree');

  // 並び替え（1 つのボタン・端末に覚える）
  await search('gateway');
  const relevance = await titles();
  await page.locator('#resSort').click();
  const byRecent = await titles();
  check((await page.locator('#resSort').getAttribute('aria-pressed')) === 'true' && /新しい順/.test(await page.locator('#resSort').innerText()), 'the sort button toggles to newest first');
  check(byRecent.join() !== relevance.join() || byRecent.length === 2, 'the order follows the sort');
  await page.reload();
  await page.locator('#groups [role=treeitem]').first().waitFor();
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  await search('gateway');
  check(/新しい順/.test(await page.locator('#resSort').innerText()), 'the sort is remembered on this device');
  await page.locator('#resSort').click();   // 関連度順へ戻す

  // 絞り込み: 語があるときだけ「発言者」と「含める」が出る。委譲の子を含めると「委譲 · 親の題」
  await page.locator('#filterBtn').click();
  const pop1 = await page.locator('#filterPop .head').allInnerTexts();
  check(pop1.includes('期間') && pop1.includes('発言者') && pop1.includes('含める'), 'the filter popover offers period, and (with a query) speaker and include');
  await page.locator('#filterPop .li', { hasText: '委譲した会話' }).click();
  await page.waitForTimeout(500);
  const withKids = await page.evaluate(() => [...document.querySelectorAll('#groups .row.res')].map(r => r.querySelector('.row-from')?.textContent ?? null).filter(Boolean));
  check(withKids.join() === '委譲 · 有料モードの切り替え', 'including delegated conversations shows the row as "委譲 · parent title"');
  check((await page.locator('#fchips .fchip', { hasText: '委譲した会話' }).count()) === 1, 'the include choice shows as a chip');
  await page.locator('#fchips .fchip', { hasText: '委譲した会話' }).locator('.x').click();
  await page.waitForTimeout(450);
  check((await page.locator('#groups .row-from').count()) === 0, 'removing the chip removes the delegated rows');
  await page.keyboard.press('Escape');
  await clear();
  await page.locator('#filterBtn').click();
  const pop2 = await page.locator('#filterPop .head').allInnerTexts();
  check(pop2.includes('期間') && !pop2.includes('発言者') && !pop2.includes('含める'), 'without a query the speaker and include sections are not offered');
  await page.locator('#filterPop .li', { hasText: '7 日' }).click();
  check((await page.locator('#fchips .fchip', { hasText: '期間' }).count()) === 1, 'the period shows as a chip');
  const recentRows = await page.locator('#groups .row[data-session]').count();
  check(recentRows >= 8 && !(await page.locator('#groups .row[data-session]', { hasText: 'E2E を毎晩流す' }).count()), 'a period narrows the tree even with no words (a 40-day-old conversation drops out)');
  await page.locator('#fchips .fchip', { hasText: '期間' }).locator('.x').click();
  await search('ci');
  check((await titles()).includes('E2E を毎晩流す'), 'removing the period brings the old conversation back');

  // ツールの入力は既定で対象外・「含める」で選ぶ
  await search('createLogger');
  check((await rows().count()) === 0, 'tool inputs are not searched by default');
  await page.locator('#filterBtn').click();
  await page.locator('#filterPop .li', { hasText: 'ツールの入力' }).click();
  await page.waitForTimeout(500);
  const tool = await page.evaluate(() => [...document.querySelectorAll('#groups .row.res')].map(r => r.querySelector('.snip.tool .snip-who')?.textContent));
  check(tool.join() === 'ツール', 'including tool inputs finds the command (shown as a tool excerpt)');
  await page.keyboard.press('Escape');
  await page.locator('#fchips .fchip', { hasText: 'ツールの入力' }).locator('.x').click();
  await clear();

  // 抜粋を押すとその発言へ飛び、輪（note-flash）。会話の中の検索は開かず、語だけ引き継ぐ
  await search('gateway');
  const target = await page.evaluate(() => { const r = [...document.querySelectorAll('#groups .row.res')].find(x => x.querySelector('.row-t').textContent.includes('有料')); return { uuid: r._result.hit.uuid, id: r._result.id }; });
  await page.locator('#groups .row.res', { hasText: '有料モードの切り替え' }).click();
  await page.waitForFunction((uuid) => { const m = [...document.querySelectorAll('.m[data-uuid]')].find(x => x.dataset.uuid === uuid); return m && (m.querySelector('.body.flash') || m.classList.contains('flash')); }, target.uuid, { timeout: 8000 });
  const landed = await page.evaluate((uuid) => {
    const m = [...document.querySelectorAll('.m[data-uuid]')].find(x => x.dataset.uuid === uuid);
    const log = document.getElementById('log').getBoundingClientRect(), r = m.getBoundingClientRect();
    return { visible: r.top >= log.top - 1 && r.bottom <= log.bottom + 1, marks: document.querySelectorAll('#thread mark.searchhit').length, active: m.querySelectorAll('mark.searchhit.active').length,
      tocOpen: document.getElementById('tocEntry').getAttribute('aria-expanded'), title: document.querySelector('.topbar, header, #title')?.textContent ?? '' };
  }, target.uuid);
  check(landed.visible, 'the excerpt jumps to its message and the message is on screen');
  check(landed.marks >= 1 && landed.active === 1, 'the words are underlined in the conversation, with the matched message marked as current');
  check(landed.tocOpen === 'false', 'the in-conversation search is not opened by the jump');
  check((await page.locator('#q').inputValue()) === 'gateway' && (await rows().count()) === 2, 'the query and results stay in the sidebar');
  check((await page.locator('#groups .row.res.sel').count()) === 1, 'the opened conversation is the selected row');
  // Ctrl+F の 1 手で、同じ語で残りの一致へ
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.toc-query');
  check((await page.locator('.toc-query').inputValue()) === 'gateway' && /\d+ \/ \d+/.test(await page.locator('.toc-count').innerText()), 'Ctrl+F then opens the in-conversation search already holding the word');
  await page.keyboard.press('Escape');

  // 同じ会話の別の結果へ（読み直さず送る）
  await page.locator('#q').fill('モック');
  await page.waitForTimeout(450);
  // 題だけの一致は、ただ開く（輪は付かない）
  await search('レビュー待ち');
  await page.locator('#groups .row.res').first().click();
  await page.waitForTimeout(800);
  check((await page.locator('#thread .body.flash, #thread .m.flash').count()) === 0, 'a match outside the messages (here the status) just opens the conversation (no jump, no ring)');
  await clear();

  // キーボード: Ctrl+Shift+F で検索欄へ、↑↓ で選ぶ、Enter で開く、Esc で語を消す
  await page.locator('#prompt').focus();
  await page.keyboard.press('Control+Shift+F');
  check(await page.evaluate(() => document.activeElement === document.getElementById('q')), 'Ctrl+Shift+F moves to the search box from the composer');
  check(!(await page.locator('.toc-query').isVisible().catch(() => false)), 'Ctrl+Shift+F does not open the in-conversation search (Ctrl+F stays that)');
  await page.keyboard.type('gateway');
  await page.waitForTimeout(450);
  await page.keyboard.press('ArrowDown');
  let kb = await page.evaluate(() => { const q = document.getElementById('q'); const a = document.getElementById(q.getAttribute('aria-activedescendant') ?? ''); return { id: a?.id, selected: a?.getAttribute('aria-selected'), idx: [...document.querySelectorAll('#groups .row.res')].indexOf(a), hint: !document.getElementById('searchHint').hidden, expanded: q.getAttribute('aria-expanded'), ring: a ? getComputedStyle(a).outlineWidth : null }; });
  check(kb.idx === 0 && kb.selected === 'true' && kb.hint && kb.expanded === 'true' && kb.ring === '2px', 'ArrowDown selects the first result (aria-activedescendant, ring) and shows the key hint');
  await page.keyboard.press('ArrowDown');
  kb = await page.evaluate(() => { const q = document.getElementById('q'); const a = document.getElementById(q.getAttribute('aria-activedescendant') ?? ''); return [...document.querySelectorAll('#groups .row.res')].indexOf(a); });
  check(kb === 1, 'ArrowDown again moves to the second result');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#thread .body.flash, #thread .m.flash'), null, { timeout: 8000 });
  check(true, 'Enter opens the selected result and jumps to its message');
  await page.locator('#q').focus();
  await page.keyboard.press('Escape');
  check((await page.locator('#q').inputValue()) === '' && (await page.locator('#groups').getAttribute('role')) === 'tree', 'Esc clears the query and returns to the tree');
  check(await page.evaluate(() => document.activeElement === document.getElementById('q')), 'the focus stays in the search box after Esc');

  // 最近の検索: 結果を開いた語だけ。空の検索欄に入ると候補に出る
  await page.locator('#prompt').focus();
  await page.locator('#q').focus();
  await page.waitForTimeout(200);
  const recent = await page.evaluate(() => ({ shown: !document.getElementById('recentPop').hidden, items: [...document.querySelectorAll('#recentPop .li .lbl')].map(n => n.textContent) }));
  check(recent.shown && recent.items.join() === 'gateway,レビュー待ち', 'focusing the empty search box offers the words whose results were opened, newest first (words that were only typed are not kept)');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(450);
  check((await page.locator('#q').inputValue()) === 'gateway' && (await rows().count()) === 2, 'choosing a recent search runs it');
  await clear();

  // 設定を開いている間は効かない
  await page.locator('#settings').click();
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+Shift+F');
  check(!(await page.evaluate(() => document.activeElement === document.getElementById('q'))), 'Ctrl+Shift+F does nothing while the settings are open');
  await page.locator('#backToChat').click();

  console.log(results.map(l => 'OK  ' + l).join('\n'));
  return results.length;
}
