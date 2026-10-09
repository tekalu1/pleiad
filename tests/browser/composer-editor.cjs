// playwright-cli -s=composer-editor run-code --filename=tests/browser/composer-editor.cjs
// 入力欄の編集欄（web/md-editor.mjs、ADR 0060）を本物のブラウザーで確かめる。認証済みの、実データと分離した fake サーバーを開いてから実行する
// （AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時> AGENT_HOST_PORT=<空き> AGENT_HOST_LOCALE=ja で起動し、最初の案内は「あとで」）。
//   1. 整形: 見出し・箇条書き・番号・引用・コードブロック・太字・斜体・コード・リンク・書式バー。整えた直後の元に戻す・やり直し
//   2. 文中の添付: 貼り付けた画像が位置に入る・直後の Backspace で外れる・元に戻す・一覧の面・下書きの復元・送信（印は 1 回、位置のまま）
//   3. 送っている途中・失敗の添付: 進み具合・送信を止める・再試行・中止
//   4. 複数行の貼り付け・コピー・シェルの形（!）・スキル候補（/）
//   5. 日本語入力: 変換中は整えない・強調の直後で始めても外に入る
async page => {
  const results = [];
  const check = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw Error(`${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    results.push(name);
  };
  const K = page.keyboard;
  const val = () => page.evaluate(() => document.querySelector('#prompt').value);
  const kinds = () => page.evaluate(() => [...document.querySelector('#prompt').children].map(b => b.dataset.k + (b.dataset.pad !== undefined ? '(pad)' : '')).join(','));
  const html = () => page.evaluate(() => document.querySelector('#prompt').innerHTML.replace(/ data-[a-z]+="[^"]*"/g, '').replace(/ style="[^"]*"/g, ''));
  const strip = () => page.evaluate(() => { const s = document.querySelector('#attached'); return s.hidden ? '' : s.textContent; });
  const marks = (v) => v.split('\n').map(l => l.startsWith('[添付]') ? 'A' : l).join('|');
  const reset = () => page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = ''; p.focus(); });
  const clean = async () => {
    for (let n = 0; n < 12; n++) {
      if (await page.evaluate(() => document.querySelector('#attached').hidden)) break;
      await page.click('.att-entry'); await page.waitForSelector('dialog.att-list[open]');
      await page.evaluate(() => { [...document.querySelectorAll('dialog.att-list .att-list-action')].find(b => b.textContent === '外す' || b.textContent.includes('やめる'))?.click(); });
      await K.press('Escape'); await page.waitForTimeout(80);
    }
    await reset();
  };
  const pasteImage = (name) => page.evaluate(async (n) => {
    const c = document.createElement('canvas'); c.width = 40; c.height = 30; c.getContext('2d').fillRect(0, 0, 40, 30);
    const b = await new Promise(r => c.toBlob(r, 'image/png'));
    const dt = new DataTransfer(); dt.items.add(new File([b], n, { type: 'image/png' }));
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, name);

  const ready = async () => {
    await page.waitForTimeout(1200);   // 最初の案内は少し遅れて開く
    await page.evaluate(() => document.querySelectorAll('dialog[open] button').forEach(b => { if (b.textContent.includes('あとで')) b.click(); }));
    await page.waitForFunction(() => { const p = document.querySelector('#prompt'); return !p.disabled && !p.readOnly && !document.querySelector('#cbox').hasAttribute('aria-busy'); });
  };
  await page.reload();
  await ready();

  // ---------------------------------------------------------------- 1. 整形
  await reset(); await K.type('a **bold** b');
  check('太字は閉じた時点で整い、続きは外へ', [await val(), (await html()).includes('<strong>bold</strong>')], ['a **bold** b', true]);
  await reset(); await K.type('x **bold**'); await K.press('Control+z');
  check('整えた直後の元に戻すで記号に戻る', [await val(), (await html()).includes('<strong>')], ['x **bold**', false]);
  await K.type(' more');
  check('戻した後の続きは記号のまま', [await val(), (await html()).includes('<strong>')], ['x **bold** more', false]);
  await reset(); await K.type('use `code` here');
  check('コード', [await val(), (await html()).includes('<code>code</code>')], ['use `code` here', true]);
  await reset(); await K.type('*it* and _it2_ and [t](http://x.y/z)');
  check('斜体・リンク', [await val(), (await html()).includes('<em>it</em>'), (await html()).includes('>t</a>')], ['*it* and _it2_ and [t](http://x.y/z)', true, true]);
  await reset(); await K.type('# '); await K.type('Head');
  check('見出し', [await val(), (await html()).startsWith('<div class="md-b md-h">Head</div>')], ['# Head', true]);
  await K.press('Control+z'); await K.press('Control+z');
  check('元に戻す 2 回で記号のままの行', [await val(), await kinds()], ['# ', 'p']);
  await K.press('Control+Shift+z'); await K.press('Control+Shift+z');
  check('やり直しで見出しへ', await val(), '# Head');
  await reset(); await K.type('## Title'); await K.press('Home'); await K.press('Backspace');
  check('見出しの行頭の Backspace は本文に戻す', await val(), 'Title');
  await reset(); await K.type('> quoted'); await K.press('Enter'); await K.type('more'); await K.press('Enter'); await K.press('Enter'); await K.type('out');
  check('引用の続き・空の行で抜ける', await val(), '> quoted\n> more\nout');
  await reset(); await K.type('1. one'); await K.press('Enter'); await K.type('two');
  check('番号は 1 つ進む', await val(), '1. one\n2. two');
  await reset(); await K.press('Minus'); await K.press('Space'); await K.type('a'); await K.press('Enter'); await K.type('b'); await K.press('Enter'); await K.press('Enter'); await K.type('c');
  check('箇条書きの続き・空の項目で抜ける', await val(), '- a\n- b\nc');
  await reset(); await K.type('```');
  check('``` でコードブロック（閉じも足す）', await val(), '```\n\n```');
  await K.press('ArrowDown'); await K.type('const a = 1;'); await K.press('Enter'); await K.type('const b = 2;');
  check('コードの行', await val(), '```\nconst a = 1;\nconst b = 2;\n```');
  await K.press('Control+End'); await K.type('after');
  check('閉じの後ろにも書ける', await val(), '```\nconst a = 1;\nconst b = 2;\n```\nafter');
  await reset(); await K.type('12345'); await K.press('Home'); await K.press('Shift+End');
  await page.waitForTimeout(150);
  check('範囲選択で書式バー', await page.evaluate(() => { const b = document.querySelector('.md-bar'); return Boolean(b && !b.hidden); }), true);
  await page.click('.md-bar-b');
  check('書式バーの太字', await val(), '**12345**');
  await K.press('End'); await page.waitForTimeout(150);
  check('選択を外すと書式バーは消える', await page.evaluate(() => document.querySelector('.md-bar').hidden), true);

  // ---------------------------------------------------------------- 1b. 箇条書き・引用の続き（承認済み 2026-10-09）
  const setText = (s, at = 'end') => page.evaluate(([text, where]) => {
    const p = document.querySelector('#prompt'); p.value = text; p.focus();
    const sel = getSelection(); sel.selectAllChildren(p);
    if (where === 'end') sel.collapseToEnd(); else sel.collapseToStart();
  }, [s, at]);
  const qdepth = () => page.evaluate(() => [...document.querySelector('#prompt').children].map(b => b.style.getPropertyValue('--q')).join(','));
  await reset(); await K.type('・foo');
  check('行頭に ・ を打っただけでは何も変わらない', [await val(), await kinds()], ['・foo', 'p']);
  await K.press('Enter'); await K.type('bar');
  check('・ の行の Enter は同じ字で続ける', await val(), '・foo\n・bar');
  await K.press('Enter'); await K.press('Enter'); await K.type('out');
  check('・ だけの項目で Enter すると記号を外して抜ける', await val(), '・foo\n・bar\nout');
  await reset(); await K.type('•x'); await K.press('Enter'); await K.type('y');
  check('• でも続く（打った字のまま）', await val(), '•x\n•y');
  await reset(); await K.type('> a'); await K.press('Enter'); await K.type('> '); await K.type('b');
  check('引用の行頭で > を打つと 1 段深くなる', [await val(), await qdepth()], ['> a\n> > b', '1,2']);
  await K.press('Enter'); await K.type('c');
  check('入れ子の引用の Enter は深さを保つ', await val(), '> a\n> > b\n> > c');
  check('引用の行に深さの数だけ縦線が付く（computed style・面は敷かない・行の間で切れない）', await page.evaluate(() => [...document.querySelectorAll('#prompt .md-quote')].map(b => { const c = getComputedStyle(b); return [c.backgroundImage.includes('repeating-linear-gradient') && c.backgroundImage.includes('rgb'), c.backgroundSize.split(' ')[0], c.backgroundColor, c.marginTop, c.marginBottom].join('/'); })), ['true/16px/rgba(0, 0, 0, 0)/0px/0px', 'true/32px/rgba(0, 0, 0, 0)/0px/0px', 'true/32px/rgba(0, 0, 0, 0)/0px/0px']);
  await K.press('Enter'); await K.press('Enter');
  check('空の深い引用の Enter は 1 段戻る', await val(), '> a\n> > b\n> > c\n> ');
  await K.press('Enter');
  check('最後の段の空の引用の Enter は抜ける', [await val(), await kinds()], ['> a\n> > b\n> > c\n', 'quote,quote,quote,p']);
  await reset(); await setText('＞ x'); await K.press('End'); await K.press('Enter'); await K.type('y');
  check('全角の ＞ も引用として続く', await val(), '＞ x\n＞ y');
  await reset(); await K.type('- [ ] todo'); await K.press('Enter'); await K.type('next');
  check('チェック欄 - [ ] は - [ ] で続く（字のまま）', [await val(), await kinds()], ['- [ ] todo\n- [ ] next', 'ul,ul']);
  await setText('- [x] done'); await K.press('Enter');
  check('- [x] の次は - [ ]', await val(), '- [x] done\n- [ ] ');
  await K.press('Enter');
  check('チェック欄だけの項目で Enter すると抜ける', await val(), '- [x] done\n');
  await reset(); await K.type('- a'); await K.press('Enter'); await K.type('b'); await K.press('Tab');
  check('箇条書きの Tab は字下げ', [await val(), await page.evaluate(() => document.activeElement.id)], ['- a\n  - b', 'prompt']);
  await K.press('Shift+Tab');
  check('Shift+Tab は字上げ', await val(), '- a\n- b');
  await K.press('Control+z');
  check('字下げ・字上げは元に戻せる', await val(), '- a\n  - b');
  await reset(); await K.type('plain');
  await K.press('Tab');
  check('本文の行の Tab は字下げせず、フォーカスは今までどおり動く', [await val(), await page.evaluate(() => document.activeElement.id !== 'prompt')], ['plain', true]);
  await page.evaluate(() => document.querySelector('#prompt').focus());
  await setText('1. a\n2. b\n3. c', 'end'); await K.press('Control+Home'); await K.press('End'); await K.press('Enter'); await K.type('x');
  check('番号は Enter で数え直す', await val(), '1. a\n2. x\n3. b\n4. c');
  await setText('5. a\n6. b'); await K.press('Enter'); await K.type('c');
  check('番号は最初の数に従う', await val(), '5. a\n6. b\n7. c');
  await setText('1. a\n2. b\n3. c\n4. d'); await K.press('Control+Home'); await K.press('End'); await K.press('Delete');
  check('番号は行をつないだあとも数え直す', await val(), '1. ab\n2. c\n3. d');
  await setText('1. a\n2. b\n3. c'); await K.press('Control+Home'); await K.press('ArrowDown'); await K.press('Tab');
  check('番号の行を字下げすると 1 から数え直し、上の並びは詰まる', await val(), '1. a\n  1. b\n2. c');
  await reset();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', '1. a\n5. b');
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check('貼り付けた番号は触らない', await val(), '1. a\n5. b');
  await reset(); await K.type('- a'); await K.press('Shift+Enter'); await K.type('more');
  check('Shift+Enter は項目の中の改行（字下げした続きの行）', [await val(), await kinds()], ['- a\n  more', 'ul,cont']);
  await K.press('Enter'); await K.type('b');
  check('続きの行の Enter は次の項目', await val(), '- a\n  more\n- b');
  await reset(); await K.type('- a'); await K.press('Shift+Enter'); await K.press('Enter'); await K.type('z');
  check('空の続きの行の Enter は抜ける', await val(), '- a\nz');
  await reset(); await K.type('> a'); await K.press('Shift+Enter'); await K.type('b');
  check('引用の Shift+Enter は引用のまま', await val(), '> a\n> b');
  await reset(); await K.type('- a'); await K.press('Shift+Enter'); await K.type('b');
  await page.evaluate(() => document.querySelector('#prompt').editor?.refresh?.());
  await K.press('Home'); await K.press('Backspace');
  check('続きの行の行頭の Backspace は本文の行に戻る', [await val(), await kinds()], ['- a\nb', 'ul,p']);
  await reset(); await K.type('- a'); await K.press('Enter'); await K.type('b'); await K.press('Control+z');
  check('Ctrl+Z は自動で入れた記号だけ戻す', await val(), '- a\n- ');
  await K.press('Control+z');
  check('もう一度 Ctrl+Z で改行ごと戻る', await val(), '- a');
  await reset(); await K.type('- a');
  await K.press('Control+Enter'); await page.waitForSelector('#log .m.user', { timeout: 8000 });
  check('Ctrl+Enter は箇条書きの行でも送る', [await val(), await page.evaluate(() => [...document.querySelectorAll('#log .m.user .body')].at(-1).dataset.raw)], ['', '- a']);
  await reset(); await K.type('- a'); await K.press('Shift+Enter'); await K.type('b'); await K.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#log .m.user .body')].at(-1)?.dataset.raw === '- a\n  b', null, { timeout: 8000 });
  check('項目の中の改行も、そのままの形で送られる', await val(), '');
  await reset();

  // ---------------------------------------------------------------- 2. 文中の添付
  await clean();
  await K.type('x'); await K.press('Enter'); await K.type('y'); await K.press('ArrowUp'); await K.press('End');
  await pasteImage('pasted.png');
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-att[data-state=ok]').length === 1, null, { timeout: 10000 });
  check('貼り付けた画像はキャレットの位置に入る', [await kinds(), marks(await val()), await strip()], ['p,att,p', 'x|A|y', '添付 1 件▾']);
  // 空の行に入れると、続きはその添付の次の行に書ける（キャレットが先頭へ飛ばない）
  await K.press('Control+End'); await K.press('Enter');
  await pasteImage('second.png');
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-att[data-state=ok]').length === 2, null, { timeout: 10000 });
  await K.type('z');
  check('空の行への添付のあと、続きは添付の次に書ける', marks(await val()), 'x|A|y|A|z');
  await K.press('Control+z'); await K.press('Control+z'); await K.press('Control+z');
  check('元に戻すで 2 枚目の添付も外れる', [marks(await val()), await strip()], ['x|A|y', '添付 1 件▾']);
  await K.press('ArrowDown'); await K.press('Home'); await K.press('Backspace');
  check('直後の Backspace 1 回で外れる', [await kinds(), await val(), await strip()], ['p,p', 'x\ny', '']);
  await K.press('Control+z');
  check('元に戻すで位置も添付の実体も戻る', [await kinds(), marks(await val()), await strip()], ['p,att,p', 'x|A|y', '添付 1 件▾']);
  await page.click('.att-entry'); await page.waitForSelector('dialog.att-list[open]');
  check('一覧の区分は「文中の添付」', await page.evaluate(() => [...document.querySelectorAll('dialog.att-list .att-list-caption')].map(c => c.textContent)), ['文中の添付']);
  await page.evaluate(() => [...document.querySelectorAll('dialog.att-list .att-list-action')].find(b => b.textContent.includes('文中の位置')).click());
  await page.waitForTimeout(200);
  check('文中の位置へ移動は札を強調する', await page.evaluate(() => Boolean(document.querySelector('#prompt .md-att.jump'))), true);
  await page.waitForTimeout(500);
  const before = await val();
  await page.reload(); await page.waitForTimeout(800);
  await ready();
  check('下書きを読み直しても位置が残る', [await val(), await kinds(), await strip()], [before, 'p,att,p', '添付 1 件▾']);
  await page.evaluate(() => document.querySelector('#prompt').focus());
  await K.press('Control+Home'); await K.press('Enter'); await K.press('ArrowUp'); await K.type('# Title');
  await K.press('Control+Enter');
  await page.waitForSelector('#log .m.user', { timeout: 8000 });
  await page.waitForTimeout(800);
  const msg = await page.evaluate(() => { const m = [...document.querySelectorAll('#log .m.user')].at(-1); return { raw: m.querySelector('.body').dataset.raw, imgs: m.querySelectorAll('.msg-att-img').length, cards: document.querySelectorAll('#log .present').length }; });
  check('送信: 印は 1 回・位置のまま・別カードは出ない', [msg.raw.split('\n').filter(l => l.startsWith('[添付]')).length, marks(msg.raw).replace(/^# Title\|/, ''), msg.imgs, msg.cards], [1, 'x|A|y', 1, 0]);
  check('送信: 欄は空', [await val(), await strip()], ['', '']);

  // 旧形式の下書きと同じ状態（添付の実体があり、本文には印が無い）は「文末に付く」。位置に入れて送ると、文中の印は位置のまま・文末に付く分だけ末尾
  await clean();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['a'], 'a.txt', { type: 'text/plain' })); dt.items.add(new File(['b'], 'b.txt', { type: 'text/plain' }));
    document.querySelector('main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-att[data-state=ok]').length === 2, null, { timeout: 15000 });
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = '古い下書き\n続き'; p.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.click('.att-entry'); await page.waitForSelector('dialog.att-list[open]');
  check('印の無い添付は「文末に付く」', await page.evaluate(() => ({ sections: [...document.querySelectorAll('dialog.att-list .att-list-caption')].map(c => c.textContent), actions: [...document.querySelectorAll('dialog.att-list .att-list-action')].map(b => b.textContent).slice(0, 2) })), { sections: ['文末に付く'], actions: ['カーソルの位置に入れる', '外す'] });
  await K.press('Escape');
  await page.evaluate(() => document.querySelector('#prompt').focus()); await K.press('Control+Home'); await K.press('End');
  await page.click('.att-entry'); await page.waitForSelector('dialog.att-list[open]');
  await page.evaluate(() => [...document.querySelectorAll('dialog.att-list .att-list-row')].find(r => r.textContent.includes('a.txt')).querySelector('.att-list-action').click());
  await page.waitForTimeout(300);
  check('カーソルの位置に入れる', marks(await val()), '古い下書き|A|続き');
  await page.evaluate(() => document.querySelector('#prompt').focus());
  await K.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('#log .m.user .body')].some(b => b.dataset.raw?.includes('古い下書き')), null, { timeout: 10000 });
  const raw = await page.evaluate(() => [...document.querySelectorAll('#log .m.user .body')].find(b => b.dataset.raw?.includes('古い下書き')).dataset.raw);
  check('送信: 文中の印は位置のまま・文末に付く分は末尾に 1 つ', raw.split('\n').map(l => l.startsWith('[添付]') ? l.replace(/^.*Z_/, '[添付] ') : l), ['古い下書き', '[添付] a.txt', '続き', '', '[添付] b.txt']);

  // ---------------------------------------------------------------- 3. 送っている途中・失敗
  await clean();
  await page.evaluate(() => {
    const orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) {
      if (typeof d === 'string' && d.includes('"attachChunk"') && window.__slow) { if (window.__fail) throw new Error('boom'); const self = this; return void setTimeout(() => orig.call(self, d), window.__slow); }
      return orig.call(this, d);
    };
    window.__slow = 500; window.__fail = false;
  });
  const dropBig = () => page.evaluate(() => {
    const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(3 * 1024 * 1024)], 'big.bin'));
    document.querySelector('main').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const snap = () => page.evaluate(() => ({
    atoms: [...document.querySelectorAll('#prompt .md-att')].map(a => a.dataset.state + ':' + (a.querySelector('.md-att-up-pct')?.textContent ?? a.querySelector('.md-att-up-err')?.textContent ?? '')),
    strip: document.querySelector('#attached').hidden ? '' : document.querySelector('#attached').textContent,
    sendDisabled: document.querySelector('#send').disabled, sendTitle: document.querySelector('#send').title,
  }));
  await K.type('hello');
  await dropBig(); await page.waitForTimeout(300);
  let s = await snap();
  check('送信中: 札に %・入口に「1 件送信中」・送信は押せず理由が title', [s.atoms[0].startsWith('sending:'), s.strip.includes('1 件送信中'), s.sendDisabled, s.sendTitle], [true, true, true, '添付を送っている間は送れません']);
  await K.press('Control+Enter'); await page.waitForTimeout(150);
  check('送っている間は Ctrl+Enter でも送らない', await page.evaluate(() => document.querySelector('#prompt').value.length > 0), true);
  await page.waitForFunction(() => document.querySelector('#prompt .md-att')?.dataset.state === 'ok', null, { timeout: 15000 });
  await page.evaluate(() => { window.__fail = true; });
  await dropBig();
  await page.waitForFunction(() => [...document.querySelectorAll('#prompt .md-att')].some(a => a.dataset.state === 'failed'), null, { timeout: 15000 });
  s = await snap();
  check('失敗: 札に理由・入口に「1 件失敗」・送信は押せない', [s.atoms.some(a => a.startsWith('failed:送れませんでした')), s.strip.includes('1 件失敗'), s.sendDisabled], [true, true, true]);
  await page.evaluate(() => { window.__fail = false; window.__slow = 0; });
  await page.click('#prompt .md-att-act[data-act=retry]');
  await page.waitForFunction(() => [...document.querySelectorAll('#prompt .md-att')].every(a => a.dataset.state === 'ok'), null, { timeout: 15000 });
  s = await snap();
  check('再試行で普通の札になり、送信できる', [s.atoms.length, s.sendDisabled], [2, false]);
  await page.evaluate(() => { window.__slow = 800; });
  await dropBig(); await page.waitForSelector('#prompt .md-att[data-state=sending]');
  await page.click('#prompt .md-att-act[data-act=cancel]'); await page.waitForTimeout(1600);
  s = await snap();
  check('送信をやめると札は外れたまま', [s.atoms.length, s.strip], [2, '添付 2 件▾']);
  await page.evaluate(() => { window.__slow = 0; });

  // ---------------------------------------------------------------- 4. 貼り付け・コピー・シェル・スキル候補
  await clean();
  await page.evaluate(() => {
    const dt = new DataTransfer(); dt.setData('text/plain', '# H\n- a\n- b\n\n```js\ncode\n```\n> q');
    document.querySelector('#prompt').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  check('複数行の貼り付けは行ごとに整う', [await kinds(), await val()], ['h,ul,ul,p,code,code,code,quote', '# H\n- a\n- b\n\n```js\ncode\n```\n> q']);
  const copied = await page.evaluate(() => { const p = document.querySelector('#prompt'); p.focus(); getSelection().selectAllChildren(p); const dt = new DataTransfer(); p.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData('text/plain'); });
  check('コピーは Markdown', copied, '# H\n- a\n- b\n\n```js\ncode\n```\n> q');
  await K.press('Backspace');
  check('全部選んで消せばふつうの空行', [await val(), await kinds()], ['', 'p']);
  await K.type('!');
  check('空の欄で ! を打つとシェルの形', await page.evaluate(() => ({ shell: document.querySelector('#cbox').classList.contains('shell'), val: document.querySelector('#prompt').value })), { shell: true, val: '' });
  await K.type('echo **a** `b`'); await K.press('Enter'); await K.press('Minus'); await K.press('Space'); await K.type('x');
  check('シェルの形は整えない（等幅の平文）', [await val(), await kinds(), (await html()).includes('<strong')], ['echo **a** `b`\n- x', 'p,p', false]);
  await K.press('Control+a'); await K.press('Backspace'); await K.press('Backspace');
  check('空の欄の Backspace でシェルの形を出る', await page.evaluate(() => document.querySelector('#cbox').classList.contains('shell')), false);
  await K.type('run /comp'); await page.waitForTimeout(400);
  check('文中の / でスキル候補が開く', await page.evaluate(() => !document.querySelector('#skillList').hidden), true);
  await K.press('Enter');
  check('候補を選ぶと token だけが置き換わる', await val(), 'run /compact');
  await K.press('Control+a'); await K.press('Backspace');
  await K.type('```'); await K.press('ArrowDown'); await K.type('/com'); await page.waitForTimeout(300);
  check('コードブロックの中ではスキル候補を出さない', await page.evaluate(() => document.querySelector('#skillList').hidden), true);
  await reset();

  // ---------------------------------------------------------------- 5. 日本語入力
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '#', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: '# ', selectionStart: 2, selectionEnd: 2 });
  check('変換中は見出しにならない', [await val(), await kinds()], ['# ', 'p']);
  await cdp.send('Input.insertText', { text: '# ' }); await page.waitForTimeout(100);
  check('確定しても整えない', [await val(), await kinds()], ['# ', 'p']);
  await reset(); await K.type('**b**');
  await cdp.send('Input.imeSetComposition', { text: 'あ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '亜' }); await page.waitForTimeout(150);
  check('太字の直後で変換を始めても外へ入る', [await val(), (await html()).includes('<strong>b</strong>亜')], ['**b**亜', true]);
  await reset();
  await cdp.send('Input.imeSetComposition', { text: 'てすと', selectionStart: 3, selectionEnd: 3 });
  const during = await page.evaluate(() => {
    const p = document.querySelector('#prompt');
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true, keyCode: 229 });
    p.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, blocks: p.children.length };
  });
  check('変換中の Enter は改行も送信もしない', during, { prevented: false, blocks: 1 });
  await cdp.send('Input.insertText', { text: 'テスト' }); await page.waitForTimeout(100);
  check('確定', await val(), 'テスト');
  await reset();

  // ---------------------------------------------------------------- 6. 貼り付け・往復・打鍵の重さ・変換の後始末
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await K.type('x');
  await page.evaluate(async () => {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob(['<h1 style="color:red">Big</h1><div>line2</div><img src="https://example.com/t.png">'], { type: 'text/html' }) })]);
  });
  await K.press('Control+v'); await page.waitForTimeout(300);
  check('HTML だけの貼り付けは Markdown として入る（要素・外の画像・style は入らない。ADR 0141）',
    await page.evaluate(() => ({ v: document.querySelector('#prompt').value, img: document.querySelectorAll('#prompt img[src^="http"]').length, h1: document.querySelectorAll('#prompt h1').length })),
    { v: 'x\n# Big\nline2', img: 0, h1: 0 });
  await reset();
  check('value の往復（設定した文字がそのまま読める）', await page.evaluate(() => {
    const p = document.querySelector('#prompt');
    return ['a\tb', '## h\n- x\n  - y\n\n> q\n```js\ncode\n```', '**a****b**', 'trailing  ', '\n先頭の空行', '末尾の改行\n'].map(s => { p.value = s; return p.value === s; });
  }), [true, true, true, true, true, true]);
  // 長い下書きの 1 打鍵で DOM を読み直す回数（行数に比例しない。値の読み取りは DOM が変わるまで読み直さない）
  await page.evaluate(() => {
    const p = document.querySelector('#prompt');
    p.value = Array.from({ length: 300 }, (_, i) => `本文の行 ${i} の **太字** と [リンク](https://x.y/${i})`).join('\n');
    p.focus(); const s = getSelection(); s.selectAllChildren(p.lastElementChild); s.collapseToEnd();
  });
  await K.press('a'); await page.waitForTimeout(50);   // 最初の 1 打鍵は全行を読む（写しが空）。数えるのはその次から
  await page.evaluate(() => {
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, 'childNodes');
    window.__reads = 0; window.__restoreReads = () => Object.defineProperty(Node.prototype, 'childNodes', desc);
    Object.defineProperty(Node.prototype, 'childNodes', { configurable: true, get() { window.__reads++; return desc.get.call(this); } });
  });
  await K.press('b'); await page.waitForTimeout(50);
  const oneKey = await page.evaluate(() => window.__reads);
  const rereads = await page.evaluate(() => { const p = document.querySelector('#prompt'); const before = window.__reads; for (let i = 0; i < 5; i++) { p.value; p.selectionStart; p.selectionEnd; } return window.__reads - before; });
  await page.evaluate(() => window.__restoreReads());
  check('1 打鍵で DOM を読む回数は行数（300）に比例しない', oneKey < 50, true);
  check('DOM が変わらなければ value・選択の読み取りで DOM を読み直さない', rereads, 0);
  await reset();
  // 変換中に添付の描き直し（refresh）が走っても、変換中の字は本文に残らない
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = 'line1\nabc'; p.focus(); const s = getSelection(); s.selectAllChildren(p.lastElementChild); s.collapseToEnd(); });
  await cdp.send('Input.imeSetComposition', { text: 'にほ', selectionStart: 2, selectionEnd: 2 });
  await page.evaluate(() => document.querySelector('#prompt').editor.refresh());
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await cdp.send('Input.insertText', { text: '日本' }); await page.waitForTimeout(100);
  check('変換中に refresh が走っても変換中の字は残らない', await val(), 'line1\nabc日本');
  // 確定の直後（同じ tick）の Enter は、ブラウザーの行の分割に任せず、モデルが割る（記号が増えない）
  await page.evaluate(() => { const p = document.querySelector('#prompt'); p.value = '- abc'; p.focus(); const s = getSelection(); s.selectAllChildren(p.lastElementChild); s.collapseToEnd(); });
  check('確定の直後の Enter はモデルが行を割る（default を止め、記号は 1 つずつ）', await page.evaluate(() => {
    const p = document.querySelector('#prompt');
    p.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    p.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'x' }));
    const ev = new InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
    p.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, value: p.value, marks: [...p.children].map(d => d.dataset.m ?? '').join('|') };
  }), { prevented: true, value: '- abc\n- ', marks: '- |- ' });
  await clean();
  // 一覧の「外す」を押した後も、フォーカスは <body> に落ちない（同じ位置の行のボタンへ。全部外したら入力欄へ）
  await pasteImage('one.png'); await page.waitForTimeout(700); await pasteImage('two.png'); await page.waitForTimeout(700);
  await page.click('.att-entry'); await page.waitForSelector('dialog.att-list[open]');
  await page.evaluate(() => document.querySelector('dialog.att-list .att-list-row .att-list-action:last-child').focus());
  await K.press('Enter'); await page.waitForTimeout(150);
  check('一覧の「外す」の後も、フォーカスは面の中の同じ位置のボタン', await page.evaluate(() => {
    const a = document.activeElement;
    return { inDialog: Boolean(a.closest('dialog.att-list')), label: a.textContent, rows: document.querySelectorAll('dialog.att-list .att-list-row').length, heading: document.querySelector('dialog.att-list h3').textContent };
  }), { inDialog: true, label: '外す', rows: 1, heading: '添付 1 件' });
  await K.press('Enter'); await page.waitForTimeout(250);
  check('全部外して面が閉じたら、フォーカスは入力欄へ', await page.evaluate(() => ({ id: document.activeElement.id, open: document.querySelectorAll('dialog.att-list[open]').length })), { id: 'prompt', open: 0 });
  await reset();
  return `${results.length} 件通過\n${results.join('\n')}`;
}
