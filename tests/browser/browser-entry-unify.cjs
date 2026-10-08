// Run with an isolated fake backend, a disposable data directory, and a private port.
// Browser bridge and Chrome events are fakes; the page and its right panel are the real UI.
async page => {
  const check = (value, message) => { if (!value) throw Error(message); };
  await page.addInitScript(() => {
    const tabs = [{ id:'native-1', url:'https://example.test/', title:'Example', external:true }];
    let state = { tabs, current:'native-1', sessionId:null };
    const listeners = new Set();
    window.plyDesktop = { browser: {
      command: async (name, args) => {
        if (name === 'context') state = { ...state, sessionId:args?.sessionId ?? null };
        if (name === 'select') state = { ...state, current:args.id };
        if (name === 'newTab') { tabs.push({ id:`native-${tabs.length + 1}`, url:'', title:'New tab' }); state = { ...state, current:tabs.at(-1).id }; }
        listeners.forEach(fn => fn(state));
        return state;
      },
      layout: () => {}, onState: fn => { listeners.add(fn); return () => listeners.delete(fn); }, onShortcut: () => () => {},
    } };
    const NativeSocket = WebSocket;
    window.__sockets = [];
    window.WebSocket = class extends NativeSocket {
      constructor(...args) { super(...args); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && (event => {
          const message = JSON.parse(event.data);
          if (message.kind === 'response' && message.result && 'osActions' in message.result && 'hostName' in message.result) message.result.chromeWindow = true;
          return fn({ data:JSON.stringify(message) });
        });
      }
      get onmessage() { return super.onmessage; }
      send(data) {
        const message = JSON.parse(data);
        if (message.kind === 'command' && ['browserScreencast', 'browserScreencastStop', 'browserScreencastAck', 'chromeCloseWindow'].includes(message.command)) {
          queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ kind:'response', id:message.id, ok:true, result:{} }) })));
          return;
        }
        return super.send(data);
      }
    };
    window.__chromeEvent = event => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data:JSON.stringify({ kind:'event', event }) }));
  });
  await page.reload();
  await page.locator('#prompt').waitFor();
  await page.screenshot();
  await page.evaluate(() => document.querySelector('#onboardingDialog[open]')?.close());
  const later = page.getByRole('button', { name:'あとで', exact:true });
  if (await later.isVisible()) await later.click();
  await page.locator('#newSession').click();
  await page.waitForFunction(() => localStorage.getItem('agent-host-current'));
  const id = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  check(id, 'conversation id');
  check(await page.locator('#chromeEntry').count() === 0, 'only one browser entry');
  const entry = page.locator('#browserEntry');
  await entry.click();
  check(await entry.getAttribute('aria-expanded') === 'true', 'unified expanded state');
  check(await page.locator('.browser-tab-chrome [role=tab]').count() === 1, 'fixed Chrome tab');
  check(await page.locator('.browser-tab-chrome .browser-tab-close').count() === 0, 'fixed tab has no close');
  check(await page.locator('.browser-address').isVisible(), 'viewer tools shown');
  check(await page.locator('.file-preview-title').isHidden(), 'no heading text row');

  await page.evaluate(sessionId => window.__chromeEvent({ type:'chromeWindow', sessionId, windows:2, operating:true, windowIds:[41,42], currentWindowId:42 }), id);
  check(await page.locator('.browser-address').isVisible(), 'running agent does not switch an open viewer');
  check(await page.locator('.browser-tab-chrome .browser-tab-count').textContent() === '2', 'window count on the fixed tab');
  check(await page.locator('.browser-tab-chrome .run').count() === 1, 'arc on background Chrome tab');
  await page.locator('.browser-tab-chrome [role=tab]').click();
  check(await page.locator('.browser-address').count() === 0, 'viewer tools removed in Chrome');
  check(await page.locator('.cp-slot').isVisible(), 'Chrome status in tool row');
  check(await page.locator('.cp-profile-slot').count() === 1, 'profile pill insertion slot');
  await page.locator('.cp-window-menu').click();
  check((await page.locator('.pop:not([hidden])').textContent()).includes('窓 2 · 表示中'), 'current window in menu');
  check((await page.locator('.pop:not([hidden])').textContent()).includes('窓 2'), 'window list in menu');
  check((await page.locator('.pop:not([hidden])').textContent()).includes('窓を閉じる'), 'close action in menu');
  await page.keyboard.press('Escape');
  await page.locator('.browser-tab-chrome [role=tab]').focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('.browser-address').waitFor({ state:'visible' });
  await page.locator('.browser-tab-list [role=tab][aria-selected=true]').focus();
  await page.keyboard.press('Home');
  await page.locator('.cp-screen').waitFor({ state:'visible' });
  await entry.click();
  check(await entry.getAttribute('aria-expanded') === 'false', 'entry closes either tab');
  await entry.click();
  await page.locator('.cp-screen').waitFor({ state:'visible' });
  check(true, 'running state opens Chrome on the next open');
  return 'fixed tab, tools, state, keyboard, menu, entry: passed';
}
