// playwright-cli run-code --filename=tests/browser/switch-notice.cjs
// 切り替えを待つ表示（web/switch-notice.mjs。docs/design-system.md「切り替えを待つ表示」、docs/zero-downtime-update/design.md §6.1）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（AGENTS.md）。
// 新しい main の橋（preload の plyDesktop.switch。desktop/switch-screen.cjs）は偽物にする: window.__switch(payload) で状態を渡し、
// 画面の操作（act）は window.__acts に記録する。更新の口（plyDesktop.update）も偽物で、無停止の更新（handover）の確認の段を出せる。
// 撮った画面は temporary/screenshots/switch-notice-*.png（ライト・ダーク・狭い窓）。
async page => {
  const shots = 'temporary/screenshots/switch-notice';
  await page.addInitScript(() => {
    if (window.__switchStub) return;
    window.__switchStub = true;
    window.__acts = [];
    window.__helloed = 0;
    window.__bridgeState = null;
    let listener = null;
    window.__switch = (payload) => { window.__bridgeState = payload; listener?.(payload); };
    window.__update = { phase: 'current', enabled: true, version: '0.8.0', target: null, notice: false, autoDownload: true, autoCheck: true, channel: 'stable', handover: true };
    let updateListener = null;
    window.__setUpdate = (patch) => { window.__update = { ...window.__update, ...patch }; updateListener?.({ ...window.__update }); };
    window.plyDesktop = {
      onUpdate: (fn) => { updateListener = fn; },
      update: async () => ({ ...window.__update }),
      switch: {
        version: 1,
        hello: () => { window.__helloed++; },
        state: async () => window.__bridgeState,
        onState: (fn) => { listener = fn; return () => { listener = null; }; },
        act: async (action) => { window.__acts.push(action); return true; },
      },
    };
  });
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.locator('.row[data-session]').first().waitFor();
  await wait(800);

  // ---- 会話を作る: 実行中 3（slow）・承認待ち 1（ask）。題は付け直す
  const start = async (text) => {
    await page.locator('#newSession').click();
    await wait(800);
    await page.locator('#prompt').fill(text);
    await page.locator('#send').click();
    await wait(1500);
    return page.evaluate(() => document.querySelector('.row.sel')?.dataset.session ?? null);
  };
  const sorted = [];
  for (const text of ['slow a', 'slow b', 'ask c', 'slow d', 'slow e', 'slow f']) sorted.push(await start(text));
  check('会話が 6 件できた', sorted.every(Boolean) && new Set(sorted).size === 6, JSON.stringify(sorted));
  const titles = ['認証まわりのリファクタ', 'リリースノートの下書き', 'テストの失敗を調べる', '依存の更新を確かめる', 'ログ収集の調整', 'API の修正'];
  await page.evaluate(async (args) => {
    const [sorted, titles] = args;
    const ws = new WebSocket(`ws://${location.host}/ws?token=${new URL(location.href).searchParams.get('token')}`);
    await new Promise(r => { ws.onopen = r; });
    sorted.forEach((id, i) => ws.send(JSON.stringify({ kind: 'command', id: `t${i}`, command: 'setTitle', args: { sessionId: id, title: titles[i], reasonKey: 'manual' } })));
    await new Promise(r => setTimeout(r, 800));
  }, [sorted, titles]);
  await wait(1200);
  const [a, b, c, d, e, f] = sorted;
  const mk = (phase, extra = {}) => ({ v: 1, phase, target: '0.8.0', current: '0.7.4', ...extra });
  const items = [
    { kind: 'turn', sessionId: a, backend: 'fake' }, { kind: 'turn', sessionId: b, backend: 'fake' },
    { kind: 'permission', sessionId: c }, { kind: 'turn', sessionId: d, backend: 'fake' }];
  const stoppers = [{ kind: 'shell', sessionId: e, label: 'npm run dev' }, { kind: 'background', sessionId: f, backend: 'fake', label: 'vite dev' }];
  const send = (payload) => page.evaluate((p) => window.__switch(p), payload);
  const since = new Date(); since.setHours(14, 32, 0, 0);

  // ---- 表示が無い間は何も出さない・読めない版の状態も出さない
  await page.waitForFunction(() => window.__helloed >= 1);
  check('画面は読み込むとき hello で口の版を知らせる', await page.evaluate(() => window.__helloed >= 1));
  check('状態が無ければ何も出ない', await page.evaluate(() => document.querySelector('#switchNotice').hidden && document.querySelector('#switchBox').hidden));
  await send({ v: 2, phase: 'waiting', target: '0.8.0', items: [] });
  check('知らない版（v: 2）の状態は読まない', await page.evaluate(() => document.querySelector('#switchNotice').hidden));
  await send(mk('nonsense'));
  check('知らない phase は読まない', await page.evaluate(() => document.querySelector('#switchNotice').hidden));

  // 撮る: ライト・ダーク × 広い窓。名前は state 名
  const take = async (name, { settings = false, narrow = false } = {}) => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await wait(150);
      const target = settings ? page.locator('#updatesPanel') : narrow ? page.locator('#sidebar') : page.locator('#sidebar');
      await target.screenshot({ path: `${shots}-${name}-${theme}.png` });
    }
  };
  const settleLeaving = () => wait(400);

  // ---- 待ち（たたんだ形・開いた形）
  await send(mk('waiting', { since: since.getTime(), items, stoppers }));
  const waiting = await page.evaluate(() => ({ hidden: document.querySelector('#switchNotice').hidden, title: document.querySelector('#switchTitle').textContent, role: document.querySelector('#switchTitle').getAttribute('role'),
    sub: document.querySelector('#switchSub').textContent, dot: document.querySelector('#settings').classList.contains('has-update'),
    acts: [...document.querySelectorAll('#switchActs button')].map(b => b.textContent), expanded: document.querySelector('#switchActs [data-act=toggle]')?.getAttribute('aria-expanded') }));
  check('待ち: 「Pleiad 0.8.0 への切り替えを待っています」と件数', !waiting.hidden && waiting.title === 'Pleiad 0.8.0 への切り替えを待っています' && waiting.sub === '実行中 3 件・承認待ち 1 件' && waiting.role === 'status', JSON.stringify(waiting));
  check('待ち: たたんだ形のボタンは「作業を見る」だけ（中断のボタンは出さない）・⚙ に点', waiting.acts.join() === '作業を見る' && waiting.expanded === 'false' && waiting.dot, JSON.stringify(waiting));
  await take('wait-collapsed');
  await page.locator('#switchActs [data-act=toggle]').click();
  await wait(400);
  const opened = await page.evaluate(() => ({
    acts: [...document.querySelectorAll('#switchActs button')].map(b => b.textContent), expanded: document.querySelector('#switchActs [data-act=toggle]')?.getAttribute('aria-expanded'),
    groups: [...document.querySelectorAll('#switchList .switch-grp')].map(g => ({ head: g.querySelector('h4').textContent, rows: [...g.querySelectorAll('.update-work-row')].map(r => r.textContent), hidden: g.hidden })),
    after: { hidden: document.querySelector('#switchAfter').hidden, text: document.querySelector('#switchAfter').textContent }, primary: document.querySelectorAll('#switchActs .btn-primary').length }));
  check('待ち（開いた形）: 待っている作業 4 行と「14:32 から」', opened.groups[0].rows.length === 4 && /14:32/.test(opened.groups[0].head) && /から/.test(opened.groups[0].head), JSON.stringify(opened.groups));
  check('待ち（開いた形）: 行は「会話名 実行中 · エージェント」「承認待ち」', opened.groups[0].rows.some(r => r.startsWith('認証まわりのリファクタ実行中 · ')) && opened.groups[0].rows.some(r => r.includes('テストの失敗を調べる') && r.includes('承認待ち')), JSON.stringify(opened.groups[0].rows));
  check('待ち（開いた形）: 切り替えで止まるもの 2 行（`!` のシェル・端末）', opened.groups[1].rows.length === 2 && opened.groups[1].rows[0].includes('! npm run dev') && opened.groups[1].rows[1].includes('端末 · vite dev'), JSON.stringify(opened.groups[1]));
  check('待ち（開いた形）: 注意書きは開いたときだけ。「今すぐ中断して切り替える」は塗らない', !opened.after.hidden && opened.after.text.includes('承認待ちは却下扱い') && opened.acts.join() === 'たたむ,今すぐ中断して切り替える' && opened.primary === 0 && opened.expanded === 'true', JSON.stringify(opened));
  await take('wait-open');
  // 行を押すとその会話が開く
  await page.locator('#switchList button.switch-row').nth(2).click();
  await page.waitForFunction((id) => document.querySelector(`.row[data-session="${id}"].sel`), c);
  check('行を押すとその会話が開く（承認待ちの会話）', true);
  await page.locator('#sidebar').screenshot({ path: `${shots}-wait-open-conversation.png` });
  // 作業が 1 件終わる: 行が縮んで消える。件数の字は即時
  await send(mk('waiting', { since: since.getTime(), items: items.slice(1), stoppers }));
  await wait(60);
  check('作業が終わると、その行は縮んで（leaving）から消える', await page.evaluate(() => document.querySelectorAll('#switchList .switch-grp-work .update-work-row.leaving').length === 1));
  await settleLeaving();
  const afterEnd = await page.evaluate(() => ({ rows: document.querySelectorAll('#switchList .switch-grp-work .update-work-row').length, sub: document.querySelector('#switchSub').textContent }));
  check('消えた後の行数と件数', afterEnd.rows === 3 && afterEnd.sub === '実行中 2 件・承認待ち 1 件', JSON.stringify(afterEnd));
  // 中断のボタンは act を返す
  await page.evaluate(() => { window.__acts.length = 0; });
  await page.locator('#switchActs [data-act=now]').click();
  check('「今すぐ中断して切り替える」は main へ now を返す', await page.evaluate(() => window.__acts.join() === 'now'));
  await send(mk('waiting', { since: since.getTime(), items: items.slice(1), stoppers, interruptFailed: true }));
  check('中断が止まらなかったときの 1 行（辞書の文言）', await page.evaluate(() => document.querySelector('#switchSub').textContent.includes('止まらない作業があったため')));

  // ---- 設定 › アプリ情報・更新（待っている間）
  await page.locator('#settings').click();
  await page.locator('#updatesTab').click();
  await wait(300);
  const pageWait = await page.evaluate(() => ({ status: document.querySelector('#updateStatus').textContent, hint: document.querySelector('#updateHint').textContent, box: !document.querySelector('#switchBox').hidden,
    rows: document.querySelectorAll('#switchPageList .update-work-row').length, acts: [...document.querySelectorAll('#switchPageActs button')].map(b => b.textContent) }));
  check('設定のページ: 切り替えを待っている字・動いている版・同じ一覧・「今すぐ中断して切り替える」', pageWait.status === '新しい版への切り替えを待っています · 0.8.0' && pageWait.hint === '動いているのは 0.7.4 です' && pageWait.box && pageWait.rows === 5 && pageWait.acts.join() === '今すぐ中断して切り替える', JSON.stringify(pageWait));
  await take('settings-wait', { settings: true });
  await page.screenshot({ path: `${shots}-settings-wait-full.png` });

  // ---- 設定 › 確認の段（無停止の更新。更新は準備済み）。作業の一覧と中断は出さず、止まらないことを 1 行で言う
  await send(null);
  await wait(200);
  await page.evaluate(() => window.__setUpdate({ phase: 'downloaded', target: '0.8.0', version: '0.7.4', handover: true }));
  await page.locator('#installUpdate').click();
  await wait(500);
  const confirmTo = await page.evaluate(() => ({ work: { hidden: document.querySelector('#updateHandoverWork').hidden, text: document.querySelector('#updateHandoverWork').textContent }, browser: document.querySelector('#updateHandoverBrowser').hidden,
    list: document.querySelector('#updateWork').hidden, after: document.querySelector('#updateWorkAfter').hidden, ok: document.querySelector('#confirmInstallUpdate').textContent, later: document.querySelector('#cancelInstallUpdate').textContent }));
  check('確認の段（無停止）: 「実行中の作業 N 件は止まりません」・一覧と中断の注意は出ない・「保存して再起動」', !confirmTo.work.hidden && /実行中の作業 \d+ 件は止まりません。新しい版へは、作業が終わってから切り替わります。/.test(confirmTo.work.text)
    && confirmTo.list && confirmTo.after && confirmTo.ok === '保存して再起動' && confirmTo.later === 'あとで', JSON.stringify(confirmTo));
  check('確認の段: 内蔵ブラウザーのタブ・コンピューターの操作が無ければ注意の 1 行は出ない', confirmTo.browser);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('#updateConfirm').screenshot({ path: `${shots}-confirm-handover-light.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('#updateConfirm').screenshot({ path: `${shots}-confirm-handover-dark.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // 内蔵ブラウザーのタブがあるときだけ注意が出る（画面の browserPanel は無いので、computer の状態を差し込む代わりに関数を直接確かめる）
  await page.evaluate(() => window.__setUpdate({ handover: false }));
  await wait(200);
  const asis = await page.evaluate(() => ({ work: document.querySelector('#updateHandoverWork').hidden, list: document.querySelector('#updateWork').hidden, ok: document.querySelector('#confirmInstallUpdate').textContent }));
  check('確認の段（off）: 今のまま（止まらないの 1 行は出ず、中断して更新）', asis.work && asis.ok === '中断して更新', JSON.stringify(asis));
  await page.locator('#updateConfirm').screenshot({ path: `${shots}-confirm-asis-light.png` });
  await page.locator('#cancelInstallUpdate').click();
  await page.evaluate(() => window.__setUpdate({ handover: true, phase: 'current', version: '0.8.0', target: null }));
  await page.locator('#backToChat').click();
  await wait(300);

  // ---- 作業が終わり、止まるものだけが残った（Z）
  await send(mk('asking', { stoppers }));
  await settleLeaving();
  const asking = await page.evaluate(() => ({ title: document.querySelector('#switchTitle').textContent, sub: document.querySelector('#switchSub').textContent,
    acts: [...document.querySelectorAll('#switchActs button')].map(b => ({ text: b.textContent, primary: b.classList.contains('btn-primary') })),
    groups: [...document.querySelectorAll('#switchList .switch-grp')].filter(g => !g.hidden).map(g => g.querySelector('h4').textContent) }));
  check('聞く: 「準備ができました」・「切り替えると 2 件が止まります」・止まるものだけを一覧に', asking.title === 'Pleiad 0.8.0 に切り替える準備ができました' && asking.sub === '切り替えると 2 件が止まります' && asking.groups.join() === '切り替えで止まるもの', JSON.stringify(asking));
  check('聞く: 「あとで」と、塗った「止めて切り替え」', asking.acts.map(a => a.text).join() === 'あとで,止めて切り替え' && asking.acts[1].primary && !asking.acts[0].primary, JSON.stringify(asking.acts));
  await take('asking');
  await page.evaluate(() => { window.__acts.length = 0; });
  await page.locator('#switchActs [data-act=later]').click();
  check('「あとで」は main へ later を返す', await page.evaluate(() => window.__acts.join() === 'later'));
  await send(mk('held', { kind: 'stoppers', reason: 'stoppers', stoppers }));
  const held = await page.evaluate(() => ({ notice: document.querySelector('#switchNotice').hidden, dot: document.querySelector('#settings').classList.contains('has-update') }));
  check('あとでの後: 脇の知らせは閉じ、⚙ の点だけ残る', held.notice && held.dot, JSON.stringify(held));
  await page.locator('#settings').click();
  await page.locator('#updatesTab').click();
  await wait(300);
  const heldPage = await page.evaluate(() => ({ status: document.querySelector('#updateStatus').textContent, acts: [...document.querySelectorAll('#switchPageActs button')].map(b => ({ t: b.textContent, p: b.classList.contains('btn-primary') })), rows: document.querySelectorAll('#switchPageList .update-work-row').length }));
  check('設定のページ: 「切り替えると止まるものがあります」・止まるもの 2 行・塗った「止めて切り替え」', heldPage.status === '切り替えると止まるものがあります · 0.8.0' && heldPage.rows === 2 && heldPage.acts.length === 1 && heldPage.acts[0].t === '止めて切り替え' && heldPage.acts[0].p, JSON.stringify(heldPage));
  await take('settings-held', { settings: true });
  await page.locator('#backToChat').click();

  // ---- 合わない版（形式番号）
  await send(mk('manual', { reason: 'schema', items, stoppers }));
  const manual = await page.evaluate(() => ({ title: document.querySelector('#switchTitle').textContent, sub: document.querySelector('#switchSub').textContent, acts: [...document.querySelectorAll('#switchActs button')].map(b => b.textContent),
    groups: [...document.querySelectorAll('#switchList .switch-grp')].filter(g => !g.hidden).length, after: !document.querySelector('#switchAfter').hidden }));
  check('合わない版: 「切り替えるには作業を中断します」・形式が変わる理由・「あとで／中断して切り替え」・作業と止まるものと注意', manual.title === 'Pleiad 0.8.0 に切り替えるには作業を中断します' && manual.sub === 'データの形式が変わるため、自動では切り替わりません'
    && manual.acts.join() === 'あとで,中断して切り替え' && manual.groups === 2 && manual.after, JSON.stringify(manual));
  await take('manual');

  // ---- 中断している・切り替えている
  await send(mk('stopping', { interrupt: { done: 2, total: 4 } }));
  const stopping = await page.evaluate(() => ({ title: document.querySelector('#switchTitle').textContent, progress: !document.querySelector('#switchProgress').hidden, acts: document.querySelectorAll('#switchActs button').length }));
  check('中断中: 「作業を中断しています… 2 / 4」と進み。ボタンは出ない', stopping.title === 'Pleiad 0.8.0 · 作業を中断しています… 2 / 4' && stopping.progress && stopping.acts === 0, JSON.stringify(stopping));
  await take('stopping');
  await send(mk('switching'));
  const switching = await page.evaluate(() => ({ title: document.querySelector('#switchTitle').textContent, role: document.querySelector('#switchTitle').getAttribute('role'), dot: document.querySelector('#settings').classList.contains('has-update') }));
  check('切り替え中: 「切り替えています…」', switching.title === 'Pleiad 0.8.0 に切り替えています…' && !switching.dot, JSON.stringify(switching));
  await take('switching');

  // ---- 切り替えに失敗して、前の版で動いている → もう一度試す
  await send(mk('failed', { current: '0.7.4', at: 1 }));
  const failed = await page.evaluate(() => ({ title: document.querySelector('#switchTitle').textContent, role: document.querySelector('#switchTitle').getAttribute('role'), mark: !!document.querySelector('#switchTitle .warn-mark'),
    acts: [...document.querySelectorAll('#switchActs button')].map(b => b.textContent) }));
  check('失敗: 三角の印と「前の版（0.7.4）で動いています」・role=alert・「もう一度試す／閉じる」', failed.title.includes('新しい版を起動できなかったため、前の版（0.7.4）で動いています') && failed.role === 'alert' && failed.mark && failed.acts.join() === 'もう一度試す,閉じる', JSON.stringify(failed));
  await take('failed');
  await page.evaluate(() => { window.__acts.length = 0; });
  await page.locator('#switchActs [data-act=retry]').click();
  check('「もう一度試す」は main へ retry を返す', await page.evaluate(() => window.__acts.join() === 'retry'));
  await send(mk('failed', { current: '0.7.4', at: 1 }));
  await page.locator('#switchActs [data-act=dismiss]').click();
  check('閉じると知らせは消える（同じ失敗では戻らない）', await page.evaluate(() => document.querySelector('#switchNotice').hidden));
  await send(mk('failed', { current: '0.7.4', at: 2 }));
  check('次の失敗（別の時刻）はまた出る', await page.evaluate(() => !document.querySelector('#switchNotice').hidden));

  // ---- 切り替わった後: 「更新しました」に、止めたものの 1 行（読み直した新しい画面）
  await page.evaluate(() => window.__setUpdate({ phase: 'current', notice: true, version: '0.8.0', target: null }));
  await send(mk('done', { current: '0.8.0', at: 3, stopped: stoppers }));
  await wait(300);
  const done = await page.evaluate(() => ({ hidden: document.querySelector('#updateNotice').hidden, text: document.querySelector('#updateNoticeText').textContent, stopped: document.querySelector('#updateNoticeStopped').textContent, sw: document.querySelector('#switchNotice').hidden }));
  check('切り替わった後: 「Pleiad 0.8.0 に更新しました」と「止めたもの: ! のシェル 1 件・Fake (test) の端末 1 件」', !done.hidden && done.text === 'Pleiad 0.8.0 に更新しました' && done.stopped === '止めたもの: ! のシェル 1 件・Fake (test) の端末 1 件' && done.sw, JSON.stringify(done));
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('#updateNotice').screenshot({ path: `${shots}-done-light.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.locator('#updateNotice').screenshot({ path: `${shots}-done-dark.png` });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  // 切り替えが済むまでは「更新しました」を出さない
  await page.evaluate(() => { sessionStorage.removeItem('ply-update-notice'); });
  await send(mk('waiting', { since: since.getTime(), items, stoppers }));
  check('切り替えを待っている間は「更新しました」を出さない', await page.evaluate(() => document.querySelector('#updateNotice').hidden));
  await send(null);

  // ---- 狭い窓（引き出し）・360px
  await send(mk('waiting', { since: since.getTime(), items, stoppers }));
  await page.evaluate(() => { const b = document.querySelector('#switchActs [data-act=toggle]'); if (b?.getAttribute('aria-expanded') === 'false') b.click(); });
  for (const width of [640, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await wait(400);
    // 引き出しを開く
    await page.evaluate(() => document.querySelector('#openSidebar')?.click());
    await wait(500);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await wait(150);
      await page.screenshot({ path: `${shots}-narrow-${width}-${theme}.png` });
    }
    const narrow = await page.evaluate(() => { const n = document.querySelector('#switchNotice'); const r = n.getBoundingClientRect(); return { visible: !n.hidden && r.width > 0, width: Math.round(r.width), overflow: n.scrollWidth > n.clientWidth + 1 }; });
    check(`${width}px: 引き出しの中に知らせが収まる`, narrow.visible && !narrow.overflow, JSON.stringify(narrow));
  }
  await page.setViewportSize({ width: 1280, height: 800 });

  // 後片付け: 走っている作業を中断
  await page.evaluate(() => { const ws = new WebSocket(`ws://${location.host}/ws?token=${new URL(location.href).searchParams.get('token')}`); ws.onopen = () => ws.send(JSON.stringify({ kind: 'command', id: 'cleanup', command: 'abort', args: {} })); });
  await wait(1500);
  return { passed: true, checks };
}
