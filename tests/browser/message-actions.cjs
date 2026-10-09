// playwright-cli -s=message-actions run-code --filename=tests/browser/message-actions.cjs
// 認証済みの、実データと分離した fake サーバーを開いてから実行する。
// 発言の操作（コピー・⋯・編集して再送信・再送信・分岐して送る）。送り直しは同じ会話の中で、いつもの入力欄を「編集中」にして行う（ADR 0102・0177）。
async page => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/edit-resend-in-composer-impl-${name}.png` }); };
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
  const probe = async () => {
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
  };
  await probe();
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
  const prompt = page.locator('#prompt');
  const note = page.locator('.edit-note');
  const value = () => prompt.evaluate(e => e.value);
  const focusedIn = sel => page.evaluate(sel => { const a = document.activeElement; const root = document.querySelector(sel); return Boolean(a && root && (a === root || root.contains(a))); }, sel);
  // 編集中の入力欄の先頭の 1 行を打ち替える（添付の札は残す。fill は札まで置き換えるので使わない）
  const retype = async text => {
    await prompt.click();
    await page.keyboard.press('Control+Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.insertText(text);
  };
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
  await prompt.fill('echo:編集前の本文');
  await page.locator('#fileIn').setInputFiles([`${ROOT}/README.md`, `${ROOT}/temporary/message-actions-attachment.png`]);
  await prompt.getByText('README.md').waitFor();
  await prompt.getByRole('img', { name: 'message-actions-attachment.png' }).waitFor();
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
  await prompt.fill('元の会話に残す下書き');

  // ---- 編集して再送信（後ろに自分の発言がある）: いつもの入力欄が「編集中」になる。別の編集欄は出ない
  const user = page.locator('.m.user').nth(1);
  await menu(user, '編集して再送信');
  await note.waitFor();
  const editValue = await value();
  check(editValue.startsWith('echo:編集前の本文') && (editValue.match(/\[添付\]/g) ?? []).length === 2, '入力欄に本文と添付の印を位置ごと戻す');
  check(await prompt.getByText('README.md').count() === 1, '添付は入力欄の札として入る');
  check(await page.locator('.message-editor, .resend-band, .message-edit-controls').count() === 0, '発言の場所に別の編集欄・帯は開かない');
  check(await note.getAttribute('role') === 'group' && await note.getAttribute('aria-label') === '編集中', '帯は「編集中」の group');
  check(await focusedIn('#prompt'), '入力欄にフォーカスが移る');
  const noteText = await note.innerText();
  check(/の発言を編集中/.test(noteText) && noteText.includes('「echo:編集前の本文」'), '帯に何時の発言か・先頭の一行を書く');
  check(noteText.includes('この後のやり取り（あなたの発言 1 件と返答）は、送り直すと消え、分岐して送ると残ります。'), '帯に後ろの発言の件数と、送り直す・分岐して送るの違いを書く');
  check(noteText.includes('書きかけの文は、送り直すか取り消すと戻ります。'), '書きかけを脇に取ったことを書く');
  check((await note.locator('.en-acts button').allInnerTexts()).map(s => s.trim()).join('|') === '元の位置へ|取り消す', '帯のボタンは［元の位置へ］［取り消す］');
  check((await page.locator('.erow button').allInnerTexts()).map(s => s.trim()).join('|') === '分岐して送る|送り直す', '入力欄のボタンは［分岐して送る］［送り直す］の順（主が右端）');
  check(await page.locator('.erow').getByRole('button', { name: '送り直す、この後のやり取り（あなたの発言 1 件と返答）を消します' }).count() === 1, '主のボタンの読み上げ名に消える件数');
  check(await prompt.getAttribute('aria-describedby') === await note.getAttribute('id'), '入力欄は帯の文を読み上げに結ぶ');
  check(!(await page.locator('#send').isVisible()) && await page.locator('#composer .send-more:visible, #composer .chip.armed:visible').count() === 0, '送信の円と予約（▾）は編集中は出さない');
  check(await user.locator('.editing-tag').count() === 1 && await user.evaluate(m => m.classList.contains('edit-src')), '元の発言に「編集中」の札を付ける');
  check(await page.locator('#thread .mw.doomed').count() >= 3, '送り直すと消える範囲（後ろの行）を薄くする');
  await page.waitForTimeout(300);   // 薄くする遷移が終わってから見る
  check(await page.evaluate(() => getComputedStyle(document.querySelector('#thread .mw.doomed')).opacity) === '0.42', '薄くする不透明度は .42');
  check((await cmd('loadSession', { sessionId: source })).messages.length === original.messages.length, '押した時点では何も消えない');
  await page.waitForTimeout(700);   // 入力欄の縁の一度の点滅が終わってから撮る
  await shot('1280');

  // ---- 取り消す（Esc）: 直した内容は捨て、書きかけが戻る。フォーカスは入力欄
  await retype('取り消す変更'); await page.keyboard.press('Escape');
  check(await note.count() === 0 && await page.locator('.erow').count() === 0 && await page.locator('#thread .mw.doomed').count() === 0, 'Esc で帯とボタンを閉じ、薄くした行も戻す');
  check(await user.locator('.editing-tag').count() === 0 && await page.locator('#thread .edit-src').count() === 0, '「編集中」の札も外す');
  check(await value() === '元の会話に残す下書き' && await prompt.getByText('README.md').count() === 0, '取り消すと書きかけがそのまま戻る（編集中の添付は残らない）');
  check(await focusedIn('#prompt') && await page.locator('#send').isVisible(), 'Esc のあとフォーカスは入力欄、送信の円も戻る');
  check(await page.locator('.sr-live', { hasText: '編集を取り消しました' }).count() === 1, '取り消したら読み上げで知らせる');
  await menu(user, '編集して再送信'); await note.waitFor();
  await note.getByRole('button', { name: '取り消す' }).click();
  check(await note.count() === 0 && await value() === '元の会話に残す下書き', '［取り消す］でも閉じて書きかけを戻す');

  // ---- 別の発言の編集を選ぶ: 直していなければ黙って切り替え、直していれば帯の中で聞く
  const follow = page.locator('.m.user').nth(2);
  await menu(user, '編集して再送信'); await note.waitFor();
  await menu(follow, '編集して再送信');
  await page.waitForFunction(() => document.querySelector('#prompt').value.startsWith('echo:後続の発言'));
  check(await note.count() === 1 && await follow.evaluate(m => m.classList.contains('edit-src')) && await user.evaluate(m => !m.classList.contains('edit-src')), '直していなければ黙って別の発言の編集へ切り替える');
  check(await page.locator('.en-confirm').count() === 0, '黙って切り替えたので確認は出ない');
  await retype('echo:後続を直した');
  await menu(user, '編集して再送信');
  const confirm = page.locator('.en-confirm');
  await confirm.waitFor();
  check(await confirm.getAttribute('role') === 'group' && (await confirm.innerText()).includes('の発言の編集に切り替えますか？'), '直していれば帯の中で聞く');
  check(await page.evaluate(() => document.activeElement?.textContent.trim()) === '続ける', '確認の初めのフォーカスは［続ける］（直した内容を守る側）');
  await confirm.getByRole('button', { name: '続ける' }).click();
  check(await confirm.count() === 0 && (await value()).startsWith('echo:後続を直した') && await focusedIn('#prompt'), '［続ける］で確認を閉じ、直した内容を保つ');
  await menu(user, '編集して再送信');
  await confirm.getByRole('button', { name: '切り替える' }).click();
  await page.waitForFunction(() => document.querySelector('#prompt').value.startsWith('echo:編集前の本文'));
  check(await user.evaluate(m => m.classList.contains('edit-src')) && await confirm.count() === 0, '［切り替える］で別の発言の編集になる（今の変更は捨てる）');
  check(await page.locator('.edit-note .sub').count() === 1, '脇に取った書きかけは切り替えても保つ');

  // ---- 編集中は読み込み直しても続く（下書きと一緒に保存する）
  await page.reload();
  await prompt.waitFor();
  await note.waitFor();
  await probe();
  check((await value()).startsWith('echo:編集前の本文') && /の発言を編集中/.test(await note.innerText()), '読み込み直しても編集中が続き、元の本文も入っている');
  await page.waitForFunction(() => document.querySelector('.m.user .editing-tag'));
  check(await page.locator('.m.user').nth(1).locator('.editing-tag').count() === 1 && await page.locator('#thread .mw.doomed').count() >= 3, '読み込み直したあとも元の発言の札と薄さが付く');
  await prompt.click();
  await page.keyboard.press('Escape');
  await ready();
  check(await note.count() === 0 && await value() === '元の会話に残す下書き', '読み込み直したあとでも取り消すと書きかけが戻る');

  // ---- 送り直す（同じ会話）: 画面を切り替えず、後ろが消えて新しい返答が続く。会話は増えない
  await menu(user, '編集して再送信'); await note.waitFor();
  await retype('echo:変更後の本文');
  check(await note.locator('.en-confirm').count() === 0 && (await value()).startsWith('echo:変更後の本文') && (await value().then(v => v.match(/\[添付\]/g) ?? [])).length === 2, '先頭の行だけ直しても添付の札は残る');
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('変更後の本文')) && !document.querySelector('.edit-note'));
  await ready();
  const after = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source, '送り直しでは会話を切り替えない');
  check(after.messages[2].text.startsWith('echo:変更後の本文') && !after.messages.some(m => m.text?.includes('後続の発言')), '編集した本文を同じ会話で送り、後続の発言は消える');
  check(after.messages[0].uuid === original.messages[0].uuid && after.messages[1].uuid === original.messages[1].uuid, '切り口より前の発言はそのまま');
  check(humanPresents(after).length === 2 && after.presents.some(p => p.by === 'human' && p.kind === 'image'), '送り直しで画像とファイルを一度だけ引き継ぐ');
  check((await cmd('listSessions')).length === sessionCount, '送り直しで会話（子）は増えない');
  check((await userTexts()).length === 2 && (await userTexts()).at(-1).startsWith('echo:変更後の本文'), '画面でも消えた発言が片付き、新しい本文の吹き出しが置かれる');
  check(await page.locator('#thread .mw.doomed, #thread .mw.leaving, #thread .editing-tag').count() === 0, '薄くした行・畳んだ行・札は残らない');
  check(await page.locator('.branch-row').count() === 0, '送り直しでは枝の地図を作らない');
  check(await page.locator('.sr-live', { hasText: '1 件の発言を消して送り直しました' }).count() === 1, '送ったら読み上げで知らせる');
  check(await value() === '元の会話に残す下書き' && await page.locator('.erow').count() === 0, '送り直したら書きかけが戻り、編集中のボタンは消える');

  // ---- 再送信: 後ろに続きがあるときは同じ形で聞く。フォーカスは［送り直す］。後ろの返答だけでも出す
  const userAfter = page.locator('.m.user').nth(1);
  await menu(userAfter, '再送信');
  await note.waitFor();
  check((await note.innerText()).includes('この後の返答は、送り直すと消え、分岐して送ると残ります。'), '後ろが返答だけのときは「この後の返答は…」');
  check(await page.evaluate(() => document.activeElement?.textContent.includes('送り直す')) && (await value()).startsWith('echo:変更後の本文'), '再送信で編集中になったらフォーカスは［送り直す］、入力欄には元の本文');
  await page.waitForTimeout(700);
  await shot('resend-1280');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.edit-note'));
  await ready();
  const resent = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant' && d.messages[2].uuid !== after.messages[2].uuid);
  check(await current() === source && resent.messages[2].text === after.messages[2].text, '再送信は同じ本文を同じ会話で送り直す');
  check(humanPresents(resent).length === 2 && resent.presents.some(p => p.by === 'human' && p.kind === 'image'), '再送信でも画像形式と添付を保持');
  check((await cmd('listSessions')).length === sessionCount, '再送信でも会話は増えない');
  check(await value() === '元の会話に残す下書き', '再送信のあとも書きかけが戻る');

  // ---- 後ろに何も無いとき: 再送信はすぐ送る。編集して再送信は消えるものが無いので［送り直す］だけ
  await prompt.fill('slow'); await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#abort') && !document.querySelector('#abort').hidden);
  await page.locator('#abort').click();
  await ready();
  await history(source, d => d.messages.length === 5 && d.messages.at(-1)?.role === 'user');
  const last = page.locator('.m.user').last();
  await prompt.fill('途中まで書いた次の発言');
  await menu(last, '編集して再送信'); await note.waitFor();
  check((await page.locator('.erow button:visible').allInnerTexts()).map(s => s.trim()).join('|') === '送り直す', '消えるものが無ければ［分岐して送る］は出さない');
  check(await page.locator('#thread .mw.doomed').count() === 0, '消えるものが無ければ薄くしない');
  await retype('echo:止めた発言を直した');
  await page.locator('.erow').getByRole('button', { name: '送り直す' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('止めた発言を直した')) && !document.querySelector('.edit-note'));
  await ready();
  const fixed = await history(source, d => d.messages.length === 6 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source && fixed.messages[4].text === 'echo:止めた発言を直した', '後ろが無い発言も同じ会話のまま送り直す');
  check(await value() === '途中まで書いた次の発言', '書きかけは［送り直す］のあとに戻る');
  await prompt.fill('');

  // ---- 実行中: 帯に「止まります」を出し、主は［止めて送り直す］。止めてから巻き戻して送る
  await prompt.fill('steps:{"steps":[{"text":"処理を始めます"},{"tool":"Read","input":{"file_path":"a.md"},"result":"ok","ms":2500},{"newMessage":true},{"text":"読み終えました。続きの返答です"}]}');
  await page.locator('#send').click();
  await page.waitForFunction(() => document.querySelector('#abort') && !document.querySelector('#abort').hidden);
  await menu(page.locator('.m.user').nth(1), '再送信');
  await note.waitFor();
  const rowsAtOpen = await page.locator('#thread > .mw').count();
  check((await note.innerText()).includes('実行中の返答は、送り直すと止まります。分岐して送ると、元の会話で続きます。'), '実行中は帯に止まることを書く');
  check(await page.locator('.erow').getByRole('button', { name: '止めて送り直す', exact: false }).count() === 1, '主のボタンは［止めて送り直す］');
  // 編集中に走っている返答が足す行にも消える範囲の薄さが付く
  await page.waitForFunction(n => document.querySelectorAll('#thread > .mw').length > n, rowsAtOpen, { timeout: 8000 });
  await page.waitForTimeout(400);
  check(await page.evaluate(() => {
    const host = document.querySelector('.edit-src').closest('.mw');
    const after = [];
    for (let n = host.nextElementSibling; n; n = n.nextElementSibling) if (!n.classList.contains('spine')) after.push(n);
    return after.length > 0 && after.every(n => n.classList.contains('doomed'));
  }), '実行中に後から増えた行にも「消える範囲」の薄さが付く');
  await page.locator('.erow .btn-primary').click();
  await page.waitForFunction(() => !document.querySelector('.edit-note'));
  await ready();
  const stopped = await history(source, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(await current() === source && !stopped.interrupted && stopped.messages[2].text === after.messages[2].text, '止めて同じ会話で送り直し、中断の印は残さない');
  check(!(await page.locator('#thread').innerText()).includes('中断しました'), '画面にも「中断しました」の行は残らない');

  // ---- 分岐して送る: 子の会話ができて切り替わり、元の会話は残る
  const beforeBranch = await cmd('loadSession', { sessionId: source });
  await prompt.fill('元の会話に戻る下書き');
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await note.waitFor();
  await retype('echo:分岐で試す本文');
  await page.locator('.erow').getByRole('button', { name: '分岐して送る' }).click();
  await page.waitForFunction(source => localStorage.getItem('agent-host-current') !== source, source);
  await ready();
  const child = await current();
  const branched = await history(child, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant');
  check(branched.messages[2].text.startsWith('echo:分岐で試す本文') && branched.messages[0].uuid === beforeBranch.messages[0].uuid, '分岐して送ると子の会話で新しい本文を送る');
  check(JSON.stringify((await cmd('loadSession', { sessionId: source })).messages) === JSON.stringify(beforeBranch.messages), '分岐して送ると元の会話は残る');
  check((await cmd('listSessions')).length === sessionCount + 1, '分岐して送るときだけ子の会話が増える');
  check(await note.count() === 0 && await page.locator('.erow').count() === 0, '分岐した先の入力欄は編集中ではない');
  check(await page.evaluate(id => { const e = JSON.parse(localStorage.getItem('agent-host-drafts-v1') || '[]').find(x => x[0] === id)?.[1]; return e?.text === '元の会話に戻る下書き' && !e.edit; }, source), '分岐して送ると元の会話の下書きに書きかけが戻り、編集中は残らない');
  // Ctrl/⌘+Shift+Enter でも分岐して送る
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await note.waitFor();
  await retype('echo:近道で分岐');
  await page.keyboard.press('Control+Shift+Enter');
  await page.waitForFunction(child => localStorage.getItem('agent-host-current') !== child, child);
  await ready();
  const grand = await current();
  check((await history(grand, d => d.messages.length === 4 && d.messages.at(-1)?.role === 'assistant')).messages[2].text.startsWith('echo:近道で分岐'), 'Ctrl+Shift+Enter で分岐して送る');

  // ---- 会話を切り替えても編集中は持ち主の会話に残る
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await note.waitFor();
  // 一覧の行は playwright の click では選ばれないことがあるので、画面の中で押す（docs/dev-verification.md）
  await page.evaluate(() => document.querySelector('.row[data-session]:not(.sel)').click());
  await page.waitForFunction(id => localStorage.getItem('agent-host-current') !== id, grand);
  check(await note.count() === 0 && await page.locator('#thread .editing-tag').count() === 0, '別の会話を開くと編集中の帯・札は持ち越さない');
  await ready();
  await page.evaluate(id => document.querySelector(`.row[data-session="${id}"]`).click(), grand);
  await page.waitForFunction(id => localStorage.getItem('agent-host-current') === id, grand);
  await note.waitFor();
  check(/の発言を編集中/.test(await note.innerText()) && (await value()).startsWith('echo:近道で分岐'), '元の会話へ戻ると編集中が続いている');
  await page.keyboard.press('Escape');
  await ready();

  // ---- 巻き戻しは済んだのに応答が失敗で返る: 本文を失わず、巻き戻さずに同じ messageId で送り直す
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await note.waitFor();
  await retype('echo:応答が失敗しても届く本文');
  failNextRewind = true;
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.m.user > .body')].some(b => b.textContent.includes('応答が失敗しても届く本文')) && !document.querySelector('.edit-note'));
  await ready();
  const recovered = await history(grand, d => d.messages.at(-1)?.role === 'assistant' && d.messages.some(m => m.text?.startsWith('echo:応答が失敗しても届く本文')));
  check(await current() === grand && recovered.messages.length === 4 && recovered.messages[2].text.startsWith('echo:応答が失敗しても届く本文'), '巻き戻しは済んだのに応答が失敗しても、本文は失われず同じ会話で送られる');
  check(failNextRewind === false && (await page.locator('#settingsError').textContent()) === '', '失敗の表示は残らない（送り直せたので）');

  // ---- 送れなかったら編集中のまま理由を出す
  await menu(page.locator('.m.user').nth(1), '編集して再送信'); await note.waitFor();
  await retype('送信に失敗しても残る文');
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(raw) {
      const msg = JSON.parse(raw);
      if (msg.command === 'sendMessage' && msg.args.rewind) { msg.args.sessionId = 'missing-session-for-test'; raw = JSON.stringify(msg); }
      return send.call(this, raw);
    };
    window.restoreMessageActionsSend = () => { WebSocket.prototype.send = send; };
  });
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('送り直せませんでした'));
  check(await page.locator('#thread .mw.leaving').count() === 0, '送れなかったら畳んだ行を元に戻す');
  check(await note.count() === 1 && (await value()).startsWith('送信に失敗しても残る文'), '送れなかったら編集中のまま、書いた本文を残す');
  check(await page.locator('.erow button:disabled').count() === 0 && await prompt.getAttribute('contenteditable') !== 'false', '送れなかったあとはボタンも入力欄も使える');
  await page.evaluate(() => window.restoreMessageActionsSend());

  // ---- 狭い画面: ボタンは入力欄の下の 2 段目。主が全幅。横にはみ出さない
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '狭い画面で横にはみ出さない');
  const box = async sel => page.locator(sel).first().boundingBox();
  const primary = await box('.erow .btn-primary'), quiet = await box('.erow .btn-quiet'), cbox = await box('#composer .cbox'), crow = await box('#composer .cbox .crow');
  check(await page.locator('.erow.below').count() === 1 && primary.y >= crow.y + crow.height - 2 && primary.y + primary.height <= cbox.y + cbox.height + 2, '360px ではボタンが入力欄の下の 2 段目（枠の中）');
  check(primary.width > quiet.width && primary.x + primary.width <= cbox.x + cbox.width + 2, '360px では主のボタンが残りの幅を取る');
  await shot('360');
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => window.messageActionsProbeSocket.close());
    return results;
  } catch (e) { fail(e); }
}
