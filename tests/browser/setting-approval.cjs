// playwright-cli run-code --filename=tests/browser/setting-approval.cjs
// 設定の変更の承認カード（ADR 0082・0088、docs/design-system.md「設定の変更の承認カード」）を、本物の経路で実ブラウザーに出して確かめる:
// fake の会話（承認モード「都度確認」）が `control:` の台本で ply_control の set_setting を呼ぶ → サーバーが会話に承認カード（permission の settingChange）を出し、
// 呼び出しは待たずに承認待ち（status: pending）で返ってターンが終わる → 会話の単独のカード（見出し・設定画面と同じ名前と値・理由・⚠・「拒否」と「変更を許可」だけ。
// 稼働表示に「承認を待っている」を出さない）→ 許可で設定が変わってカードが 1 行に畳まれ、結果の通知（「設定の変更の結果（変更した）」の 1 行）が会話に届く。拒否も同じ。
// 認証済みで、案内を閉じた fake の会話（新しいセッション）から始める。サーバーは prefs.json に confirmAgentSites: true を入れておく
// （AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時ディレクトリ> AGENT_HOST_PORT=<空きポート> AGENT_HOST_LOCALE=ja node core/server.mjs）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  await page.addInitScript(() => {
    if (window.__spWrapped) return;
    window.__spWrapped = true;
    window.__sent = [];
    const Orig = WebSocket.prototype.send;
    WebSocket.prototype.send = function (d) { try { const m = JSON.parse(d); if (m.kind === 'command') window.__sent.push({ command: m.command, args: m.args }); } catch {} return Orig.call(this, d); };
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});

  const call = (args) => 'control:' + JSON.stringify({ name: 'set_setting', arguments: args });
  const send = async (prompt) => {
    await page.evaluate(() => document.getElementById('newSession').click());
    await page.waitForFunction(() => !document.querySelector('.mw.card'));
    await page.locator('#prompt').fill(prompt);
    await page.locator('#prompt').press('Control+Enter');
  };
  // ターンが終わる（送信欄が「送信」に戻り、稼働表示が消える）まで待つ
  const idle = () => page.waitForFunction(() => !document.querySelector('.m.activity'), null, { timeout: 15000 });

  // ============ 1. 許可: 確認を切る（関所を緩める）
  await send(call({ key: 'confirmAgentSites', value: false, reason: '確認のたびに止まってしまうため' }));
  await page.locator('.mw.card .cu-ap').waitFor();
  await page.waitForFunction(() => /"status":\s*"pending"/.test(document.body.textContent), null, { timeout: 15000 });
  await idle();
  const card = await page.evaluate(() => {
    const m = document.querySelector('.mw.card');
    const q = (s) => m.querySelector(s);
    const surface = m.querySelector('.m.card > .card');
    const box = surface.getBoundingClientRect(), col = document.querySelector('.m.ai').getBoundingClientRect();
    const deny = q('.card-actions .btn-quiet').getBoundingClientRect();
    const allow = q('.card-actions .btn-primary').getBoundingClientRect();
    const key = q('.ap-key'), keyTextLeft = key.getBoundingClientRect().left + parseFloat(getComputedStyle(key).paddingLeft);
    return {
      mark: q('.card-head').textContent, q: q('.q').textContent, label: q('.lbl').textContent, key: q('.ap-key').textContent, was: q('.ap-was').textContent, now: q('.ap-now').textContent,
      sub: [...m.querySelectorAll('.cu-ap .sub')].map((x) => x.textContent), warn: q('.warn')?.textContent, buttons: [...m.querySelectorAll('.card-actions .btn')].map((x) => x.textContent),
      text: m.textContent, inRow: Boolean(m.closest('.tc')),
      column: Math.abs(box.left - col.left) <= 1 && Math.abs(box.right - col.right) <= 1,
      gutterClear: getComputedStyle(m).backgroundColor === 'rgba(0, 0, 0, 0)',
      buttonsAligned: Math.abs(deny.left - keyTextLeft) <= 1 && deny.right < allow.left && allow.right <= box.right,
      activity: document.querySelector('.m.activity')?.textContent ?? '', abort: !document.getElementById('abort').hidden,
    };
  });
  if (!card.mark.includes('承認を待っている') || !/が設定を変えようとしています$/.test(card.q) || card.label !== '設定'
      || card.key !== 'エージェントがサイトを使う前に確認' || card.was !== 'オン' || card.now !== 'オフ'
      || !card.sub.includes('設定 › ブラウザー') || !card.sub.includes('理由: 確認のたびに止まってしまうため') || card.warn !== '⚠ 確認なしでできることが増える変更です。'
      || card.buttons.join() !== '拒否,変更を許可' || /confirmAgentSites|関所|true|\{/.test(card.text))
    throw Error('setting approval card: ' + JSON.stringify(card));
  // 会話の単独のカード（ツールの行の中ではない。ターンが終わっても残る）・会話の列の内側・「承認を待っている」の稼働表示も「中断」も出さない
  if (card.inRow || !card.column || !card.gutterClear || !card.buttonsAligned || /承認を待っている/.test(card.activity) || card.abort) throw Error('setting approval placement: ' + JSON.stringify(card));
  await page.getByRole('button', { name: '変更を許可', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mw.card .card.done') && /変更を許可した/.test(document.querySelector('.mw.card')?.textContent ?? ''));
  const folded = await page.evaluate(() => {
    const m = document.querySelector('.mw.card'), box = m.querySelector('.m.card > .card').getBoundingClientRect();
    const col = document.querySelector('.m.ai').getBoundingClientRect();
    return { left: box.left, right: box.right, colLeft: col.left, colRight: col.right };
  });
  if (Math.abs(folded.left - folded.colLeft) > 1 || Math.abs(folded.right - folded.colRight) > 1) throw Error('folded placement: ' + JSON.stringify(folded));
  const answered = await page.evaluate(() => window.__sent.filter((x) => x.command === 'resolvePermission').at(-1));
  if (answered.args.allow !== true || !/^[a-f0-9]{32}$/.test(answered.args.receipt || '') || answered.args.always) throw Error('resolvePermission: ' + JSON.stringify(answered));
  // 結果の通知が会話に届き、開ける 1 行になる（エージェントに渡した全文は開くと読める）
  await page.waitForFunction(() => [...document.querySelectorAll('.m.sys summary')].some((s) => /設定の変更の結果（変更した）/.test(s.textContent)), null, { timeout: 15000 });
  await idle();

  // ============ 2. 拒否: 確認をつけ直し（狭める向きはカードなし）、もう一度切らせる
  await send(call({ key: 'confirmAgentSites', value: true }));
  await page.waitForFunction(() => /"changed":\s*true/.test(document.body.textContent), null, { timeout: 15000 });
  if (await page.locator('.mw.card').count()) throw Error('narrowing asked for approval');
  await idle();
  await send(call({ key: 'confirmAgentSites', value: false }));
  await page.locator('.mw.card .cu-ap').waitFor();
  if (await page.locator('.mw.card .cu-ap .sub').filter({ hasText: '理由' }).count()) throw Error('empty reason shown');
  await idle();
  await page.getByRole('button', { name: '拒否', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mw.card .card.done') && /拒否した/.test(document.querySelector('.mw.card')?.textContent ?? ''));
  const refused = await page.evaluate(() => window.__sent.filter((x) => x.command === 'resolvePermission').at(-1));
  if (refused.args.allow !== false || refused.args.messageKey !== 'userDenied' || !refused.args.receipt) throw Error('deny: ' + JSON.stringify(refused));
  await page.waitForFunction(() => [...document.querySelectorAll('.m.sys summary')].some((s) => /設定の変更の結果（拒否した）/.test(s.textContent)), null, { timeout: 15000 });

  // 狭い幅でも待機中の面・ボタンと、決着後の一行が会話の列から出ない。
  await page.setViewportSize({ width: 360, height: 760 });
  await send(call({ key: 'confirmAgentSites', value: false, reason: '狭い画面での確認' }));
  await page.locator('.mw.card .cu-ap').waitFor();
  const narrow = await page.evaluate(() => {
    const m = document.querySelector('.mw.card'), box = m.querySelector('.m.card > .card').getBoundingClientRect();
    const col = document.querySelector('.m.ai').getBoundingClientRect();
    const buttons = [...m.querySelectorAll('.card-actions button')].map((b) => b.getBoundingClientRect());
    return { box: [box.left, box.right], col: [col.left, col.right], buttons: buttons.map((b) => [b.left, b.right]), scrollWidth: document.documentElement.scrollWidth };
  });
  if (Math.abs(narrow.box[0] - narrow.col[0]) > 1 || Math.abs(narrow.box[1] - narrow.col[1]) > 1
      || narrow.buttons.some(([left, right]) => left < narrow.box[0] || right > narrow.box[1]) || narrow.scrollWidth > 360)
    throw Error('narrow pending placement: ' + JSON.stringify(narrow));
  await page.getByRole('button', { name: '拒否', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.mw.card .card.done'));
  const narrowDone = await page.evaluate(() => {
    const box = document.querySelector('.mw.card .m.card > .card').getBoundingClientRect();
    const col = document.querySelector('.m.ai').getBoundingClientRect();
    return { box: [box.left, box.right], col: [col.left, col.right], scrollWidth: document.documentElement.scrollWidth };
  });
  if (Math.abs(narrowDone.box[0] - narrowDone.col[0]) > 1 || Math.abs(narrowDone.box[1] - narrowDone.col[1]) > 1 || narrowDone.scrollWidth > 360)
    throw Error('narrow folded placement: ' + JSON.stringify(narrowDone));
}
