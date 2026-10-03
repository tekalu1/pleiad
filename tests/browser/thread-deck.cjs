// playwright-cli run-code --filename=tests/browser/thread-deck.cjs
// スレッドと空間モデル（docs/design-system.md「スレッドの空間モデル」、ADR 0098）: 3 つの幅・右パネルの開閉・✕・動き（と動きを減らす設定）・
// スクロール位置と下書きの保持・ほかのスレッドへの切り替え・承認のカード・［止める］と書き足し・道具の行・可視化のインライン・見出しの出し分け。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7436, token thread-deck-test):
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_FAKE_USAGE=1 AGENT_HOST_FAKE_SLOW_STEER=1 AGENT_HOST_GIT_SNAPSHOTS=off AGENT_HOST_WORKTREES=off AGENT_HOST_LOCALE=ja AGENT_HOST_TOKEN=thread-deck-test AGENT_HOST_PORT=7436 AGENT_HOST_DATA=<一時の置き場> node core/server.mjs
// Never run against live data. bot・チャンネル・スレッドは本物の操作（bots.create・channels.post ほか）で作り、fake の bot が本当に走る。
// bot の途中の様子（本文の差し替え・提示）だけは、サーバーから届く形の出来事（channelPost）をページの WebSocket へ流して確かめる。
async page => {
  const URL = 'http://127.0.0.1:7436/?token=thread-deck-test';
  const results = [];
  const check = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  const sleep = (ms) => page.waitForTimeout(ms);
  const until = async (fn, label, ms = 20000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(80); }
    throw Error('timeout: ' + label + ' ' + JSON.stringify(last ?? null).slice(0, 300));
  };

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  // ---- 準備: WebSocket を包む（出来事を流せる・invoke と WS コマンドを呼べる・送ったコマンドを控える）
  await page.addInitScript(() => {
    if (window.__tdWrapped) return;
    window.__tdWrapped = true;
    window.__sockets = [];
    window.__sent = [];
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
      send(d) {
        try { const m = JSON.parse(d); if (m.kind === 'command') window.__sent.push({ command: m.command, args: m.args }); } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (event) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event }) }));
    const call = (command, args) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command, id, args }));
    });
    window.__rpc = (op, args = {}) => call('invoke', { op, args });
    window.__cmd = call;
    // deck の状態が替わるたびの記録（動いたか・切り替えで動かなかったかを見る）
    window.__moving = 0;
    new MutationObserver((records) => {
      for (const r of records) if (r.target.classList?.contains('moving') && !(r.oldValue ?? '').includes('moving')) window.__moving++;
    }).observe(document, { attributes: true, attributeFilter: ['class'], attributeOldValue: true, subtree: true });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const deliver = (event) => page.evaluate((e) => window.__deliver(e), event);
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);
  const cmd = (command, args) => page.evaluate(([c, a]) => window.__cmd(c, a), [command, args]);

  // ---- 準備: bot とチャンネルとスレッド（本物の操作で）
  const bots = (await rpc('bots.list')).bots ?? [];
  const owl = bots.find((b) => b.name === 'Owl') ?? await rpc('bots.create', { name: 'Owl', icon: '🦉', backend: 'fake', persona: '調べ物が得意' });
  const lynx = bots.find((b) => b.name === 'Lynx') ?? await rpc('bots.create', { name: 'Lynx', icon: '🐺', backend: 'fake', persona: '負荷試験が得意' });
  const chName = 'checkout-perf';
  const ch = (await rpc('channels.list')).channels?.find((c) => c.name === chName) ?? await rpc('channels.create', { name: chName, purpose: 'p95 を 300ms 以下に戻す', members: [owl.id, lynx.id] });
  const readThread = (threadId) => rpc('channels.read', { channelId: ch.id, threadId });
  const turnPosts = async (threadId, state) => (await readThread(threadId)).posts.filter((p) => p.turn && (!state || p.state === state));
  const ROOT = '@Owl v2.14.0 から /api/checkout の p95 が 480ms に上がってる。原因を調べて直して';
  const FILE = '/srv/acme-web/src/checkout/promotions.ts';
  const DONE = { steps: [
    { text: '調べて直します。' },
    { tool: 'Bash', input: { command: 'npm run metrics -- --route /api/checkout' }, result: 'p95 480ms', ms: 40 },
    { tool: 'Read', input: { file_path: FILE }, result: 'export async function applyPromotions() {}', ms: 40 },
    { tool: 'Grep', input: { pattern: 'pricing.quote(' }, result: '3 matches', ms: 40 },
    { tool: 'Edit', input: { file_path: FILE, old_string: 'quote(', new_string: 'quoteMany(' }, result: 'ok', ms: 40 },
    { text: `直しました。変えたのは [promotions.ts](${FILE}) です。p95 は 480ms → **296ms**。` },
  ] };
  const ASK = (cmdline) => ({ steps: [
    { text: '本番相当の設定で負荷試験を準備しました。実行には承認が必要です。' },
    { tool: 'Bash', input: { command: cmdline }, ask: true, result: 'done', ms: 40 },
    { text: '回しました。' },
  ] });
  const A = await rpc('channels.post', { channelId: ch.id, text: `@Owl steps:${JSON.stringify(DONE)}` });
  await until(async () => (await turnPosts(A.id, 'done')).length, 'A done');
  await rpc('channels.edit', { channelId: ch.id, postId: A.id, text: ROOT });
  const B = await rpc('channels.post', { channelId: ch.id, text: `@Lynx steps:${JSON.stringify(ASK('npm run bench -- --target prod-like'))}` });
  await until(async () => (await turnPosts(B.id, 'waiting')).length, 'B waiting');
  await rpc('channels.edit', { channelId: ch.id, postId: B.id, text: '@Lynx 修正が入ったら checkout だけもう一度回して。本番相当の設定で' });
  const C = await rpc('channels.post', { channelId: ch.id, text: '@Owl slow' });
  await until(async () => (await turnPosts(C.id, 'working')).length, 'C working');
  await rpc('channels.edit', { channelId: ch.id, postId: C.id, text: '@Owl カートの見積もりを一括にしたい。まず今の呼び出しを洗い出して' });
  // A に返信を足してログを長くする（人の返信。@ が無く作業中の bot も居ないので誰も起こさない）
  for (let i = 0; i < 28; i++) await rpc('channels.post', { channelId: ch.id, threadId: A.id, text: `追加の確認 ${i + 1}: 負荷試験の結果を見て、キャッシュの効き方も確かめたい。` });
  const owlSessionA = (await readThread(A.id)).threads[0].sessions[owl.id];

  // ---- 計測の道具
  const dk = () => page.evaluate(() => {
    const rect = (el) => { const r = el?.getBoundingClientRect(); return r ? { l: r.left, w: r.width, r: r.right } : null; };
    const vis = (el) => (el ? getComputedStyle(el).visibility : null);
    const deck = document.getElementById('chDeck');
    return { deck: deck?.dataset.deck, moving: deck?.classList.contains('moving'), dl: rect(deck), feed: rect(document.getElementById('chFeed')), thread: rect(document.getElementById('chThread')),
      feedVis: vis(document.getElementById('chFeed')), threadVis: vis(document.getElementById('chThread')), panel: document.body.classList.contains('file-preview-open'),
      feedInert: document.getElementById('chFeed')?.inert, threadInert: document.getElementById('chThread')?.inert, vw: innerWidth };
  });
  const settled = () => until(async () => !(await dk()).moving, 'settled');
  const open = async (id) => {   // 流れの要約の行を押して、スレッドを開く（本物の入口）
    await page.locator(`#chFeed .post[data-post-id="${id}"] .thread-summary`).click();
    await page.locator('#chThread .post').first().waitFor();
  };
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

  // ================================================================ 1280 ［流れ｜スレッド］
  await page.locator('#tabChannels').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('#chFeed .post .thread-summary').first().waitFor();
  let s = await dk();
  check(s.deck === 'feed' && near(s.feed.w, s.dl.w) && s.threadVis === 'hidden' && s.threadInert === true, 'with no thread open the feed has the whole window and the thread board is hidden');
  check(await page.locator('#chFeedComposer .ch-row').isVisible(), 'the feed composer is open (not folded) while the feed is alone');
  const feedHead = await page.evaluate(() => ({ inFeed: !!document.querySelector('#chFeed > .top'), title: document.getElementById('channelsPageTitle').textContent }));
  check(feedHead.inFeed && feedHead.title.includes('checkout-perf'), 'the channel heading sits at the head of the feed board');

  await open(A.id);
  await settled();
  s = await dk();
  check(s.deck === 'split' && near(s.feed.w / s.dl.w, 0.4, 0.02) && near(s.thread.w / s.dl.w, 0.6, 0.02) && near(s.thread.l, s.feed.r), 'opening a thread shows [feed 4 | thread 6] side by side');
  check(s.threadVis === 'visible' && s.feedVis === 'visible' && s.threadInert === false, 'both boards are visible and live in split');
  const head = await page.evaluate(() => ({ chan: getComputedStyle(document.querySelector('.th-chan')).display, title: document.querySelector('.th-title').textContent, sep: !!document.querySelector('.th-sep') }));
  check(head.chan === 'none' && head.sep && head.title.startsWith('v2.14.0 から') && !head.title.startsWith('@'), 'while the feed is on the left the heading is just "› thread title" (no channel name, no leading @)');
  check(await page.evaluate(() => document.activeElement?.id === 'chThreadComposerInput'), 'focus goes to the thread composer when a thread opens');
  const lastReplyAt = (await readThread(A.id)).posts.at(-1).at;
  await page.waitForFunction(([cid, at]) => window.__sent.some((c) => c.command === 'invoke' && c.args.op === 'channels.markRead' && c.args.args.channelId === cid && c.args.args.at >= at), [ch.id, lastReplyAt]);
  check(true, 'while you read the thread at the bottom, the channel is marked read up to the last reply (channels.markRead)');
  const fold = await page.evaluate(() => {
    const row = document.querySelector('#chFeedComposer .ch-row');
    return { row: getComputedStyle(row).display, h: document.getElementById('chFeedComposer').getBoundingClientRect().height };
  });
  check(fold.row === 'none' && fold.h < 70, 'the feed composer folds to one line while the thread is open (it opens only when you click it)');
  await page.locator('#chFeedComposerInput').click();
  check(await page.locator('#chFeedComposer .ch-row').isVisible(), 'clicking the folded feed composer opens it');
  await page.locator('#chThreadComposerInput').click();
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#chFeedComposer .ch-row')).display) === 'none', 'it folds again when focus returns to the thread');
  check(await page.locator(`#chFeed .post[data-post-id="${A.id}"][data-open]`).count() === 1, 'the open thread card in the feed is marked as selected');
  const sel = await page.evaluate((id) => { const n = document.querySelector(`#chFeed .post[data-post-id="${id}"]`); const b = getComputedStyle(n).backgroundColor; const bar = getComputedStyle(n, '::before'); return { bg: b, bar: bar.content, w: bar.width }; }, A.id);
  check(sel.bar === '""' && sel.w === '3px' && sel.bg !== 'rgba(0, 0, 0, 0)', 'the selected card has a background and a thin bar on the left');

  // ---- スレッドの中身
  const body = await page.evaluate(() => ({
    posts: [...document.querySelectorAll('#chThread .post')].map((n) => n.dataset.postId),
    rdiv: document.querySelector('.th-rdiv').textContent,
    open: [...document.querySelectorAll('#chThread .th-open')].length,
  }));
  check(body.posts[0] === A.id && body.rdiv === '29 件の返信' && body.open === 0, 'the thread shows the root post first, then the replies, with the reply count (no「会話を開く →」under the reply: the thread is the conversation)');
  await page.waitForFunction(() => document.querySelector('#chThread .th-tools .bundle'));
  const tools = await page.evaluate(() => { const b = document.querySelector('#chThread .th-tools .bundle'); return { n: b.dataset.n, label: b.querySelector('.rhead .mix')?.textContent, same: !!b.bundle }; });
  check(tools.n === '4' && tools.label === 'ツール実行' && tools.same, "the bot's reply carries the same collapsed tools row as Chats (「ツール実行 4」)");
  check(await page.locator('#chThread .th-tools .bundle .hist .hi.hid').count() === 4, 'the tool rows start folded');
  await page.locator('#chThread .th-tools .bundle .rhead').click();
  await page.waitForFunction(() => document.querySelectorAll('#chThread .th-tools .bundle .hist .hi:not(.hid)').length === 4);
  check(true, 'clicking the tools row opens all the tool calls');
  await sleep(700);   // まとまりが開く間（約 540ms）は、見出しの位置を保つためにスクロールを直す。落ち着いてから測る
  const band = await page.locator('.th-band').textContent();
  check(band.includes('このスレッドで 1.2k トークン'), 'the band quietly shows the tokens used in this thread');
  const turnA = (await turnPosts(A.id))[0];
  check(await page.locator(`#chThread [data-post-id="${turnA.id}"] a.file-link, #chThread [data-post-id="${turnA.id}"] .post-body a`).count() >= 1, 'a file path in the reply is a link');
  check(await page.locator('#chThread .post-tool.reply').first().evaluate((n) => getComputedStyle(n).display) === 'none', 'the reply tool is not shown inside the thread (the composer is the reply)');

  // ---- 右パネルのリンクの基準は、そのスレッドの bot の会話
  const s0 = await dk();
  const logBox = await page.evaluate(() => { const l = document.querySelector('#chThread .th-log'); l.scrollTop = Math.min(300, l.scrollHeight); return { top: l.scrollTop, max: l.scrollHeight - l.clientHeight }; });
  check(logBox.max > 200 && logBox.top > 100, 'the thread log is long enough to scroll');
  await page.locator('#chThreadComposerInput').click();
  await page.keyboard.type('下書きです');
  await page.evaluate(() => { window.__nodes = { thread: document.getElementById('chThread'), log: document.querySelector('#chThread .th-log'), input: document.getElementById('chThreadComposerInput') }; window.__moving = 0; });
  const scrollBefore = await page.evaluate(() => document.querySelector('#chThread .th-log').scrollTop);

  // ================================================================ 右パネルを開く → ［スレッド｜道具］
  // 読んでいる位置を動かさないよう、リンクは画面へ送らずに押す（Playwright の click は見えるところまでスクロールする）
  await page.locator(`#chThread [data-post-id="${turnA.id}"] .post-body a`).first().evaluate((n) => n.click());
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  const mid = await dk();
  check(mid.moving === true && mid.deck === 'solo' && mid.thread.l > mid.dl.l + 40, 'opening the right panel slides the thread board left (it is mid-motion a moment later)');
  await settled();
  s = await dk();
  check(s.panel && s.deck === 'solo' && near(s.thread.l, s.dl.l) && near(s.thread.w, s.dl.w), 'the right panel open → the thread alone fills the window and the tool panel sits to its right');
  check(s.feedVis === 'hidden' && s.feedInert === true && s.feed.r <= s.dl.l + 2, 'the feed slid out to the left and is hidden');
  const crumb = await page.evaluate(() => ({ chan: getComputedStyle(document.querySelector('.th-chan')).display, text: document.querySelector('.th-crumb').textContent.replace(/\s+/g, '') }));
  check(crumb.chan !== 'none' && crumb.text.startsWith('#checkout-perf›'), 'with the thread alone the heading is "# channel › thread title"');
  const kept = await page.evaluate((before) => ({ same: window.__nodes.thread === document.getElementById('chThread') && window.__nodes.log === document.querySelector('#chThread .th-log') && window.__nodes.input === document.getElementById('chThreadComposerInput'),
    top: window.__nodes.log.scrollTop, before, value: window.__nodes.input.value }), scrollBefore);
  check(kept.same && near(kept.top, kept.before, 80) && kept.value === '下書きです', 'sliding keeps the very same DOM: the scroll position stays (only text re-wrapping moves it a little) and the draft is unchanged', kept);
  check(await page.evaluate(() => window.__moving) >= 1, 'the slide is the deck mid-motion state (transform), not a rebuild');
  const fetched = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/file-preview?')));
  check(fetched.some((n) => n.includes(`sessionId=${owlSessionA}`)), "the right panel works from the thread bot's conversation (cwd basis)", fetched);
  await page.locator('#filePreview .file-preview-actions button').last().click();   // 右パネルを閉じる
  await settled();
  s = await dk();
  check(!s.panel && s.deck === 'split' && near(s.feed.w / s.dl.w, 0.4, 0.02) && s.feedVis === 'visible' && s.feedInert === false, 'closing the right panel slides the window back to [feed | thread]');
  const kept2 = await page.evaluate((before) => ({ same: window.__nodes.thread === document.getElementById('chThread') && window.__nodes.input === document.getElementById('chThreadComposerInput'), top: window.__nodes.log.scrollTop, before, value: window.__nodes.input.value }), scrollBefore);
  check(kept2.same && near(kept2.top, kept2.before, 80) && kept2.value === '下書きです', 'and the scroll position and draft are still the same after coming back', kept2);

  // ================================================================ ほかのスレッドへ（板は動かさず中身だけ入れ替える）
  await page.evaluate(() => { window.__moving = 0; });
  const leftBefore = (await dk()).thread.l;
  await open(B.id);
  await sleep(250);
  s = await dk();
  const swapped = await page.evaluate(() => ({ title: document.querySelector('.th-title').textContent, same: window.__nodes.thread === document.getElementById('chThread'), moving: window.__moving,
    marks: [...document.querySelectorAll('#chFeed .post[data-open]')].map((n) => n.dataset.postId), draft: document.getElementById('chThreadComposerInput').value }));
  check(s.deck === 'split' && near(s.thread.l, leftBefore) && swapped.same && swapped.moving === 0, 'picking another thread in the feed keeps the board still (no motion) and only swaps the contents');
  check(swapped.title.startsWith('修正が入ったら') && swapped.marks.join() === B.id, 'the heading follows and the selected card moves to the other thread');
  check(swapped.draft === '', "each thread keeps its own draft (A's draft is not carried to B)");
  await open(A.id);
  await page.waitForFunction(() => document.getElementById('chThreadComposerInput').value === '下書きです');
  check(true, "going back to the first thread brings its draft back");

  // ================================================================ 承認のカード（B のスレッド）
  await open(B.id);
  const card = page.locator('#chThread .th-perms .mw .card');
  await card.first().waitFor({ timeout: 8000 });
  const cardInfo = await page.evaluate(() => ({ head: document.querySelector('#chThread .th-perms .card-head')?.textContent, buttons: [...document.querySelectorAll('#chThread .th-perms .card-actions button')].map((b) => b.textContent.trim()),
    band: document.querySelector('.th-band')?.textContent, stop: !!document.querySelector('.th-stop') }));
  check(cardInfo.head.includes('承認を待っている') && cardInfo.head.includes('Bash') && cardInfo.buttons.includes('許可') && cardInfo.buttons.includes('拒否'), 'a thread waiting for approval shows the same approval card as Chats, inside the thread');
  check(cardInfo.band.includes('Lynx があなたを待っています') && cardInfo.stop, 'the band says who waits for you and offers 止める');
  await page.locator('#chThread .th-perms .card-actions button', { hasText: '許可' }).last().click();
  await page.waitForFunction(() => document.querySelector('#chThread .th-perms .mw.done, #chThread .th-perms .card.done'));
  const resolved = await page.evaluate(() => window.__sent.filter((c) => c.command === 'resolvePermission').length);
  check(resolved === 1, 'pressing 許可 in the thread sends the same resolvePermission command');
  await until(async () => (await turnPosts(B.id, 'done')).length, 'B done after approval');
  await page.waitForFunction(() => /回しました。/.test(document.getElementById('chThread').textContent));
  check(true, 'the turn continues after approval and the reply lands in the thread');
  // 別の画面（ここでは WS コマンド）で答えた承認のカードは外れる
  const B2 = await rpc('channels.post', { channelId: ch.id, text: `@Lynx steps:${JSON.stringify(ASK('npm run bench -- --target staging'))}` });
  await until(async () => (await turnPosts(B2.id, 'waiting')).length, 'B2 waiting');
  await rpc('channels.edit', { channelId: ch.id, postId: B2.id, text: '@Lynx staging でも回して' });
  await open(B2.id);
  await card.first().waitFor({ timeout: 8000 });
  const pendingId = await page.evaluate(() => [...document.querySelectorAll('#chThread .th-perms .mw')].length);
  check(pendingId === 1, 'the second approval card shows up');
  const running = await cmd('running');
  const perm = running.permissions.find((p) => !p.relay);
  await cmd('resolvePermission', { id: perm.id, allow: true });
  await page.waitForFunction(() => document.querySelectorAll('#chThread .th-perms .mw').length === 0, null, { timeout: 8000 });
  check(true, 'an approval answered elsewhere (another screen) removes the card from the thread');

  // ================================================================ 作業中: 書き足し・［止める］
  await open(C.id);
  await page.waitForFunction(() => document.querySelector('.th-stop'));
  check(await page.locator('#chThreadComposerInput').getAttribute('placeholder').then((p) => p.includes('作業中でも Owl に届きます')), 'the thread composer says it reaches the working bot (steer)');
  await page.locator('#chThreadComposerInput').click();
  await page.keyboard.type('途中の書き足し');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#chThread .post-body')].some((n) => n.textContent.includes('途中の書き足し')));
  check(await page.evaluate(() => document.getElementById('chThreadComposerInput').value) === '' && !!(await page.locator('.th-stop').count()), 'a reply typed while the bot works is posted (steer) and the bot keeps working');
  const steered = (await readThread(C.id)).posts.find((p) => p.text === '途中の書き足し');
  check(steered?.author.kind === 'human' && steered.threadId === C.id, 'the reply is saved in the thread through channels.post');
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'edit', post: { ...(await turnPosts(C.id))[0], state: 'working', text: '洗い出します。\n\n- [x] cart サービスの呼び出しを数える\n- [x] pricing.quote() を探す\n- [ ] 一括見積もりの形を決める\n- [ ] 移行する', editedAt: Date.now() } });
  const ck = await page.evaluate(() => ({ items: [...document.querySelectorAll('#chThread ul.ck li')].map((li) => li.className), run: document.querySelectorAll('#chThread ul.ck li.cur .run').length, text: document.querySelector('#chThread ul.ck li').textContent }));
  check(ck.items.join() === 'done,done,cur,todo' && ck.run === 1 && ck.text.trim() === 'cart サービスの呼び出しを数える', 'the progress checklist is drawn with ✓ for done, the arc for the current step and rings for the rest');
  await page.locator('.th-stop').click();
  await page.waitForFunction(() => document.querySelector('.th-band')?.textContent.includes('止めました'));
  const stopped = await readThread(C.id);
  check(stopped.threads[0].stopped?.by.kind === 'human' && stopped.posts.some((p) => p.author.kind === 'system'), '止める stops the thread through channels.stopThread and leaves a system line');
  check(await page.locator('#chThread .th-sys').count() >= 1 && await page.locator('.th-stop').count() === 0, 'the stopped thread shows the system line and no stop button');

  // ================================================================ リアクション・@ の補完・目次・可視化
  await open(A.id);
  const postA = page.locator(`#chThread [data-post-id="${turnA.id}"]`);
  await postA.hover();
  await postA.locator('.post-tool.quick').click();
  await postA.locator('.react-pill[data-emoji="👍"]').waitFor();
  check((await readThread(A.id)).posts.find((p) => p.id === turnA.id).reactions['👍']?.[0]?.kind === 'human', 'a reaction in the thread is saved through channels.react');
  await page.locator('#chThreadComposerInput').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('お願い@');
  const list = page.locator('#chThreadComposer .mention-list');
  await list.waitFor({ state: 'visible' });
  check((await list.locator('li[role=option] .lbl').allTextContents()).join() === 'Owl,Lynx,あなた', 'typing @ in the thread lists the channel members');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.locator('.th-toc').click();
  await page.locator('#filePreview .th-toc-row').first().waitFor();
  const toc = await page.evaluate(() => ({ rows: document.querySelectorAll('#filePreview .th-toc-row').length, deck: document.getElementById('chDeck').dataset.deck }));
  check(toc.rows >= 29 && toc.deck === 'solo', 'the outline entry opens the right panel with the posts of the thread');
  await page.locator('#filePreview .th-toc-search').fill('キャッシュの効き方');
  await page.waitForFunction(() => document.querySelectorAll('#filePreview .th-toc-row').length === 28);
  check(true, 'the outline narrows by search');
  await page.locator('#filePreview .file-preview-actions button').last().click();
  await settled();
  const viz = '<div style="padding:8px"><b>p95 の推移</b></div>';
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'edit', post: { ...turnA, presents: [{ kind: 'visualization', caption: 'p95 の推移', content: viz }], editedAt: Date.now() } });
  await page.locator('#chThread .post-presents .present-visualization').waitFor();
  check(await page.locator('#chThread .post-presents .present-visualization iframe').count() === 1 && await page.locator('dialog[open]').count() === 0, 'a visualization is drawn inline in the thread (no modal)');
  await page.locator('#chThread .post-presents .visualize-expand').evaluate((n) => n.click());   // 操作は枠の上に重なって出る（iframe が押下を受けるので直に押す）
  await page.waitForFunction(() => document.body.classList.contains('file-preview-open') && document.getElementById('chDeck').dataset.deck === 'solo');
  check(true, 'expanding the visualization opens it in the right panel (the thread slides left)');
  await page.locator('#filePreview .file-preview-actions button').last().click();
  await settled();

  // ================================================================ ✕ → 流れが全幅に戻る
  await page.locator('#chThread .th-close').click();
  await settled();
  s = await dk();
  check(s.deck === 'feed' && near(s.feed.w, s.dl.w) && s.threadVis === 'hidden' && s.threadInert === true, 'the ✕ closes the thread and the feed gets the whole window back');
  check(await page.locator('#chFeedComposer .ch-row').isVisible() && await page.locator('#chFeed .post[data-open]').count() === 0, 'the feed composer opens again and no card is selected');
  await open(A.id);
  await page.waitForFunction(() => document.getElementById('chThreadComposerInput').value === '');
  check(true, 'reopening works after the ✕');
  await page.locator('#chThread .th-close').click();
  await settled();

  // ---- チャンネルの入力欄から @ で bot を呼ぶと、新しいスレッドが開く
  await page.locator('#chFeedComposerInput').click();
  await page.keyboard.type('@Owl echo:こんにちは');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.getElementById('chDeck').dataset.deck === 'split');
  await settled();
  await page.waitForFunction(() => [...document.querySelectorAll('#chThread .post-body')].some((n) => n.textContent.trim() === 'こんにちは'));
  check(await page.evaluate(() => document.querySelector('.th-title').textContent) === 'echo:こんにちは', 'a post that @-calls a bot from the feed composer opens its new thread, and the bot answers there');
  await page.locator('#chThread .th-close').click();
  await settled();

  // ================================================================ 動き: 200ms で滑る。動きを減らす設定では切り替えだけ
  const probe = () => page.evaluate((id) => {
    document.querySelector(`#chFeed .post[data-post-id="${id}"] .thread-summary`).click();
    const th = document.getElementById('chThread').getBoundingClientRect().left;
    const feed = document.getElementById('chFeed').getBoundingClientRect().width;
    return { th, feed, moving: document.getElementById('chDeck').classList.contains('moving') };
  }, A.id);
  const m1 = await probe();
  await settled();
  const fin = await dk();
  check(m1.moving && m1.th > fin.thread.l + 100 && m1.feed > fin.feed.w + 100, 'opening a thread slides the thread in from the right and narrows the feed (mid-motion right after the click)');
  await page.locator('#chThread .th-close').click();
  await settled();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.__moving = 0; });
  const m2 = await probe();
  const fin2 = await dk();
  check(!m2.moving && near(m2.th, fin2.thread.l, 1) && near(m2.feed, fin2.feed.w, 1) && await page.evaluate(() => window.__moving) === 0, 'with reduced motion the boards switch without moving');
  await page.locator(`#chThread [data-post-id="${turnA.id}"] .post-body a`).first().click();
  await sleep(150);
  s = await dk();
  check(s.deck === 'solo' && !s.moving && near(s.thread.l, s.dl.l), 'also when the right panel opens (reduced motion)');
  await page.locator('#filePreview .file-preview-actions button').last().click();
  await sleep(150);
  check((await dk()).deck === 'split', 'and when it closes');
  await page.locator('#chThread .th-close').click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settled();

  // ================================================================ 幅: 900px の境目・1100・1600・360
  const deckLeft = (await dk()).dl.l;
  await open(A.id);
  await settled();
  await page.setViewportSize({ width: Math.round(deckLeft) + 900, height: 820 });
  await sleep(150);
  await settled();
  s = await dk();
  check(near(s.dl.w, 900, 1) && s.deck === 'split', 'a window exactly 900px wide still shows both boards');
  await page.setViewportSize({ width: Math.round(deckLeft) + 899, height: 820 });
  await sleep(150);
  await settled();
  s = await dk();
  check(s.dl.w < 900 && s.deck === 'solo' && near(s.thread.w, s.dl.w), 'one pixel narrower shows the thread alone at full width');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.th-chan')).display !== 'none'), 'and the heading shows the channel name again');
  await page.locator('.th-chan').click();
  await settled();
  s = await dk();
  check(s.deck === 'feed' && near(s.feed.w, s.dl.w), 'pressing the channel name returns to the feed');
  await page.setViewportSize({ width: 1100, height: 820 });
  await sleep(150);
  await open(A.id);
  await settled();
  s = await dk();
  check(s.deck === 'solo' && near(s.thread.w, s.dl.w), 'at 1100px the thread opens alone at full width');
  await page.setViewportSize({ width: 1600, height: 900 });
  await sleep(250);
  await settled();
  s = await dk();
  check(s.deck === 'split' && near(s.feed.w / s.dl.w, 0.4, 0.02), 'widening to 1600px brings the feed back beside the thread');
  await page.locator('#chThread .th-close').click();
  await settled();
  await page.setViewportSize({ width: 360, height: 760 });
  await sleep(250);
  await open(A.id);
  await settled();
  const narrow = await page.evaluate(() => {
    const t = document.getElementById('chThread').getBoundingClientRect(), c = document.getElementById('chThreadComposer').getBoundingClientRect();
    return { w: t.width, l: t.left, deck: document.getElementById('chDeck').dataset.deck, side: getComputedStyle(document.getElementById('chThreadOpenSidebar')).display,
      overflow: document.documentElement.scrollWidth > innerWidth || document.querySelector('#chThread .th-log').scrollWidth > document.querySelector('#chThread .th-log').clientWidth,
      composerInView: c.bottom <= innerHeight + 1 && c.left >= 0 && c.right <= innerWidth, git: getComputedStyle(document.querySelector('.th-git')).display };
  });
  check(narrow.deck === 'solo' && near(narrow.w, 360, 1) && narrow.l >= 0 && narrow.side !== 'none', 'at 360px the thread is the whole screen and offers the sidebar button');
  check(!narrow.overflow && narrow.composerInView, 'nothing overflows sideways and the composer stays on screen');
  const tok = await page.evaluate(() => { const n = document.querySelector('#chThread .th-band-tokens'); const r = n.getBoundingClientRect(); return { w: r.width, clipped: n.scrollWidth > n.clientWidth + 1, shown: n.querySelector('.th-tok-num')?.textContent, spoken: n.textContent, title: n.title }; });
  check(tok.shown === '1.2k' && tok.w < 60 && !tok.clipped && tok.spoken === 'このスレッドで 1.2k トークン' && tok.title.includes('入力'), 'at 360px the band shows only 1.2k (never cut off); the words stay for screen readers and the details in the title');
  await page.locator(`#chThread [data-post-id="${turnA.id}"] .post-body a`).first().click();
  await sleep(300);
  const sheet = await page.evaluate(() => { const p = document.getElementById('filePreview').getBoundingClientRect(); return { panel: document.body.classList.contains('file-preview-open'), full: p.width >= innerWidth - 1 && p.height >= innerHeight - 1 }; });
  check(sheet.panel && sheet.full, 'at 360px the right panel is the same full-screen surface as in Chats');
  await page.locator('#filePreview .file-preview-actions button').last().click();
  await sleep(200);
  await page.setViewportSize({ width: 1280, height: 820 });
  await sleep(250);

  return results;
}
