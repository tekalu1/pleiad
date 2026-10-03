// playwright-cli -s=routine-sheet run-code --filename=tests/browser/routine-sheet.cjs
// 実データと分離したサーバー（AGENT_HOST_BACKENDS=fake・別ポート・使い捨ての置き場。ポート 7433・トークン routine-test）を開いてから実行する。
// ルーティンの編集のシート・脇のルーティンの節・チャンネルの見出しの［ルーティン n］・bot のページの節（web/channels/routine-sheet.mjs・routine-entry.mjs・sidebar.mjs。ADR 0111）:
//   作る（検査・種類ごとの欄・次の時刻・承認モード・期限）・試しに動かす（一時停止で作って dryRun で走らせ、取り消すと消す）・直して保存・一時停止/再開・削除（2 度押し）・
//   脇は次の時刻の近い順に 3 件（一時停止は薄く、失敗は「✕ 失敗」）・出来事 routinesChanged で脇と見出しが更新される・360 幅は全画面で横にはみ出さない。
// チャンネルは本物の channels.*。routines.*（R1 の操作）と bots.list / bots.get はページの中で答える（記録は window.__rcalls）。
async page => {
  const URL = 'http://127.0.0.1:7433/?token=routine-test';
  // 画面を撮るときだけ、撮影の置き場（絶対パス）を書く。書かなければ撮らない
  const SHOTS = 'C:/path/to/shots';
  const shot = async name => { if (!SHOTS.startsWith('C:/path/to/')) await page.screenshot({ path: `${SHOTS}/bots-w5-routine-sheet-${name}.png` }); };
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(`${label} （直前に通った項目: ${results.at(-1) ?? '無し'}）`); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  // ---- 準備: WebSocket を包む（routines.*・bots.list・bots.get はページで答える。invoke を呼べる・出来事を流せる）
  await page.addInitScript(() => {
    if (window.__rtWrapped) return;
    window.__rtWrapped = true;
    window.__sockets = [];
    window.__calls = new Map();
    window.__rcalls = [];
    window.__routines = [];
    window.__runState = 'done';
    window.__runDelay = 250;
    window.__bots = [
      { id: 'b_owl', name: 'Owl', icon: '🦉', backend: 'fake', mode: 'default', state: 'idle', dmChannelId: null, folders: [], persona: '', model: '', effort: '', sendToOthers: true },
      { id: 'b_lynx', name: 'Lynx', icon: '🐺', backend: 'fake', mode: 'bypass', state: 'idle', dmChannelId: null, folders: [], persona: '', model: '', effort: '', sendToOthers: true },
    ];
    let seq = 0;
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
        try {
          const m = JSON.parse(d);
          if (m.kind === 'command' && m.command === 'invoke') {
            const { op, args = {} } = m.args ?? {};
            const reply = (result, delay = 0) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: true, result }) })), delay);
            const fail = (error) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'response', id: m.id, ok: false, error }) })), 0);
            const event = (routine, removed) => setTimeout(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event: { type: 'routinesChanged', sessionId: null, ...(removed ? { removed } : { routine }) } }) })), 10);
            if (op === 'bots.list') { reply({ bots: window.__bots }); return; }
            if (op === 'bots.get') { const b = window.__bots.find(x => x.id === args.botId); b ? reply({ ...b, usage: { weekTokens: 0, cacheRatio: null } }) : fail('BOT_NOT_FOUND'); return; }
            if (op?.startsWith('routines.')) {
              window.__rcalls.push({ op, args: JSON.parse(JSON.stringify(args)) });
              const find = () => window.__routines.find(r => r.id === args.routineId);
              if (window.__rfail?.[op]) { fail(window.__rfail[op]); return; }
              if (op === 'routines.list') { reply({ routines: window.__routines.map(r => ({ ...r })) }); return; }
              if (op === 'routines.get') { find() ? reply({ ...find() }) : fail('ROUTINE_NOT_FOUND'); return; }
              if (op === 'routines.create') {
                seq += 1;
                const r = { id: `r_${seq}`, createdBy: { kind: 'human' }, createdAt: Date.now(), paused: false, nextAt: Date.now() + 3600e3 * seq, ...args };
                window.__routines.push(r); reply({ ...r }); event({ ...r }); return;
              }
              if (op === 'routines.update') { const r = find(); if (!r) { fail('ROUTINE_NOT_FOUND'); return; } const { routineId, ...patch } = args; Object.assign(r, patch); reply({ ...r }); event({ ...r }); return; }
              if (op === 'routines.pause' || op === 'routines.resume') { const r = find(); if (!r) { fail('ROUTINE_NOT_FOUND'); return; } r.paused = op === 'routines.pause'; reply({ ...r }); event({ ...r }); return; }
              if (op === 'routines.delete') { window.__routines = window.__routines.filter(r => r.id !== args.routineId); reply({ ok: true }); event(null, args.routineId); return; }
              if (op === 'routines.run') { reply({ runId: 'run_1', postId: null, state: window.__runState, summary: window.__runState === 'failed' ? 'infra-deploy を読む権限がありません' : '会話 3 件を読み、承認を 0 回求めた' }, window.__runDelay); return; }
            }
          }
        } catch {}
        return super.send(d);
      }
    };
    window.__deliver = (event) => window.__sockets.at(-1).dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ kind: 'event', event }) }));
    window.__rpc = (op, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op, args } }));
    });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('channelsView'));
  const deliver = event => page.evaluate(e => window.__deliver(e), event);
  const rpc = (op, args) => page.evaluate(([o, a]) => window.__rpc(o, a), [op, args]);
  const calls = op => page.evaluate(o => window.__rcalls.filter(c => c.op === o), op);
  const showChannel = id => page.evaluate(i => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id: i } })), id);
  const sheet = page.locator('#routineSheet');
  const pick = async (chip, key) => { await page.locator(chip).click(); await page.locator(`.cpop:not([hidden]) [data-key="${key}"]`).click(); };

  // ---- チャンネルを作って開く。ルーティンが無い間も［ルーティン］の入口がある（数は付けない）
  const name = 'daily' + String(Date.now()).slice(-5);
  const ch = await rpc('channels.create', { name, purpose: '毎日の見回りとまとめ' });
  await page.locator('#tabChannels').click();
  await showChannel(ch.id);
  await page.locator('#chFeed').waitFor();
  await page.waitForSelector('.ch-routines');
  check(await page.locator('.ch-routines .rt-n').textContent() === '', '見出しにルーティンの入口がある（無い間は数を付けない）');
  check(await page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-empty').count() === 1, '脇のルーティンの節は、無い間は空の状態');
  await page.waitForFunction(() => window.__rcalls.some(c => c.op === 'routines.list'));   // 接続の前に読めなかったときは、少し待って読み直す
  check(true, 'ルーティンの一覧は routines.list で読む');

  // ---- 入口 → シート（名前に入る。種類は毎日、bot は先頭、チャンネルは今開いているもの）
  await page.locator('.ch-routines').click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.evaluate(() => document.activeElement?.id) === 'rsName', 'シートが開いて名前の欄に入る');
  check(await page.locator('#rsChannelChip .v').textContent().then(s => s.includes(name)), 'チャンネルは今開いているもの');
  check(await page.locator('#rsBotChip .v').textContent().then(s => s.includes('Owl')), 'bot は先頭');
  check(await page.locator('[data-when="daily"]').getAttribute('aria-pressed') === 'true', '種類は毎日');
  check(await page.locator('[data-when="webhook"]').isDisabled(), 'webhook は選べない形だけ（無効）');
  await page.waitForFunction(() => document.querySelector('#rsModeChip .v')?.textContent === '都度確認');
  check(await page.locator('#rsModeChip').getAttribute('data-value') === 'default', '承認モードは bot のモード（都度確認）');
  check(await page.locator('#rsTimeoutChip .v').textContent() === '30 分', '承認待ちの期限は 30 分');
  check(await page.locator('#rsNext').textContent().then(s => /^次は /.test(s)), '毎日・毎週は「次は …」を出す');
  await shot('01-new');

  // ---- 検査: 空のまま作ると作らず、欄の下に理由を出す
  await page.locator('#rsSave').click();
  check(await page.locator('[data-fld="name"] .fe').isVisible() && await page.locator('[data-fld="prompt"] .fe').isVisible(), '名前と指示が空なら作らず、欄の下に理由を出す');
  check((await calls('routines.create')).length === 0, '検査で落ちたときは routines.create を呼ばない');
  check(await page.evaluate(() => document.activeElement?.id) === 'rsName', '最初の誤りの欄に戻る');
  await shot('02-errors');

  // ---- いつ: 種類ごとの欄
  await page.locator('[data-when="weekly"]').click();
  check(await page.locator('.dayp button').count() === 7 && await page.locator('.dayp button.on').count() === 1, '毎週は曜日が 7 つ（月 … 日）で、月だけが入っている');
  check(await page.locator('.dayp button').first().textContent() === '月' && await page.locator('.dayp button').last().textContent() === '日', '曜日は月から日の順');
  await page.locator('.dayp button.on').click();
  await page.locator('#rsName').fill('朝のまとめ');
  await page.locator('#rsPrompt').fill('夜の間に失敗・中断した会話を調べて、原因と次の一手を 3 行ずつまとめて。');
  await page.locator('#rsSave').click();
  check(await page.locator('[data-fld="trigger"] .fe').isVisible(), '毎週で曜日が 0 のときは作らない');
  await page.locator('.dayp button[data-day="3"]').click();
  await page.locator('.dayp button[data-day="1"]').click();
  check(await page.locator('.dayp button.on').count() === 2, '曜日を押すと入る・外れる');
  await page.locator('[data-when="interval"]').click();
  check(await page.locator('#rsEvery .v').textContent() === '30 分ごと' && await page.locator('#rsWindow .v').textContent() === '終日', '間隔は「30 分ごと」「終日」');
  await pick('#rsEvery', 'min:120');
  check(await page.locator('#rsEvery .v').textContent() === '2 時間ごと', '間隔を選べる（2 時間ごと）');
  await pick('#rsWindow', 'window');
  check(await page.locator('#rsFrom').inputValue() === '09:00' && await page.locator('#rsTo').inputValue() === '19:00', '時間帯を指定すると開始・終了の欄が出る（9:00–19:00）');
  await page.locator('[data-when="cron"]').click();
  await page.locator('#rsCron').fill('0 9 * * 1-5');
  check(await page.locator('#rsNext').textContent().then(s => s.includes('平日の 9:00') && s.includes('次は ')), 'cron は読み下しと「次は …」を出す');
  await page.locator('#rsCron').fill('0 9 * *');
  check(await page.locator('#rsNext').textContent().then(s => s.includes('5 欄')), '読めない式は書き方の手がかりを出す');
  await page.locator('#rsSave').click();
  check(await page.locator('[data-fld="trigger"] .fe').textContent().then(s => s.includes('5 欄')), '読めない式は作らない');
  await shot('03-cron');
  await page.locator('[data-when="event"]').click();
  check(await page.locator('[data-on]').count() === 3 && await page.locator('[data-on="failed"]').getAttribute('aria-pressed') === 'true', 'イベントは完了・失敗・あなた待ちで、失敗が入っている');
  await page.locator('[data-on="waiting"]').click();
  check(await page.locator('[data-on="waiting"]').getAttribute('aria-pressed') === 'true' && await page.locator('.rs-scope').textContent() === 'すべての会話', 'イベントを選べる。対象はすべての会話');
  await shot('04-event');

  // ---- 試しに動かす: 一時停止で作って dryRun で走らせる。取り消すと消す
  await page.locator('[data-when="daily"]').click();
  await page.locator('#rsAt').fill('07:30');
  await page.locator('#rsTryBtn').click();
  await page.waitForFunction(() => document.getElementById('rsTry')?.textContent.includes('試しに動いています'));
  check(await page.locator('#rsTryBtn').isDisabled(), '試している間は押せない');
  await shot('05-trying');
  await page.waitForFunction(() => document.getElementById('rsTry')?.textContent.includes('終了'));
  check(await page.locator('#rsTry').textContent().then(s => s.includes('会話 3 件を読み、承認を 0 回求めた')), '試しの結果（終了・要約）を足に出す');
  const created = await calls('routines.create');
  check(created.length === 1 && created[0].args.paused === true && created[0].args.name === '朝のまとめ' && created[0].args.trigger.at === '07:30', '試すために一時停止で作る');
  const ran = await calls('routines.run');
  check(ran.length === 1 && ran[0].args.dryRun === true && ran[0].args.routineId === 'r_1', 'routines.run は dryRun: true で呼ぶ');
  await shot('06-tried');
  await page.locator('#rsCancel').click();
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.__rcalls.some(c => c.op === 'routines.delete'));
  check((await calls('routines.delete'))[0].args.routineId === 'r_1' && (await page.evaluate(() => window.__routines.length)) === 0, '取り消すと、試すために作った下書きを消す');
  check(await page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-row').count() === 0, '消したら脇にも残らない');

  // ---- 試しの失敗
  await page.locator('.ch-routines').click();
  await sheet.waitFor({ state: 'visible' });
  await page.locator('#rsName').fill('試し');
  await page.locator('#rsPrompt').fill('見て');
  await page.evaluate(() => { window.__runState = 'failed'; });
  await page.locator('#rsTryBtn').click();
  await page.waitForFunction(() => document.getElementById('rsTry')?.textContent.includes('✕ 失敗'));
  check(await page.locator('#rsTry.fail').count() === 1 && await page.locator('#rsTry').textContent().then(s => s.includes('権限がありません')), '試しが失敗なら「✕ 失敗」と理由を出す');
  await page.evaluate(() => { window.__runState = 'done'; });
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => window.__routines.length === 0);
  check(true, 'Esc で閉じても、試すために作った下書きは消える');

  // ---- 作る: 毎日・平日・承認モード・期限
  await page.locator('.ch-routines').click();
  await sheet.waitFor({ state: 'visible' });
  await page.locator('#rsName').fill('朝のまとめ');
  await page.locator('#rsPrompt').fill('夜の間に失敗した会話をまとめて');
  await page.locator('#rsAt').fill('09:00');
  await pick('#rsWeekdays', 'weekdays');
  await page.locator('#rsModeChip').click();
  await page.waitForSelector('#rsModePop:not([hidden]) [data-key="mode:plan"]');
  await shot('06b-mode-picker');
  await page.keyboard.press('Escape');
  await page.locator('#rsBotChip').click();
  await page.waitForSelector('.cpop:not([hidden]) [data-key="bot:b_lynx"]');
  await shot('06c-bot-picker');
  await page.keyboard.press('Escape');
  await pick('#rsModeChip', 'mode:plan');
  check(await page.locator('#rsModeChip').getAttribute('data-value') === 'plan', '承認モードを入力欄と同じ面から選べる');
  await pick('#rsTimeoutChip', 'timeout:60');
  check(await page.locator('#rsTimeoutChip .v').textContent() === '1 時間', '承認待ちの期限を選べる');
  await pick('#rsBotChip', 'bot:b_lynx');
  await page.waitForFunction(() => document.getElementById('rsModeChip')?.dataset.value === 'plan');
  check(await page.locator('#rsBotChip .v').textContent().then(s => s.includes('Lynx')), 'bot を選べる');
  await page.locator('#rsSave').click();
  await sheet.waitFor({ state: 'hidden' });
  const made = (await calls('routines.create')).at(-1).args;
  check(made.name === '朝のまとめ' && made.botId === 'b_lynx' && made.channelId === ch.id && made.mode === 'plan' && made.approvalTimeoutMin === 60
    && made.trigger.kind === 'daily' && made.trigger.at === '09:00' && made.trigger.weekdaysOnly === true && made.paused === false, '作るは routines.create に名前・bot・チャンネル・指示・トリガ・モード・期限を渡す');
  await page.waitForSelector('#channelsSide .cs-sec[data-sec="routines"] .cs-row');
  const row = page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-row').first();
  check(await row.locator('.row-t').textContent() === '朝のまとめ' && await row.locator('.cs-rt-ch').textContent() === `#${name}`, '脇に名前と #チャンネルが出る');
  check(await row.locator('.row-when').textContent().then(s => /\d:\d\d$/.test(s)), '脇に次の時刻が出る');
  check(await page.locator('.ch-routines .rt-n').textContent() === '1', '見出しの［ルーティン］に数が付く');
  await shot('07-created');

  // ---- 3 件に絞る・並べ方・一時停止は薄く・失敗は「✕ 失敗」・ほか n 件
  const mk = (id, name, nextAt, extra = {}) => ({ id, name, botId: 'b_owl', channelId: ch.id, prompt: 'x', trigger: { kind: 'daily', at: '09:00', weekdaysOnly: false }, mode: 'default', approvalTimeoutMin: 30, paused: false, createdBy: { kind: 'human' }, createdAt: 1, nextAt, ...extra });
  const t0 = Date.now();
  await page.evaluate(([a, b, c]) => { window.__routines.push(a, b, c); }, [mk('r_a', '夜の失敗の見回り', t0 + 20 * 60e3, { last: { at: t0 - 3600e3, runId: 'x', state: 'failed' } }), mk('r_b', '依存の更新', null, { paused: true }), mk('r_c', '週次のまとめ', t0 + 7 * 86400e3)]);
  for (const id of ['r_a', 'r_b', 'r_c']) await deliver({ type: 'routinesChanged', sessionId: null, routine: await page.evaluate(i => window.__routines.find(r => r.id === i), id) });
  await page.waitForFunction(() => document.querySelectorAll('#channelsSide .cs-sec[data-sec="routines"] .cs-row').length === 3);
  const order = await page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-row .row-t').allTextContents();
  check(order.join() === '夜の失敗の見回り,朝のまとめ,週次のまとめ', '脇は次に動く時刻の近い順に 3 件（4 件目は一時停止なので後ろ）');
  check(await page.locator('#channelsSide .cs-rt-fail').first().textContent() === '✕ 失敗', '直近の失敗は「✕ 失敗」');
  const more = page.locator('#channelsSide .cs-more');
  check(await more.textContent() === 'ほか 1 件を見る', '3 件を超えると［ほか n 件を見る］');
  await more.click();
  check(await page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-row').count() === 4 && await page.locator('#channelsSide .cs-row.paused').count() === 1, '押すと全部出る。一時停止は薄い（.paused）');
  check(await page.locator('#channelsSide .cs-row.paused .row-when').textContent() === '一時停止', '一時停止の行は時刻の代わりに「一時停止」');
  check(await page.locator('.ch-routines .rt-n').textContent() === '4', '見出しの数が出来事で 4 になる');
  await shot('08-side');
  await page.locator('#channelsSide .cs-more').click();

  // ---- 見出しの入口: 複数あればメニュー（そのルーティン … / ルーティンを作る）
  await page.locator('.ch-routines').click();
  const menu = await page.evaluate(() => [...document.querySelectorAll('.pop.menu .li .lbl')].map(n => n.textContent));
  check(menu.length === 5 && menu.at(-1) === 'ルーティンを作る' && menu.some(m => m.includes('依存の更新 · 一時停止')), '見出しのボタンはメニュー（ルーティンの一覧と「ルーティンを作る」）');
  await page.keyboard.press('Escape');

  // ---- 編集: 脇の行 → 値が入る → 直して保存 → routines.update
  await page.locator('#channelsSide .cs-row', { hasText: '朝のまとめ' }).click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('#rsName').inputValue() === '朝のまとめ' && await page.locator('#rsAt').inputValue() === '09:00' && await page.locator('#rsWeekdays .v').textContent() === '平日だけ', '編集のシートに今の値が入る');
  check(await page.locator('#rsSave').textContent() === '保存' && await page.locator('#rsDelete').isVisible() && await page.locator('[data-fld="state"]').isVisible(), '保存済みは［保存］［削除］と状態の欄がある');
  check(await page.locator('[data-fld="state"] .rs-last').textContent().then(s => s.includes('まだ動いていません')), '前回の実行が無ければそう書く');
  await page.locator('#rsPrompt').fill('夜の間に失敗した会話をまとめて。直さないで提案だけ。');
  await page.locator('#rsAt').fill('08:15');
  await page.locator('#rsSave').click();
  await sheet.waitFor({ state: 'hidden' });
  const upd = (await calls('routines.update')).at(-1).args;
  check(upd.routineId && upd.trigger.at === '08:15' && upd.prompt.includes('提案だけ') && !('paused' in upd), '保存は routines.update に直した欄を渡す');

  // ---- 一時停止・再開（状態の欄。保存を待たずにすぐ効く）
  await page.locator('#channelsSide .cs-row', { hasText: '朝のまとめ' }).click();
  await sheet.waitFor({ state: 'visible' });
  await page.locator('[data-state="off"]').click();
  await page.waitForFunction(() => window.__rcalls.some(c => c.op === 'routines.pause'));
  await page.waitForFunction(() => document.querySelector('[data-state="off"]').getAttribute('aria-pressed') === 'true');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.locator('#channelsSide .cs-more').click();   // 一時停止にすると 4 番目へ回り、3 件の外に出る
  await page.waitForSelector('#channelsSide .cs-row.paused:has-text("朝のまとめ")');
  check(true, '状態を「一時停止」にすると routines.pause が呼ばれ、脇の行が薄くなる（後ろへ回る）');
  await page.locator('#channelsSide .cs-row.paused', { hasText: '朝のまとめ' }).click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('[data-state="off"]').getAttribute('aria-pressed') === 'true', '開き直すと状態は「一時停止」');
  await page.locator('[data-state="on"]').click();
  await page.waitForFunction(() => window.__rcalls.some(c => c.op === 'routines.resume'));
  await page.waitForFunction(() => document.querySelector('[data-state="on"]').getAttribute('aria-pressed') === 'true');
  check(true, '「有効」に戻すと routines.resume が呼ばれる');

  // ---- 削除は 2 度押し（1 度目は確かめの字になるだけ）
  const deletedBefore = (await calls('routines.delete')).length;
  await page.locator('#rsDelete').click();
  check(await page.locator('#rsDelete').textContent() === 'もう一度押すと削除' && (await calls('routines.delete')).length === deletedBefore, '削除の 1 度目は「もう一度押すと削除」になるだけ');
  await page.locator('#rsDelete').click();
  await sheet.waitFor({ state: 'hidden' });
  check((await calls('routines.delete')).length === deletedBefore + 1 && await page.locator('#channelsSide .cs-row', { hasText: '朝のまとめ' }).count() === 0, '2 度目で routines.delete を呼び、脇から消える');

  // ---- 脇の＋・失敗の行から編集・別の人が消した（出来事）ときはシートも閉じる
  await page.locator('#channelsSide .cs-sec[data-sec="routines"] .grp-head').hover();
  await page.locator('#channelsSide .cs-sec[data-sec="routines"] .cs-add').click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('#rsChannelChip .v').textContent().then(s => s.includes(name)), '脇の＋でも作れる（開いているチャンネルが入る）');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.locator('#channelsSide .cs-row', { hasText: '夜の失敗の見回り' }).click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('.rs-last').textContent().then(s => s.includes('✕ 失敗')) && await page.locator('.rs-last.fail').count() === 1, '編集のシートに前回の結果（✕ 失敗）が出る');
  await page.evaluate(() => { window.__routines = window.__routines.filter(r => r.id !== 'r_a'); });
  await deliver({ type: 'routinesChanged', sessionId: null, removed: 'r_a' });
  await sheet.waitFor({ state: 'hidden' });
  check(await page.locator('#channelsSide .cs-row', { hasText: '夜の失敗の見回り' }).count() === 0, '別の所で消されたら、開いているシートも閉じて脇からも消える');

  // ---- bot のページの「ルーティン」の節
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id: 'b_lynx' } })));
  await page.waitForSelector('#botView:not([hidden]) #botRoutines:not([hidden])');
  const botRows = await page.locator('#botRoutines .bp-rt .bp-rt-name').allTextContents();
  check(botRows.join() === '', 'bot のページには、その bot のルーティンだけ（今は Lynx のものは作っていない）→ 空の案内');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id: 'b_owl' } })));
  await page.waitForFunction(() => document.querySelectorAll('#botRoutines .bp-rt').length >= 2);
  const owlRows = await page.locator('#botRoutines .bp-rt .bp-rt-name').allTextContents();
  check(owlRows.includes('週次のまとめ') && owlRows.includes('依存の更新'), 'Owl のページに Owl のルーティンが並ぶ');
  await shot('09-bot-page');
  await page.locator('#botRoutines .bp-rt', { hasText: '週次のまとめ' }).click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('#rsName').inputValue() === '週次のまとめ', 'bot のページの行から編集のシートが開く');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.locator('#botRoutines .bp-rt-add').click();
  await sheet.waitFor({ state: 'visible' });
  check(await page.locator('#rsBotChip .v').textContent().then(s => s.includes('Owl')), 'bot のページの［ルーティンを作る］はその bot が入る');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'bot', id: 'new' } })));
  await page.waitForSelector('#botView.is-new');
  check(await page.locator('#botRoutines').isHidden(), '作る画面（bot がまだ無い）にはルーティンの節を出さない');
  // 同じチャンネルへ戻る前に別のチャンネルを挟む（同じチャンネルへ戻ると見出しが空のままになる既知の挙動は feed.mjs の持ち主へ）
  const other = await rpc('channels.create', { name: 'other' + String(Date.now()).slice(-5) });
  await showChannel(other.id);
  await showChannel(ch.id);
  await page.waitForSelector('.ch-routines');

  // ---- 失敗: 保存に失敗したら理由を出して開いたまま
  await page.locator('.ch-routines').click();
  await page.locator('.pop.menu .li', { hasText: 'ルーティンを作る' }).click();
  await sheet.waitFor({ state: 'visible' });
  await page.locator('#rsName').fill('失敗する');
  await page.locator('#rsPrompt').fill('見て');
  await page.evaluate(() => { window.__rfail = { 'routines.create': 'NEEDS_UI' }; });
  await page.locator('#rsSave').click();
  await page.waitForSelector('.rs-err:not([hidden])');
  check(await sheet.isVisible() && await page.locator('.rs-err').textContent().then(s => s.includes('保存できませんでした')) && await page.locator('#rsSave').isEnabled(), '保存に失敗したら理由を出して開いたまま（直せる）');
  await page.evaluate(() => { window.__rfail = {}; });
  check(await page.locator('#rsName').inputValue() === '失敗する', '打った内容は残る');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });

  // ---- 狭い画面: 全画面で、横にはみ出さない。足は畳んで見える
  await page.setViewportSize({ width: 360, height: 740 });
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('channels:routine', { detail: {} })));
  await sheet.waitFor({ state: 'visible' });
  const box = await sheet.boundingBox();
  check(box.width === 360 && box.height === 740, '360 幅ではシートが全画面');
  check(await page.evaluate(() => { const d = document.getElementById('routineSheet'); return d.scrollWidth <= d.clientWidth + 1 && d.querySelector('.rs-body').scrollWidth <= d.querySelector('.rs-body').clientWidth + 1; }), '360 幅で横にはみ出さない');
  check(await page.locator('#rsSave').isVisible() && await page.locator('#rsTryBtn').isVisible(), '360 幅でも足のボタンが見える');
  await page.locator('[data-when="interval"]').click();
  check(await page.evaluate(() => { const b = document.querySelector('#routineSheet .rs-body'); return b.scrollWidth <= b.clientWidth + 1; }), '360 幅の間隔の欄も横にはみ出さない');
  await shot('10-360');
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 1280, height: 820 });

  return results;
}
