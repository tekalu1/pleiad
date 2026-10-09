// playwright-cli run-code --filename=tests/browser/mobile-boot.cjs
// スマホ版の殻（window.plyRemote の shell: mobile）の起動と脇のパネル（docs/remote.md §8.4・docs/design-system.md「スマホの起動と脇のパネル」）。
// tests/lib/search-seed.mjs のデータを使う隔離した fake サーバー（port 7496、token mobile-boot-test）で流す。本物のデータでは流さない。
//   - 前の会話（localStorage）を、一覧の返事より先に読み始める。一覧の件数の外にある会話も開く。殻だけ、無いときは最近の会話を開く
//   - 接続する間は、覚えていた前の題と骨組みを出す（殻だけ）
//   - 一覧は会話とスレッドの両方が届くまで骨組み。起動で自動に選んでも、利用者が開いた脇のパネルを閉じない
//   - 開閉のタップでは印だけ。背後の inert は開き始めた後。行を押して選べば閉じる
async (page) => {
  const url = 'http://127.0.0.1:7496/?token=mobile-boot-test';
  const checks = [];
  const check = (value, label) => { if (!value) throw Error(label); checks.push(label); };
  await page.setViewportSize({ width: 390, height: 844 });
  // 殻・保留・一覧からの取り除きは sessionStorage の印で決める（同じタブで読み直しても残る。addInitScript は積み重なるので 1 回だけ守る）
  await page.addInitScript(() => {
    if (window.__bootTest) return;
    window.__bootTest = true;
    if (sessionStorage.getItem('bt-shell') === '1') {
      Object.defineProperty(window, 'plyRemote', { value: Object.freeze({ hostId: 'bt-host', hostName: 'テスト', shell: 'mobile' }) });
    }
    window.__cmds = [];
    window.__held = [];
    const listIds = new Set();
    const key = (m) => (m.command === 'invoke' ? m.args?.op : m.command);
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      if (m?.kind === 'command') {
        window.__cmds.push(key(m));
        if (m.command === 'listSessions') listIds.add(m.id);
        if ((sessionStorage.getItem('bt-hold') ?? '').split(',').includes(key(m))) { window.__held.push({ ws: this, data, key: key(m) }); return; }
      }
      return send.call(this, data);
    };
    window.__release = (name) => {
      const rest = [];
      for (const h of window.__held) { if (h.key === name) send.call(h.ws, h.data); else rest.push(h); }
      window.__held = rest;
    };
    const desc = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
    Object.defineProperty(WebSocket.prototype, 'onmessage', {
      configurable: true,
      get() { return desc.get.call(this); },
      set(fn) {
        desc.set.call(this, fn && ((e) => {
          const drop = sessionStorage.getItem('bt-drop');
          if (drop && typeof e.data === 'string') {
            try {
              const m = JSON.parse(e.data);
              if (m.kind === 'response' && listIds.has(m.id) && m.ok) {
                const list = Array.isArray(m.result) ? m.result : m.result.sessions;
                const kept = list.filter((s) => s.id !== drop);
                if (Array.isArray(m.result)) m.result = kept; else m.result.sessions = kept;
                return fn.call(this, new MessageEvent('message', { data: JSON.stringify(m) }));
              }
            } catch {}
          }
          return fn.call(this, e);
        }));
      },
    });
  });

  // [殻か, 保留する命令（,区切り）, 一覧から外す会話, 前の会話, 覚えた題]
  const arrange = (s) => page.evaluate(([shell, hold, drop, current, title]) => {
    sessionStorage.clear();
    if (shell) sessionStorage.setItem('bt-shell', '1');
    if (hold) sessionStorage.setItem('bt-hold', hold);
    if (drop) sessionStorage.setItem('bt-drop', drop);
    localStorage.clear();
    if (current) localStorage.setItem('agent-host-current', current);
    if (title) localStorage.setItem('agent-host-current-title', JSON.stringify({ id: current, title }));
  }, s);
  const stored = () => page.evaluate(() => localStorage.getItem('agent-host-current'));
  const command = (name, args) => page.evaluate(({ name, args }) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws?token=mobile-boot-test`);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.kind === 'ready') ws.send(JSON.stringify({ kind: 'command', id: '1', command: name, args }));
      else if (message.kind === 'response' && message.id === '1') { ws.close(); message.ok ? resolve(message.result) : reject(Error(message.error)); }
    };
    ws.onerror = reject;
  }), { name, args });
  // 同じオリジンの storage を整えてから読み直す（初めの読み込みで入れた印は arrange が消す）
  const boot = async (settings) => {
    await page.goto(url);
    await arrange(settings);
    await page.goto(url);
  };

  // 種の会話（一覧の最近のもの。殻で覚えが無いときに開くもの）
  await page.goto(url);
  const listed = await command('listSessions', {});
  const sessions = Array.isArray(listed) ? listed : listed.sessions;
  const normal = sessions.filter((s) => !s.bot && !s.delegation && !s.unsent);
  const recent = normal.reduce((a, b) => (new Date(b.lastModified ?? 0) > new Date(a.lastModified ?? 0) ? b : a));
  const previous = normal.find((s) => s.id !== recent.id && s.title && s.title !== '(no title)');
  check(recent && previous, '種の会話が 2 つ以上ある');

  // ---- 1. 殻: 一覧の返事を待つ間も、前の題と骨組みを出し、前の会話の履歴は一覧より先に頼む
  await boot([true, 'listSessions,channels.threads', null, previous.id, previous.title]);
  await page.waitForFunction(() => window.__cmds?.includes('loadSession'));
  check(await page.evaluate(() => window.__held.some((h) => h.key === 'listSessions')),
    '一覧の返事を待たずに、前の会話の履歴（loadSession）を頼む');
  check(await page.inputValue('#titleEdit') === previous.title, '接続の間は覚えていた前の題を出す（「新しいセッション」ではない）');
  check(await page.locator('#log .history-skeleton').count() >= 1, '接続の間は履歴の骨組みを出す');
  // 一覧の骨組み。開いたとき空に見えない（まだ会話の行は無い）
  await page.evaluate(() => document.getElementById('openSidebar').click());
  await page.waitForFunction(() => document.documentElement.classList.contains('side-open'));
  await page.waitForFunction(() => document.querySelector('#groups .side-skeleton'));
  check(await page.evaluate(() => document.getElementById('groups').getAttribute('aria-busy') === 'true' &&
    document.querySelectorAll('#groups .row[data-session]').length === 0), '一覧は会話・スレッドが届くまで骨組み（行は出さない）');
  await page.evaluate(() => window.__release('listSessions'));
  await page.waitForFunction((id) => localStorage.getItem('agent-host-current') === id && document.getElementById('titleEdit').value, previous.id);
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.querySelectorAll('#groups .row[data-session]').length === 0 && !!document.querySelector('#groups .side-skeleton')),
    '会話だけ届いても、スレッドが届くまで一覧は骨組みのまま');
  check(await page.evaluate(() => document.documentElement.classList.contains('side-open')), '起動で前の会話を選んでも、利用者が開いた脇のパネルは閉じない');
  await page.evaluate(() => window.__release('channels.threads'));
  await page.waitForFunction(() => document.querySelectorAll('#groups .row[data-session]').length >= 5 && !document.querySelector('#groups .side-skeleton'));
  check(await page.evaluate(() => !document.getElementById('groups').hasAttribute('aria-busy')), '両方届いたら一覧を描き、骨組みと busy を外す');
  check(await page.evaluate(() => document.documentElement.classList.contains('side-open')), '一覧を描いても脇のパネルは開いたまま');
  check(await stored() === previous.id, '前の会話が開く');
  check(await page.evaluate((id) => !!document.querySelector(`#groups .row.sel[data-session="${id}"]`), previous.id), '開いている会話の行が選ばれて描かれる');
  check(await page.evaluate(() => document.querySelector('main').inert === true), '開いている間は背後が inert');

  // ---- 2. 行を押して選ぶ道は今まで通り閉じる
  const other = normal.find((s) => s.id !== previous.id && s.id !== recent.id) ?? recent;
  await page.evaluate((id) => document.querySelector(`#groups .row[data-session="${id}"]`).click(), other.id);
  await page.waitForFunction(() => !document.documentElement.classList.contains('side-open'));
  await page.waitForFunction(() => document.querySelector('main').inert === false);
  check(await stored() === other.id, '行を押して選ぶと、その会話が開き、脇のパネルを閉じる（背後の inert も外れる）');

  // ---- 3. タップの中では印だけ。inert・一覧の描き直し・フォーカスは次のフレーム以降
  if (await page.locator('#onboardingDialog[open]').count()) await page.locator('#closeOnboarding').click();   // 新しい置き場の最初の案内
  await page.waitForFunction(() => document.querySelector('main').inert === false);
  const tap = await page.evaluate(() => new Promise((resolve) => {
    const main = document.querySelector('main');
    const root = document.documentElement;
    const out = {};
    document.getElementById('openSidebar').click();
    out.openedSync = root.classList.contains('side-open');
    out.expanded = document.getElementById('openSidebar').getAttribute('aria-expanded');
    out.inertSync = main.inert;
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      out.inertLater = main.inert;
      out.focus = document.activeElement?.id || document.activeElement?.tagName || '';
      document.getElementById('closeSidebar').click();
      out.closedSync = !root.classList.contains('side-open');
      out.inertAfterClose = main.inert;
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => { out.inertClosedLater = main.inert; resolve(out); }, 50)));
    }, 50)));
  }));
  check(tap.openedSync && tap.expanded === 'true' && tap.inertSync === false, 'タップの中では side-open と aria-expanded だけ（背後の inert はまだ付けない）');
  check(tap.inertLater === true, '開き始めた後に背後を inert にする');
  check(tap.focus === 'closeSidebar', `開いたらフォーカスは脇の閉じるボタンへ（${tap.focus}）`);
  check(tap.closedSync && tap.inertAfterClose === true && tap.inertClosedLater === false, '閉じるときも、印は先・inert を外すのは後');
  // 続けて開閉しても最後の状態に落ち着く
  await page.evaluate(() => { const o = document.getElementById('openSidebar'); o.click(); o.click(); o.click(); });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.documentElement.classList.contains('side-open') && document.querySelector('main').inert === true),
    '続けて開閉しても最後の状態に合わせて落ち着く');
  await page.evaluate(() => document.getElementById('closeSidebar').click());
  await page.waitForFunction(() => document.querySelector('main').inert === false);

  // ---- 4. 殻: 前の会話が一覧の件数の外でも、読めれば開く（新しい会話にしない）
  await boot([true, null, previous.id, previous.id, previous.title]);
  await page.waitForFunction(() => window.__cmds.includes('listSessions') && !document.querySelector('#log .history-skeleton'));   // 閉じた脇は一覧を描かないので、履歴が載るのを待つ
  await page.waitForTimeout(600);
  check(await stored() === previous.id && await page.locator('#log .m.user').count() >= 1, '前の会話が一覧に無くても（件数の外）、読めれば新しい会話にせず、その会話の履歴を開く');
  check(await page.evaluate(() => !document.querySelector('#log .history-skeleton')), '開いたら骨組みは外れる');
  // 閉じた脇に一覧が届いたあと（描かれずに印だけ付く）、開いたら骨組みのままにならず行が出る
  await page.evaluate(() => document.getElementById('openSidebar').click());
  await page.waitForFunction(() => document.querySelectorAll('#groups .row[data-session]').length >= 5 && !document.querySelector('#groups .side-skeleton'));
  check(await page.evaluate(() => !document.getElementById('groups').hasAttribute('aria-busy')), '閉じている間に一覧が届いても、開くと行が出て骨組みと busy が外れる');

  // ---- 5. 殻: 覚えが無いとき（端末の代理のポートが変わった）は、新しい会話ではなく最近の会話
  await boot([true, null, null, null, null]);
  await page.waitForFunction(() => localStorage.getItem('agent-host-current'));
  await page.waitForTimeout(600);
  check(await stored() === recent.id, '殻で覚えが無ければ、いちばん最近動いた会話を開く');
  check(await page.inputValue('#titleEdit') === recent.title, '開いた会話の題が出る');

  // ---- 6. 殻の外（ブラウザー・デスクトップ版）は今まで通り
  await boot([false, 'listSessions', null, previous.id, previous.title]);
  await page.waitForFunction(() => window.__held.some((h) => h.key === 'listSessions'));
  check(await page.inputValue('#titleEdit') === '' && await page.locator('#log .history-skeleton').count() === 0,
    '殻の外では接続の間に前の題と骨組みを出さない');
  await page.evaluate(() => window.__release('listSessions'));
  await page.waitForFunction((id) => localStorage.getItem('agent-host-current') === id, previous.id);
  await boot([false, null, null, null, null]);
  await page.waitForFunction(() => localStorage.getItem('agent-host-current'));
  await page.waitForTimeout(600);
  check(await stored() !== recent.id, '殻の外では、覚えが無ければ新しい会話（最近の会話に替えない）');

  // ---- 7. 前の会話が無い（読めない）ときも、殻では新しい会話ではなく最近の会話。無い id から何も作らない
  await boot([true, null, null, 'ghost-no-such-session', 'もう無い会話']);
  await page.waitForFunction(() => localStorage.getItem('agent-host-current') && localStorage.getItem('agent-host-current') !== 'ghost-no-such-session');
  await page.waitForTimeout(600);
  check(await stored() === recent.id, '前の会話が無いときも、殻では最近の会話を開く');
  check(await page.inputValue('#titleEdit') === recent.title, '無い会話の題は出さない');
  return checks;
}
