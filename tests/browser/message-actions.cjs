// playwright-cli -s=message-actions run-code --filename=tests/browser/message-actions.cjs
// 認証済みの、実データと分離した fake サーバーを開いてから実行する。
// 発言の操作（コピー・⋯・編集して再送信・再送信・分岐して送る）。送り直しは同じ会話の中で行う（ADR 0102）。
async page => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/resend-in-place-impl-${name}.png` }); };
  const results = [];
  // 落ちたときに直前に通った項目を添える（run-code はスタックを出さない）
  const fail = e => { throw Error(`${String(e.message).split(String.fromCharCode(10))[0]} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); };
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  // 発言の操作は ⋯ のメニュー（右クリックと同じ）。項目は名前で引く（「再送信」が「編集して再送信」に当たらないよう exact）
  const menu = async (m, name) => { await m.hover(); await m.locator('.who-more').click(); await page.getByRole('menuitem', { name, exact: true }).click(); };
  // 巻き戻しは済んだのに応答が失敗で返る（接続断など）場面を作る。failNextRewind を立てると、次の rewind 付き sendMessage の応答を失敗に差し替える
  let failNextRewind = false;
  const rewindIds = new Set();
  await page.routeWebSocket(/\/ws/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(raw => {
      try { const m = JSON.parse(raw); if (m.command === 'sendMessage' && m.args?.rewind) rewindIds.add(m.id); } catch {}
      server.send(raw);
    });
    server.onMessage(raw => {
      try {
        const m = JSON.parse(raw);
        if (m.kind === 'response' && rewindIds.has(m.id) && failNextRewind) {
          failNextRewind = false;
          ws.send(JSON.stringify({ kind: 'response', id: m.id, ok: false, error: '接続が途中で切れました（テスト）' }));
          return;
        }
      } catch {}
      ws.send(raw);
    });
  });
  await page.reload();
  await page.locator('#prompt:not([aria-disabled="true"])').waitFor();
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws${location.search}`);
    const pending = new Map(); let seq = 0;
    window.messageActionsProbe = (command, args = {}) => new Promise((resolve, reject) => {
      const id = `qa-${++seq}`; pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ kind: 'command', command, args, id }));
    });
    await new Promise(resolve => { socket.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.kind === 'ready') return resolve();
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(Error(m.error)); }
    }; });
    window.messageActionsProbeSocket = socket;
  });
  const cmd = (command, args) => page.evaluate(({ command, args }) => window.messageActionsProbe(command, args), { command, args });
  const current = () => page.evaluate(() => localStorage.getItem('agent-host-current'));
  const history = async (id, matches) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      const data = await cmd('loadSession', { sessionId: id });
      if (matches(data)) return data;
      await page.waitForTimeout(100);
    }
    throw Error('履歴の更新を待機中にタイムアウト');
  };
  const ready = async () => {
    await page.waitForFunction(async () => {
      const work = await window.messageActionsProbe('running');
      // ターンの終わりの履歴の読み直しが済んで、自分の発言（⋯ の編集・再送信の元）に uuid が付くまで待つ
      return !work.turns.length && !document.querySelector('.branch-transition') && !document.querySelector('#send').disabled
        && [...document.querySelectorAll('.m.user:not(.cmd)')].every(m => m.dataset.uuid);
    });
  };
  const send = async text => {
    const id = await current();
    const before = (await cmd('loadSession', { sessionId: id })).messages.length;
    await page.locator('#prompt').fill(text); await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await history(id, d => d.messages.length >= before + 2 && d.messages.at(-1)?.role === 'assistant');
    await ready();
  };
  const userTexts = () => page.$$eval('.m.user:not(.cmd) > .body', els => els.map(e => e.dataset.raw ?? e.textContent));
  const humanPresents = d => d.presents.filter(p => p.by === 'human');
  const band = page.locator('.resend-band');
  const editor = page.getByRole('textbox', { name: 'メッセージを編集' });
  try {
  const old = await current();
  await page.getByRole('button', { name: '新しいセッション（絞り込みの条件を引き継ぐ）' }).click();
  await page.waitForFunction(old => localStorage.getItem('agent-host-current') !== old, old);
  await send('echo:前提のコード\n```js\nconst greeting = "<こんにちは>";\nconsole.log(greeting);\n```');
  const source = await current();
  const code = page.locator('#thread .code-block').first();
  await code.waitFor();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await code.hover(); await code.locator('.code-copy').click();
  await page.waitForFunction(() => document.querySelector('.code-copy')?.getAttribute('aria-label') === 'コピーしました');
  check((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n') === await code.locator('code').textContent(), '本文のコードを元の文字列でコピー');
  check(await code.locator('.code-copy').getAttribute('aria-label') === 'コピーしました', 'コピー成功を表示');
  await page.screenshot({ path: `${ROOT}/temporary/message-actions-attachment.png`, clip: { x: 0, y: 0, width: 16, height: 16 } });
  // 添付は入力欄の文中（キャレットの位置）に札として入る。上の「添付 N 件」は入口だけ。本文を先に書いてから添える（fill は札も置き換えるので）
  await page.locator('#prompt').fill('echo:編集前の本文');
  await page.locator('#fileIn').setInputFiles([`${ROOT}/README.md`, `${ROOT}/temporary/message-actions-attachment.png`]);
  await page.locator('#prompt').getByText('README.md').waitFor();
  await page.locator('#prompt').getByRole('img', { name: 'message-actions-attachment.png' }).waitFor();
  {
    const before = (await cmd('loadSession', { sessionId: source })).messages.length;
    await page.locator('#send').click();
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await history(source, d => d.messages.length >= before + 2 && d.messages.at(-1)?.role === 'assistant');
    await ready();
  }
  await send('echo:後続の発言');
  const original = await cmd('loadSession', { sessionId: source });
  const sessionCount = (await cmd('listSessions')).length;
  await page.locator('#prompt').fill('元の会話に残す下書き');

  // ---- 編集して再送信（後ろに自分の発言がある）: 帯が出て、編集欄は自前の送信ボタンを持たない
  const user = page.locator('.m.user').nth(1);
  await menu(user, '編集して再送信');
  await editor.waitFor();
  // 印（[添付] パス）は本文の位置のまま編集欄へ戻す（文中の位置を保つ）
  const editValue = await editor.inputValue();
  check(editValue.startsWith('echo:編集前の本文') && (editValue.match(/\[添付\]/g) ?? []).length === 2, '編集欄に本文と添付の印を位置ごと戻す');
  check((await user.innerText()).includes('README.md'), '編集時に添付名を表示');
  await band.waitFor();
  check(await band.getAttribute('role') === 'group' && await band.getAttribute('aria-label') === '送り方', '帯は「送り方」の group');
  check((await band.innerText()).includes('この後のやり取り（あなたの発言 1 件と返答）は、送り直すと消え、分岐して送ると残ります。'), '帯に後ろの発言の件数と、送り直す・分岐して送るの違いを書く');
  check(await page.locator('.message-edit-controls').count() === 0, '帯があるとき編集欄は自前の送信ボタンを持たない（送り先を 1 か所に）');
  const buttons = await band.locator('button').allInnerTexts();
  check(buttons.map(s => s.trim()).join('|') === '取り消し|分岐して送る|送り直す', '帯のボタンは［取り消し］［分岐して送る］［送り直す］の順（主が右端）');
  check(await band.getByRole('button', { name: '送り直す、この後のやり取り（あなたの発言 1 件と返答）を消します' }).count() === 1, '主のボタンの読み上げ名に消える件数');
  check(await editor.getAttribute('aria-describedby') === await band.locator('.rb-t').getAttribute('id'), '編集欄は帯の文を読み上げに結ぶ');
  const doomedCount = await page.locator('#thread .mw.doomed').count();
  check(doomedCount >= 3, '送り直すと消える範囲（後ろの行）を薄くする');
  await page.waitForTimeout(300);   // 薄くする遷移（120ms）が終わってから見る
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#thread .mw.doomed')).opacity) === '0.42', '薄くする不透明度は .42');
  check((await cmd('loadSession', { sessionId: source })).messages.length === original.messages.length, '押した時点では何も消えない');
  await shot('edit-1280');
  await editor.fill('取り消す変更'); await editor.press('Escape');
  check(await band.count() === 0 && await editor.count() === 0 && await page.locator('#thread .mw.doomed').count() === 0, 'Esc で編集欄と帯を閉じ、薄くした行も戻す');
  check(await page.evaluate(() => document.activeElement?.classList.contains('who-more')), 'Esc のあとフォーカスは ⋯ へ戻る');
  check(await page.locator('#prompt').evaluate(e => e.value) === '元の会話に残す下書き', '取り消しで元の入力欄の下書きを保持');
  await menu(user, '編集して再送信'); await band.waitFor();
  await band.getByRole('button', { name: '取り消し' }).click();
  check(await band.count() === 0 && await editor.count() === 0, '［取り消し］でも閉じる');

  // ---- 送り直す（同じ会話）: 画面を切り替えず、後ろが消えて新しい返答が続く。会話は増えない
  await menu(user, '編集して再送信'); await editor.fill(editValue.replace('echo:編集前の本文', 'echo:変更後の本文'));
  await editor.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('変更後の本文')) && !document.querySelector('.resend-band'));
  await ready();
  const after = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source, '送り直しでは会話を切り替えない');
  check(after.messages[2].text.startsWith('echo:変更後の本文') && !after.messages.some(m => m.text?.includes('後続の発言')), '編集した本文を同じ会話で送り、後続の発言は消える');
  check(after.messages[0].uuid === original.messages[0].uuid && after.messages[1].uuid === original.messages[1].uuid, '切り口より前の発言はそのまま');
  check(humanPresents(after).length === 2 && after.presents.some(p => p.by === 'human' && p.kind === 'image'), '送り直しで画像とファイルを一度だけ引き継ぐ');
  check((await cmd('listSessions')).length === sessionCount, '送り直しで会話（子）は増えない');
  check((await userTexts()).length === 2 && (await userTexts()).at(-1).startsWith('echo:変更後の本文'), '画面でも消えた発言が片付き、新しい本文の吹き出しが置かれる');
  check(await page.locator('#thread .mw.doomed, #thread .mw.leaving').count() === 0, '薄くした行・畳んだ行は残らない');
  check(await page.locator('.branch-row').count() === 0, '送り直しでは枝の地図を作らない');
  check(await page.locator('.sr-live', { hasText: '1 件の発言を消して送り直しました' }).count() === 1, '送ったら読み上げで知らせる');
  check(await page.locator('#prompt').evaluate(e => e.value) === '元の会話に残す下書き', '送り直しでも入力欄の下書きに触らない');
  // 後ろの返答だけでも帯を出す（返答も消える）。再送信は同じ帯・同じ位置で、フォーカスは主のボタン
  const userAfter = page.locator('.m.user').nth(1);
  await menu(userAfter, '再送信');
  await band.waitFor();
  check((await band.innerText()).includes('この後の返答は、送り直すと消え、分岐して送ると残ります。'), '後ろが返答だけのときは「この後の返答は…」');
  check(await page.evaluate(() => document.activeElement?.classList.contains('rb-send')), '再送信で帯が出たらフォーカスは［送り直す］');
  check(await page.locator('.message-editor').count() === 0, '再送信は編集欄を出さない（帯だけ）');
  await page.waitForTimeout(300);
  await shot('resend-1280');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.resend-band'));
  await ready();
  const resent = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant' && d.messages[2].uuid !== after.messages[2].uuid);
  check(await current() === source && resent.messages[2].text === after.messages[2].text, '再送信は同じ本文を同じ会話で送り直す');
  check(humanPresents(resent).length === 2 && resent.presents.some(p => p.by === 'human' && p.kind === 'image'), '再送信でも画像形式と添付を保持');
  check((await cmd('listSessions')).length === sessionCount, '再送信でも会話は増えない');

  // ---- 後ろに何も無いとき: 帯を出さず、編集欄が［取り消し］［送り直す］を持つ。再送信はすぐ送る
  await page.locator('#prompt').fill('slow'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#abort') && !document.querySelector('#abort').hidden);
  await page.locator('#abort').click();
  await ready();
  await history(source, d => d.messages.length === 5 && d.messages.at(-1)?.role === 'user');
  const last = page.locator('.m.user').last();
  await menu(last, '編集して再送信'); await editor.waitFor();
  check(await band.count() === 0, '後ろに何も無いときは帯を出さない');
  const own = await page.locator('.message-edit-controls button').allInnerTexts();
  check(own.map(s => s.trim()).join('|') === '取り消し|送り直す', '編集欄が［取り消し］［送り直す］を持つ');
  check(await page.locator('#thread .mw.doomed').count() === 0, '消えるものが無ければ薄くしない');
  await editor.fill('echo:止めた発言を直した'); await editor.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('止めた発言を直した')) && !document.querySelector('.message-editor'));
  await ready();
  const fixed = await history(source, d => d.messages.length === 6 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source && fixed.messages[4].text === 'echo:止めた発言を直した', '後ろが無い発言は帯なしで同じ会話のまま送り直す');

  // ---- 実行中: 帯に「止まります」を出し、主は［止めて送り直す］。止めてから巻き戻して送る
  await page.locator('#prompt').fill('steps:{"steps":[{"text":"処理を始めます"},{"tool":"Read","input":{"file_path":"a.md"},"result":"ok","ms":2500},{"newMessage":true},{"text":"読み終えました。続きの返答です"}]}');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#abort') && !document.querySelector('#abort').hidden);
  await menu(page.locator('.m.user').nth(1), '再送信');
  await band.waitFor();
  const rowsAtOpen = await page.locator('#thread > .mw').count();
  check((await band.innerText()).includes('実行中の返答は、送り直すと止まります。分岐して送ると、元の会話で続きます。'), '実行中は帯に止まることを書く');
  check(await band.getByRole('button', { name: '止めて送り直す', exact: false }).count() === 1, '主のボタンは［止めて送り直す］');
  // 帯を開いたあとに、走っている返答が足す行にも消える範囲の薄さが付く
  await page.waitForFunction(n => document.querySelectorAll('#thread > .mw').length > n, rowsAtOpen, { timeout: 8000 });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => {
    const host = document.querySelector('.resend-band').closest('.mw');
    const after = [];
    for (let n = host.nextElementSibling; n; n = n.nextElementSibling) if (!n.classList.contains('spine')) after.push(n);
    return after.length > 0 && after.every(n => n.classList.contains('doomed'));
  }), '実行中に後から増えた行にも「消える範囲」の薄さが付く');
  // 帯から走っている返答の増えた行まで 1 枚に収めるため、縦を伸ばして撮る
  if (!SHOTS.startsWith('C:/path/to/')) {
    await page.setViewportSize({ width: 1280, height: 1500 });
    await page.locator('.resend-band').evaluate(el => el.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(400);
    await shot('running-1280');
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  await band.locator('.rb-send').click();
  await page.waitForFunction(() => !document.querySelector('.resend-band'));
  await ready();
  const stopped = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source && !stopped.interrupted && stopped.messages[2].text === after.messages[2].text, '止めて同じ会話で送り直し、中断の印は残さない');
  check(!(await page.locator('#thread').innerText()).includes('中断しました'), '画面にも「中断しました」の行は残らない');

  // ---- 分岐して送る: 今の分岐の経路。子の会話ができて切り替わり、元の会話は残る
  const beforeBranch = await cmd('loadSession', { sessionId: source });
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await editor.fill('echo:分岐で試す本文');
  await band.getByRole('button', { name: '分岐して送る' }).click();
  await page.waitForFunction(source => localStorage.getItem('agent-host-current') !== source, source);
  await ready();
  const child = await current();
  const branched = await history(child, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(branched.messages[2].text.startsWith('echo:分岐で試す本文') && branched.messages[0].uuid === beforeBranch.messages[0].uuid, '分岐して送ると子の会話で新しい本文を送る');
  check(JSON.stringify((await cmd('loadSession', { sessionId: source })).messages) === JSON.stringify(beforeBranch.messages), '分岐して送ると元の会話は残る');
  check((await cmd('listSessions')).length === sessionCount + 1, '分岐して送るときだけ子の会話が増える');
  // Ctrl/⌘+Shift+Enter でも分岐して送る
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await editor.fill('echo:近道で分岐');
  await editor.press('Control+Shift+Enter');
  await page.waitForFunction(child => localStorage.getItem('agent-host-current') !== child, child);
  await ready();
  const grand = await current();
  check((await history(grand, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant')).messages[2].text.startsWith('echo:近道で分岐'), 'Ctrl+Shift+Enter で分岐して送る');

  // ---- 帯を開いたあとに増える行にも、消える範囲の薄さが付く（別の画面・別の送信が足す行）
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await band.waitFor();
  await page.locator('#prompt').fill('echo:帯を開いたあとに増える行'); await page.locator('#send').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('帯を開いたあとに増える行')));
  await page.waitForTimeout(400);
  check(await page.evaluate(() => {
    const host = document.querySelector('.resend-band').closest('.mw');
    const after = [];
    for (let n = host.nextElementSibling; n; n = n.nextElementSibling) if (!n.classList.contains('spine')) after.push(n);
    return after.length > 0 && after.every(n => n.classList.contains('doomed'));
  }), '帯を開いたあとに増えた行にも薄さが付く');
  await editor.press('Escape');
  await ready();

  // ---- 巻き戻しは済んだのに応答が失敗で返る: 本文を失わず、巻き戻さずに同じ messageId で送り直す
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await band.waitFor();
  await editor.fill('echo:応答が失敗しても届く本文');
  failNextRewind = true;
  await editor.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('応答が失敗しても届く本文')) && !document.querySelector('.resend-band'));
  await ready();
  const recovered = await history(grand, d => d.messages.at(-1)?.role === 'assistant' && d.messages.some(m => m.text?.startsWith('echo:応答が失敗しても届く本文')));
  check(await current() === grand && recovered.messages.length === 4 && recovered.messages[2].text.startsWith('echo:応答が失敗しても届く本文'), '巻き戻しは済んだのに応答が失敗しても、本文は失われず同じ会話で送られる');
  check(failNextRewind === false && (await page.locator('#settingsError').textContent()) === '', '失敗の表示は残らない（送り直せたので）');

  // ---- 送れなかったら元の画面に戻して理由を出す
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await band.waitFor();
  await editor.fill('送信に失敗しても残る文');
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(raw) {
      const msg = JSON.parse(raw);
      if (msg.command === 'sendMessage' && msg.args.rewind) { msg.args.sessionId = 'missing-session-for-test'; raw = JSON.stringify(msg); }
      return send.call(this, raw);
    };
    window.restoreMessageActionsSend = () => { WebSocket.prototype.send = send; };
  });
  await editor.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('送り直せませんでした'));
  check(await page.locator('#thread .mw.leaving').count() === 0, '送れなかったら畳んだ行を元に戻す');
  check(await band.count() === 1 && await editor.inputValue() === '送信に失敗しても残る文', '送れなかったら編集欄と帯を開いたまま、書いた本文を残す');
  check(await band.locator('button:disabled').count() === 0, '送れなかったあとはボタンを押し直せる');
  await page.evaluate(() => window.restoreMessageActionsSend());

  // ---- 狭い画面: 帯のボタンは折り返し、主が下段の全幅。横にはみ出さない
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '狭い画面で横にはみ出さない');
  const box = async sel => page.locator(sel).first().boundingBox();
  const send2 = await box('.rb-send'), branch2 = await box('.rb-branch'), group = await box('.resend-band');
  check(send2.y > branch2.y + branch2.height - 1 && send2.width >= group.width - 2, '360px では主のボタンが下段の全幅');
  await shot('edit-360');
  await editor.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.messageActionsProbeSocket.close());
    return results;
  } catch (e) { fail(e); }
}
