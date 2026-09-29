// playwright-cli run-code --filename=tests/browser/history-heights.cjs
// 長い会話を広い窓（#log が会話の列 860px よりずっと広い）で開いたとき、仮の高さの発言を見ている所の近くだけ実寸に確定して
// 落ち着いた後も末尾にいること、読み返している位置が動かないこと、遠い行は確定しないままなこと（web/history-heights.mjs）。
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
  // 確定は近くだけで、遠い行は仮の高さのまま残る。確定した行数が 1.5 秒変わらなくなったら落ち着いたとみなす
  const settled = () => page.evaluate(() => { delete window.__settle; }).then(() => page.waitForFunction(() => {
    const n = document.querySelectorAll('#thread > .mw.height-ready').length;
    const s = window.__settle ??= { n: -1, at: performance.now() };
    if (n !== s.n) { s.n = n; s.at = performance.now(); }
    return performance.now() - s.at > 1500;
  }, null, { timeout: 60000, polling: 250 }));
  const unsettled = () => page.evaluate(() => document.querySelectorAll('#thread > .mw:not(.activity):not(.height-ready)').length);
  const gap = () => page.evaluate(() => { const l = document.getElementById('log'); return l.scrollHeight - l.scrollTop - l.clientHeight; });

  // 1. 末尾で開く。確定が落ち着き、末尾に合わせ直す見張り（scrollToEnd）も止まった後で末尾にいる
  await open();
  const width = await page.evaluate(() => document.getElementById('log').clientWidth);
  check(width >= 2000, `#log is wider than 2000px (${width})`);
  await settled();
  await page.waitForTimeout(1500);
  const endGap = await gap();
  check(endGap < 40, `stays at the end after the nearby heights are settled (gap ${endGap})`);
  const farRows = await unsettled();
  check(farRows > 100, `rows far from the view keep their placeholder height (${farRows} rows)`);

  // 2. 開いた直後に読み返し始める（ホイールで見張りを止め、途中へ移る）。確定が済まないうちに見ている発言を控え、落ち着いた後も同じ位置にある。
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
      // 見えた行と画面のすぐ外の行はブラウザーが実寸で描き直す（content-visibility:auto）。それが済んでから控える
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const line = log.getBoundingClientRect().top + 80;
        const rows = [...document.querySelectorAll('#thread > .mw')];
        const index = rows.findIndex(r => r.getBoundingClientRect().bottom > line);
        window.__readBack = {
          ready: document.querySelectorAll('#thread > .mw.height-ready').length,
          index, top: rows[index].getBoundingClientRect().top,
        };
      }));
    };
    requestAnimationFrame(watch);
  });
  await page.locator(`.row[data-session="${ID}"]`).click();
  await page.waitForFunction(() => window.__readBack);
  const before = await page.evaluate(() => window.__readBack);
  await settled();
  await page.waitForTimeout(500);
  const after = await page.evaluate(index => document.querySelectorAll('#thread > .mw')[index].getBoundingClientRect().top, before.index);
  check(Math.abs(after - before.top) < 2, `the row being read stays in place (moved ${after - before.top}px)`);
  const midGap = await gap();
  check(midGap > 1000, `still reading back, not at the end (gap ${midGap})`);
  const nowReady = await page.evaluate(() => document.querySelectorAll('#thread > .mw.height-ready').length);
  check(nowReady > before.ready && (await unsettled()) > 100, `the heights near the view were settled (${before.ready} -> ${nowReady} rows), far ones were not`);
  return { passed: true, checks: results };
}
