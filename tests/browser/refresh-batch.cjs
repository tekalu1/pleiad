// playwright-cli -s=refresh-batch --raw run-code --filename=tests/browser/refresh-batch.cjs
// tests/lib/search-seed.mjs のデータを使う隔離した fake サーバー（port 7498、token refresh-batch-test）で流す。
async (page) => {
  const url = 'http://127.0.0.1:7498/?token=refresh-batch-test';
  const check = (value, label) => { if (!value) throw Error(label); return label; };
  const checks = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('agent-host-current', 'ss-index');
    window.startupListCalls = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      // 差分（since 付き）の取り直しは数えない。全量の取得が重ならないことを見る（ADR 0179）
      try { const m = JSON.parse(data); if (m.command === 'listSessions' && !m.args?.since) window.startupListCalls++; } catch {}
      return send.call(this, data);
    };
  });
  await page.goto(url);
  await page.locator('#groups .row[data-session="ss-nightly"]').waitFor();
  // 初回のあいさつは一覧より少し後に開くので、待ってから閉じる
  await page.waitForTimeout(500);
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  checks.push(check(await page.evaluate(() => window.startupListCalls) === 1, '起動時の一覧取得は 1 回'));

  const command = (name, args) => page.evaluate(({ name, args }) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=refresh-batch-test`);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.kind === 'ready') ws.send(JSON.stringify({ kind: 'command', id: '1', command: name, args }));
      else if (message.kind === 'response' && message.id === '1') {
        ws.close();
        message.ok ? resolve(message.result) : reject(Error(message.error));
      }
    };
    ws.onerror = reject;
  }), { name, args });

  await page.evaluate(() => { window.stableRow = document.querySelector('#groups .row[data-session="ss-nightly"]'); });
  await page.evaluate(() => document.querySelector('#groups .row[data-session="ss-paid"]').click());
  await page.waitForFunction(() => document.querySelector('#groups .row.sel')?.dataset.session === 'ss-paid');
  await page.waitForTimeout(500);
  checks.push(check(await page.evaluate(() => window.stableRow === document.querySelector('#groups .row[data-session="ss-nightly"]')),
    '別の会話を選んでも変更のない行は同じ DOM'));

  await page.evaluate(() => {
    window.listCalls = 0;
    window.rowAdds = 0;
    const countRows = (node) => (node.nodeType === 1 ? Number(node.matches('.row')) + node.querySelectorAll('.row').length : 0);
    window.rowObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) window.rowAdds += countRows(node);
    });
    window.rowObserver.observe(document.getElementById('groups'), { subtree: true, childList: true });
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try { if (JSON.parse(data).command === 'listSessions') window.listCalls++; } catch {}
      return send.call(this, data);
    };
  });
  const title = `更新 ${Date.now()}`;
  await command('setTitle', { sessionId: 'ss-nightly', title });
  await command('setTitle', { sessionId: 'ss-map', title: `${title} 2` });
  await command('setTitle', { sessionId: 'ss-dark', title: `${title} 3` });
  await page.waitForFunction((expected) => document.querySelector('#groups .row[data-session="ss-nightly"] .row-t')?.textContent === expected, title);
  await page.waitForTimeout(450);
  checks.push(check(await page.evaluate(() => window.listCalls) === 1, '他会話の連続変更は一覧取得 1 回'));
  checks.push(check(await page.evaluate(() => window.rowAdds) === 3, '変わった 3 行だけを差し替える'));
  await page.evaluate(() => window.rowObserver.disconnect());

  await page.evaluate(() => document.getElementById('settings').click());
  await page.waitForFunction(() => document.body.classList.contains('settings'));
  await page.evaluate(() => {
    window.settingsMutations = 0;
    window.settingsObserver = new MutationObserver((records) => { window.settingsMutations += records.length; });
    window.settingsObserver.observe(document.getElementById('groups'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const settingsTitle = `${title} settings`;
  await command('setTitle', { sessionId: 'ss-nightly', title: settingsTitle });
  await page.waitForTimeout(650);
  checks.push(check(await page.evaluate(() => window.settingsMutations === 0), '設定画面では隠れた一覧を描かない'));
  await page.evaluate(() => document.getElementById('backToChat').click());
  checks.push(check(await page.evaluate((expected) => !document.body.classList.contains('settings') &&
    document.querySelector('#groups .row[data-session="ss-nightly"] .row-t')?.textContent === expected, settingsTitle),
    '会話へ戻ると最新の題を描く'));
  await page.evaluate(() => window.settingsObserver.disconnect());

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => matchMedia('(max-width:700px)').matches);
  await page.evaluate(() => {
    window.sideMutations = 0;
    window.sideObserver = new MutationObserver((records) => { window.sideMutations += records.length; });
    window.sideObserver.observe(document.getElementById('groups'), { subtree: true, childList: true, attributes: true, characterData: true });
  });
  const closedTitle = `${title} closed`;
  await command('setTitle', { sessionId: 'ss-nightly', title: closedTitle });
  await page.waitForTimeout(650);
  checks.push(check(await page.evaluate((expected) => window.sideMutations === 0 &&
    document.querySelector('#groups .row[data-session="ss-nightly"] .row-t')?.textContent !== expected, closedTitle),
    '閉じたドロワーでは一覧を描かない'));
  await page.evaluate(() => document.getElementById('openSidebar').click());
  // 一覧の描き直しはタップの後ろ（開き始めた次のコマ）へ回している
  await page.waitForFunction((expected) => document.documentElement.classList.contains('side-open') &&
    document.querySelector('#groups .row[data-session="ss-nightly"] .row-t')?.textContent === expected, closedTitle);
  checks.push('開いたときに最新の題を描く');

  await page.evaluate(() => { window.stableRow = document.querySelector('#groups .row[data-session="ss-map"]'); });
  const movedStatus = `検証 ${Date.now()}`;
  await command('setStatus', { sessionId: 'ss-nightly', status: movedStatus });
  await page.waitForFunction((expected) => document.querySelector('#groups .row[data-session="ss-nightly"]')?.closest('.grp')?.querySelector('.grp-name')?.textContent === expected, movedStatus);
  checks.push(check(await page.evaluate(() => window.stableRow === document.querySelector('#groups .row[data-session="ss-map"]')),
    '状態の移動後も他の行を再利用する'));

  await page.evaluate(() => { const q = document.getElementById('q'); q.value = 'gateway'; q.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.getElementById('groups').getAttribute('role') === 'listbox');
  checks.push(check(await page.locator('#groups .row.res').count() >= 1, '検索結果を表示する'));
  await page.evaluate(() => { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); });
  checks.push(check(await page.evaluate(() => document.getElementById('groups').getAttribute('role') === 'tree' &&
    document.querySelectorAll('#groups [data-side-keep]').length === 0 && document.querySelectorAll('#groups .row[data-session]').length >= 10),
    '検索を戻すと一覧の行が揃う'));

  const source = await command('loadSession', { sessionId: 'ss-index' });
  const fork = await command('fork', { sessionId: 'ss-index', upToMessageId: source.messages[0].uuid, title: `枝 ${Date.now()}` });
  await page.waitForTimeout(600);
  const family = page.locator('#groups .fam-head[data-key="f:ss-index"]');
  await family.waitFor();
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();
  if (await family.getAttribute('aria-expanded') === 'false') await family.click();
  await page.waitForFunction((id) => document.querySelector(`#groups .row[data-session="${id}"]`), fork.sessionId);
  checks.push(check(await page.evaluate((id) => {
    const child = document.querySelector(`#groups .row[data-session="${id}"]`);
    return child?.closest('.fam')?.querySelector('.fam-head')?.getAttribute('aria-expanded') === 'true';
  }, fork.sessionId), '枝は同じ状態のグループに入る'));
  await command('setStatus', { sessionId: fork.sessionId, status: `別の状態 ${Date.now()}` });
  await page.waitForFunction((id) => !document.querySelector(`#groups .row[data-session="${id}"]`)?.closest('.fam'), fork.sessionId);
  checks.push(check(await page.evaluate((id) => document.querySelector(`#groups .row[data-session="${id}"]`) &&
    document.querySelectorAll('#groups [data-side-keep]').length === 0, fork.sessionId),
    '枝がグループを出ても行が残る'));
  return checks;
}
