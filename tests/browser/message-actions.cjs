// playwright-cli -s=message-actions run-code --filename=tests/browser/message-actions.cjs
// 認証済みの、実データと分離した fake サーバーを開いてから実行する。
async page => {
  // run-code は Node のモジュールも process も使えない。このリポジトリの絶対パスを書いてから実行する。
  const ROOT = 'C:/path/to/ply';
  if (ROOT.startsWith('C:/path/to/')) throw Error('ROOT をこのリポジトリの絶対パスに書き換えてください');
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  await page.reload();
  await page.locator('#prompt:not(:disabled)').waitFor();
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
      return !work.turns.length && !document.querySelector('.branch-transition') && !document.querySelector('#send').disabled;
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
  await page.locator('#fileIn').setInputFiles([`${ROOT}/README.md`, `${ROOT}/temporary/message-actions-attachment.png`]);
  await page.locator('#attached').getByText('README.md').waitFor();
  await page.locator('#attached').getByRole('img', { name: 'message-actions-attachment.png' }).waitFor();
  await send('echo:編集前の本文');
  await send('echo:後続の発言');
  const original = await cmd('loadSession', { sessionId: source });
  await page.locator('#prompt').fill('元の会話に残す下書き');
  const user = page.locator('.m.user').nth(1);
  await user.hover(); await user.locator('.editbtn').click();
  const editor = page.getByRole('textbox', { name: 'メッセージを編集' });
  await editor.waitFor();
  check(await editor.inputValue() === 'echo:編集前の本文', '編集欄から自動添付行を除外');
  check((await user.innerText()).includes('README.md'), '編集時に添付名を表示');
  await editor.fill('取り消す変更'); await editor.press('Escape');
  check(await page.locator('#prompt').inputValue() === '元の会話に残す下書き', '取り消しで元の入力欄の下書きを保持');
  await user.hover(); await user.locator('.editbtn').click(); await editor.fill('echo:変更後の本文');
  await page.screenshot({ path: `${ROOT}/temporary/message-actions-edit.png` });
  await editor.press('Control+Enter');
  await page.waitForFunction(source => localStorage.getItem('agent-host-current') !== source, source);
  await ready();
  let edited = await current();
  const after = await history(edited, d => d.messages.filter(m => m.role === 'user').at(-1)?.text.startsWith('echo:変更後の本文') && d.messages.at(-1)?.role === 'assistant');
  await ready();
  check(after.messages.filter(m => m.role === 'user').at(-1).text.startsWith('echo:変更後の本文'), '編集した本文を分岐先で送信');
  check(!after.messages.some(m => m.text?.includes('後続の発言')), '後続の発言を分岐先に含めない');
  check(after.presents.filter(p => p.by === 'human').length === 2 && after.presents.some(p => p.by === 'human' && p.kind === 'image'), '編集送信で画像とファイルを一度だけ引き継ぐ');
  const unchanged = await cmd('loadSession', { sessionId: source });
  check(JSON.stringify(unchanged.messages) === JSON.stringify(original.messages) && unchanged.draft.text === '元の会話に残す下書き', '元の履歴と下書きを保持');
  await page.locator('.m.user').nth(1).hover(); await page.locator('.resendbtn').nth(1).click();
  await page.waitForFunction(id => localStorage.getItem('agent-host-current') !== id, edited);
  edited = await current();
  const attachedResend = await history(edited, d => d.messages.filter(m => m.role === 'user').length === 2 && d.messages.at(-1)?.role === 'assistant');
  check(attachedResend.presents.filter(p => p.by === 'human').length === 2 && attachedResend.presents.some(p => p.by === 'human' && p.kind === 'image'), '再送信でも画像形式と添付を保持');
  // 最初の発言も、同じ本文の再送も根の分岐位置を保つ。
  await page.locator('.m.user').first().hover(); await page.locator('.editbtn').first().click();
  await editor.fill('echo:新しい最初の発言'); await editor.press('Control+Enter');
  await page.waitForFunction(edited => localStorage.getItem('agent-host-current') !== edited, edited); await ready();
  const root = await current();
  await history(root, d => d.messages.length === 2);
  check((await cmd('loadSession', { sessionId: root })).messages[0].text === 'echo:新しい最初の発言', '最初の発言から編集できる');
  check(await page.locator('.branch-row[data-key="m:-1"]').count() === 1, '根に枝の切り替えを表示');
  await page.locator('.m.user').first().hover(); await page.locator('.resendbtn').first().click();
  await page.waitForFunction(root => localStorage.getItem('agent-host-current') !== root, root); await ready();
  const resent = await current();
  await history(resent, d => d.messages.length === 2);
  check((await cmd('loadSession', { sessionId: resent })).messages[0].text === 'echo:新しい最初の発言', '再送信は同じ本文を送る');
  check(await page.locator('.branch-row[data-key="m:-1"]').count() === 1, '同じ本文を再送しても根の分岐を維持');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.m.user').first().hover(); await page.locator('.editbtn').first().click();
  await editor.fill('送信に失敗しても残る文');
  await page.screenshot({ path: `${ROOT}/temporary/message-actions-mobile.png` });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '狭い画面で横にはみ出さない');
  await page.evaluate(() => {
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(raw) {
      const msg = JSON.parse(raw);
      if (msg.command === 'sendMessage') { msg.args.sessionId = 'missing-session-for-test'; raw = JSON.stringify(msg); }
      return send.call(this, raw);
    };
    window.restoreMessageActionsSend = () => { WebSocket.prototype.send = send; };
  });
  await editor.press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('#settingsError').textContent.includes('送信を確認できませんでした'));
  check(await page.locator('#prompt').inputValue() === '送信に失敗しても残る文', '送信失敗でも分岐先の入力を保持');
  await page.evaluate(() => { window.restoreMessageActionsSend(); window.messageActionsProbeSocket.close(); });
  await page.setViewportSize({ width: 1280, height: 720 });
  return results;
}
