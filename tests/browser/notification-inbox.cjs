// playwright-cli run-code --filename=tests/browser/notification-inbox.cjs
// 通知ボタンと通知の一覧（docs/design-system.md「通知の一覧」、ADR 9102）: 空・ベルの件数と ◆・面（絞り込み・すべて既読・↑↓ Enter Esc）・
// 行を押して会話の発言へ（輪）・チャンネルのスレッドの投稿へ（輪）・動きを減らす設定・360 幅のシート・開いている間に届く通知。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7434, token inbox-test, fresh data dir). Never run against live data.
// 通知の元は本物の操作で作る（会話の完了・失敗・承認は fake の台本 echo / fail / ask を別の会話で走らせる。@あなた は bot の投稿）。
// 狭い幅（360px）の脇は引き出しなので、広い幅で作ってから setViewportSize で狭める。
async page => {
  const URL = 'http://127.0.0.1:7434/?token=inbox-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  await page.addInitScript(() => {
    if (window.__inboxWrapped) return;
    window.__inboxWrapped = true;
    window.__sockets = [];
    window.__calls = new Map();
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.kind === 'ready') window.__home = m.homeDir;
            const call = m.kind === 'response' ? window.__calls.get(m.id) : null;
            if (call) { window.__calls.delete(m.id); if (m.ok) call.res(m.result); else call.rej(new Error(String(m.error))); return; }
          } catch {}
          return fn(e);
        });
      }
      get onmessage() { return super.onmessage; }
    };
    window.__cmd = (command, args = {}, wait = true) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      if (wait) window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command, id, args }));
      if (!wait) res(null);
    });
    window.__rpc = (op, args = {}) => window.__cmd('invoke', { op, args });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && window.__home);
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);
  const cmd = (command, args, wait = true) => page.evaluate(([c, a, w]) => window.__cmd(c, a, w), [command, args, wait]);
  await cmd('authLogin', { backend: 'fake' });
  await page.locator('#backToChat').click({ timeout: 3000 }).catch(() => {});   // 設定が開いていれば会話へ戻る
  const bell = page.locator('#notifBell');
  const panel = page.locator('#notifPanel');
  const rows = page.locator('#notifPanel .nrow');
  const counts = () => rpc('notifications.count', {});
  const turn = async (prompt, wait = true) => cmd('runTurn', { prompt, sessionId: null, cwd: await page.evaluate(() => window.__home), backend: 'fake', mode: 'default' }, wait);
  const until = (fn, label, ms = 15000) => page.waitForFunction(fn, null, { timeout: ms }).catch(() => { throw Error(label); });

  // ---- 空
  check(await bell.getAttribute('aria-label') === '通知' && await page.locator('#notifBell .bell-badge').count() === 0, 'with nothing unread the bell has no count and is named 通知');
  await bell.click();
  await panel.waitFor();
  check(await page.locator('#notifPanel .nempty').textContent() === '新しい通知はありません', 'an empty list says 新しい通知はありません');
  check(await bell.getAttribute('aria-expanded') === 'true' && await panel.getAttribute('role') === 'dialog', 'the bell reports that it opened a dialog');
  await page.keyboard.press('Escape');
  check(await panel.isHidden() && await page.evaluate(() => document.activeElement?.id) === 'notifBell', 'Esc closes the panel and returns focus to the bell');

  // ---- 通知を作る（別の会話。いま見ているのは新しい会話）: 完了 → 失敗 → 決着した承認 → 決着していない承認 → bot の @あなた
  await turn('echo:ログイン画面のバグ調査');
  await turn('fail');
  await turn('ask', false);
  await until(() => document.querySelector('#notifBell .bell-badge'), 'the bell gets a count when notifications arrive');
  // ask は承認で止まる。そのままにして、もう 1 本の ask は答えて決着させる
  const waitRows = async () => (await rpc('notifications.list', { filter: 'wait' })).items;
  let waits = [];
  for (let i = 0; i < 100 && waits.length < 1; i++) { waits = await waitRows(); if (!waits.length) await page.waitForTimeout(100); }
  check(waits.length === 1 && waits[0].resolvedAt === undefined, 'an approval that is waiting shows up as needs-you');
  const owl = await rpc('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake' });
  const dev = await rpc('channels.create', { name: 'release-ci', members: [owl.id] });
  await rpc('channels.post', { channelId: dev.id, text: '@Owl echo:@あなた 負荷試験を回してください' });
  for (let i = 0; i < 150 && (await counts()).unread < 4; i++) await page.waitForTimeout(100);
  const c = await counts();
  check(c.unread >= 4 && c.waiting === 1, `the counts: ${JSON.stringify(c)}`);
  const badge = page.locator('#notifBell .bell-badge');
  check((await badge.textContent()).includes('◆') && (await badge.textContent()).includes(String(c.unread)), 'the badge shows ◆ (needs you first) and the unread count');
  check((await bell.getAttribute('aria-label')).includes(`未読 ${c.unread} 件`) && (await bell.getAttribute('aria-label')).includes('あなた待ち'), 'the bell name carries the count and 「あなた待ちあり」');

  // ---- 面: 行・絞り込み
  await bell.click();
  await panel.waitFor();
  await until(() => document.querySelectorAll('#notifPanel .nrow').length >= 4, 'rows are listed');
  check(await page.evaluate(() => document.activeElement?.className) === 'nlist', 'opening the panel puts focus on the list');
  const kinds = await rows.evaluateAll((ns) => ns.map((n) => ({ t: n.querySelector('.nt').textContent, m: n.querySelector('.nm').textContent, unread: n.classList.contains('unread'), k: n.querySelector('.nk').textContent })));
  check(kinds[0].t.includes('@あなた') && kinds[0].m.startsWith('#release-ci') && kinds[0].unread, 'the newest row is the @you mention with #channel › thread and a blue dot');
  check(kinds.some((r) => r.t === 'エージェントが承認を待っています' && r.k === '◆') && kinds.some((r) => r.t.includes('失敗') && r.k === '✕' || r.k.trim() === ''), 'a needs-you row and a failed row are there');
  check(await page.locator('#notifPanel .nrow .udot').count() >= 4, 'unread rows have a blue dot');
  check(await panel.evaluate((n) => getComputedStyle(n).position) === 'fixed' && !(await panel.evaluate((n) => n.classList.contains('sheet'))), 'a wide window shows the popover, not the sheet');
  await page.locator('#notifPanel .nseg button', { hasText: 'あなた待ち' }).click();
  await until(() => document.querySelectorAll('#notifPanel .nrow').length === 1, 'filter: needs-you');
  check(true, 'the needs-you filter shows only needs-you rows');
  await page.locator('#notifPanel .nseg button', { hasText: '@あなた' }).click();
  await until(() => document.querySelectorAll('#notifPanel .nrow').length === 1 && document.querySelector('#notifPanel .nrow .nt').textContent.includes('@あなた'), 'filter: mention');
  check(true, 'the @you filter shows only mentions');
  await page.locator('#notifPanel .nseg button', { hasText: 'すべて' }).first().click();
  await until(() => document.querySelectorAll('#notifPanel .nrow').length >= 4, 'filter: all');

  // ---- キー: ↑↓ で行を動かし、Enter で飛ぶ。会話の発言へ（輪）
  const list = page.locator('#notifPanel .nlist');
  await list.focus();
  const active0 = await list.getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  check(await list.getAttribute('aria-activedescendant') !== active0, 'ArrowDown moves the active row');
  await page.keyboard.press('ArrowUp');
  check(await list.getAttribute('aria-activedescendant') === active0, 'ArrowUp moves it back');
  const doneIndex = await rows.evaluateAll((ns) => ns.findIndex((n) => n.querySelector('.nt').textContent.includes('完了')));
  check(doneIndex >= 0, 'a completed row exists');
  for (let i = 0; i < doneIndex; i++) await page.keyboard.press('ArrowDown');
  const beforeUnread = (await counts()).unread;
  await page.keyboard.press('Enter');
  check(await panel.isHidden(), 'Enter closes the panel');
  await page.locator('.m.ai .body').first().waitFor({ timeout: 15000 });
  const flashed = await page.waitForFunction(() => document.querySelector('.m.ai .body.flash, .m.ai.flash'), null, { timeout: 5000 }).then(() => true, () => false);
  check(flashed, 'the message that the notification points at gets the flash ring');
  await page.waitForFunction(() => !document.querySelector('.m.ai .body.flash, .m.ai.flash'), null, { timeout: 3000 });
  check(true, 'the flash ends within about 1.2 seconds');
  check((await counts()).unread === beforeUnread - 1, 'the opened notification is read (the count goes down by one)');

  // ---- チャンネルのスレッドの投稿へ（輪）。動きを減らす設定では明滅しない
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bell.click();
  await panel.waitFor();
  await until(() => document.querySelectorAll('#notifPanel .nrow').length >= 1, 'rows again');
  await page.locator('#notifPanel .nrow', { hasText: '@あなた と書きました' }).click();
  await page.locator('#chThread .post[data-post-id]').first().waitFor({ timeout: 15000 });
  const postId = await page.evaluate(async () => (await window.__rpc('notifications.list', { filter: 'mention' })).items[0].target.postId);
  const ring = await page.waitForFunction((id) => { const n = document.querySelector(`#chThread .post[data-post-id="${id}"].flash`); return n ? getComputedStyle(n).animationName : null; }, postId, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
  check(ring === 'none', `with reduced motion the post is marked without blinking (animation: ${ring})`);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check(await page.locator('#tabChannels').getAttribute('aria-selected') === 'true', 'the Channels tab is shown after jumping to a post');

  // ---- すべて既読・開いている間に届く通知
  await bell.click();
  await panel.waitFor();
  await page.locator('#notifPanel .nhead .btn').click();
  await until(() => !document.querySelector('#notifPanel .nrow.unread') && !document.querySelector('#notifBell .bell-badge'), 'read all');
  check((await counts()).unread === 0, 'すべて既読 clears the unread dots and the bell count');
  const before = await rows.count();
  await turn('fail');
  await until((n) => document.querySelectorAll('#notifPanel .nrow').length > n, 'a new notification appears while the panel is open', 8000).catch(() => {});
  for (let i = 0; i < 80 && (await rows.count()) <= before; i++) await page.waitForTimeout(100);
  check((await rows.count()) === before + 1, 'a notification that arrives while the panel is open is added to the list');
  await page.mouse.click(900, 400);
  check(await panel.isHidden(), 'pressing outside closes the panel');

  // ---- 360 幅: 下からのシート
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  await page.locator('#chThreadOpenSidebar').click();   // スレッドだけが見えている狭い画面の「脇を開く」
  await page.waitForTimeout(400);
  await bell.click();
  await panel.waitFor();
  check(await panel.evaluate((n) => n.classList.contains('sheet')) && await page.locator('#notifVeil').isVisible(), 'a narrow window shows the bottom sheet with a veil');
  await page.waitForTimeout(400);   // 下からせり上がる動きが終わるのを待つ
  const box = await panel.boundingBox();
  check(Math.abs(box.x) < 1 && Math.abs(box.width - 360) < 1 && Math.abs(box.y + box.height - 780) < 2, 'the sheet is as wide as the window and sits at the bottom');
  const rowH = await rows.first().evaluate((n) => n.getBoundingClientRect().height);
  check(rowH >= 44, `rows are at least 44px tall for fingers (${rowH})`);
  await page.keyboard.press('Escape');
  check(await panel.isHidden() && await page.locator('#notifVeil').isHidden(), 'Esc closes the sheet and the veil');
  await bell.click();
  await panel.waitFor();
  await page.locator('#notifVeil').click({ position: { x: 180, y: 40 } });
  check(await panel.isHidden(), 'pressing the veil closes the sheet');
  await bell.click();
  await rows.first().click();
  check(await panel.isHidden(), 'a row opens its target and closes the sheet');

  return results.map((r) => `ok - ${r}`).join('\n');
}
