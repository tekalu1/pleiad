// playwright-cli run-code --filename=tests/browser/chrome-control.cjs
// 右パネル「Chrome の窓」へ差し込んだ状態の一行・止める・引き継ぐ・戻す（web/chrome-control.mjs。ADR 0148・0154）: 状態ごとの字とボタン・押した位置の輪・
// 一時停止中の帯（会話の側）・撮影を断つ幕は映像の側の 1 つだけ・窓が無くなっても一時停止中は戻せる・会話の引き継ぎの行・動きを減らす設定・狭い幅。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token chrome-control-test, port 7435, AGENT_HOST_LOCALE=ja). Never run against live data.
// Chrome の窓の知らせ・映像・状態はサーバーに無い（偽の Chrome が要る）ので、ページの中で届いたことにする（WebSocket の onmessage で配り、送るコマンドは send を包んで控えて応答を作る）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };

  await page.addInitScript(() => {
    if (window.__ccWrapped) return;
    window.__ccWrapped = true;
    window.__sockets = [];
    window.__sent = [];
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          const m = JSON.parse(e.data);
          if (m.kind === 'response' && m.result && typeof m.result === 'object' && 'osActions' in m.result && 'hostName' in m.result) m.result.chromeWindow = true;
          return fn({ data: JSON.stringify(m) });
        });
      }
      get onmessage() { return super.onmessage; }
      send(d) {
        try {
          const m = JSON.parse(d);
          const control = { chromeTakeOver: 'paused', chromeResume: 'running', chromeStop: 'stopped' };
          if (m.kind === 'command' && (m.command in control || ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck'].includes(m.command))) {
            window.__sent.push({ command: m.command, args: m.args });
            const result = m.command === 'browserScreencast' ? { tabId: 'T1', state: { tabId: 'T1', agent: false, suspended: false, tabs: 1 } }
              : m.command in control ? { sessionId: m.args.sessionId, state: control[m.command], since: null } : {};
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result }) })));
            return;
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (message) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
    window.__event = (event) => window.__deliver({ kind: 'event', event });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sent = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);
  const control = (id, state, since = null) => page.evaluate(([i, s, at]) => window.__event({ type: 'chromeControl', sessionId: i, state: s, since: at }), [id, state, since]);

  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('echo:chrome control');
  await page.locator('#prompt').press('Control+Enter');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(!!sessionId, 'a conversation exists');

  // ============ 1. 窓があるとき、パネルの差し込み口に状態の一行が入る
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#browserEntry').click();
  await page.locator('#filePreview[data-panel="chrome-window"]').waitFor();
  await page.locator('.cp-screen').waitFor();
  check(await page.locator('.cp-slot .cc').count() === 1, 'the status row is mounted in the slot');
  check((await page.locator('.cp-slot .cc-text').textContent()) === '待機中' && (await page.locator('.cp-slot .cc-btn:visible').allTextContents()).join() === '引き継ぐ', 'with a window and no news yet: idle, take over only');
  check(await page.locator('.cp-screen .cc-overlay').count() === 1, 'the overlay sits on top of the video');
  check(await page.locator('#chromeBanner .cc-banner').count() === 1 && await page.locator('#chromeBanner .cc-banner').isHidden(), 'the banner is in the conversation side and hidden');

  // ============ 2. running: 「… が操作中」と止める・引き継ぐ。role=status
  await control(sessionId, 'running');
  await page.locator('.cp-slot .cc').waitFor({ state: 'visible' });
  check(/が操作中$/.test((await page.locator('.cp-slot .cc-text').textContent()).trim()), 'running: the agent is operating');
  check(await page.locator('.cp-slot .cc-status').getAttribute('role') === 'status', 'the line is role=status');
  const shown = async () => (await page.locator('.cp-slot .cc-btn:visible').allTextContents());
  check((await shown()).join() === '止める,引き継ぐ', `running buttons: ${(await shown()).join()}`);

  // ============ 3. 押した位置の輪（映像の元の大きさが分かるとき、割合で置く）
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 1, data, metadata: { deviceWidth: 1000, deviceHeight: 500 } }), [sessionId, PNG]);
  await page.waitForFunction(() => document.querySelector('.cp-frame')?.getAttribute('src'));
  await page.evaluate((id) => window.__event({ type: 'chromeTap', sessionId: id, x: 250, y: 125, windowId: 1 }), sessionId);
  const ring = page.locator('.cp-screen .cc-ring');
  await ring.waitFor({ state: 'attached' });
  check(await ring.evaluate((el) => el.style.left === '25%' && el.style.top === '25%'), 'the ring is placed by the share of the page');
  check(await ring.evaluate((el) => getComputedStyle(el).borderTopWidth === '0px' && /rgb/.test(getComputedStyle(el).boxShadow)), 'the ring is a shadow ring (no border)');
  check(await ring.evaluate((el) => getComputedStyle(el).pointerEvents === 'none'), 'the ring never takes the pointer');
  await page.waitForFunction(() => !document.querySelector('.cp-screen .cc-ring'), null, { timeout: 3000 });
  check(true, 'the ring goes away');
  await page.evaluate(() => window.__event({ type: 'chromeTap', sessionId: 'someone-else', x: 1, y: 1 }));
  check(await page.locator('.cp-screen .cc-ring').count() === 0, 'taps of other conversations are ignored');

  // ============ 4. 引き継ぐ → paused（帯・戻すだけ・映像の幕は映像の側の 1 つだけ）
  await page.locator('.cp-slot .cc-btn', { hasText: '引き継ぐ' }).click();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeTakeOver'));
  check((await sent('chromeTakeOver'))[0].args.sessionId === sessionId, 'the button sends chromeTakeOver for this conversation');
  await control(sessionId, 'paused', 1);
  await page.locator('#chromeBanner .cc-banner').waitFor({ state: 'visible' });
  check((await page.locator('#chromeBanner .cc-banner-text').textContent()) === '一時停止中 · あなたが Chrome で操作しています', 'the banner text');
  check(await page.locator('#chromeBanner .cc-banner').getAttribute('role') === null && await page.locator('.cp-slot .cc').getAttribute('aria-label') === null, 'the banner has no role (no double reading) and the row div has no aria-label');
  check((await page.locator('.cp-slot .cc-text').textContent()) === 'あなたが操作中', 'paused: you are operating');
  check((await shown()).length === 1 && /に戻す$/.test((await shown())[0]), `paused: only the hand-back button (${(await shown()).join()})`);
  // 撮影を断つ幕は映像の側（server が suspended を送る）。こちらの層は幕を持たない
  await page.evaluate((id) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'state', sessionId: id, state: { tabId: 'T1', agent: false, suspended: true, tabs: 1 } }), sessionId);
  await page.locator('.cp-veil').waitFor({ state: 'visible' });
  check(await page.locator('.cp-veil').count() === 1 && await page.locator('.cc-veil').count() === 0, 'one veil only (the video side)');
  check((await page.locator('.cp-veil').textContent()).includes('映像を止めています'), 'the veil says the video is stopped');
  // 窓が無くなっても、一時停止中は戻せる
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 0, operating: false }), sessionId);
  await page.locator('#browserEntry').waitFor({ state: 'hidden' });
  check(await page.locator('#chromeBanner .cc-banner').isVisible(), 'the banner stays while paused even if the window is gone');
  await page.locator('#chromeBanner .cc-banner .cc-btn').click();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeResume'));
  check((await sent('chromeResume'))[0].args.sessionId === sessionId, 'the banner button sends chromeResume');
  await control(sessionId, 'running');
  await page.locator('#chromeBanner .cc-banner').waitFor({ state: 'hidden' });
  check(true, 'the banner goes away when resumed');

  // ============ 5. 窓が戻ると一行も戻る。止める・待機中・止めた後
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#browserEntry').waitFor({ state: 'visible' });
  check((await shown()).join() === '止める,引き継ぐ', 'back to running buttons');
  await page.locator('.cp-slot .cc-btn', { hasText: '止める' }).click();
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'chromeStop'));
  await control(sessionId, 'stopped');
  check((await page.locator('.cp-slot .cc-text').textContent()) === '止めました' && (await shown()).join() === '引き継ぐ', 'stopped: only take over');
  await control(sessionId, 'idle');
  check((await page.locator('.cp-slot .cc-text').textContent()) === '待機中' && (await shown()).join() === '引き継ぐ', 'idle: only take over');
  // ほかの会話の状態は出ない
  await page.evaluate(() => window.__event({ type: 'chromeControl', sessionId: 'someone-else', state: 'paused', since: 1 }));
  check(await page.locator('#chromeBanner .cc-banner').isHidden() && (await page.locator('.cp-slot .cc-text').textContent()) === '待機中', 'other conversations do not change this one');

  // ============ 6. 会話の中の行（引き継いで戻した）
  await page.evaluate((id) => window.__event({ type: 'present', sessionId: id, kind: 'chromeHandover', chromeHandover: { seconds: 72 }, by: 'ai', at: new Date().toISOString() }), sessionId);
  await page.locator('.cc-line').waitFor();
  check(/あなたが引き継ぎ · .+ に戻しました · 1 分 12 秒/.test(await page.locator('.cc-line').last().textContent()), 'the hand-over line in the conversation');

  // ============ 7. 動きを減らす設定では、輪は広がらず薄く出て消えるだけ
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate((id) => window.__event({ type: 'chromeTap', sessionId: id, x: 10, y: 10, windowId: 1 }), sessionId);
  await page.locator('.cp-screen .cc-ring').waitFor({ state: 'attached' });
  check(await page.locator('.cp-screen .cc-ring').evaluate((el) => getComputedStyle(el).animationName === 'cc-ring-hold'), 'reduced motion: the ring only fades');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ============ 8. 狭い幅(360px): 一行とボタンが収まる
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(300);
  const box = await page.locator('.cp-slot .cc').boundingBox();
  check(!!box && box.width <= 360, `the status row fits 360px (${box?.width})`);
  check(await page.locator('.cp-slot .cc').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'the row does not overflow');
  await page.setViewportSize({ width: 1280, height: 800 });

  // ============ 9. 窓が無くなって一時停止でもなければ、一行は隠れ、差し込み口は場所を取らない
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 0, operating: false }), sessionId);
  await page.waitForFunction(() => document.querySelector('.cp-slot .cc')?.hidden === true);
  check(await page.locator('.cp-slot').evaluate((el) => getComputedStyle(el).display === 'none'), 'the slot takes no room while the row is hidden');

  // 後片付け: パネルを閉じる
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.locator('#filePreview[data-panel="chrome-window"]').isVisible()) await page.locator('#browserEntry').click();
  return results.join('\n');
}
