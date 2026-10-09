// playwright-cli run-code --filename=tests/browser/history-window.cjs
// 会話を開くとき末尾の窓だけを読み、手前は上へ送ると読み足すこと（ADR 0902）。広い窓（デスクトップ）で:
//   末尾で開く・手前を読み足しても読んでいる位置が動かない・大きい提示は見えるときに本文を取る・脇の検索で古い発言へ 1 回の読み足しで飛べる・
//   窓の外のサブエージェントが作業ダイアログの過去の一覧に出る・時刻だけで並ぶ提示が手前の読み足しで時刻の位置へ移る・枝を切り替えても窓で開く。
// 純粋な部分は tests/unit/history-window.mjs・tests/unit/server-history-window.mjs
// 種を入れた fake サーバーを別ポート・別のデータ置き場で立ててから流す（実データには向けない）:
//   node tests/browser/history-window-seed.mjs <空のデータ置き場> <作業ディレクトリ>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_FAKE_SUBAGENTS=<データ置き場>/fake-subagents.json AGENT_HOST_DATA=<データ置き場> AGENT_HOST_PORT=7434 AGENT_HOST_TOKEN=history-window-test AGENT_HOST_LOCALE=ja node core/server.mjs
async (page) => {
  const HOME = 'http://127.0.0.1:7434/?token=history-window-test';
  const ID = 'history-window';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const bodies = [];
  page.on('request', r => { if (r.url().includes('/present-body')) bodies.push(r.url()); });
  // 手前を読み足す頼み（loadSession の older）。検索から飛ぶときは届かせたい発言（reach）を添えて 1 回で済ませる
  const olderAsks = [];
  page.on('websocket', ws => ws.on('framesent', f => { const s = String(f.payload); if (s.includes('"loadSession"') && s.includes('"older"')) olderAsks.push(s); }));
  await page.setViewportSize({ width: 2560, height: 1300 });
  const rowCount = () => page.evaluate(() => document.querySelectorAll('#thread > .mw').length);
  const gap = () => page.evaluate(() => { const l = document.getElementById('log'); return l.scrollHeight - l.scrollTop - l.clientHeight; });
  const open = async () => {
    await page.goto(HOME);
    await page.locator(`.row[data-session="${ID}"]`).waitFor();
    await page.waitForTimeout(300);
    if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
    await page.locator(`.row[data-session="${ID}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#thread > .mw').length > 20);
    // 手前を足す仕事（C1）と実寸の確定が落ち着くまで待つ
    await page.waitForFunction(() => {
      const n = document.querySelectorAll('#thread > .mw').length;
      const s = window.__rows ??= { n: -1, at: performance.now() };
      if (n !== s.n) { s.n = n; s.at = performance.now(); }
      return performance.now() - s.at > 1200;
    }, null, { timeout: 30000, polling: 200 });
  };
  const firstKey = () => page.evaluate(() => document.querySelector('#thread > .mw[data-key^="m:"]')?.dataset.key ?? null);

  // 1. 末尾で開く。窓だけを描き（全 320 発言ではない）、末尾にいる
  await open();
  const width = await page.evaluate(() => document.getElementById('log').clientWidth);
  check(width >= 2000, `#log is wider than 2000px (${width})`);
  const opened = await rowCount();
  check(opened > 20 && opened < 160, `only the tail window is painted (${opened} rows of 320 messages)`);
  const key0 = await firstKey();
  check(/^m:\d+$/.test(key0) && Number(key0.slice(2)) > 100, `the first painted row is an absolute index in the window (${key0})`);
  check((await gap()) < 40, `opens at the end (gap ${await gap()})`);
  const windowKeys = await page.evaluate(() => [...document.querySelectorAll('#thread > .mw[data-key]')].map(r => r.dataset.key));
  check(!windowKeys.includes('m:1') && !windowKeys.includes('m:21'), 'the first assistant message and the message the late present belongs after are outside the window');
  check(windowKeys.indexOf('p:3') >= 0 && windowKeys.indexOf('p:3') < windowKeys.findIndex(k => k.startsWith('m:')), 'the late present, which has a time before the window, is drawn at the head of the window');

  // 1b. 窓の外のサブエージェント（最初の AI の発言の Task）が、作業ダイアログの過去の一覧に出る
  await page.waitForFunction(() => !document.getElementById('workEntry').hidden, null, { timeout: 8000 });
  await page.locator('#workEntryButton').click();
  await page.waitForFunction(() => document.getElementById('workList').textContent.includes('窓の外の調査'), null, { timeout: 8000 });
  check(true, 'a subagent called outside the window is listed in the work dialog');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('workDialog').open);

  // 2. 大きい提示は枠だけで開き、本文は近づいたときに取る。窓の手前の提示（i=0）は開いたときに取らない
  await page.waitForTimeout(800);
  const asked = () => bodies.map(u => /[?&]i=(\d+)/.exec(u)?.[1] ?? null);
  check(!asked().includes('0'), 'the present that belongs to the old part is not fetched on open');
  const holds = await page.evaluate(() => document.querySelectorAll('#thread .present-lazy').length + document.querySelectorAll('#thread iframe').length);
  check(holds >= 1, `the presents in the window are drawn as frames (${holds})`);
  await page.locator('#thread > .mw[data-key="p:1"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#thread > .mw[data-key="p:1"] iframe'), null, { timeout: 8000 });
  check(asked().includes('1'), `scrolling a present near fetches its body over /present-body (i=${asked().join(',')})`);
  await page.evaluate(() => { const log = document.getElementById('log'); log.scrollTop = log.scrollHeight; });
  await page.waitForTimeout(500);

  // 3. 上へ送ると手前を読み足す。読んでいる発言の位置は動かない。何度か繰り返して 0 まで届く
  const probe = async () => page.evaluate(() => {
    const log = document.getElementById('log'), line = log.getBoundingClientRect().top + 120;
    const row = [...document.querySelectorAll('#thread > .mw[data-key]')].find(r => r.getBoundingClientRect().bottom > line);
    return { key: row.dataset.key, top: row.getBoundingClientRect().top };
  });
  const drifts = [];
  for (let step = 0; step < 12; step++) {
    await page.evaluate(() => { const log = document.getElementById('log'); log.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true })); log.scrollTop = 0; });
    const before = await rowCount();
    const grew = await page.waitForFunction(n => document.querySelectorAll('#thread > .mw').length > n, before, { timeout: 8000 }).then(() => true, () => false);
    if (!grew) break;
    await page.waitForTimeout(500);
    const mark = await probe();
    await page.waitForTimeout(500);
    const after = await page.evaluate(({ key }) => document.querySelector(`#thread > .mw[data-key="${key}"]`)?.getBoundingClientRect().top ?? null, mark);
    if (after !== null) drifts.push(Math.abs(after - mark.top));
  }
  check(drifts.length >= 1 && Math.max(...drifts) < 3, `reading position does not drift while older rows load (max ${Math.max(...drifts)}px over ${drifts.length} loads)`);
  await page.waitForTimeout(800);
  await page.evaluate(() => { document.getElementById('log').scrollTop = 0; });
  await page.waitForTimeout(600);
  check((await firstKey()) === 'm:0', `older rows load all the way to the first message (${await firstKey()})`);
  const all = await rowCount();
  const painted = await page.evaluate(() => [...document.querySelectorAll('#thread > .mw[data-key^="m:"]')].map(r => Number(r.dataset.key.slice(2))));
  const missing = Array.from({ length: 320 }, (_, k) => k).filter(k => !painted.includes(k));
  check(all >= 320, `all messages are painted after scrolling up (${all} rows; ${painted.length} messages, missing ${missing.slice(0, 5).join(',')}.. ${missing.length})`);
  const keys = await page.evaluate(() => [...document.querySelectorAll('#thread > .mw[data-key]')].map(r => r.dataset.key));
  check(new Set(keys).size === keys.length, 'no row is painted twice');
  const late = keys.indexOf('p:3');
  check(keys[late - 1] === 'm:21' && keys[late + 1] === 'm:22', `the late present moved to its time between m:21 and m:22 (${keys.slice(late - 1, late + 2).join(',')})`);
  await page.locator('#thread > .mw[data-key="p:0"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('#thread > .mw[data-key="p:0"] iframe'), null, { timeout: 8000 });
  check(asked().includes('0'), 'the old present body is fetched when it is brought near the view');

  // 4. 脇の検索で古い発言へ飛ぶ: 窓の手前を読み足して着く
  await open();
  const windowRows = await rowCount();
  const asksBefore = olderAsks.length;
  await page.locator('#q').fill('ひつじ印');
  await page.waitForTimeout(700);
  await page.locator('#groups .row.res').first().click();
  await page.waitForFunction(() => [...document.querySelectorAll('#thread .m[data-uuid]')].some(m => m.dataset.uuid === 'claude:hw:u2'), null, { timeout: 15000 });
  const reached = await page.evaluate(() => {
    const m = [...document.querySelectorAll('#thread .m[data-uuid]')].find(x => x.dataset.uuid === 'claude:hw:u2');
    const top = m.getBoundingClientRect().top, log = document.getElementById('log').getBoundingClientRect();
    return { top, visible: top >= log.top && top < log.bottom };
  });
  check((await rowCount()) > windowRows, `the search jump loaded the older rows (${windowRows} -> ${await rowCount()})`);
  check(reached.visible, 'the message the search found is in view');
  const jumpAsks = olderAsks.slice(asksBefore);
  // 着いた発言が先頭に近いと、読み足した後に画面が続きの手前を自分で読み足す（reach の無い頼み）。届かせる頼みは 1 回で済む
  const reaching = jumpAsks.filter(s => s.includes('"reach"'));
  check(reaching.length === 1 && jumpAsks[0] === reaching[0] && reaching[0].includes('"reach":"claude:hw:u2"'), `the search jump reached the old message with one older request that names it (${reaching.length} of ${jumpAsks.length})`);

  // 5. 枝を切り替えても窓で開く（枝は分岐元までの発言を持つので、先頭は 0 でなくてよい）
  await open();
  await page.locator('.mw[data-key="m:317"] .m').hover();
  await page.locator('.mw[data-key="m:317"] .who-more').click();
  await page.getByRole('menuitem', { name: 'ここから分岐', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.branch-tip').length >= 2 && !document.querySelector('.branch-tip:disabled'), null, { timeout: 15000 });
  const target = page.locator('.branch-tip[aria-pressed=false]').first();
  const targetId = await target.getAttribute('data-session');
  await target.click();
  await page.waitForFunction(id => document.querySelector('.branch-tip[aria-pressed=true]')?.dataset.session === id && !document.querySelector('.branch-tip:disabled'), targetId, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#thread > .mw').length > 20);
  await page.waitForTimeout(1200);
  const branchRows = await rowCount();
  check(branchRows > 20 && branchRows < 200, `the switched branch also opens as a window (${branchRows} rows)`);
  const lastKey = await page.evaluate(() => [...document.querySelectorAll('#thread > .mw[data-key^="m:"]')].at(-1)?.dataset.key);
  check(/^m:3\d\d$/.test(lastKey ?? ''), `the branch shows the end of the conversation (${lastKey})`);
  return { passed: true, checks: results };
}
