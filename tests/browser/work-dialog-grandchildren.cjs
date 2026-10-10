// playwright-cli run-code --filename=tests/browser/work-dialog-grandchildren.cjs
// 作業ダイアログ（#workDialog）の「バックグラウンド」: ply_delegate で作った子の会話がネイティブのサブエージェント（孫）を呼んだとき、
// 孫が子の行の下に字下げ（.bg-row.sub）で出て、子の行に「委譲 N」が付く。子が終わっても孫の行は残り（sessions.subagents で読み出す）、
// 孫を選ぶとその会話が開く。稼働中・完了の数は孫を二重に数えない（docs/design-system.md「バックグラウンド」）。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (port 7461, token grand-test, fresh data dir). Never run against live data.
//   AGENT_HOST_BACKENDS=fake AGENT_HOST_FAKE_USAGE=1 AGENT_HOST_GIT_SNAPSHOTS=off AGENT_HOST_WORKTREES=off AGENT_HOST_LOCALE=ja AGENT_HOST_TOKEN=grand-test AGENT_HOST_PORT=7461 AGENT_HOST_DATA=<一時の置き場> node core/server.mjs
// 子の台本は fake の "bg <本数> <秒>"（Claude の Agent ツールと同じ形で、本数ぶんのサブエージェントを裏で走らせる。core/backends/fake.mjs）。
async page => {
  const URL = 'http://127.0.0.1:7461/?token=grand-test';
  const SHOT = ''; // 撮るなら絶対パス（例 D:/dev/…/temporary/screenshots/work-grandchildren.png）
  const results = [];
  const check = (ok, label, detail) => { if (!ok) throw Error(label + (detail === undefined ? '' : ' ' + JSON.stringify(detail))); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  const until = (fn, label, ms = 30000) => page.waitForFunction(fn, null, { timeout: ms, polling: 150 }).catch(() => { throw Error('timeout: ' + label); });

  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto(URL);
  await page.addInitScript(() => {
    if (window.__grandWrapped) return;
    window.__grandWrapped = true;
    window.__sockets = [];
    window.__calls = new Map();
    const Orig = WebSocket;
    window.WebSocket = class extends Orig {
      constructor(...a) { super(...a); window.__sockets.push(this); }
      set onmessage(fn) {
        super.onmessage = fn && ((e) => {
          try {
            const m = JSON.parse(e.data);
            if (m.kind === 'ready') window.__home = m.homeDir;
            const call = m.kind === 'response' ? window.__calls.get(m.id) : null;
            if (call) { window.__calls.delete(m.id); if (m.ok) call.res(m.result); else call.rej(new Error(String(m.error))); return; }
          } catch {}
          return fn(e);
        });
      }
      get onmessage() { return super.onmessage; }
    };
    window.__cmd = (command, args = {}) => new Promise((res, rej) => {
      const id = 't' + Math.random().toString(36).slice(2);
      window.__calls.set(id, { res, rej });
      window.__sockets.at(-1).send(JSON.stringify({ kind: 'command', command, id, args }));
    });
  });
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && window.__home);
  await page.evaluate(() => window.__cmd('authLogin', { backend: 'fake' }));
  await page.locator('#backToChat').click({ timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.getElementById('workDialog').close());

  // 子を 1 つ委譲する。子は裏のサブエージェントを 2 本、12 秒走らせる
  const call = { name: 'ply_delegate', arguments: { kind: 'mechanical', backend: 'fake', title: '調べる子', task: 'bg 2 12' } };
  await page.locator('#newSession').click();
  await page.locator('#prompt').fill('ply:' + JSON.stringify(call));
  await page.locator('#prompt').press('Control+Enter');
  const allow = page.locator('.btn-primary').filter({ hasText: '許可' }).first();
  await allow.waitFor({ timeout: 4000 }).then(() => allow.click()).catch(() => {});
  await page.locator('#workEntryButton').waitFor({ timeout: 20000 });
  await page.locator('#workEntryButton').click();

  const rows = () => page.evaluate(() => [...document.querySelectorAll('#workDialog .bg-row')].map(r => ({
    name: r.querySelector('.bg-row-name')?.textContent ?? '', sub: r.classList.contains('sub'), depth: Number(r.style.getPropertyValue('--bg-depth') || 0),
    meta: r.querySelector('.bg-row-meta')?.textContent ?? '', mark: r.querySelector('[role=img]')?.getAttribute('aria-label') ?? '',
  })));

  // 走っている間: 子の行に「委譲 2」、その下に孫が 2 行（深さ 1）
  await until(() => [...document.querySelectorAll('#workDialog .bg-row.sub')].length >= 2, 'two grandchild rows while the child runs');
  const live = await rows();
  const kid = live.findIndex(r => r.name.includes('調べる子'));
  check(kid >= 0 && !live[kid].sub && live[kid].meta.includes('委譲 2'), 'the child row says 委譲 2', live);
  check(live.slice(kid + 1, kid + 3).every(r => r.sub && r.depth === 1), 'the two grandchildren sit right under the child, indented one level', live);
  check(live.filter(r => r.sub).length === 2, 'nothing else is indented', live);
  const runLabel = live[kid + 1].mark;
  check(runLabel && live.slice(kid + 1, kid + 3).every(r => r.mark === runLabel), 'running grandchildren carry the running mark', live);
  const chip = await page.evaluate(() => document.getElementById('workEntryButton').textContent);
  results.push('entry button while running: ' + chip.replace(/\s+/g, ' ').trim());
  if (SHOT) await page.screenshot({ path: SHOT.replace('.png', '-running.png') });

  // 孫を選ぶと、その会話が詳細に出る
  await page.evaluate(() => document.querySelector('#workDialog .bg-row.sub').click());
  await until(() => document.querySelector('#workBody')?.textContent.includes('を始めた'), 'grandchild conversation opens');
  check(true, 'selecting a grandchild shows its conversation');

  // 子が終わっても孫の行は残る（読み出した分）。12 秒の裏が終わるのを待つ
  await page.waitForFunction((label) => [...document.querySelectorAll('#workDialog .bg-row')].every(r => r.querySelector('[role=img]')?.getAttribute('aria-label') !== label)
    && document.querySelectorAll('#workDialog .bg-row.sub').length >= 2, runLabel, { timeout: 60000, polling: 200 }).catch(() => { throw Error('timeout: rows stay after the child ends'); });
  await page.waitForTimeout(1500);
  const ended = await rows();
  const kid2 = ended.findIndex(r => r.name.includes('調べる子'));
  check(kid2 >= 0 && ended[kid2].meta.includes('委譲 2') && ended.filter(r => r.sub).length === 2, 'after the child ends the grandchildren and 委譲 2 remain', ended);
  const names = (list) => list.filter(r => r.sub).map(r => r.name).sort().join();
  check(names(ended) === names(live), 'the grandchildren keep the same titles after the child ends', { live: names(live), ended: names(ended) });
  if (SHOT) await page.screenshot({ path: SHOT });

  // 閉じて開き直しても、同じ（読み出し済みの分から出す）
  await page.evaluate(() => document.getElementById('workDialog').close());
  await page.locator('#workEntryButton').click();
  await until(() => document.querySelectorAll('#workDialog .bg-row.sub').length === 2, 'rows come back after reopening');
  const again = await rows();
  check(again.filter(r => r.sub).length === 2 && again.filter(r => !r.sub).length === ended.filter(r => !r.sub).length, 'reopening keeps the same rows without duplicates', again);

  // 読み込み直して（配信の記憶が無い状態）も、終わった子の孫は読み出して出る
  await page.reload();
  await later.click({ timeout: 5000 }).catch(() => {});
  await page.locator('#workEntryButton').waitFor({ timeout: 20000 });
  await page.locator('#workEntryButton').click();
  await until(() => document.querySelectorAll('#workDialog .bg-row.sub').length === 2, 'rows come back after reloading the page');
  const fresh = await rows();
  check(fresh.find(r => r.name.includes('調べる子'))?.meta.includes('委譲 2') && fresh.filter(r => r.sub).length === 2, 'after reloading the page the ended child still shows its grandchildren', fresh);
  return 'ok ' + JSON.stringify(results);
}
