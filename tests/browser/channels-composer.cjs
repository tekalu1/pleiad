// playwright-cli run-code --filename=tests/browser/channels-composer.cjs
// チャンネル・スレッドの入力欄を Chats の入力欄に揃えた分（ADR 0116）: 貼り付け・ファイルの選択・ドロップで添付 → 札・「添付 N 件」・一覧 → 投稿に載る・
// 画像の拡大 → 書きかけ（別のチャンネルへ移って戻る・再読み込み）→ スレッドの入力欄 → Chats の入力欄へ漏れない。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (AGENT_HOST_PORT=7497 AGENT_HOST_TOKEN=a11a-test AGENT_HOST_LOCALE=ja、別のデータ置き場). Never run against live data.
// 書き込みは本物のサーバー（channels.create / post・attachStart …）を通す。bot は fake では作れないので、@ の宛先・bot の受け取りは tests/unit/bot-dispatch.mjs が確かめる。
async page => {
  const URL = 'http://127.0.0.1:7497/?token=a11a-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript(() => {
    if (window.__w) return;
    window.__w = true;
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
      send(d) {
        // window.__stall の間は、添付の断片を握っておく（送っている途中の状態を作る）。__release() で送り出す
        try { if (window.__stall && JSON.parse(d).command === 'attachChunk') { window.__held.push([this, d]); return; } } catch {}
        return super.send(d);
      }
    };
    window.__held = [];
    window.__release = () => { window.__stall = false; for (const [s, d] of window.__held.splice(0)) WebSocket.prototype.send.call(s, d); };
    window.__rpc = (op, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
    });
  });
  await page.goto(URL);
  await later.click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);
  const show = (id, threadId) => page.evaluate(([i, t]) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: i, ...(t ? { threadId: t } : {}) } })), [id, threadId]);
  const makeImage = (name, color) => page.evaluate(async ([n, c]) => {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 100;
    const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 160, 100); g.fillStyle = '#fff'; g.font = '20px sans-serif'; g.fillText(n, 10, 55);
    const b = await new Promise((r) => cv.toBlob(r, 'image/png'));
    window.__dt = new DataTransfer(); window.__dt.items.add(new File([b], n, { type: 'image/png' }));
  }, [name, color]);
  const paste = async (sel, name, color) => {
    await makeImage(name, color);
    await page.evaluate((s) => document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: window.__dt, bubbles: true, cancelable: true })), sel);
  };

  const suffix = String(Date.now()).slice(-5);
  const ch = await rpc('channels.create', { name: 'attach' + suffix, purpose: '添付の確認' });
  const ch2 = await rpc('channels.create', { name: 'other' + suffix });
  await page.locator('#sideOrder [data-order="channel"]').click();
  await show(ch.id);
  await page.locator('#chFeed').waitFor();
  await page.waitForFunction(() => !document.querySelector('#chFeed .ch-loading'));
  const input = page.locator('#chFeedComposerInput');

  // ---- 入力欄の作り: クリップ・案内（Ctrl+Enter）・チップは無い
  check(/Ctrl\+Enter/.test(await input.getAttribute('placeholder')), 'the placeholder tells the send shortcut like Chats');
  check(await page.locator('#chFeedComposer .ch-attach').count() === 1 && await page.locator('#chFeedComposer .chip').count() === 0, 'the clip button exists and there are no model chips');
  check(await page.locator('#chFeedComposer input[type=file]').count() === 1, 'a hidden file input backs the clip');

  // ---- 貼り付け（画像）
  await input.click();
  await page.keyboard.type('スクショです');
  await page.keyboard.press('Enter');
  await paste('#chFeedComposerInput', 'shot1.png', '#3a7');
  await page.waitForFunction(() => document.querySelectorAll('#chFeedComposer .md-b.md-att img').length === 1, null, { timeout: 8000 });
  check(await page.locator('#chFeedComposer .att-count').textContent() === '添付 1 件', 'pasting an image puts it in the editor and the strip says 添付 1 件');
  const value = await page.evaluate(() => document.getElementById('chFeedComposerInput').value);
  check(/^スクショです\n\[添付\] .*shot1\.png$/.test(value), 'the editor value carries the 添付 mark line (what a bot reads): ' + JSON.stringify(value));

  // ---- ファイルの選択（クリップ）と一覧
  await page.setInputFiles('#chFeedComposer input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello attach') });
  await page.waitForFunction(() => document.querySelectorAll('#chFeedComposer .md-b.md-att').length === 2 && !document.querySelector('#chFeedComposer .md-att-up'), null, { timeout: 8000 });
  check(await page.locator('#chFeedComposer .att-count').textContent() === '添付 2 件', 'the file picker adds a second attachment');
  await page.locator('#chFeedComposer .att-entry').click();
  await page.locator('dialog.att-list[open]').waitFor();
  check(await page.locator('dialog.att-list .att-list-row').count() === 2, 'the list shows both attachments');
  await page.keyboard.press('Escape');

  // ---- 送信（Ctrl+Enter）
  await input.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('最後の行');
  await page.keyboard.press('Control+Enter');
  await page.locator('#chFeed .post').first().waitFor();
  await page.waitForTimeout(300);
  const first = (await rpc('channels.read', { channelId: ch.id })).posts[0];
  check(first.attachments?.length === 2 && first.attachments[0].kind === 'image' && first.attachments[0].origin === 'device', 'the post stores both attachments (image + file) from this device');
  check((first.text.match(/\[添付\]/g) ?? []).length === 2, 'the post text keeps both marks');
  check(await page.locator('#chFeed .post-body .msg-att-img img').count() === 1 && await page.locator('#chFeed .post-body .msg-att-file').count() === 1, 'the post shows the image and the file chip');
  check(await page.evaluate(() => { const i = document.querySelector('#chFeed .post-body .msg-att-img img'); return i.complete && i.naturalWidth > 0; }), 'the attached image loads');
  check(await page.evaluate(() => document.getElementById('chFeedComposerInput').value) === '' && await page.locator('#chFeedComposer .att-strip').isHidden(), 'the composer is empty after posting');

  // ---- 画像を押すと大きく見る
  await page.locator('#chFeed .msg-att-zoom').click();
  await page.locator('#lightbox[open]').waitFor();
  check(true, 'clicking the image opens the lightbox');
  await page.keyboard.press('Escape');

  // ---- ドロップ（板に落とす。Chats の入力欄へは入らない）
  await makeImage('drop1.png', '#a53');
  await page.evaluate(() => {
    const z = document.querySelector('#chFeed .ch-log'); const r = z.getBoundingClientRect();
    const init = { dataTransfer: window.__dt, bubbles: true, cancelable: true, clientX: r.left + 50, clientY: r.top + 50 };
    z.dispatchEvent(new DragEvent('dragenter', init)); z.dispatchEvent(new DragEvent('dragover', init));
    window.__dropping = document.getElementById('chFeed').classList.contains('dropping') && !document.querySelector('main').classList.contains('dropping');
    z.dispatchEvent(new DragEvent('drop', init));
  });
  check(await page.evaluate(() => window.__dropping), 'dragging files over the feed highlights the feed (and not Chats)');
  await page.waitForFunction(() => document.querySelectorAll('#chFeedComposer .md-b.md-att img').length === 1, null, { timeout: 8000 });
  check(await page.evaluate(() => document.getElementById('prompt').value === '' && document.getElementById('attached').hidden), 'the drop lands in the channel composer, not the Chats composer');

  // ---- 書きかけ: 別のチャンネルへ移って戻る・再読み込み
  await input.click();
  await page.keyboard.type('下書きのテキスト');
  await show(ch2.id);
  await page.waitForFunction((n) => document.getElementById('channelsPageTitle').textContent === `#${n}`, 'other' + suffix);
  check(await page.evaluate(() => document.getElementById('chFeedComposerInput').value) === '' && await page.locator('#chFeedComposer .att-strip').isHidden(), 'another channel starts with an empty composer');
  await show(ch.id);
  await page.waitForFunction((n) => document.getElementById('channelsPageTitle').textContent === `#${n}`, 'attach' + suffix);
  await page.waitForTimeout(300);
  check((await page.evaluate(() => document.getElementById('chFeedComposerInput').value)).includes('下書きのテキスト') && await page.locator('#chFeedComposer .md-b.md-att img').count() === 1, 'the draft (text + attachment) comes back with the channel');
  await page.reload();
  await later.click({ timeout: 4000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  await page.locator('#sideOrder [data-order="channel"]').click();
  await show(ch.id);
  await page.waitForFunction((n) => !document.querySelector('#chFeed .ch-loading') && document.getElementById('channelsPageTitle').textContent === `#${n}`, 'attach' + suffix);
  await page.waitForTimeout(400);
  check((await page.evaluate(() => document.getElementById('chFeedComposerInput').value)).includes('下書きのテキスト') && await page.locator('#chFeedComposer .md-b.md-att img').count() === 1, 'the draft survives a reload');

  // ---- スレッドの入力欄も同じ
  await page.evaluate(([c, t]) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: c, threadId: t } })), [ch.id, first.id]);
  await page.locator('#thPrompt').waitFor();
  await page.waitForFunction(() => document.querySelector('#chThread .th-log .post'));
  await page.locator('#thPrompt').click();
  await page.keyboard.type('スレッドの返信');
  await paste('#thPrompt', 'reply.png', '#37a');
  await page.waitForFunction(() => document.querySelectorAll('#thComposer .md-b.md-att img').length === 1, null, { timeout: 8000 });
  check(await page.locator('#thComposer .att-count').textContent() === '添付 1 件', 'the thread composer takes attachments too');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('#chThread .th-replies .post .msg-att-img').length === 1, null, { timeout: 8000 });
  const reply = (await rpc('channels.read', { channelId: ch.id, threadId: first.id })).posts.at(-1);
  check(reply.threadId === first.id && reply.attachments?.length === 1, 'the thread reply stores its attachment');
  check(await page.evaluate(() => document.getElementById('chFeedComposerInput').value).then((v) => v.includes('下書きのテキスト')), 'the feed draft is untouched by the thread');

  // ---- 送っている途中の添付があるうちは送らない（欠けた添付を前提に bot が動き出さないように）。届いたら送れる
  await page.evaluate(() => { window.__stall = true; });
  await page.locator('#thPrompt').click();
  await page.keyboard.type('待ちの返信');
  await paste('#thPrompt', 'slow.png', '#555');
  await page.waitForFunction(() => document.querySelector('#thComposer .md-att-up'), null, { timeout: 8000 });
  check(/送信中/.test(await page.locator('#thComposer .att-state').textContent()), 'the strip says the attachment is being sent');
  const before = (await rpc('channels.read', { channelId: ch.id, threadId: first.id })).posts.length;
  const shown = await page.locator('#chThread .th-replies .post').count();
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(400);
  check((await rpc('channels.read', { channelId: ch.id, threadId: first.id })).posts.length === before && (await page.locator('#thComposer .settings-error').textContent()).length > 0, 'sending is refused with a reason while an attachment is still being sent');
  await page.evaluate(() => window.__release());
  await page.waitForFunction(() => !document.querySelector('#thComposer .md-att-up') && document.querySelectorAll('#thComposer .md-b.md-att img').length === 1, null, { timeout: 8000 });
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction((n) => document.querySelectorAll('#chThread .th-replies .post').length === n + 1, shown, { timeout: 8000 });
  check(true, 'once it has arrived the post goes out');
  return results;
}
