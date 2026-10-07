// playwright-cli run-code --filename=tests/browser/channels.cjs
// チャンネルの流れ（docs/design-system.md「チャンネルの流れ」、モック 02）: 投稿・リアクションの付け外し・@ の補完と提案・スレッドの要約の行・出来事での更新・メモと設定・360 幅。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7433, token channels-test). Never run against live data.
// 書き込みは本物のサーバー（channels.create / post / react / update）を通す。bot の定義（bots.list）はまだ本物の操作が無い版でも動くよう、ページの中で答える。
// bot の投稿・リアクション・スレッドの状態は、サーバーから届く形の出来事（channelPost ほか）をページの WebSocket へ流して確かめる（人は bot の名前で書けないため）。
// 狭い幅（360px）の画面は新しいセッションの + が引き出しの中なので、広い幅で作ってから setViewportSize で狭める。
async page => {
  const URL = 'http://127.0.0.1:7433/?token=channels-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  // ---- 準備: WebSocket を包む（bots.list はページで答える・invoke を呼べる・出来事を流せる）
  await page.addInitScript(() => {
    if (window.__chWrapped) return;
    window.__chWrapped = true;
    window.__sockets = [];
    window.__sent = [];
    window.__calls = new Map();
    window.__bots = [
      { id: 'b_owl', name: 'Owl', icon: '🦉', backend: 'claude', state: 'working' },
      { id: 'b_lynx', name: 'Lynx', icon: '🐺', backend: 'codex', state: 'waiting' },
      { id: 'b_kit', name: 'Kit', icon: '🦊', backend: 'antigravity', state: 'idle' },
    ];
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
        try {
          const m = JSON.parse(d);
          if (m.kind === 'command') {
            window.__sent.push({ command: m.command, args: m.args });
            if (m.command === 'invoke' && m.args?.op === 'bots.list') {
              queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result: { bots: window.__bots } }) })));
              return;
            }
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (event) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event }) }));
    window.__rpc = (op, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
    });
    window.__threadOpened = [];
    document.addEventListener('channels:openthread', (e) => window.__threadOpened.push(e.detail));
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const deliver = (event) => page.evaluate((e) => window.__deliver(e), event);
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);

  // ---- チャンネルを作って開く（メンバーの bot は定義の出来事で足す）
  const name = 'checkout-perf' + String(Date.now()).slice(-5);
  const ch = await rpc('channels.create', { name, purpose: 'チェックアウトの p95 を 300ms 以下に戻す' });
  const members = ['b_owl', 'b_lynx', 'b_kit'];
  await page.locator('#sideOrder [data-order="channel"]').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('#chFeed').waitFor();
  await page.waitForFunction(() => !document.querySelector('#chFeed .ch-loading'));
  await deliver({ type: 'channelsChanged', channel: { ...ch, members } });

  const head = await page.evaluate(() => ({
    title: document.getElementById('channelsPageTitle').textContent,
    purpose: document.querySelector('.ch-purpose')?.textContent,
    avatars: [...document.querySelectorAll('.ch-members .ch-av')].map(n => n.textContent),
    more: !!document.querySelector('.ch-more'),
  }));
  check(head.title === `#${name}`, 'the header shows # and the channel name');
  check(head.purpose?.includes('300ms') && head.more, 'the header shows the purpose and the ⋯ button');
  check(head.avatars.join('') === 'あ🦉🐺🦊', 'the header shows you and the member bots as icons');
  check(await page.locator('.ch-empty-feed').count() === 1, 'an empty channel says so');

  // ---- 投稿（Ctrl+Enter）。Enter は改行
  const input = page.locator('#chFeedComposerInput');
  await input.click();
  await page.keyboard.type('はじめの投稿');
  await page.keyboard.press('Enter');
  await page.keyboard.type('二行目');
  check(await page.locator('.post').count() === 0, 'Enter alone does not post');
  await page.keyboard.press('Control+Enter');
  await page.locator('.post').first().waitFor();
  const first = page.locator('.post').first();
  check((await first.locator('.post-name').textContent()) === 'あなた' && (await first.locator('.post-body').textContent()).includes('二行目'), 'Ctrl+Enter posts as you');
  check(await page.evaluate(() => document.getElementById('chFeedComposerInput').value) === '', 'the composer is cleared after posting');
  check(await page.locator('.ch-empty-feed').count() === 0, 'the empty note goes away');
  const firstId = await first.getAttribute('data-post-id');
  check((await page.locator('.ch-day').count()) === 1 && (await page.locator('.ch-day').textContent()) === '今日', 'a day separator says 今日');

  // ---- 「（編集済み）」は本文が変わったときだけ。同じ本文での書き直し（付帯情報だけ）では出ない
  const sameText = (await rpc('channels.read', { channelId: ch.id })).posts[0].text;
  await rpc('channels.edit', { channelId: ch.id, postId: firstId, text: sameText });
  await page.waitForTimeout(300);
  check(await first.locator('.post-edited').count() === 0, 'editing a post back to the same text does not say 編集済み');

  // ---- リアクション: 👍 で付く・押すと外れる・＋でピッカーから任意の絵文字
  await first.hover();
  await first.locator('.post-tool.quick').click();
  const pill = first.locator('.react-pill[data-emoji="👍"]');
  await pill.waitFor();
  check((await pill.getAttribute('aria-pressed')) === 'true' && (await pill.locator('.react-n').textContent()) === '1', 'the quick reaction adds my 👍');
  const saved = await rpc('channels.read', { channelId: ch.id });
  check(saved.posts[0].reactions['👍']?.[0]?.kind === 'human', 'the reaction is saved on the server');
  await pill.click();
  await page.waitForFunction((id) => !document.querySelector(`[data-post-id="${id}"] .react-pill`), firstId);
  check(true, 'clicking my pill removes it');
  await first.hover();
  await first.locator('.post-tool.add').click();
  await page.locator('#iconPop .egrid button').first().waitFor();
  check(await page.locator('#iconPop').isVisible() && (await page.locator('#iconPop .egrid button').count()) > 50, 'the add button opens the emoji picker');
  const picked = await page.locator('#iconPop .egrid button').nth(5).getAttribute('data-e');
  await page.locator('#iconPop .egrid button').nth(5).click();
  await first.locator(`.react-pill[data-emoji="${picked}"]`).waitFor();
  check(true, 'any emoji from the picker becomes a pill');
  // 札の行の右の ＋ でも付く
  await first.locator('.react-add').click();
  await page.locator('#iconPop .egrid button').first().waitFor();
  await page.keyboard.press('Escape');
  check(await page.locator('#iconPop:not([hidden])').count() === 0, 'Esc closes the picker');
  // 別の端末・bot が付けた分は出来事で来る。触れると誰が付けたか
  await deliver({ type: 'channelReaction', channelId: ch.id, postId: firstId, reactions: { [picked]: [{ kind: 'human' }, { kind: 'bot', botId: 'b_owl' }], '🎉': [{ kind: 'bot', botId: 'b_lynx' }] } });
  const pills = await first.locator('.react-pill').evaluateAll(ns => ns.map(n => ({ e: n.dataset.emoji, n: n.querySelector('.react-n').textContent, mine: n.classList.contains('mine'), title: n.title })));
  check(pills.length === 2 && pills[0].n === '2' && pills[0].mine && pills[0].title.includes('あなた') && pills[0].title.includes('Owl'), 'a channelReaction event updates the pills with who reacted');
  check(!pills[1].mine && pills[1].title.includes('Lynx') && pills[1].title.includes('押すと付ける'), "another's pill is not mine and offers to add");

  // ---- bot の投稿（出来事）。名前・アイコン・バックエンドのロゴ・状態の行・@ の色
  const now = Date.now();
  const botPost = { id: 'p_bot1', channelId: ch.id, threadId: null, author: { kind: 'bot', botId: 'b_owl' }, text: '調べます。`/api/checkout` を見て、**原因**を探します。\n\n- [ ] 計測\n- [ ] 修正', mentions: ['you'], at: now, state: 'working', reactions: {} };
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'add', post: botPost });
  const owl = page.locator('[data-post-id="p_bot1"]');
  await owl.waitFor();
  check((await owl.locator('.post-name').textContent()) === 'Owl' && (await owl.locator('.post-av').textContent()) === '🦉', 'a bot post shows the bot name and icon');
  check(await owl.locator('.post-head .row-be').count() === 1, 'a bot post shows the backend logo');
  check(await owl.locator('.post-state.working .run').count() === 1 && (await owl.locator('.post-state-text').textContent()) === '作業中', 'a working turn shows the arc and 作業中');
  check(await owl.locator('.post-body strong').count() === 1 && await owl.locator('.post-body code').count() === 1, 'the body is rendered as Markdown');
  // 作業中の投稿の更新（本文を置き換える）→ 終了
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'edit', post: { ...botPost, text: '直しました。@あなた 確認してください。', state: 'done', editedAt: now + 1 } });
  check((await owl.locator('.post-body').textContent()).startsWith('直しました') && await owl.locator('.post-state').count() === 0, 'an edit event replaces the text and clears the working state');
  check((await owl.locator('.post-body .mention').textContent()) === '@あなた', 'an @ to you is highlighted');
  check((await owl.locator('.post-edited').count()) === 1, 'an edited post says so');

  // ---- スレッド: 返信が付くと要約の行（本物の返信 → 出来事）。状態は channelThread
  const reply = await rpc('channels.post', { channelId: ch.id, threadId: firstId, text: 'スレッドの返信' });
  const summary = first.locator('.thread-summary');
  await summary.waitFor();
  check((await summary.locator('.ts-count').textContent()) === '💬 1 件の返信', 'a reply adds the thread summary row');
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'add', post: { ...reply, id: 'p_reply2', author: { kind: 'bot', botId: 'b_owl' }, text: '返事', at: Date.now() + 5000 } });
  check((await summary.locator('.ts-count').textContent()) === '💬 2 件の返信', 'a second reply updates the count');
  await deliver({ type: 'channelThread', channelId: ch.id, threadId: firstId, thread: { channelId: ch.id, threadId: firstId, sessions: { b_owl: 's1' }, state: 'working', live: { b_owl: 'working' }, tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, updatedAt: now } });
  check((await summary.locator('.ts-status').textContent()).includes('🦉 Owl 作業中') && await summary.locator('.ts-status .run').count() === 1, 'a working thread shows who is working with the arc');
  await deliver({ type: 'channelThread', channelId: ch.id, threadId: firstId, thread: { channelId: ch.id, threadId: firstId, sessions: { b_owl: 's1' }, state: 'waiting', live: { b_owl: 'waiting' }, tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, updatedAt: now } });
  check((await summary.locator('.ts-status').textContent()).includes('Owl があなたを待っている'), 'a waiting thread says who is waiting for you');
  // 状態はスレッド全体の集計。名前は live から選ぶ（返信した最後の bot ではない）。複数なら並べ、多ければ「ほか n」
  await deliver({ type: 'channelThread', channelId: ch.id, threadId: firstId, thread: { channelId: ch.id, threadId: firstId, sessions: { b_owl: 's1', b_lynx: 's2' }, state: 'working', live: { b_lynx: 'working' }, tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, updatedAt: now } });
  check(!(await summary.locator('.ts-status').textContent()).includes('Owl') && (await summary.locator('.ts-status').textContent()).includes('Lynx 作業中'), 'the working name comes from the bots that are working, not the last bot that replied');
  await deliver({ type: 'channelThread', channelId: ch.id, threadId: firstId, thread: { channelId: ch.id, threadId: firstId, sessions: { b_owl: 's1', b_lynx: 's2' }, state: 'working', live: { b_owl: 'working', b_lynx: 'working' }, tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, updatedAt: now } });
  check((await summary.locator('.ts-status').textContent()).includes('Owl・Lynx 作業中'), 'two working bots are listed together');
  await deliver({ type: 'channelThread', channelId: ch.id, threadId: firstId, thread: { channelId: ch.id, threadId: firstId, sessions: { b_owl: 's1' }, state: 'failed', tokens: { input: 0, output: 0, cached: 0 }, calls: 1, stopped: null, updatedAt: now } });
  check((await summary.locator('.ts-status').textContent()).includes('✕ 失敗'), 'a failed thread shows ✕ 失敗');
  await summary.click();
  const opened = await page.evaluate(() => window.__threadOpened);
  check(opened.length === 1 && opened[0].channelId === ch.id && opened[0].threadId === firstId, 'clicking the summary calls host.openThread(channelId, threadId)');
  await first.hover();
  await first.locator('.post-tool.reply').click();
  check((await page.evaluate(() => window.__threadOpened)).length === 2, 'the reply tool calls host.openThread too');

  // ---- @ の補完
  await input.click();
  await page.keyboard.type('お願い@');
  const list = page.locator('#chFeedComposer .mention-list');
  await list.waitFor({ state: 'visible' });
  let labels = await list.locator('li[role=option] .lbl').allTextContents();
  check(labels.join(',') === 'Owl,Lynx,Kit,あなた', 'typing @ lists the member bots and you');
  check(await list.locator('li[role=option] .row-be').count() === 3, 'bots show their backend logo');
  const hints = await list.locator('li[role=option] .hint').allTextContents();
  check(hints.join(',') === '作業中,あなた待ち', 'a bot that is working or waiting says so');
  await page.keyboard.press('ArrowDown');
  check((await list.locator('li.on .lbl').textContent()) === 'Lynx', 'ArrowDown moves the selection');
  await page.keyboard.press('Enter');
  check(await list.isHidden() && (await page.evaluate(() => document.getElementById('chFeedComposerInput').value)).startsWith('お願い@Lynx '), 'Enter inserts @Lynx and closes the list');
  await page.keyboard.type('@k');
  labels = await list.locator('li[role=option] .lbl').allTextContents();
  check(labels.join(',') === 'Kit', 'typing narrows the candidates');
  await page.keyboard.press('Tab');
  check((await page.evaluate(() => document.getElementById('chFeedComposerInput').value)).includes('@Kit '), 'Tab also commits');
  await page.keyboard.type('@');
  await list.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  check(await list.isHidden(), 'Esc closes the list');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  // メールの形では出さない
  await page.keyboard.type('a@');
  check(await list.isHidden(), 'an @ inside a word (email) does not open the list');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  // 誰も @ していない文には @ の提案（この流れで最後に返事をした bot = Owl）
  const hint = page.locator('#chFeedComposer .ch-hint');
  await page.keyboard.type('負荷を調べて');
  await hint.waitFor({ state: 'visible' });
  check((await hint.textContent()).includes('bot は反応しません') && (await hint.locator('button').textContent()) === '@Owl を呼ぶ', 'a sentence with no @ gets a faint suggestion of the last bot to answer');
  await hint.locator('button').click();
  check((await page.evaluate(() => document.getElementById('chFeedComposerInput').value)).startsWith('@Owl ') && await hint.isHidden(), 'the suggestion button inserts @Owl');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');

  // ---- 出来事で流れが動く: 末尾なら追従・離れていれば「新しい投稿」・削除
  await page.evaluate((id) => { document.__ch = id; }, ch.id);
  await page.evaluate(() => { for (let i = 0; i < 25; i++) window.__deliver({ type: 'channelPost', channelId: document.__ch, op: 'add', post: { id: 'p_fill' + i, channelId: document.__ch, threadId: null, author: { kind: 'bot', botId: 'b_kit' }, text: '行 ' + i + ' 長めの文章で行を埋めます。', mentions: [], at: Date.now() + 10 + i, reactions: {} } }); });
  await page.waitForFunction(() => document.querySelectorAll(".post").length >= 27);
  const atEnd = await page.evaluate(() => { const l = document.querySelector('.ch-log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; });
  check(atEnd, 'new posts keep the log at the bottom when you were at the bottom');
  await page.evaluate(() => { document.querySelector('.ch-log').scrollTop = 0; });
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'add', post: { id: 'p_late', channelId: ch.id, threadId: null, author: { kind: 'bot', botId: 'b_lynx' }, text: '遅れて届いた投稿', mentions: [], at: Date.now() + 100, reactions: {} } });
  await page.locator('#chFeed .ch-jump').waitFor({ state: 'visible' });
  check(await page.evaluate(() => document.querySelector('.ch-log').scrollTop < 200), 'a post arriving while scrolled away does not yank the log');
  await page.locator('#chFeed .ch-jump').click();
  check(await page.evaluate(() => { const l = document.querySelector('.ch-log'); return l.scrollHeight - l.scrollTop - l.clientHeight < 90; }), 'the jump button returns to the bottom');
  await deliver({ type: 'channelPost', channelId: ch.id, op: 'delete', post: { id: 'p_late', channelId: ch.id, threadId: null, author: { kind: 'bot', botId: 'b_lynx' }, text: '', deletedAt: Date.now(), at: Date.now(), reactions: {} } });
  check(await page.locator('[data-post-id="p_late"].deleted .post-deleted').count() === 1, 'a delete event leaves a placeholder');
  // 別のチャンネルの出来事は流れに混ぜない
  const before = await page.locator('.post').count();
  await deliver({ type: 'channelPost', channelId: 'c_other', op: 'add', post: { id: 'p_x', channelId: 'c_other', threadId: null, author: { kind: 'human' }, text: 'x', mentions: [], at: Date.now(), reactions: {} } });
  check(await page.locator('.post').count() === before, 'an event for another channel is ignored');

  // ---- 既読
  const sent = await page.evaluate(() => window.__sent.filter(s => s.command === 'invoke' && s.args.op === 'channels.markRead'));
  check(sent.length >= 1 && sent[0].args.args.channelId === ch.id, 'the feed marks the channel read through channels.markRead');

  // ---- 右クリックのメニュー（長押しも同じ contextmenu）
  await page.locator('[data-post-id="p_bot1"] .post-body').click({ button: 'right' });
  const menu = await page.locator('.pop.menu .li').allTextContents();
  check(menu.some(m => m.includes('スレッドで返信')) && menu.some(m => m.includes('リアクションを付ける')) && menu.some(m => m.includes('本文をコピー')), 'right-click opens the post menu');
  await page.keyboard.press('Escape');

  // ---- メモ・設定
  await page.locator('.ch-more').click();
  const dlg = page.locator('dialog.ch-settings');
  await dlg.waitFor({ state: 'visible' });
  check(await dlg.locator('.cs-member input:checked').count() === 3, 'the settings dialog lists the members');
  // ページで答えた bot はサーバーに無いので、メンバーは外して保存する（有るものしかメンバーにできない）
  await dlg.getByRole('button', { name: '保存' }).click();
  await page.waitForFunction(() => document.querySelector('dialog.ch-settings .cs-error')?.textContent.length > 0);
  check(true, 'a save the server refuses keeps the dialog open and says why');
  for (const box of await dlg.locator('.cs-member input').all()) await box.uncheck();
  await dlg.locator('.cs-memo').fill('ここでは日本語で書く。');
  await dlg.locator('.cs-input').nth(1).fill('p95 を 250ms に');
  await dlg.getByRole('button', { name: '保存' }).click();
  await dlg.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('.ch-purpose')?.textContent === 'p95 を 250ms に');
  const got = await rpc('channels.get', { channelId: ch.id });
  check(got.memo === 'ここでは日本語で書く。' && got.purpose === 'p95 を 250ms に', 'saving the settings updates the channel and the header');

  // ---- 読み直し（本物の channels.read の summaries・threads から描く）
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1);
  await page.locator('#sideOrder [data-order="channel"]').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('.post .thread-summary').first().waitFor();
  const again = page.locator('.post').first();
  check((await again.locator('.thread-summary .ts-count').textContent()) === '💬 1 件の返信', 'after a reload the thread summary comes from the saved replies');
  check((await again.locator('.post-body').textContent()).includes('二行目') && await again.locator('.react-pill').count() === 1, 'after a reload the post and its reactions come back');

  // ---- 別の面（bot のページ）へ移って同じチャンネルへ戻っても、見出しは「# 名前」のまま（汎用の「Channels」や空にならない）
  const bots = (await rpc('bots.list')).bots ?? [];
  if (bots.length) {
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id } })), bots[0].id);
    await page.locator('#botView').waitFor({ state: 'visible' });
    await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
    await page.locator('#chFeed .post').first().waitFor();
    const backHead = await page.evaluate(() => { const h = document.getElementById('channelsPageTitle'); return { text: h.textContent, shown: h.getBoundingClientRect().width > 20 }; });
    check(backHead.shown && backHead.text.includes(name), 'coming back from the bot page to the same channel restores the # heading');
  }

  // ---- 360 幅
  await page.setViewportSize({ width: 360, height: 760 });
  await page.waitForTimeout(150);
  const narrow = await page.evaluate(() => {
    const log = document.querySelector('.ch-log'), comp = document.getElementById('chFeedComposer');
    const r = comp.getBoundingClientRect();
    return {
      overflowX: document.documentElement.scrollWidth > innerWidth || log.scrollWidth > log.clientWidth,
      composerInView: r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth,
      purposeHidden: getComputedStyle(document.querySelector('.ch-purpose')).display === 'none',
      placeholder: document.getElementById('chFeedComposerInput').getAttribute('placeholder'),
      tools: getComputedStyle(document.querySelector('.post-tools')).display,
    };
  });
  check(!narrow.overflowX && narrow.composerInView, 'at 360px nothing overflows sideways and the composer stays on screen');
  check(narrow.purposeHidden && narrow.placeholder.startsWith('#') && !narrow.placeholder.includes('@'), 'at 360px the purpose is hidden and the placeholder is short');
  await page.setViewportSize({ width: 1280, height: 820 });

  return results;
}
