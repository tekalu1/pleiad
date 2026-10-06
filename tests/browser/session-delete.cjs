// playwright-cli -s=session-delete run-code --filename=tests/browser/session-delete.cjs
// 認証済みの、実データと分離した fake サーバーを開いてから実行する（LLM は呼ばない）。
// 送った会話の削除（ADR 0147）: 行のメニューの「セッションを削除…」→ 確かめ（戻せないこと・エージェント側の記録は残ること）→
// 「やめる」なら消えない →「削除する」で一覧から消え、開いていた画面は新しい会話の画面へ移る（文脈のメーターも持ち越さない）。
async page => {
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/delete-sent-session-${name}.png` }); };
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(`${label} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  await page.locator('#prompt:not([aria-disabled="true"])').waitFor();
  // 会話を作って送る（画面とは別の接続から。fake は echo: の字を返す）
  await page.evaluate(async () => {
    const socket = new WebSocket(`ws://${location.host}/ws${location.search}`);
    const pending = new Map(); let seq = 0;
    window.sessionDeleteProbe = (command, args = {}) => new Promise((resolve, reject) => {
      const id = `sd-${++seq}`; pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ kind: 'command', command, args, id }));
    });
    await new Promise(resolve => { socket.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.kind === 'ready') return resolve();
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); m.ok ? p.resolve(m.result) : p.reject(Error(m.error)); }
    }; });
  });
  const cmd = (command, args) => page.evaluate(({ command, args }) => window.sessionDeleteProbe(command, args), { command, args });
  const title = `消す会話-${Date.now()}`;
  const { sessionId: id } = await cmd('newSession', { backend: 'fake' });
  await cmd('setTitle', { sessionId: id, title });
  await cmd('runTurn', { sessionId: id, prompt: 'echo:送った会話' });
  const row = page.locator(`.row[data-session="${id}"]`);
  await row.waitFor();
  for (let i = 0; i < 100; i++) { const s = (await cmd('listSessions')).find(x => x.id === id); if (s && !s.unsent) break; await page.waitForTimeout(100); }
  await row.click();
  await page.waitForTimeout(500);

  await row.click({ button: 'right' });
  const labels = await page.evaluate(() => [...document.querySelectorAll('.pop.menu .li .lbl')].map(e => e.textContent));
  check(labels.at(-1) === 'セッションを削除…' && !labels.includes('未送信のセッションを削除…'), '送った会話の行のメニューの最後に「セッションを削除…」');
  await page.getByRole('menuitem', { name: 'セッションを削除…' }).click();
  const head = await page.locator('.pop .head').last().textContent();
  check(head.includes(title) && head.includes('元に戻せません') && head.includes('エージェント側の会話の記録'), '確かめに、戻せないこととエージェント側の記録が残ることを書く');
  await shot('confirm');
  await page.getByRole('menuitem', { name: 'やめる' }).click();
  await page.waitForTimeout(300);
  check(await row.isVisible(), '「やめる」なら消えない');

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'セッションを削除…' }).click();
  await page.getByRole('menuitem', { name: '削除する' }).click();
  await row.waitFor({ state: 'detached', timeout: 10000 });
  check(!(await cmd('listSessions')).some(x => x.id === id), '一覧から消える');
  await page.waitForTimeout(300);
  check(await page.locator('#titleEdit').inputValue() === '' && await page.locator('#contextStrip').isHidden(), '開いていた画面は新しい会話の画面へ移り、文脈のメーターを持ち越さない');
  await shot('after');
  return { passed: true, results };
}
