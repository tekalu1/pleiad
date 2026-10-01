// playwright-cli run-code --filename=tests/browser/computer-use.cjs
// コンピューターの操作の会話の表示（docs/computer-use.md、docs/design-system.md「コンピューターの操作」）を fake の `steps:` 台本で実ブラウザーに出して確かめる:
// 走っている塊（3 行・止める）・アプリの承認が塊の最新の行の場所に出る・終わった塊の 3 行と「ほか N 件」・サムネイルの拡大と ← →・消えた画面・
// Esc で止めた塊（✕ にしない）・高リスクと拒否・止めるの送信・別の会話を待つ行と「その会話へ移る」・中継された承認の単独のカード。
// 認証済みで、案内を閉じた fake の会話（新しいセッション）から始める。サーバー側（computer.state・computerStop・撮った画面の配信・permission の computerApp）はまだ
// 流れてこない前提で、ページの中で足す（WebSocket の onmessage で届いたことにする。送る側は send を包んで控え、computerStop の応答だけ作る）。
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();

  // ---- 準備: WebSocket の送信を控える・computerStop の応答を作る・届いた permission に computerApp を足す
  await page.addInitScript(() => {
    if (window.__cuWrapped) return;
    window.__cuWrapped = true;
    window.__sockets = [];
    window.__sent = [];
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          const m = JSON.parse(e.data);
          if (m.kind === 'event' && m.event?.type === 'permission' && window.__computerApp && !m.event.computerApp) m.event.computerApp = window.__computerApp;
          return fn({ data: JSON.stringify(m) });
        });
      }
      get onmessage() { return super.onmessage; }
      send(d) {
        try {
          const m = JSON.parse(d);
          if (m.kind === 'command') {
            window.__sent.push({ command: m.command, args: m.args });
            if (m.command === 'computerStop') {
              queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result: { stopped: true } }) })));
              return;
            }
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (event) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event }) }));
  });
  const SVG = (c) => `<svg viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="180" fill="${c}"/><rect x="28" y="16" width="170" height="120" rx="5" fill="#f9f9fb"/><text x="40" y="40" font-size="12" fill="#222">shot</text></svg>`;
  const ID = (h) => '0'.repeat(32 - String(h).length) + h;
  await page.route('**/computer-shot/*.jpg', (route) => {
    const id = route.request().url().match(/computer-shot\/([0-9a-f]{32})\.jpg/)?.[1] ?? '';
    if (id.endsWith('f')) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: SVG(['#2b3558', '#3a3160', '#1d2a44'][parseInt(id.at(-1), 16) % 3]) });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});   // 読み直すと最初の案内がまた開く

  const P = 'mcp__ply_computer__';
  const comp = (tool, extra = {}) => ({ tool, state: 'ok', title: extra.title ?? '操作', app: 'メモ帳', display: 1, ...extra });
  const shotStep = (n, title, ms = 500) => ({ tool: `${P}screenshot`, input: { title }, result: 'ディスプレイ 1', ms, images: [{ url: `/computer-shot/${ID(n)}.jpg`, shot: ID(n), width: 1460, height: 821 }], computer: comp('screenshot', { title, shot: ID(n), w: 1460, h: 821 }) });
  const send = async (script) => {
    await page.locator('#newSession').click();
    await page.waitForFunction(() => !document.querySelector('.bundle.cu, .tc-appr'));   // 前の会話の塊に当たらない
    await page.locator('#prompt').fill('steps:' + JSON.stringify(script));
    await page.locator('#prompt').press('Control+Enter');
  };
  const sentOf = (command) => page.evaluate((c) => window.__sent.filter((x) => x.command === c), command);
  const APP = { agent: { id: 'claude', label: 'Claude' }, apps: [{ id: 'exe:c:/windows/system32/notepad.exe', name: 'メモ帳', risk: 'normal' }], first: true };

  // ============ 1. 承認 → 操作 → 終わった塊（3 行・ほか N 件・拡大）
  await page.evaluate((app) => { window.__computerApp = app; }, APP);
  await send({ steps: [
    { tool: `${P}request_access`, input: { title: 'メモ帳の許可', apps: ['メモ帳'] }, result: '許可しました', ask: true, ms: 300, computer: comp('request_access', { title: 'メモ帳の許可' }) },
    shotStep('1', 'メモ帳の画面を撮る'),
    { tool: `${P}left_click`, input: { title: '本文の欄を押す', coordinate: [412, 238] }, result: '押しました', ms: 400, computer: comp('left_click', { title: '本文の欄を押す' }) },
    { tool: `${P}type`, input: { title: '請求書の本文を入力', text: '請求書（下書き）' }, result: '入力しました', ms: 400, computer: comp('type', { title: '請求書の本文を入力' }) },
    { tool: `${P}key`, input: { title: '保存する', text: 'ctrl+s' }, result: '押しました', ms: 400, computer: comp('key', { title: '保存する' }) },
    shotStep('2', '保存のダイアログを撮る'),
    { tool: `${P}left_click`, input: { title: '「保存」を押す', coordinate: [706, 512] }, result: 'Point is outside the target window', error: true, ms: 400, computer: comp('left_click', { title: '「保存」を押す', state: 'failed' }) },
    { tool: `${P}left_click`, input: { title: '「保存」を押す', coordinate: [690, 498] }, result: '押しました', ms: 400, computer: comp('left_click', { title: '「保存」を押す' }) },
    shotStep('3', '保存した後の画面を撮る', 1500),
    { text: '請求書.txt として保存しました。' },
  ] });
  // 走っている間: コンピューターの塊（kind computer）・止める・承認は最新の行の場所
  await page.locator('.bundle.cu.live .rstop').waitFor();
  await page.locator('.bundle.cu .latest .tc-appr .cu-ap').waitFor();
  const waiting = await page.evaluate(() => {
    const b = document.querySelector('.bundle.cu');
    return { head: b.querySelector('.rhead .mix').textContent, stop: b.querySelector('.rstop').textContent, q: b.querySelector('.tc-appr .q').textContent,
      expl: !!b.querySelector('.tc-appr .expl'), sub: b.querySelector('.tc-appr .sub.mono')?.textContent, buttons: [...b.querySelectorAll('.tc-appr .acts .btn')].map((x) => x.textContent),
      rowWaiting: b.querySelector('.latest .tc')?.classList.contains('tc-waiting'), outside: !!document.querySelector('.mw.card'), activity: !!document.querySelector('.m.activity'), n: b.dataset.n };
  });
  if (waiting.head !== 'コンピューターを操作中' || waiting.stop !== '止める' || waiting.q !== 'Claude に「メモ帳」の操作を許可しますか？' || !waiting.expl
      || waiting.sub !== 'c:/windows/system32/notepad.exe' || waiting.buttons.join() !== '常に許可,拒否,この会話で許可' || !waiting.rowWaiting || waiting.outside || waiting.activity || waiting.n !== '1')
    throw Error('approval card: ' + JSON.stringify(waiting));
  await page.locator('.tc-appr .btn-primary').click();
  await page.locator('.tc-appr').waitFor({ state: 'detached' });
  const resolved = await sentOf('resolvePermission');
  if (resolved.length !== 1 || resolved[0].args.allow !== true || resolved[0].args.scope !== 'session') throw Error('resolvePermission: ' + JSON.stringify(resolved));
  if (!(await page.locator('.bundle.cu .tc-note.tc-said').filter({ hasText: 'この会話で許可した' }).count())) throw Error('allowed note missing');

  // 走っている間は見出し + 薄い行 + 最新の行、右に止める。サムネイルは行の右端
  await page.waitForFunction(() => document.querySelector('.bundle.cu')?.dataset.n === '3');
  const live = await page.evaluate(() => { const b = document.querySelector('.bundle.cu'); return { ghost: b.querySelectorAll('.hi.ghost').length, latest: b.querySelectorAll('.latest .tc').length, stop: !!b.querySelector('.rstop') }; });
  if (live.ghost !== 1 || live.latest !== 1 || !live.stop) throw Error('live shape: ' + JSON.stringify(live));

  // 終わったら見出し + 失敗 + 3 行 + ほか N 件
  await page.waitForFunction(() => document.querySelector('.bundle.cu:not(.live)') && document.querySelector('.bundle.cu .more:not([hidden])'));
  const done = await page.evaluate(() => {
    const b = document.querySelector('.bundle.cu');
    const shown = [...b.querySelectorAll('.hist .hi')].filter((h) => !h.classList.contains('hid')).map((h) => h.querySelector('.tc-main').textContent);
    return { head: b.querySelector('.rhead .mix').textContent, n: b.querySelector('.rhead .n').textContent, xm: b.querySelector('.rhead .xm').textContent, shown, more: b.querySelector('.more').textContent,
      stop: !!b.querySelector('.rstop'), thumbs: b.querySelectorAll('.tc-shot').length, errRow: b.querySelectorAll('.tc-error').length };
  });
  if (done.head !== 'コンピューターを操作しました' || done.n !== '9' || done.xm !== '✕ 失敗 1' || done.shown.join('|') !== '「保存」を押す|「保存」を押す|保存した後の画面を撮る'
      || done.more !== 'ほか 6 件' || done.stop || done.thumbs !== 3 || done.errRow !== 1) throw Error('done shape: ' + JSON.stringify(done));
  // 拡大: 同じ塊の画面を ← → で順に
  await page.locator('.bundle.cu .tc-shot').last().click();
  await page.locator('dialog.tc-shot-dlg[open]').waitFor();
  const dlg = () => page.evaluate(() => ({ ttl: document.querySelector('.tc-shot-dlg .ttl').textContent, src: document.querySelector('.tc-shot-dlg .img img')?.getAttribute('src') }));
  let d = await dlg();
  if (!d.ttl.includes('3/3') || !d.ttl.includes('1460×821') || !d.ttl.includes('メモ帳') || !d.src.endsWith(ID('3') + '.jpg')) throw Error('shot dialog: ' + JSON.stringify(d));
  await page.keyboard.press('ArrowLeft');
  d = await dlg();
  if (!d.ttl.includes('2/3') || !d.src.endsWith(ID('2') + '.jpg')) throw Error('shot dialog ←: ' + JSON.stringify(d));
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  d = await dlg();
  if (!d.ttl.includes('1/3')) throw Error('shot dialog clamp: ' + JSON.stringify(d));
  await page.keyboard.press('Escape');
  await page.locator('dialog.tc-shot-dlg[open]').waitFor({ state: 'detached' });
  // ほか N 件を押すと全部、見出しを押すと閉じる
  await page.locator('.bundle.cu .more').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.bundle.cu .hist .hi')].every((h) => !h.classList.contains('hid')));
  if (await page.locator('.bundle.cu .more:not([hidden])').count()) throw Error('more stays after opening');
  await page.locator('.bundle.cu .rhead').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.bundle.cu .hist .hi')].filter((h) => !h.classList.contains('hid')).length === 3);

  // ============ 2. 消えた画面・Esc で止めた塊（✕ にしない）
  await page.evaluate(() => { window.__computerApp = null; });
  await send({ steps: [
    shotStep('f', 'メモ帳の画面を撮る'),   // …f は 404（消えた画面）
    { tool: `${P}left_click`, input: { title: '本文の欄を押す' }, result: '押しました', ms: 300, computer: comp('left_click', { title: '本文の欄を押す' }) },
    { tool: `${P}type`, input: { title: '金額を入力' }, result: 'ユーザーがコンピューターの操作を止めました。', error: true, ms: 300, computer: comp('type', { title: '金額を入力', state: 'stopped', reason: 'escape' }) },
    { text: '操作を止めました。' },
  ] });
  await page.waitForFunction(() => document.querySelector('.bundle.cu:not(.live) .tc-stopped'));
  const esc = await page.evaluate(() => {
    const b = document.querySelector('.bundle.cu');
    return { xm: b.querySelector('.rhead .xm').textContent, err: b.querySelectorAll('.tc-error').length, reason: b.querySelector('.tc-reason')?.textContent, res: b.querySelector('.tc-stopped .tc-res').textContent,
      mark: !!b.querySelector('.tc-stopped .stopmk'), gone: b.querySelector('.tc-shot-gone')?.textContent, more: b.querySelector('.more')?.hidden };
  });
  if (esc.xm !== '止めた' || esc.err !== 0 || esc.reason !== 'あなたが Esc で止めました' || esc.res !== '止めた' || !esc.mark || esc.gone !== '画面は消去済み' || esc.more !== true) throw Error('stopped shape: ' + JSON.stringify(esc));

  // ============ 3. 高リスクの承認 → 拒否（失敗にしない）
  await page.evaluate((app) => { window.__computerApp = { ...app, first: false, apps: [{ id: 'exe:c:/windows/explorer.exe', name: 'エクスプローラー', risk: 'high' }] }; }, APP);
  await send({ steps: [
    { tool: `${P}left_click`, input: { title: 'ダウンロードを開く' }, result: 'denied', error: true, ask: true, ms: 300, computer: comp('left_click', { title: 'ダウンロードを開く', state: 'stopped', reason: 'denied', app: 'エクスプローラー' }) },
    { text: '許可されなかったので止めます。' },
  ] });
  await page.locator('.tc-appr .cu-ap .warn').waitFor();
  const risk = await page.evaluate(() => ({ warn: document.querySelector('.tc-appr .warn').textContent, expl: !!document.querySelector('.tc-appr .expl'), q: document.querySelector('.tc-appr .q').textContent }));
  if (!risk.warn.startsWith('⚠') || risk.expl || risk.q !== 'Claude に「エクスプローラー」の操作を許可しますか？') throw Error('risk card: ' + JSON.stringify(risk));
  await page.locator('.tc-appr .btn-quiet').click();
  await page.locator('.tc-appr').waitFor({ state: 'detached' });
  const denied = (await sentOf('resolvePermission')).at(-1);
  if (denied.args.allow !== false || denied.args.messageKey !== 'userDenied') throw Error('deny args: ' + JSON.stringify(denied));
  await page.waitForFunction(() => document.querySelector('.bundle.cu:not(.live) .rhead') || document.querySelector('.bundle.cu .tc'));
  if (await page.locator('.bundle.cu .tc-error').count()) throw Error('denied counted as failure');

  // ============ 4. 止める（走っている間）
  await page.evaluate(() => { window.__computerApp = null; });
  await send({ steps: [
    shotStep('1', '画面を撮る', 300),
    { tool: `${P}wait`, input: { title: '待つ', duration: 5 }, result: '待ちました', ms: 6000, computer: comp('wait', { title: '待つ' }) },
    { text: '終わりました' },
  ] });
  await page.locator('.bundle.cu.live .rstop').waitFor();
  await page.locator('.bundle.cu.live .rstop').click();
  const stop = (await sentOf('computerStop')).at(-1);
  const current = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  if (!stop || stop.args.sessionId !== current) throw Error('computerStop: ' + JSON.stringify(stop) + ' current=' + current);
  if ((await page.locator('.bundle.cu .rstop').textContent()) !== '止めています…') throw Error('stopping label');

  // ============ 5. 別の会話が操作中: 待つ行と「その会話へ移る」
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('ok');
  await page.locator('#prompt').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('.m.ai'));
  const holderId = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  await send({ steps: [
    { tool: `${P}screenshot`, input: { title: '経費精算の画面を撮る' }, result: 'x', ms: 8000, computer: comp('screenshot', { title: '経費精算の画面を撮る', app: 'Excel' }) },
    { text: '終わりました' },
  ] });
  await page.locator('.bundle.cu.live .tc-running', { hasText: '経費精算の画面を撮る' }).waitFor();
  const mine = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  await page.evaluate(([id, holder]) => window.__deliver({ type: 'computer.state', sessionId: id, state: 'waiting', holder: { sessionId: holder, title: '請求書の下書き' }, since: Date.now() - 14000 }), [mine, holderId]);
  await page.locator('.tc-lockwait').waitFor();
  const wait = await page.evaluate(() => ({ text: document.querySelector('.tc-lockwait .tc-main').textContent, go: document.querySelector('.tc-lockwait .wait-ln .btn')?.textContent, verb: document.querySelector('.tc-lockwait .tc-label').textContent,
    elapsed: document.querySelector('.tc-lockwait .tc-elapsed').textContent, detailsHidden: document.querySelector('.bundle.cu .tc-details').hidden }));
  if (wait.text !== '別の会話（請求書の下書き）が操作中です。終わったら続けます' || wait.go !== 'その会話へ移る' || wait.verb !== '待つ' || !wait.detailsHidden) throw Error('lock wait: ' + JSON.stringify(wait));
  await page.evaluate((id) => window.__deliver({ type: 'computer.state', sessionId: id, state: 'running' }), mine);
  await page.locator('.tc-lockwait').waitFor({ state: 'detached' });
  await page.evaluate(([id, holder]) => window.__deliver({ type: 'computer.state', sessionId: id, state: 'waiting', holder: { sessionId: holder, title: '請求書の下書き' } }), [mine, holderId]);
  await page.locator('.tc-lockwait .wait-ln .btn').click();
  await page.waitForFunction((id) => localStorage.getItem('agent-host-current') === id, holderId);

  // ============ 6. 中継された承認（委譲の子の分）は塊の外の単独のカード
  await page.evaluate(() => { window.__computerApp = null; });
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('ok');
  await page.locator('#prompt').press('Control+Enter');
  await page.waitForFunction(() => document.querySelector('.m.ai'));
  const parent = await page.evaluate(() => localStorage.getItem('agent-host-current'));
  await page.evaluate((id) => window.__deliver({ type: 'permission', id: 'relay-1', kind: 'tool', toolName: 'ply_computer', input: {}, sessionId: id, title: '委譲先「経費の入力」 / Codex に「Excel」の操作を許可しますか？', conversationTitle: '経費の入力', canAlways: true,
    computerApp: { agent: { id: 'codex', label: 'Codex' }, apps: [{ id: 'exe:c:/x/excel.exe', name: 'Excel', risk: 'normal' }], first: false } }), parent);
  await page.locator('.m.card .cu-ap').waitFor();
  const relay = await page.evaluate(() => ({ q: document.querySelector('.m.card .cu-ap .q').textContent, sub: [...document.querySelectorAll('.m.card .cu-ap .sub')].map((x) => x.textContent), buttons: [...document.querySelectorAll('.m.card .card-actions .btn')].map((x) => x.textContent) }));
  if (relay.q !== 'Codex に「Excel」の操作を許可しますか？' || relay.sub[0] !== '委譲先「経費の入力」' || relay.buttons.join() !== '常に許可,拒否,この会話で許可') throw Error('relay card: ' + JSON.stringify(relay));
  await page.locator('.m.card .btn', { hasText: '常に許可' }).click();
  await page.waitForFunction(() => (window.__sent.filter((x) => x.command === 'resolvePermission').at(-1)?.args.scope) === 'always');

  // ============ 7. 開き直した会話（履歴）でも、塊・サムネイル・止めた行が同じに出る
  await page.evaluate(() => { window.__computerApp = null; });
  await send({ steps: [
    shotStep('1', 'メモ帳の画面を撮る', 200),
    { tool: `${P}left_click`, input: { title: '本文の欄を押す' }, result: '押しました', ms: 200, computer: comp('left_click', { title: '本文の欄を押す' }) },
    { tool: `${P}left_click`, input: { title: '「保存」を押す' }, result: 'outside', error: true, ms: 200, computer: comp('left_click', { title: '「保存」を押す', state: 'failed' }) },
    shotStep('2', '保存のダイアログを撮る', 200),
    { tool: `${P}type`, input: { title: 'ファイル名を入力' }, result: 's', error: true, ms: 200, computer: comp('type', { title: 'ファイル名を入力', state: 'stopped', reason: 'escape' }) },
    { text: '止めました。' },
  ] });
  await page.waitForFunction(() => document.querySelector('.bundle.cu:not(.live) .tc-stopped') && document.querySelector('.m.ai .body'));
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.locator('.bundle.cu:not(.live)').waitFor();
  const history = await page.evaluate(() => {
    const b = document.querySelector('.bundle.cu');
    return { head: b.querySelector('.rhead .mix').textContent, n: b.querySelector('.rhead .n').textContent, xm: b.querySelector('.rhead .xm').textContent, thumbs: b.querySelectorAll('.tc-shot').length,
      shown: [...b.querySelectorAll('.hist .hi')].filter((h) => !h.classList.contains('hid')).length, more: b.querySelector('.more')?.textContent, stop: !!b.querySelector('.rstop'), reason: b.querySelector('.tc-reason')?.textContent };
  });
  if (history.head !== 'コンピューターを操作しました' || history.n !== '5' || history.xm !== '✕ 失敗 1 · 止めた' || history.thumbs !== 2 || history.shown !== 3 || history.more !== 'ほか 2 件' || history.stop
      || history.reason !== 'あなたが Esc で止めました') throw Error('history shape: ' + JSON.stringify(history));
  return 'ok';
}
