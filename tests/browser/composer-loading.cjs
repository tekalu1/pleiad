// playwright-cli run-code --filename=tests/browser/composer-loading.cjs
// 入力欄の待ち（docs/design-system.md「入力欄の待ち」）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（AGENTS.md）。
// fake は即座に答えるので、ページ上で WebSocket.prototype.send を包んでコマンドを遅らせる・失敗させる。
// 撮った画面は temporary/composer-loading-shots/ に置く（playwright-cli を起動した作業ディレクトリからの相対）。
async page => {
  const shots = 'temporary/composer-loading-shots';
  await page.addInitScript(() => {
    const hold = window.__hold = { delay: { listSessions: 1500 }, once: new Set(['listSessions']), fail: new Set(), log: [] };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let m = null;
      try { m = JSON.parse(data); } catch {}
      if (m?.kind !== 'command') return send.call(this, data);
      hold.log.push({ command: m.command, args: m.args, at: Date.now() });
      const ms = hold.delay[m.command] ?? 0;
      if (hold.once.delete(m.command)) delete hold.delay[m.command];
      if (hold.fail.delete(m.command)) {
        setTimeout(() => this.onmessage?.({ data: JSON.stringify({ kind: 'response', id: m.id, ok: false, error: 'forced failure' }) }), ms);
        return;
      }
      if (ms) { setTimeout(() => send.call(this, data), ms); return; }
      return send.call(this, data);
    };
  });
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const ui = () => page.evaluate(() => {
    const p = document.querySelector('#prompt'), box = document.querySelector('#cbox'), send = document.querySelector('#send'), note = document.querySelector('#composerNote');
    return { value: p.value, readOnly: p.readOnly, disabled: p.disabled, busy: box.getAttribute('aria-busy'), wait: box.dataset.wait ?? null,
      busyText: document.querySelector('#composerBusyText').textContent, busyShown: !document.querySelector('#composerBusy').hidden,
      sendDisabled: send.disabled, sendTitle: send.title, sendWait: send.classList.contains('wait'), note: note.hidden ? null : note.textContent };
  });

  // ---- 初めて接続するまで（一覧の読み込みを 1.5 秒遅らせる）
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#cbox').dataset.wait === 'connect');
  let s = await ui();
  check('初めての接続: readonly + aria-busy・「接続しています…」・送信は押せない', s.readOnly && !s.disabled && s.busy === 'true' && s.busyShown && s.busyText === '接続しています…' && s.sendDisabled, JSON.stringify(s));
  await page.locator('#prompt').press('a');
  check('初めての接続: 打鍵を受け付けない', (await ui()).value === '');
  await page.screenshot({ path: `${shots}/1-connecting.png` });
  await page.waitForFunction(() => !document.querySelector('#cbox').hasAttribute('aria-busy'), null, { timeout: 10000 });
  await page.locator('.row[data-session]').first().waitFor();
  await page.evaluate(() => { const c = document.getElementById('closeOnboarding'); if (c && c.offsetParent) c.click(); });

  // ---- ＋ の直後から打つ（newSession・一覧の読み直し・空の履歴の読み込みをそれぞれ 700ms 遅らせる）
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 700, listSessions: 700, loadSession: 700 }));
  const before = await page.evaluate(() => [...document.querySelectorAll('.row[data-session]')].map(r => r.dataset.session));
  await page.locator('#newSession').click();
  await page.locator('#prompt').pressSequentially('abc');
  s = await ui();
  check('作成中: 欄は書ける（readonly・disabled・aria-busy なし）', !s.readOnly && !s.disabled && !s.busy, JSON.stringify(s));
  await page.waitForFunction(() => window.__hold.log.some(l => l.command === 'listSessions' && Date.now() - l.at < 600));
  await page.locator('#prompt').pressSequentially('def');   // 一覧の読み直しの間（以前はここで打った字が消えた）
  await page.screenshot({ path: `${shots}/2-typing-while-creating.png` });
  await page.waitForFunction(() => window.__hold.log.some(l => l.command === 'loadSession' && Date.now() - l.at < 600));
  await page.locator('#prompt').pressSequentially('ghi');   // 空の履歴の読み込みの間
  await page.waitForFunction(ids => { const sel = document.querySelector('.row.sel')?.dataset.session; return sel && !ids.includes(sel) && !sel.startsWith('pending-'); }, before, { timeout: 10000 });
  await page.waitForTimeout(900);
  s = await ui();
  check('作成後: ＋ の直後から打った字が全部残る', s.value === 'abcdefghi', JSON.stringify(s));
  const created = await page.evaluate(() => document.querySelector('.row.sel').dataset.session);
  const drafts = new Map(await page.evaluate(() => JSON.parse(localStorage.getItem('agent-host-drafts-v1') ?? '[]')));
  check('作成後: 作った会話の下書きとして保存・"" の仮置きは無い', drafts.get(created)?.text === 'abcdefghi' && !drafts.has(''), JSON.stringify([...drafts]));
  await page.screenshot({ path: `${shots}/3-created-text-kept.png` });

  // ---- 作成中に送信（newSession を 1.5 秒遅らせる）→ 予約 → できしだい送る
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 1500, listSessions: 0, loadSession: 0 }));
  await page.locator('#newSession').click();
  await page.locator('#prompt').pressSequentially('echo:queued-hello');
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden);
  s = await ui();
  check('作成中の送信: 欄は readonly、字は保つ、欄の上に「会話ができしだい送ります · 取り消す」、送信ボタンに弧', s.readOnly && !s.disabled && s.value === 'echo:queued-hello'
    && s.note.includes('会話ができしだい送ります') && s.note.includes('取り消す') && s.sendWait, JSON.stringify(s));
  await page.screenshot({ path: `${shots}/4-queued-send.png` });
  await page.locator('#composerNote').screenshot({ path: `${shots}/4b-queued-note.png` }).catch(() => {});
  await page.waitForFunction(() => window.__hold.log.some(l => l.command === 'sendMessage' && /queued-hello/.test(l.args.prompt)), null, { timeout: 10000 });
  const sent = await page.evaluate(() => window.__hold.log.find(l => l.command === 'sendMessage' && /queued-hello/.test(l.args.prompt)).args.sessionId);
  const selNow = await page.evaluate(() => document.querySelector('.row.sel')?.dataset.session);
  check('作成中の送信: できしだい作った会話へ送る', sent && sent === selNow, `${sent} / ${selNow}`);
  await page.waitForFunction(() => document.querySelector('#composerNote').hidden && !document.querySelector('#prompt').readOnly);
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${shots}/5-queued-sent.png` });

  // ---- 予約を取り消す
  await page.locator('#newSession').click();
  await page.locator('#prompt').pressSequentially('keep me');
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden);
  await page.locator('#composerNote button').click();
  s = await ui();
  check('取り消す: 欄は書けるように戻り、字は残る', !s.readOnly && s.value === 'keep me' && s.note === null && !s.sendWait, JSON.stringify(s));
  await page.locator('#prompt').pressSequentially('!');
  await page.waitForTimeout(2200);
  const cancelledSent = await page.evaluate(() => window.__hold.log.some(l => l.command === 'sendMessage' && /keep me/.test(l.args.prompt)));
  check('取り消す: 送らない。作った後も字は残る', !cancelledSent && (await ui()).value === 'keep me!');

  // ---- 別の会話を開く（loadSession を 1.5 秒遅らせる）
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 0, loadSession: 1500 }));
  const other = page.locator('.row[data-session]:not(.sel)').first();
  await other.click();
  await page.waitForFunction(() => document.querySelector('#cbox').dataset.wait === 'history');
  s = await ui();
  check('会話を開く: readonly + aria-busy・「履歴を読み込み中…」・送信は押せない', s.readOnly && !s.disabled && s.busy === 'true' && s.busyShown && s.busyText === '履歴を読み込み中…' && s.sendDisabled, JSON.stringify(s));
  const valueBefore = s.value;
  await page.locator('#prompt').press('z');
  check('会話を開く: 打鍵を受け付けない', (await ui()).value === valueBefore);
  await page.screenshot({ path: `${shots}/6-opening-session.png` });
  await page.locator('#cbox').screenshot({ path: `${shots}/6b-opening-composer.png` });
  await page.waitForFunction(() => !document.querySelector('#cbox').hasAttribute('aria-busy'), null, { timeout: 10000 });
  s = await ui();
  check('会話を開く: 読めたら書ける', !s.readOnly && !s.sendDisabled, JSON.stringify(s));

  // ---- 読み込みの失敗 → もう一度読む
  await page.evaluate(() => { window.__hold.delay.loadSession = 400; window.__hold.fail.add('loadSession'); });
  await page.locator('.row[data-session]:not(.sel)').first().click();
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden, null, { timeout: 10000 });
  s = await ui();
  check('失敗: 欄は書ける・欄の上に理由と「もう一度読む」・送信は押せず title に理由', !s.readOnly && !s.disabled && !s.busy && s.note.includes('もう一度読む')
    && s.sendDisabled && s.sendTitle.includes('履歴を読み込めていない'), JSON.stringify(s));
  await page.locator('#prompt').focus();
  await page.keyboard.press('End');
  await page.locator('#prompt').pressSequentially(' typed-after-fail');
  const valFail = (await ui()).value;
  check('失敗: 書ける', valFail.endsWith(' typed-after-fail'), `got: "${valFail}"`);
  await page.screenshot({ path: `${shots}/7-load-failed.png` });
  await page.locator('#composerNote button').click();
  await page.waitForFunction(() => document.querySelector('#composerNote').hidden && !document.querySelector('#cbox').hasAttribute('aria-busy'), null, { timeout: 10000 });
  s = await ui();
  check('もう一度読む: 読めたら書けて送れる。失敗の後に書いた字は残る', !s.readOnly && !s.sendDisabled && s.value.endsWith(' typed-after-fail'), JSON.stringify(s));
  await page.screenshot({ path: `${shots}/8-retried.png` });

  // ---- 作成中に作業場所を選ぶ（newSession を 1.5 秒遅らせる）
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 1500, listSessions: 0, loadSession: 0 }));
  const folderA = 'D:\\dev\\pleiad\\temporary\\cwd-race\\folder-A';
  await page.locator('#newSession').click();
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(folderA);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.waitForTimeout(400);
  const chipDuringA = await page.evaluate(() => document.querySelector('#cwdChip .v')?.textContent);
  check('作成中: チップに選んだ作業場所が出る', chipDuringA === 'folder-A', chipDuringA);
  await page.screenshot({ path: `${shots}/9-pick-cwd-during.png` });

  // 作成が終わるまで待つ
  await page.waitForFunction(() => {
    const sel = document.querySelector('.row.sel')?.dataset.session;
    return sel && !sel.startsWith('pending-');
  }, null, { timeout: 10000 });
  await page.waitForTimeout(600);
  const chipAfterA = await page.evaluate(() => document.querySelector('#cwdChip .v')?.textContent);
  check('作成後: チップがホームに戻らず選んだ場所のまま', chipAfterA === 'folder-A', chipAfterA);
  const createdIdA = await page.evaluate(() => document.querySelector('.row.sel').dataset.session);
  await page.screenshot({ path: `${shots}/10-created-cwd-kept.png` });

  // 送信して sendMessage の cwd を確かめる
  await page.locator('#prompt').fill('echo:hello-pick-during');
  await page.locator('#send').click();
  await page.waitForFunction(() => window.__hold.log.some(l => l.command === 'sendMessage' && /hello-pick-during/.test(l.args?.prompt)), null, { timeout: 10000 });
  await page.waitForTimeout(1000);
  const sendCmdA = await page.evaluate(() => window.__hold.log.find(l => l.command === 'sendMessage' && /hello-pick-during/.test(l.args?.prompt)));
  check('作成後に送信: sendMessage の cwd が選んだ場所', sendCmdA?.args?.cwd === folderA, JSON.stringify(sendCmdA?.args));

  // サーバーで実際に走った cwd を確かめる
  const serverRowA = await page.evaluate((id) => new Promise(resolve => {
    const loc = window.location;
    const ws = new WebSocket(`${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws${loc.search}`);
    const send = WebSocket.prototype.send;
    ws.onopen = () => send.call(ws, JSON.stringify({ kind: 'command', command: 'listSessions', id: 9991, args: {} }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === 'response' && m.id === 9991) {
          const list = m.result?.sessions ?? m.result ?? [];
          const row = (Array.isArray(list) ? list : []).find(s => (s.id ?? s.sessionId) === id);
          resolve(row ? { cwd: row.cwd } : null);
          ws.close();
        }
      } catch {}
    };
    setTimeout(() => resolve(null), 5000);
  }), createdIdA);
  check('サーバーで走った cwd が選んだ場所', serverRowA?.cwd === folderA, JSON.stringify(serverRowA));

  // ---- 作成中に作業場所を選び、送信も予約する
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 1500, listSessions: 0, loadSession: 0 }));
  const folderB = 'D:\\dev\\pleiad\\temporary\\cwd-race\\folder-B';
  await page.locator('#newSession').click();
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(folderB);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.waitForTimeout(400);
  await page.locator('#prompt').fill('echo:hello-queued-cwd');
  await page.locator('#send').click();
  await page.waitForFunction(() => !document.querySelector('#composerNote').hidden);
  check('作成中の送信: 予約状態になる', (await ui()).note.includes('会話ができしだい送ります'));

  await page.waitForFunction(() => window.__hold.log.some(l => l.command === 'sendMessage' && /hello-queued-cwd/.test(l.args?.prompt)), null, { timeout: 10000 });
  await page.waitForTimeout(1000);
  const sendCmdB = await page.evaluate(() => window.__hold.log.find(l => l.command === 'sendMessage' && /hello-queued-cwd/.test(l.args?.prompt)));
  check('送信予約: sendMessage の cwd が選んだ場所', sendCmdB?.args?.cwd === folderB, JSON.stringify(sendCmdB?.args));
  const createdIdB = await page.evaluate(() => document.querySelector('.row.sel').dataset.session);

  const serverRowB = await page.evaluate((id) => new Promise(resolve => {
    const loc = window.location;
    const ws = new WebSocket(`${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws${loc.search}`);
    const send = WebSocket.prototype.send;
    ws.onopen = () => send.call(ws, JSON.stringify({ kind: 'command', command: 'listSessions', id: 9992, args: {} }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.kind === 'response' && m.id === 9992) {
          const list = m.result?.sessions ?? m.result ?? [];
          const row = (Array.isArray(list) ? list : []).find(s => (s.id ?? s.sessionId) === id);
          resolve(row ? { cwd: row.cwd } : null);
          ws.close();
        }
      } catch {}
    };
    setTimeout(() => resolve(null), 5000);
  }), createdIdB);
  check('予約送信: サーバーで走った cwd が選んだ場所', serverRowB?.cwd === folderB, JSON.stringify(serverRowB));

  // ---- 作成中に model・mode・作業場所を選ぶ（newSession の応答後、一覧の読み直しを 3 秒遅らせた間）
  // 以前は、チップがその間の選択を会話に渡さず、できた会話の値（サーバーの値・既定）に戻った
  const folderC = 'D:\\dev\\pleiad\\temporary\\cwd-race\\folder-A';
  const chips = () => page.evaluate(() => ({
    cwd: document.querySelector('#cwdChip .v')?.textContent, model: document.querySelector('#modelChip')?.dataset.value,
    mode: document.querySelector('#modeChip')?.dataset.value,
  }));
  // 基準: モデルは smart・承認モードは default・作業場所は folder-A 以外にしておく（選んだ値が変化として見える）
  await page.evaluate(() => Object.assign(window.__hold.delay, { newSession: 0, listSessions: 0, loadSession: 0 }));
  await page.locator('#newSession').click();
  await page.waitForFunction(() => { const sel = document.querySelector('.row.sel')?.dataset.session; return sel && !sel.startsWith('pending-'); }, null, { timeout: 10000 });
  await page.waitForTimeout(500);
  const base = await chips();
  check('基準: 作成中に選ぶ前のチップは smart / default / folder-A 以外', base.model === '' && base.mode === 'default' && base.cwd !== 'folder-A', JSON.stringify(base));

  await page.evaluate(() => { Object.assign(window.__hold.delay, { newSession: 300, listSessions: 3000, loadSession: 0 }); window.__hold.log.length = 0; window.__samples = []; });
  const beforeRows = await page.evaluate(() => [...document.querySelectorAll('.row[data-session]')].map(r => r.dataset.session));
  await page.locator('#newSession').click();
  // newSession の応答が来て、一覧の読み直し(listSessions)を送ったところで選ぶ
  await page.waitForFunction(() => { const l = window.__hold.log, i = l.map(x => x.command).lastIndexOf('newSession'); return i >= 0 && l.slice(i).some(x => x.command === 'listSessions'); }, null, { timeout: 10000 });
  await page.evaluate(() => {
    const read = () => ({ cwd: document.querySelector('#cwdChip .v')?.textContent, model: document.querySelector('#modelChip')?.dataset.value, mode: document.querySelector('#modeChip')?.dataset.value });
    window.__sampler = setInterval(() => window.__samples.push({ t: Date.now(), ...read() }), 40);
  });
  await page.locator('#modelChip').click();
  await page.locator('#modelPop [data-key="model:fast"]').click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.locator('#modeChip').click();
  const modeOpts = page.locator('#modePop .copt');
  for (let i = 0, n = await modeOpts.count(); i < n; i++) { if (!(await modeOpts.nth(i).locator('.tick').textContent())) { await modeOpts.nth(i).click(); break; } }
  await page.waitForTimeout(150);
  await page.keyboard.press('Escape');
  await page.locator('#cwdChip').click();
  await page.locator('#cwdPop .cpath').fill(folderC);
  await page.locator('#cwdPop .cpath').press('Enter');
  await page.waitForTimeout(300);
  const picked = await chips();
  const tPicked = await page.evaluate(() => Date.now());
  check('一覧の読み直し中に選んだ値がチップに出る', picked.model === 'fast' && picked.mode !== 'default' && picked.cwd === 'folder-A', JSON.stringify(picked));
  // 読み直しが終わる（3 秒後）まで待ち、会話が開いてからさらに待つ
  await page.waitForFunction(ids => { const sel = document.querySelector('.row.sel')?.dataset.session; return sel && !ids.includes(sel) && !sel.startsWith('pending-'); }, beforeRows, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const settled = await chips();
  const flicker = await page.evaluate(({ t, want }) => { clearInterval(window.__sampler); return window.__samples.filter(x => x.t >= t && (x.model !== want.model || x.mode !== want.mode || x.cwd !== want.cwd)); }, { t: tPicked, want: picked });
  check('読み直しが終わって会話が開いても、選んだ値のまま（モデル・承認モード・作業場所）', settled.model === picked.model && settled.mode === picked.mode && settled.cwd === picked.cwd, JSON.stringify(settled));
  check('その間、チップが一瞬も戻らない', flicker.length === 0, JSON.stringify(flicker.slice(0, 3)));
  const createdId = await page.evaluate(() => document.querySelector('.row.sel').dataset.session);
  const sentCmds = await page.evaluate(() => window.__hold.log.filter(l => ['setTurnSettings', 'setMode', 'setPref'].includes(l.command)).map(l => ({ command: l.command, args: l.args })));
  check('できた会話へモデル・承認モード・作業場所が渡る', sentCmds.some(c => c.command === 'setTurnSettings' && c.args.sessionId === createdId && c.args.model === 'fast')
    && sentCmds.some(c => c.args.sessionId === createdId && c.args.mode === (picked.mode)) && sentCmds.some(c => c.command === 'setTurnSettings' && c.args.sessionId === createdId && c.args.cwd === folderC), JSON.stringify(sentCmds));
  check('承認モードで既定のモード（setPref）を書き換えない', !sentCmds.some(c => c.command === 'setPref'), JSON.stringify(sentCmds));
  await page.screenshot({ path: `${shots}/11-settings-during-creation.png` });

  return { passed: true, checks };
}
