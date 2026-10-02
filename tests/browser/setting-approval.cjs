// playwright-cli run-code --filename=tests/browser/setting-approval.cjs
// 設定の変更の承認カード（ADR 0082、docs/design-system.md「設定の変更の承認カード」）を、本物の経路で実ブラウザーに出して確かめる:
// fake の会話（承認モード「都度確認」）が `control:` の台本で ply_control の set_setting を呼ぶ → サーバーが会話に承認カード（permission の settingChange）を出して待つ →
// ply_control のツールの行の下に出るカード（computer use のカードと同じ置き場。見出し・設定画面と同じ名前と値・理由・⚠・「拒否」と「変更を許可」だけ。「承認を待っている」の行は重ねない）
// → 許可で設定が変わり、拒否で変わらない。
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
    await page.locator('#newSession').click();
    await page.waitForFunction(() => !document.querySelector('.mw.card, .tc-appr'));
    await page.locator('#prompt').fill(prompt);
    await page.locator('#prompt').press('Control+Enter');
  };

  // ============ 1. 許可: 確認を切る（関所を緩める）
  await send(call({ key: 'confirmAgentSites', value: false, reason: '確認のたびに止まってしまうため' }));
  await page.locator('.tc-appr .cu-ap').waitFor();
  const card = await page.evaluate(() => {
    const m = document.querySelector('.tc-appr');
    const q = (s) => m.querySelector(s);
    const box = m.getBoundingClientRect(), col = document.querySelector('.m.ai').getBoundingClientRect();
    return {
      mark: q('.h').textContent, q: q('.q').textContent, label: q('.lbl').textContent, key: q('.ap-key').textContent, was: q('.ap-was').textContent, now: q('.ap-now').textContent,
      sub: [...m.querySelectorAll('.cu-ap .sub')].map((x) => x.textContent), warn: q('.warn')?.textContent, buttons: [...m.querySelectorAll('.acts .btn')].map((x) => x.textContent),
      text: m.textContent, inRow: Boolean(m.closest('.tc')), column: box.left >= col.left - 1 && box.right <= col.right + 1,
      cards: document.querySelectorAll('.mw.card').length, activity: document.querySelector('.m.activity')?.textContent ?? '',
      actsLeft: q('.acts .btn').getBoundingClientRect().left - box.left,
    };
  });
  if (!card.mark.includes('承認を待っている') || !/が設定を変えようとしています$/.test(card.q) || card.label !== '設定'
      || card.key !== 'エージェントがサイトを使う前に確認' || card.was !== 'オン' || card.now !== 'オフ'
      || !card.sub.includes('設定 › ブラウザー') || !card.sub.includes('理由: 確認のたびに止まってしまうため') || card.warn !== '⚠ 確認なしでできることが増える変更です。'
      || card.buttons.join() !== '拒否,変更を許可' || /confirmAgentSites|関所|true|\{/.test(card.text))
    throw Error('setting approval card: ' + JSON.stringify(card));
  // computer use のカードと同じ置き場: ツールの行の中・会話の列の内側（単独の .mw.card にしない）・左寄せのボタン・「承認を待っている」の行を重ねない
  if (!card.inRow || !card.column || card.cards || card.actsLeft > 80 || /承認を待っている/.test(card.activity)) throw Error('setting approval placement: ' + JSON.stringify(card));
  await page.getByRole('button', { name: '変更を許可', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.tc-appr') && /変更を許可した/.test(document.querySelector('.tc')?.textContent ?? ''));
  const answered = await page.evaluate(() => window.__sent.filter((x) => x.command === 'resolvePermission').at(-1));
  if (answered.args.allow !== true || !/^[a-f0-9]{32}$/.test(answered.args.receipt || '') || answered.args.always) throw Error('resolvePermission: ' + JSON.stringify(answered));
  // 許可後は、承認前の行に戻って補足が「変更を許可した」になる
  // 設定が実際に変わった（会話の返りに changed: true が出る）
  await page.waitForFunction(() => /"changed":\s*true/.test(document.body.textContent), null, { timeout: 15000 });

  // ============ 2. 拒否: 確認をつけ直し（狭める向きはカードなし）、もう一度切らせる
  await send(call({ key: 'confirmAgentSites', value: true }));
  await page.waitForFunction(() => /"changed":\s*true/.test(document.body.textContent), null, { timeout: 15000 });
  if (await page.locator('.tc-appr').count()) throw Error('narrowing asked for approval');
  await send(call({ key: 'confirmAgentSites', value: false }));
  await page.locator('.tc-appr .cu-ap').waitFor();
  if (await page.locator('.tc-appr .cu-ap .sub').filter({ hasText: '理由' }).count()) throw Error('empty reason shown');
  await page.getByRole('button', { name: '拒否', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.tc-appr') && /拒否した/.test(document.querySelector('.tc')?.textContent ?? ''));
  const refused = await page.evaluate(() => window.__sent.filter((x) => x.command === 'resolvePermission').at(-1));
  if (refused.args.allow !== false || refused.args.messageKey !== 'userDenied' || !refused.args.receipt) throw Error('deny: ' + JSON.stringify(refused));
  await page.waitForFunction(() => /DENIED/.test(document.body.textContent), null, { timeout: 15000 });
}
