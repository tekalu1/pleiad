// playwright-cli run-code --filename=tests/browser/history-heights.cjs
// 長い会話を広い窓（#log が会話の列 860px よりずっと広い）で開いたとき、仮の高さの発言を実寸に確定し終えても
// 末尾にいること、読み返している位置が動かないこと（web/client.mjs の prepareHistoryHeights）。
// 作りものの画面での同じ確認は tests/unit/history-heights.mjs。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token history-heights-test, port 7432). Never run against live data:
//   node tests/browser/history-heights-seed.mjs <empty data dir> <cwd>
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<data dir> AGENT_HOST_PORT=7432 AGENT_HOST_TOKEN=history-heights-test AGENT_HOST_LOCALE=ja node core/server.mjs
async (page) => {
  const URL = 'http://127.0.0.1:7432/?token=history-heights-test';
  const ID = 'history-heights';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  await page.setViewportSize({ width: 2560, height: 1300 });
  const open = async () => {
    await page.goto(URL);
    await page.locator(`.row[data-session="${ID}"]`).waitFor();
    await page.evaluate(() => { for (const d of document.querySelectorAll('dialog[open]')) d.close(); });
    await page.locator(`.row[data-session="${ID}"]`).click();
    await page.waitForFunction(() => document.querySelectorAll('#thread > .mw').length > 200);
  };
  const allReady = () => page.waitForFunction(() => !document.querySelector('#thread > .mw:not(.activity):not(.height-ready)'), null, { timeout: 30000 });
  const gap = () => page.evaluate(() => { const l = document.getElementById('log'); return l.scrollHeight - l.scrollTop - l.clientHeight; });

  // 1. 末尾で開く。確定が全部終わり、末尾に合わせ直す見張り（scrollToEnd）も止まった後で末尾にいる
  await open();
  const width = await page.evaluate(() => document.getElementById('log').clientWidth);
  check(width >= 2000, `#log is wider than 2000px (${width})`);
  await allReady();
  await page.waitForTimeout(1500);
  const endGap = await gap();
  check(endGap < 40, `stays at the end after all heights are ready (gap ${endGap})`);

  // 2. 開いた直後に読み返し始める（ホイールで見張りを止め、途中へ移る）。確定が残っているうちに見ている発言を控え、終わった後も同じ位置にある。
  //    確定はすぐ進むので、描いた次のフレームの頭（確定を始める rAF より先に登録した rAF）で動く
  await page.goto(URL);
  await page.locator(`.row[data-session="${ID}"]`).waitFor();
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    const watch = () => {
      if (document.querySelectorAll('#thread > .mw').length <= 200) return requestAnimationFrame(watch);
      const log = document.getElementById('log');
      log.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
      log.scrollTop = Math.round(log.scrollHeight * 0.4);
      // 見えた行と画面のすぐ外の行はブラウザーが実寸で描き直す（content-visibility:auto）。それが済んでから控える。
      // ホイールから 350ms は確定を止めているので、その間に控えられる
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const line = log.getBoundingClientRect().top + 80;
        const rows = [...document.querySelectorAll('#thread > .mw')];
        const index = rows.findIndex(r => r.getBoundingClientRect().bottom > line);
        window.__readBack = {
          pending: document.querySelectorAll('#thread > .mw:not(.activity):not(.height-ready)').length,
          index, top: rows[index].getBoundingClientRect().top,
        };
      }));
    };
    requestAnimationFrame(watch);
  });
  await page.locator(`.row[data-session="${ID}"]`).click();
  await page.waitForFunction(() => window.__readBack);
  const before = await page.evaluate(() => window.__readBack);
  check(before.pending > 16, `heights are still being prepared when reading back (${before.pending} rows left)`);
  await allReady();
  await page.waitForTimeout(500);
  const after = await page.evaluate(index => document.querySelectorAll('#thread > .mw')[index].getBoundingClientRect().top, before.index);
  check(Math.abs(after - before.top) < 2, `the row being read stays in place (moved ${after - before.top}px)`);
  const midGap = await gap();
  check(midGap > 1000, `still reading back, not at the end (gap ${midGap})`);
  return { passed: true, checks: results };
}
