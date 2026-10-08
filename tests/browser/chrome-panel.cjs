// playwright-cli run-code --filename=tests/browser/chrome-panel.cjs
// 右パネル「Chrome の窓」（docs/inapp-browser.md「リモートから見る」、ADR 0148 第 5 段）: 会話の頭の行の入口・パネルのモード・見るだけの案内・撮影を止めている間の幕・
// 状態の一行の差し込み口・閉じたときの停止・動きを減らす設定・狭い幅。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (token chrome-panel-test, port 7434, AGENT_HOST_LOCALE=ja). Never run against live data.
// Chrome の窓の知らせと映像はサーバーに無い（偽の Chrome が要る）ので、ページの中で届いたことにする（WebSocket の onmessage で配り、送るコマンドは send を包んで控えて応答を作る）。
// 認証済みで、案内を閉じた fake の会話から始める。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };

  await page.addInitScript(() => {
    if (window.__cpWrapped) return;
    window.__cpWrapped = true;
    window.__sockets = [];
    window.__sent = [];
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          const m = JSON.parse(e.data);
          // この環境には Chrome の窓の映像がある、ということにする
          if (m.kind === 'response' && m.result && typeof m.result === 'object' && 'osActions' in m.result && 'hostName' in m.result) m.result.chromeWindow = true;
          return fn({ data: JSON.stringify(m) });
        });
      }
      get onmessage() { return super.onmessage; }
      send(d) {
        try {
          const m = JSON.parse(d);
          if (m.kind === 'command' && ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'browserScreencastInput', 'browserScreencastNav'].includes(m.command)) {
            window.__sent.push({ command: m.command, args: m.args });
            const result = m.command === 'browserScreencast' ? { tabId: 'T1', state: { tabId: 'T1', agent: false, suspended: false, tabs: 1 } } : {};
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

  // 1×1 の画像（JPEG と言い張る。ブラウザーは中身で判別する）
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const sent = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);

  // 会話を 1 つ作る
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('echo:chrome window');
  await page.locator('#prompt').press('Control+Enter');
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  const sessionId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(!!sessionId, 'a conversation exists');

  // ============ 1. 窓が無い会話には入口を出さない。窓ができたら出る
  check(await page.locator('#chromeEntry').isHidden(), 'no entry without a Chrome window');
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.locator('#chromeEntry').waitFor({ state: 'visible' });
  const label = await page.locator('#chromeEntry').getAttribute('aria-label');
  check(/の Chrome の窓$/.test(label), `entry name: ${label}`);
  check(await page.locator('#chromeEntry .entry-run').count() === 0, 'no arc while idle');
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: true }), sessionId);
  await page.locator('#chromeEntry .entry-run').waitFor();
  check(/操作中$/.test(await page.locator('#chromeEntry').getAttribute('aria-label')), 'arc and name while the agent operates');
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 1, operating: false }), sessionId);
  await page.waitForFunction(() => !document.querySelector('#chromeEntry .entry-run'));
  // ほかの会話の知らせでは出ない
  await page.evaluate(() => window.__event({ type: 'chromeWindow', sessionId: 'someone-else', windows: 1, operating: true }));
  check(await page.locator('#chromeEntry .entry-run').count() === 0, 'other conversations do not change this entry');

  // ============ 2. 開く: 右パネルのモード・映像の名前・状態の一行の差し込み口・始める依頼
  await page.locator('#chromeEntry').click();
  await page.locator('#filePreview[data-panel="chrome-window"]').waitFor();
  check(await page.locator('#chromeEntry').getAttribute('aria-expanded') === 'true', 'entry is pressed while open');
  const screen = page.locator('.cp-screen');
  await screen.waitFor();
  check(/の Chrome の窓の映像（見るだけ）$/.test(await screen.getAttribute('aria-label')) && await screen.getAttribute('role') === 'img', 'the video is named and read-only');
  check(await page.locator('.cp-slot').count() === 1 && await page.locator('.cp-slot .cc').count() === 1, 'the status slot exists and holds the control row (web/chrome-control.mjs)');
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'browserScreencast'));
  const start = (await sent('browserScreencast'))[0].args;
  check(start.sessionId === sessionId && start.source === 'chrome' && start.width > 100 && start.height > 100 && start.scale >= 1, `start request: ${JSON.stringify(start)}`);
  check(await page.locator('.cp-foot').textContent() !== undefined, 'footer exists');

  // ============ 3. 映像が描かれ、描き終えたら ack を返す。内蔵ブラウザーの映像（source なし）は混ざらない
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 7, data, metadata: { deviceWidth: 1100, deviceHeight: 720 } }), [sessionId, PNG]);
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'browserScreencastAck' && x.args.seq === 7));
  const ack = (await sent('browserScreencastAck')).find((x) => x.args.seq === 7).args;
  check(ack.source === 'chrome' && ack.sessionId === sessionId, 'ack carries source chrome');
  check((await page.locator('.cp-frame').getAttribute('src')).startsWith('data:image/jpeg;base64,'), 'the frame is drawn');
  check(/fps/.test(await page.locator('.cp-fps').textContent()), 'footer shows fps');
  const before = await page.locator('.cp-frame').getAttribute('src');
  await page.evaluate(([id]) => window.__deliver({ kind: 'screencast', type: 'frame', sessionId: id, seq: 9, data: 'AAAA', metadata: {} }), [sessionId]);
  await page.waitForTimeout(150);
  check(await page.locator('.cp-frame').getAttribute('src') === before, 'frames without source chrome are ignored by the panel');

  // ============ 4. 見るだけ: 押す・打つで案内を出す（何も送らない）。タッチでは常に出す
  check(await page.locator('.cp-hint').evaluate((el) => el.textContent === '' && !('shown' in el.dataset)), 'no hint until pressed');
  await screen.click({ position: { x: 40, y: 40 } });
  await page.waitForFunction(() => 'shown' in document.querySelector('.cp-hint').dataset);
  check(await page.locator('.cp-hint').textContent() === '見るだけ · 操作は引き継いでから', 'pressing shows the view-only hint');
  // 映像のフレームが続いて届いても（描き直しても）、出している案内は消えない
  await page.evaluate(([id, data]) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'frame', sessionId: id, seq: 8, data, metadata: { deviceWidth: 1100, deviceHeight: 720 } }), [sessionId, PNG]);
  await page.waitForFunction(() => window.__sent.some((x) => x.command === 'browserScreencastAck' && x.args.seq === 8));
  check(await page.locator('.cp-hint').evaluate((el) => 'shown' in el.dataset && el.textContent !== ''), 'a new frame does not clear the hint');
  await page.waitForFunction(() => !('shown' in document.querySelector('.cp-hint').dataset), null, { timeout: 6000 });
  check(true, 'the hint goes away');
  await screen.focus();
  await page.keyboard.type('a');
  await page.waitForFunction(() => 'shown' in document.querySelector('.cp-hint').dataset);
  check(true, 'typing shows the hint');
  const inputs = await page.evaluate(() => window.__sent.filter((x) => ['browserScreencastInput', 'browserScreencastNav'].includes(x.command)).length);
  check(inputs === 0, 'pressing and typing send no input');
  await page.waitForFunction(() => !('shown' in document.querySelector('.cp-hint').dataset), null, { timeout: 6000 });
  await page.evaluate(() => document.querySelector('.cp-screen').dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true })));
  await page.waitForTimeout(3200);
  check(await page.locator('.cp-hint').evaluate((el) => 'shown' in el.dataset), 'touch keeps the hint visible');

  // ============ 5. 撮影を止めている間の幕・窓が閉じた
  await page.evaluate((id) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'state', sessionId: id, state: { tabId: 'T1', agent: false, suspended: true, tabs: 1 } }), sessionId);
  await page.locator('.cp-veil').waitFor({ state: 'visible' });
  check((await page.locator('.cp-veil').textContent()).includes('映像を止めています'), 'veil while capture is refused');
  await page.evaluate((id) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'state', sessionId: id, state: { tabId: 'T1', agent: false, suspended: false, tabs: 1 } }), sessionId);
  await page.locator('.cp-veil').waitFor({ state: 'hidden' });
  await page.evaluate((id) => window.__deliver({ kind: 'screencast', source: 'chrome', type: 'ended', sessionId: id, reason: 'closed' }), sessionId);
  await page.waitForFunction(() => document.querySelector('.cp-screen').classList.contains('ended'));
  check((await page.locator('.cp-fps').textContent()).includes('閉じました'), 'ended is shown');

  // ============ 6. 状態の一行の差し込み口: 差し込むと場所ができ、外すと詰まる（第 6 段の部品を後で入れる）
  await page.evaluate(() => { const row = document.createElement('div'); row.id = 'probe'; row.textContent = 'status'; document.querySelector('.cp-slot').append(row); });
  check(await page.locator('#probe').isVisible(), 'a mounted status row shows in the slot');
  await page.evaluate(() => document.querySelector('#probe').remove());

  // ============ 7. 動きを減らす設定では、出し入れだけ
  await page.emulateMedia({ reducedMotion: 'reduce' });
  check(await page.locator('.cp-hint').evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration) === 0), 'reduced motion: no transition on the hint');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // ============ 8. 狭い幅(360px): パネルは全面になり、映像の箱は幅に収まる
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(300);
  const box = await page.locator('.cp-screen').boundingBox();
  check(!!box && box.width <= 360 && box.width > 200, `the video fits 360px (${box?.width})`);
  await page.setViewportSize({ width: 1280, height: 800 });

  // ============ 9. 閉じると停止を送る。別の会話へ移ってもパネルは残らない
  await page.keyboard.press('Escape').catch(() => {});
  if (await page.locator('#filePreview[data-panel="chrome-window"]').isVisible()) await page.locator('#chromeEntry').click();
  await page.waitForFunction(() => !document.querySelector('#filePreview[data-panel="chrome-window"]:not([hidden])'));
  const stops = await sent('browserScreencastStop');
  check(stops.length >= 1 && stops.at(-1).args.source === 'chrome' && stops.at(-1).args.sessionId === sessionId, 'closing sends a stop for the chrome source');
  check(await page.locator('#chromeEntry').getAttribute('aria-expanded') === 'false', 'entry is released after closing');
  // 窓が無くなったら入口も消える
  await page.evaluate((id) => window.__event({ type: 'chromeWindow', sessionId: id, windows: 0, operating: false }), sessionId);
  await page.locator('#chromeEntry').waitFor({ state: 'hidden' });
  check(true, 'the entry goes away with the window');

  return results.join('\n');
}
