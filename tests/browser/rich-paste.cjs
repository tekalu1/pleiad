// playwright-cli run-code --filename=tests/browser/rich-paste.cjs
// 貼り付けの HTML を書式・画像ごと入力欄へ入れる（ADR 0141）: Chats と Channels の入力欄に、合成の paste（text/html と text/plain を持つ DataTransfer）を送る。
// 書式 → Markdown・構造の無い HTML と text/plain だけは平文・シェルの形とコードの中は字だけ・data: の画像は札（3 枚目から小さなタイル）・
// 取りに行けない https の画像（私設アドレス。ホストが断る）は取り込み中の札が静かに消える・Ctrl+Z で貼り付けごと戻る・Channels でも同じ。
// Open an isolated AGENT_HOST_BACKENDS=fake server first (AGENT_HOST_PORT=7497 AGENT_HOST_TOKEN=a11a-test AGENT_HOST_LOCALE=ja、別のデータ置き場). Never run against live data.
// ホストが画像を取りに行く守りは tests/unit/image-import.mjs、https の画像が取れて札が替わる所は、AGENT_HOST_IMAGE_IMPORT_TEST_ORIGIN を渡した確認（docs/dev-verification.md）。
async page => {
  const URL = 'http://127.0.0.1:7497/?token=a11a-test';
  const results = [];
  const check = (ok, label) => { if (!ok) throw Error(label); results.push(label); };
  const later = page.getByRole('button', { name: 'あとで', exact: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => {
    if (window.__w) return;
    window.__w = true;
    window.__sockets = [];
    const Orig = WebSocket;
    window.WebSocket = class extends Orig { constructor(...a) { super(...a); window.__sockets.push(this); } };
  });
  await page.goto(URL);
  await later.click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('prompt') && document.getElementById('channelsView'));

  const paste = (sel, { html, text }) => page.evaluate(([s, h, t]) => {
    const el = document.querySelector(s);
    el.focus();
    const dt = new DataTransfer();
    if (h != null) dt.setData('text/html', h);
    if (t != null) dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [sel, html ?? null, text ?? null]);
  const value = (sel = '#prompt') => page.evaluate((s) => document.querySelector(s).value, sel);
  const clear = (sel = '#prompt') => page.evaluate((s) => { document.querySelector(s).value = ''; }, sel);
  const cards = (scope = '#prompt') => page.evaluate((s) => [...document.querySelectorAll(`${s} .md-b.md-att`)].map((d) => ({ state: d.dataset.state, gal: d.dataset.gal !== undefined, img: Boolean(d.querySelector('img')) })), scope);
  const png = (i) => page.evaluate((n) => { const c = document.createElement('canvas'); c.width = 80; c.height = 50; const g = c.getContext('2d'); g.fillStyle = `hsl(${n * 47} 55% 50%)`; g.fillRect(0, 0, 80, 50); return c.toDataURL('image/png'); }, i);

  // ---- 書式（Chrome の選択 HTML の形: 長い style・語の間の <span> </span>）
  const LONG = 'color: rgb(28, 34, 71); font-family: sans-serif; font-size: 14px; font-style: normal; font-weight: 400; orphans: 2; white-space: normal;';
  const release = `<meta charset='utf-8'><h2 style="${LONG}">リリース手順</h2><p style="${LONG}">今回は<span> </span><strong>本番</strong><span> </span>へ出します。詳細は<span> </span><a href="https://example.com/runbook">runbook</a><span> </span>を見てください。<span style="color: rgb(179, 38, 30);">注意</span></p>`
    + `<ul style="${LONG}"><li>ビルドを確認する</li><li>必ず<span> </span><em>ステージング</em>で試す</li></ul><ol start="1" style="${LONG}"><li>バックアップを取る</li><li>切り替える</li></ol><blockquote style="${LONG}">迷ったら止める</blockquote><pre style="${LONG}"><code class="language-sh">npm run build</code></pre>`;
  await paste('#prompt', { html: release, text: 'リリース手順\n今回は 本番 へ出します' });
  await page.waitForTimeout(150);
  const md = await value();
  check(md === ['## リリース手順', '今回は **本番** へ出します。詳細は [runbook](https://example.com/runbook) を見てください。注意', '- ビルドを確認する', '- 必ず *ステージング*で試す', '1. バックアップを取る', '2. 切り替える', '> 迷ったら止める', '```sh', 'npm run build', '```'].join('\n'), 'a Chrome selection HTML pastes as Markdown (HTML wins over text/plain): ' + JSON.stringify(md));
  check(await page.evaluate(() => [...document.querySelectorAll('#prompt .md-b')].map((d) => d.dataset.k).join()) === 'h,p,ul,ul,ol,ol,quote,code,code,code,p', 'the lines become the editor\'s own formatting (heading, bullets, numbers, quote, code)');
  check(await page.evaluate(() => document.querySelectorAll('#prompt strong').length === 1 && document.querySelectorAll('#prompt em').length === 1 && document.querySelectorAll('#prompt a.md-link').length === 1), 'bold, italic and the link are real editor marks');
  check(await page.evaluate(() => ![...document.querySelectorAll('#prompt [style]')].some((e) => !e.classList.contains('md-b') && !e.closest('.md-att'))), 'colors and fonts from the source are not carried over');
  await page.keyboard.press('Control+z');
  check(await value() === '', 'Ctrl+Z undoes the whole paste');
  await page.keyboard.press('Control+y');
  check((await value()).startsWith('## リリース手順'), 'Ctrl+Y redoes it');
  await clear();

  // ---- 平文のまま
  const vscode = '<meta charset="utf-8"><div style="color:#d4d4d4;background-color:#1e1e1e;font-family:Consolas;white-space:pre"><div><span style="color:#569cd6">function</span><span> f() {</span></div><div><span>    return </span><span style="font-style:italic">1</span><span>;</span></div><div>}</div></div>';
  await paste('#prompt', { html: vscode, text: 'function f() {\n    return 1;\n}' });
  check(await value() === 'function f() {\n    return 1;\n}', 'an HTML with only colored spans (VS Code) stays text/plain, indentation intact');
  await clear();
  await paste('#prompt', { text: '**平文** と # 見出し' });
  check(await value() === '**平文** と # 見出し', 'text/plain only (the Ctrl+Shift+V shape) is a plain paste: ' + JSON.stringify(await value()));
  await clear();
  await page.locator('#prompt').click();
  await page.keyboard.type('! echo ');
  await paste('#prompt', { html: '<strong>太字</strong> <a href="https://example.com/">リンク</a>', text: '太字 リンク' });
  const shell = await value();
  check(/echo 太字 リンク/.test(shell) && !/\*\*|\]\(/.test(shell), 'in the shell form (leading !) only the text is pasted: ' + JSON.stringify(shell));
  await clear();
  await page.locator('#prompt').click();
  await page.keyboard.type('```');
  await page.keyboard.press('Enter');
  await paste('#prompt', { html: '<strong>太字</strong> と <a href="https://example.com/">リンク</a>', text: '太字 と リンク' });
  const inCode = await value();
  check(/太字 と リンク/.test(inCode) && !/\*\*|\]\(/.test(inCode), 'inside a code block only the text is pasted: ' + JSON.stringify(inCode));
  await clear();
  // シェルの形に入った欄は読み直して抜ける（以降は ふつうの欄で確かめる）
  await page.reload();
  await later.click({ timeout: 6000 }).catch(() => {});
  await page.waitForFunction(() => window.__sockets?.at(-1)?.readyState === 1 && document.getElementById('prompt') && document.getElementById('channelsView'));
  await clear();

  // ---- 画像: data: は札（3 枚目から小さなタイル）・小さな画像と http は alt の字
  const imgs = await Promise.all([0, 1, 2, 3].map(png));
  await paste('#prompt', { html: `<h3>図</h3><p>前${imgs.map((d, i) => `<img src="${d}" alt="shot-${i + 1}">`).join('')}後<img src="https://cdn.example.com/e.png" alt="👀" width="20" height="20"><img src="http://cdn.example.com/p.png" alt="平文"></p>` });
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-b.md-att img').length === 4 && !document.querySelector('#prompt .md-att-up'), null, { timeout: 8000 });
  let c = await cards();
  check(c.length === 4 && c.every((x) => x.gal), 'four data: images become cards in place, the run of 3+ is small tiles: ' + JSON.stringify(c));
  check(await page.evaluate(() => { const r = document.querySelector('#prompt .md-b.md-att[data-gal] img').getBoundingClientRect(); return r.width === 72 && r.height === 54; }), 'a tile is 72x54');
  const withText = await value();
  check(/^### 図\n前\n(\[添付\] .*\n){4}後👀平文$/.test(withText), 'the text around the cards keeps its place; small and http images are their alt text: ' + JSON.stringify(withText));
  await page.keyboard.press('Control+z');
  check(await value() === '' && (await cards()).length === 0, 'Ctrl+Z removes the cards with the paste');
  await clear();
  await page.evaluate(() => { document.getElementById('prompt').value = ''; });
  const two = await Promise.all([4, 5].map(png));
  await paste('#prompt', { html: `<h3>x</h3><p>${two.map((d, i) => `<img src="${d}" alt="two-${i}">`).join('')}</p>` });
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-b.md-att img').length === 2, null, { timeout: 8000 });
  check((await cards()).every((x) => !x.gal), 'one or two images keep the current size');
  await clear();

  // ---- 取りに行けない画像（私設アドレス。ホストが断る）: 取り込み中の札が静かに消える
  await paste('#prompt', { html: '<h3>x</h3><p>前<img src="https://10.0.0.8/a.png" alt="private">後</p>' });
  await page.waitForFunction(() => document.querySelectorAll('#prompt .md-b.md-att').length === 0, null, { timeout: 8000 });
  const after = await page.evaluate(() => ({ text: document.getElementById('prompt').textContent, note: document.getElementById('composerNote')?.textContent ?? '', send: document.getElementById('send').disabled }));
  check(!/失敗|できません|送れません|再試行/.test(after.text + after.note) && !after.send, 'a card the host cannot fetch disappears quietly (no failure card, no notice) and sending works again');
  check(await value() === '### x\n前\n後', 'the text around it stays: ' + JSON.stringify(await value()));
  await clear();

  // ---- Channels の入力欄
  const rpc = (op, args) => page.evaluate(([o, a]) => new Promise((res, rej) => {
    const sock = window.__sockets.at(-1), id = 'r' + Math.random().toString(36).slice(2);
    const h = (e) => { const m = JSON.parse(e.data); if (m.kind === 'response' && m.id === id) { sock.removeEventListener('message', h); m.ok ? res(m.result) : rej(new Error(m.error)); } };
    sock.addEventListener('message', h);
    sock.send(JSON.stringify({ kind: 'command', command: 'invoke', id, args: { op: o, args: a } }));
  }), [op, args]);
  const ch = await rpc('channels.create', { name: 'paste' + String(Date.now()).slice(-5), purpose: '貼り付け' });
  await page.locator('#sideOrder [data-order="channel"]').click();
  await page.evaluate((id) => document.dispatchEvent(new CustomEvent('channels:show', { detail: { kind: 'channel', id } })), ch.id);
  await page.locator('#chFeedComposerInput').waitFor();
  const sel = '#chFeedComposerInput';
  await paste(sel, { html: `<h3>手順</h3><p><strong>先に</strong>これ</p><ul><li>a</li><li>b</li></ul><p><img src="${imgs[0]}" alt="one"></p>`, text: '手順\n先にこれ\na\nb' });
  await page.waitForFunction(() => document.querySelectorAll('#chFeedComposer .md-b.md-att img').length === 1, null, { timeout: 8000 });
  check((await value(sel)).startsWith('### 手順\n**先に**これ\n- a\n- b\n[添付] '), 'Channels: the composer pastes formatting and a card the same way: ' + JSON.stringify(await value(sel)));
  check(await page.locator('#chFeedComposer .att-count').textContent() === '添付 1 件', 'Channels: the strip counts the image');
  await page.keyboard.press('Control+z');
  check(await value(sel) === '' && (await cards('#chFeedComposer')).length === 0, 'Channels: Ctrl+Z undoes the paste');
  return results;
}
