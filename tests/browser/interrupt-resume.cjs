// playwright-cli run-code --filename=tests/browser/interrupt-resume.cjs
// 中断と再開・実行中でも更新できる更新（docs/design-system.md「中断と再開」、ADR 0027）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（AGENTS.md）。
// デスクトップの更新の口（window.plyDesktop.update）は偽物にする: 更新は準備済み（downloaded）、install は記録するだけ。
// fake は "slow" で中断されるまで走り、"ask" で承認を待つ。abort は 1.5 秒遅らせて「作業を中断しています… 0 / 3」を撮る。
// 撮った画面は temporary/screenshots/interrupt-resume-impl-*.png（playwright-cli を起動した作業ディレクトリからの相対）。
async page => {
  const shots = 'temporary/screenshots/interrupt-resume-impl';
  await page.addInitScript(() => {
    const hold = window.__hold = { delay: {}, log: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      if (m?.kind === 'command') hold.log.push({ command: m.command, args: m.args, at: Date.now() });
      const ms = m?.kind === 'command' ? hold.delay[m.command] ?? 0 : 0;
      if (ms) { setTimeout(() => send.call(this, data), ms); return; }
      return send.call(this, data);
    };
    // 更新で Pleiad が再起動したことにする: 印が立っていれば ready の startedAt（サーバーの起動時刻）を今にする。
    // 「更新で中断した会話が N 件」は起動より前の中断だけを数えるので、同じサーバーのままでは出ない
    const onmessage = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, get() { return onmessage.get.call(this); }, set(fn) {
      onmessage.set.call(this, fn && function (e) {
        if (sessionStorage.getItem('ply-test-restarted')) {
          try { const m = JSON.parse(e.data); if (m.kind === 'ready') return fn.call(this, { data: JSON.stringify({ ...m, startedAt: Date.now() }) }); } catch {}
        }
        return fn.call(this, e);
      });
    } });
    let listener = null;
    const state = { phase: 'downloaded', enabled: true, version: '0.9.2', target: '0.9.3', notice: false, autoDownload: true, autoCheck: true, channel: 'stable' };
    window.__installs = 0;
    window.plyDesktop = {
      onUpdate: (fn) => { listener = fn; },
      update: async (name) => {
        if (name === 'install') { window.__installs++; return { ...state }; }
        return { ...state };
      },
    };
  });
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.locator('.row[data-session]').first().waitFor();
  await wait(800);

  // ---- 実行中 2 件（slow）と承認待ち 1 件（ask）を作る。前からある会話は数えない（同じデータ置き場で流し直せるように）
  const before = await page.evaluate(() => [...document.querySelectorAll('.row[data-session]')].map(r => r.dataset.session));
  const start = async (text) => {
    await page.locator('#newSession').click();
    await wait(800);
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await wait(1500);
  };
  await start('slow');
  await start('slow');
  await start('ask');
  await page.waitForFunction(() => (window.__hold.log.length, document.querySelectorAll('.row .run').length >= 2));
  await wait(4500);   // running の放送（4 秒ごと）で脇の知らせの件数が合う
  const promptWork = await page.evaluate(() => ({ hidden: document.querySelector('#updatePromptWork').hidden, text: document.querySelector('#updatePromptWork').textContent }));
  check('脇の更新の知らせに「実行中 N 件・承認待ち M 件」', !promptWork.hidden && /実行中 2 件・承認待ち 1 件/.test(promptWork.text), JSON.stringify(promptWork));
  await page.screenshot({ path: `${shots}-update-prompt.png` });

  // ---- 確認の段: 止まる作業の一覧と「あとで」「中断して更新」
  await page.locator('#viewAvailableUpdate').click();
  await page.locator('#installUpdate').click();
  await page.waitForFunction(() => !document.querySelector('#updateWork').hidden);
  const confirm = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.update-work-row')].map(r => r.textContent),
    after: document.querySelector('#updateWorkAfter').textContent,
    button: document.querySelector('#confirmInstallUpdate').textContent,
    later: document.querySelector('#cancelInstallUpdate').textContent,
  }));
  check('確認の段に 3 件（実行中 2・承認待ち 1）', confirm.rows.length === 3 && confirm.rows.filter(r => r.includes('承認待ち')).length === 1, JSON.stringify(confirm.rows));
  check('主ボタンは「中断して更新」、もう一方は「あとで」', confirm.button === '中断して更新' && confirm.later === 'あとで', JSON.stringify(confirm));
  check('中断した会話がどう残るかの 1 行', confirm.after.includes('承認待ちは却下扱いになります'), confirm.after);
  await page.locator('#updateConfirm').screenshot({ path: `${shots}-update-confirm.png` });

  // ---- 中断して更新: 進み → 保存 → install
  await page.evaluate(() => { window.__hold.delay.abort = 1500; });
  await page.locator('#confirmInstallUpdate').click();
  await page.waitForFunction(() => /作業を中断しています/.test(document.querySelector('#updateStatus').textContent));
  const progress = await page.evaluate(() => document.querySelector('#updateStatus').textContent);
  check('「作業を中断しています… N / M」', /作業を中断しています… 0 \/ 3/.test(progress), progress);
  await page.screenshot({ path: `${shots}-update-stopping.png` });
  await page.waitForFunction(() => window.__installs > 0, null, { timeout: 35000 });
  const aborted = await page.evaluate(() => window.__hold.log.filter(l => l.command === 'abort').map(l => l.args));
  // 止まり終えるまで見るたびに送り直す（待つ間に始まったターンも止める）。どれも全部・reason update
  check('abort は全部・reason update', aborted.length >= 1 && aborted.every(a => a.reason === 'update' && !a.sessionId), JSON.stringify(aborted));

  // ---- 更新のあと（画面を読み直す）: 三角・理由・脇の下の一行
  await page.evaluate(() => { window.__hold.delay = {}; sessionStorage.setItem('ply-test-restarted', '1'); });
  await page.reload();
  await page.locator('.row[data-session]').first().waitFor();
  await wait(1500);
  const side = await page.evaluate((before) => [...document.querySelectorAll('.row[data-session]')].filter(r => !before.includes(r.dataset.session)).map(r => ({
    mark: r.querySelector('.warn-mark')?.getAttribute('class') ?? null, why: r.querySelector('.row-why')?.textContent ?? null,
    label: r.querySelector('.warn-mark')?.getAttribute('aria-label') ?? null })), before);
  const stopped = side.filter(r => r.mark);
  // 承認待ちだけだった会話は、却下で普通に終わるので三角は付かない（モックの場面 5 と同じ）
  check('更新で止めた実行中の 2 件に三角と「更新のため中断」', stopped.length === 2 && stopped.every(r => r.why === '更新のため中断' && r.label === '更新のため中断'), JSON.stringify(side));
  check('開いていない会話の三角は未読（--ink）', stopped.some(r => r.mark === 'warn-mark'), JSON.stringify(side));
  const strip = await page.evaluate(() => ({ hidden: document.querySelector('#resumeStrip').hidden, text: document.querySelector('#resumeStripText').textContent }));
  check('脇の下に「更新で中断した会話が N 件あります」', !strip.hidden && /更新で中断した会話が \d+ 件あります/.test(strip.text), JSON.stringify(strip));
  // 中断した会話を開く（開くと三角は既読の --ink-weak になる）
  await page.locator('.row[data-session]:has(.warn-mark:not(.read))').first().click();
  await page.waitForFunction(() => document.querySelector('.row.sel .warn-mark.read') && document.querySelector('.m.sys[data-interrupted]'));
  const line = await page.evaluate(() => document.querySelector('.m.sys[data-interrupted]')?.textContent ?? null);
  check('開いている会話の末尾に「Pleiad の更新のため中断しました」', Boolean(line?.startsWith('Pleiad の更新のため中断しました')), String(line));
  await page.screenshot({ path: `${shots}-after-update.png` });

  // ---- 畳んだ見出しにも三角
  await page.locator('.grp-name').first().click();
  const head = await page.evaluate(() => document.querySelector('.grp.collapsed .grp-head .warn-mark')?.getAttribute('aria-label') ?? null);
  check('畳んだ見出しに三角', head === '中の会話が中断', String(head));
  await page.locator('#sidebar').screenshot({ path: `${shots}-collapsed.png` });
  await page.locator('.grp-name').first().click();

  // ---- まとめて再開
  await page.locator('#resumeAll').click();
  await page.waitForFunction(() => document.querySelector('#resumeStrip').hidden, null, { timeout: 10000 });
  await wait(2500);
  const resumes = await page.evaluate(() => window.__hold.log.filter(l => l.command === 'resume').length);
  check('まとめて再開は各会話に resume', resumes >= 2, String(resumes));
  // slow はまた走るので中断して片付ける（ask の承認待ちも中断で却下）
  await page.evaluate(() => { const ws = new WebSocket(`ws://${location.host}/ws?token=${new URL(location.href).searchParams.get('token')}`); ws.onopen = () => ws.send(JSON.stringify({ kind: 'command', id: 'cleanup', command: 'abort', args: {} })); });
  await wait(2000);
  return { passed: true, checks };
}
