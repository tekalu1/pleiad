// playwright-cli run-code --filename=tests/browser/tool-bundle-events.cjs
// 実バックエンドが流す順序を、WebSocket のメッセージとして合成して実クライアントに流し、ツールのまとまり（web/tool-bundle.mjs）と
// 末尾の稼働表示の境目を確かめる: 押さずに決着した承認・承認待ちの行・中断で残る走っている行・activity 事象・委譲のツール・キーボード。
// 認証済みの fake サーバーで案内を閉じてから流す（サーバーの状態には触れない。合成した事象はこのページだけに届く）。
async page => {
  await page.addInitScript(() => {
    const W = window.WebSocket;
    window.__wss = [];
    window.WebSocket = function (...a) { const s = new W(...a); window.__wss.push(s); return s; };
    window.WebSocket.prototype = W.prototype;
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  });
  await page.reload();
  await page.waitForTimeout(1500);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('ok');
  await page.locator('#prompt').press('Control+Enter');
  await page.locator('.m.ai .body').filter({ hasText: 'ok' }).waitFor();

  const out = await page.evaluate(async () => {
    const ws = window.__wss.at(-1);
    const sid = document.querySelector('.row.sel')?.dataset.session ?? null;
    const send = (event) => ws.onmessage({ data: JSON.stringify({ kind: 'event', event: { sessionId: sid, ...event } }) });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const q = (s) => document.querySelector(s);
    const qa = (s) => [...document.querySelectorAll(s)];
    const perm = (id, toolUseID, toolName = 'Write') => send({ type: 'permission', id, kind: 'tool', toolName, toolUseID, input: { file_path: 'D:/x/b.mjs', content: 'a' }, canAlways: true });
    const end = async () => { send({ type: 'turnResult', outcome: 'ok' }); send({ type: 'activity', state: 'idle' }); await sleep(300); };
    const res = {};

    // 2. 押さずに決着した承認（別の端末で許可した・自動で通った）。結果が届いたら承認カードを外して行を戻す
    send({ type: 'tool.start', id: 'a1', name: 'Read', input: { file_path: 'D:/x/a.mjs' } });
    send({ type: 'tool.start', id: 'a2', name: 'Write', input: { file_path: 'D:/x/b.mjs', content: 'a\nb' } });
    perm('pa2', 'a2');
    await sleep(350);
    res.appearedAppr = qa('.tc-appr').length;
    send({ type: 'tool.result', id: 'a2', text: 'ok', isError: false });
    await sleep(350);
    const a2 = q('[data-id="a2"]');
    res.staleAppr = qa('.tc-appr').length;
    res.rowVisible = !a2.querySelector('.tc-details').hidden && a2.classList.contains('tc-done') && !a2.classList.contains('tc-waiting');
    send({ type: 'tool.result', id: 'a1', text: 'x', isError: false });
    await end();

    // 3. 承認を待つ行が最新でなくなる（並列のツール）。まとまりを閉じる・開く操作でも、待っている承認は見えて押せる
    send({ type: 'tool.start', id: 'b0', name: 'Read', input: { file_path: 'D:/x/z.mjs' } });
    send({ type: 'tool.start', id: 'b1', name: 'Write', input: { file_path: 'D:/x/b.mjs', content: 'a' } });
    perm('pb1', 'b1');
    send({ type: 'tool.start', id: 'b2', name: 'Bash', input: { command: 'sleep 9' } });
    send({ type: 'tool.start', id: 'b3', name: 'Grep', input: { pattern: 'x' } });
    await sleep(500);
    const shown = () => { const w = q('[data-perm-id="pb1"]')?.closest('.hi'); return !!w && !w.classList.contains('hid') && !w.classList.contains('ghost') && !w.hasAttribute('inert'); };
    res.waitingShownAtStart = shown();
    q('.bundle .rhead').click(); await sleep(400);
    q('.bundle .rhead').click(); await sleep(400);
    res.waitingShownAfterToggle = shown();
    q('.bundle').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(400);
    res.waitingShownAfterEsc = shown();
    // 12. ↑↓ を奪うのは見出しと薄い行だけ。承認のボタンにフォーカスがあるときは会話のスクロールに任せる
    const key = (target) => { const e = new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }); target.dispatchEvent(e); return e.defaultPrevented; };
    res.arrowOnButton = key(q('[data-perm-id="pb1"] .btn-primary'));
    res.arrowOnHead = key(q('.bundle .rhead'));
    // 4. 中断（結果が来ないまま turnResult aborted）。走っている印と承認カードを残さない
    send({ type: 'turnResult', outcome: 'aborted', reason: 'user' });
    await sleep(500);
    res.strayRunning = qa('.tc-running').length;
    res.strayWaiting = qa('.tc-waiting, .tc-appr').length;
    res.strayTick = qa('.tc-res').filter(r => r.textContent.includes('s') && r.querySelector('.run')).length;
    send({ type: 'activity', state: 'idle' });

    // 5. activity 事象（running / waiting）は、ツールの行が語っている間は稼働表示を出さない
    send({ type: 'tool.start', id: 'c1', name: 'Bash', input: { command: 'npm test' } });
    send({ type: 'activity', state: 'running' });
    await sleep(200);
    res.activityWhileRunning = qa('.m.activity').length;
    perm('pc1', 'c1', 'Bash');
    send({ type: 'activity', state: 'waiting' });
    await sleep(300);
    res.activityWhileWaiting = qa('.m.activity').length;
    send({ type: 'tool.result', id: 'c1', text: 'ok', isError: false });
    await end();

    // 6. 委譲・サブエージェント（境界のツール）の間は、従来の稼働表示を残す
    send({ type: 'tool.start', id: 'd1', name: 'Agent', input: { description: '調べる', subagent_type: 'Explore', prompt: 'x' } });
    await sleep(300);
    res.activityForAgent = q('.m.activity .txt')?.textContent ?? null;
    send({ type: 'tool.result', id: 'd1', text: '裏で始めた', isError: false });
    await end();
    return res;
  });
  const bad = [];
  if (out.appearedAppr !== 1) bad.push('approval did not appear');
  if (out.staleAppr !== 0 || !out.rowVisible) bad.push('stale approval after result');
  if (!out.waitingShownAtStart || !out.waitingShownAfterToggle || !out.waitingShownAfterEsc) bad.push('waiting row hidden by bundle operation');
  if (out.arrowOnButton !== false || out.arrowOnHead !== true) bad.push('arrow keys: ' + out.arrowOnButton + '/' + out.arrowOnHead);
  if (out.strayRunning !== 0 || out.strayWaiting !== 0 || out.strayTick !== 0) bad.push('strays after abort');
  if (out.activityWhileRunning !== 0 || out.activityWhileWaiting !== 0) bad.push('activity line stacked on the tool row');
  if (!out.activityForAgent) bad.push('no activity for the delegate tool');
  if (bad.length) throw Error(bad.join('; ') + ' ' + JSON.stringify(out));
  return { passed: true, out };
}
