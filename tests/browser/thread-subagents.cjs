// playwright-cli run-code --filename=tests/browser/thread-subagents.cjs
// スレッドのサブエージェント（bot が委譲した子。docs/design-system.md「バックグラウンド」「委譲カード」、ADR 0139）:
// 入力欄の上のチップ（子がいなければ出さない）・押すと bot ごとに子を並べる一覧・子の会話を開ける・作業ログの委譲カードが Chats と同じ形。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7438, token thread-subagents-test):
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_FAKE_USAGE=1 AGENT_HOST_GIT_SNAPSHOTS=off AGENT_HOST_WORKTREES=off AGENT_HOST_LOCALE=ja AGENT_HOST_TOKEN=thread-subagents-test AGENT_HOST_PORT=7438 AGENT_HOST_DATA=<一時の置き場> node core/server.mjs
// Never run against live data. bot・チャンネル・スレッドは本物の操作（bots.create・channels.post ほか）で作り、fake の bot が ply_delegate を呼び、fake の子が走る。
async page => {
  const URL = 'http://127.0.0.1:7438/?token=thread-subagents-test';
  const results = [];
  const check = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); results.push(label); };
  const sleep = (ms) => page.waitForTimeout(ms);
  const until = async (fn, label, ms = 40000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(120); }
    throw Error('timeout: ' + label + ' ' + JSON.stringify(last ?? null).slice(0, 300));
  };

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => {
    if (window.__saWrapped) return;
    window.__saWrapped = true;
    window.__sockets = [];
    window.__calls = new Map();
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          try {
            const m = JSON.parse(e.data);
            const call = m.kind === 'response' ? window.__calls.get(m.id) : null;
            if (call) { window.__calls.delete(m.id); if (m.ok) call.res(m.result); else call.rej(new Error(String(m.error))); return; }
          } catch {}
          return fn(e);
        });
      }
      get onmessage() { return super.onmessage; }
    };
    window.__rpc = (op, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
    });
  });
  await page.goto(URL);
  await page.getByRole('button', { name: 'あとで', exact: true }).click({ timeout: 4000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);

  // ---- 準備: bot 2 体・チャンネル・スレッド（bot が fake の子を 3 つ委譲する。2 つは動いたまま、1 つは終わる）
  const bots = (await rpc('bots.list')).bots ?? [];
  const owl = bots.find((b) => b.name === 'Owl') ?? await rpc('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
  const lynx = bots.find((b) => b.name === 'Lynx') ?? await rpc('bots.create', { name: 'Lynx', icon: '🐺', backend: 'fake', persona: '負荷試験が得意' });
  const ch = (await rpc('channels.list')).channels?.find((c) => c.name === 'release-ci') ?? await rpc('channels.create', { name: 'release-ci', purpose: 'リリースの CI を見張る', members: [owl.id, lynx.id] });
  const turns = async (threadId) => (await rpc('channels.read', { channelId: ch.id, threadId })).posts.filter((p) => p.turn && p.state === 'done');
  const delegate = (title, task, kind = 'mechanical') => `ply:${JSON.stringify({ name: 'ply_delegate', arguments: { kind, backend: 'fake', task, title } })}`;
  const A = await rpc('channels.post', { channelId: ch.id, text: `@Owl ${delegate('CI の結果を待つ', 'active-shell')}` });
  await until(async () => (await turns(A.id)).length >= 1, 'owl first turn');
  await rpc('channels.post', { channelId: ch.id, threadId: A.id, text: `@Owl ${delegate('リリースノートを下書きする', 'ok')}` });
  await until(async () => (await turns(A.id)).length >= 2, 'owl second turn');
  await rpc('channels.post', { channelId: ch.id, threadId: A.id, text: `@Lynx ${delegate('負荷試験を回す', 'active-shell', 'investigate')}` });
  await until(async () => (await turns(A.id)).length >= 3, 'lynx turn');
  const B = await rpc('channels.post', { channelId: ch.id, text: '@Lynx ok' });   // 委譲しないスレッド
  await until(async () => (await turns(B.id)).length >= 1, 'plain thread turn');

  await page.locator('#tabChannels').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('#chFeed .post .thread-summary').first().waitFor();
  const open = async (id) => {
    await page.locator(`#chFeed .post[data-post-id="${id}"] .thread-summary`).click();
    await page.locator('#chThread .post').first().waitFor();
    await sleep(2500);
  };

  // ================================================================ 子のいるスレッド
  await open(A.id);
  const chip = page.locator('#chThread .th-subs button.bg-chip');
  await until(async () => (await chip.count()) === 1 && await page.locator('#chThread .th-subs').isVisible(), 'chip visible');
  const place = await page.evaluate(() => {
    const r = (s) => document.querySelector(s)?.getBoundingClientRect();
    return { chip: r('#chThread .th-subs'), composer: r('#chThread .ch-composer') ?? r('#chThreadComposer') };
  });
  check(place.chip && place.composer && place.chip.bottom <= place.composer.top + 1 && place.chip.right > place.composer.right - 40, 'the subagent chip is at the right end just above the thread composer', place);
  check(/一覧を開く/.test(await chip.getAttribute('aria-label')) && await chip.getAttribute('aria-controls') === 'workDialog', 'the chip has the same spoken name as the Chats chip and controls the work dialog');

  // ---- 作業ログの委譲カードは Chats と同じ形（「委譲」・題・状態の印と経過・子の会話への矢印）
  for (const d of await page.locator('#chThread details.th-worklog').all()) await d.evaluate((n) => { n.open = true; });
  await sleep(600);
  const card = await page.evaluate(() => {
    const c = document.querySelector('#chThread .tc[data-tool$="ply_delegate"]');
    return c && { delegate: c.classList.contains('tc-delegate'), label: c.querySelector('.tc-label')?.textContent, main: c.querySelector('.tc-main')?.textContent,
      go: Boolean(c.querySelector(':scope > .tc-go')), logo: Boolean(c.querySelector('.rt-target-logo')), state: Boolean(c.querySelector('.tc-res .run, .tc-res svg, .tc-res .tc-el, .tc-res .tc-when')),
      server: Boolean(c.querySelector('.tc-server')) };
  });
  check(card && card.delegate && card.label === '委譲' && card.main && card.go && card.logo && !card.server, 'a delegate tool card in the thread is drawn like the Chats delegate card', card);
  await until(async () => page.locator('#chThread .tc-delegate .tc-res .tc-el, #chThread .tc-delegate .tc-res .run').count(), 'running mark on the card');

  // ---- 一覧: bot ごと・題・状態・経過
  await chip.click();
  await until(async () => page.evaluate(() => document.getElementById('workDialog').open), 'dialog open');
  await sleep(600);
  const modal = await page.evaluate(() => ({
    title: document.getElementById('workTitle').textContent,
    groups: [...document.querySelectorAll('#workList .bg-bot')].map((n) => n.textContent.replace(/^\S*(?=Lynx|Owl)/, '')),
    rows: [...document.querySelectorAll('#workList .bg-row')].map((r) => ({ name: r.querySelector('.bg-row-name')?.textContent, time: r.querySelector('.bg-row-time')?.textContent, mark: Boolean(r.querySelector('.run, svg')) })),
    count: document.getElementById('workCount').textContent,
  }));
  check(modal.title === 'サブエージェント' && modal.groups.includes('Owl') && modal.groups.includes('Lynx') && modal.groups.length === 2, 'the list is grouped by bot', modal);
  check(modal.rows.length === 3 && modal.rows.every((r) => r.name && r.time && r.mark), 'each child shows a mark, its title and the elapsed time / done time', modal);
  check(/実行中 2 · 完了 1/.test(modal.count), 'the header counts running and done children', modal.count);
  await page.locator('#workList .bg-row').first().click();
  await until(async () => page.locator('#workBody .m, #workBody .mw').count(), 'child conversation in the detail');
  check(await page.locator('#workHead .bg-open').count() === 1, 'the detail can open the child conversation');

  // ---- 子の会話を開ける（Chats へ移る）
  await page.locator('#workHead .bg-open').click();
  await until(async () => page.evaluate(() => !document.getElementById('workDialog').open && !document.body.classList.contains('channels')), 'left Channels for the child chat');
  check(await page.locator('#parentChatEntry').isVisible(), 'the child conversation is opened in Chats (with the way back to the parent)');

  // ---- カードの矢印から: スレッドの一覧で、その子を選んだ状態で開く
  await page.locator('#tabChannels').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('#chThread .post').first().waitFor();
  await sleep(1500);
  for (const d of await page.locator('#chThread details.th-worklog').all()) await d.evaluate((n) => { n.open = true; });
  const go = page.locator('#chThread .tc-delegate > .tc-go').first();
  await go.scrollIntoViewIfNeeded();
  await go.click({ force: true });
  await until(async () => page.evaluate(() => document.getElementById('workDialog').open), 'dialog from the card arrow');
  const selected = await page.evaluate(() => ({ title: document.getElementById('workTitle').textContent, current: Boolean(document.querySelector('#workList .bg-row[aria-current]')) }));
  check(selected.title === 'サブエージェント' && selected.current, 'the card arrow opens the thread list with that child selected', selected);
  await page.keyboard.press('Escape');

  // ================================================================ 子のいないスレッド
  await open(B.id);
  const none = await page.evaluate(() => ({ hidden: document.querySelector('#chThread .th-subs')?.hidden, shown: document.querySelectorAll('#chThread .th-subs .bgc-slot, #chThread .th-subs .bgc-done').length }));
  check(none.hidden === true && none.shown === 0, 'a thread whose bots delegated nothing shows no subagent chip', none);

  // ================================================================ Chats のダイアログは従来どおり（題は「バックグラウンド」）
  await page.locator('#tabChats').click();
  const entry = page.locator('#workEntryButton');
  if (await entry.isVisible().catch(() => false)) {
    await entry.click();
    await until(async () => page.evaluate(() => document.getElementById('workDialog').open), 'Chats dialog');
    const chats = await page.evaluate(() => ({ title: document.getElementById('workTitle').textContent, groups: document.querySelectorAll('#workList .bg-bot').length }));
    check(chats.title === 'バックグラウンド' && chats.groups === 0, 'the Chats chip still opens the plain Background list (no bot groups)', chats);
    await page.keyboard.press('Escape');
  }
  return results;
}
