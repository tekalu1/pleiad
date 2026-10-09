// playwright-cli -s=message-quote-bar run-code --filename=tests/browser/message-quote-bar.cjs
// 発言の中の引用（Markdown の blockquote）が入力欄の引用と同じ左の縦線になっているか、本物のブラウザーの computed style で確かめる
// （docs/design-system.md「4.5 会話」。規則の文字は tests/unit/composer-layout.mjs）。認証済みの、実データと分離した fake サーバーを開いてから実行する
// （AGENT_HOST_BACKENDS=fake AGENT_HOST_DATA=<一時> AGENT_HOST_PORT=<空き> AGENT_HOST_LOCALE=ja で起動し、最初の案内は「あとで」）。
//   1. 面・角丸・枠が無く、左に 2px の線（::before・--line-strong）と弱い字。会話の返答・あなたの吹き出し・Channels の投稿・スレッドの作業ログ
//   2. 入れ子は 1 段ごとに 16px 右へ線が増え、入れ子の後の下に余白が溜まらない
//   3. 吹き出しの中の線も --line-strong（青にしない）
async page => {
  const results = [];
  const check = (name, got, want) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) throw Error(`${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
    results.push(name);
  };
  const THEMES = ['light', 'dark'];
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((theme) => document.documentElement.setAttribute('data-theme', theme), theme);
    const got = await page.evaluate(() => {
      const host = document.createElement('div');
      host.id = 'mqb-probe';
      // render.mjs の出力と同じ形（外 → 内 → 内の内、外へ戻る段落、後続の本文）
      const quote = '<blockquote><p>外</p><blockquote><p>内</p><blockquote><p>内の内</p></blockquote></blockquote></blockquote><p>本文</p>';
      host.innerHTML = `
        <div class="m ai"><div class="body" id="mqb-ai">${quote}</div></div>
        <div class="m user"><div class="body md-user" id="mqb-user">${quote}</div></div>
        <div class="post"><div class="post-body" id="mqb-post">${quote}</div></div>
        <div class="th-log-text" id="mqb-log">${quote}</div>
        <i id="mqb-line" style="display:block;width:2px;height:2px;background:var(--line-strong)"></i><i id="mqb-weak" style="color:var(--ink-weak)"></i>`;
      document.body.append(host);
      const rgb = (n) => getComputedStyle(n).backgroundColor;
      const lineRef = rgb(document.getElementById('mqb-line'));
      const weakRef = getComputedStyle(document.getElementById('mqb-weak')).color;
      const out = {};
      for (const id of ['ai', 'user', 'post', 'log']) {
        const root = document.getElementById('mqb-' + id);
        const [q1, q2, q3] = root.querySelectorAll('blockquote');
        const c = getComputedStyle(q1), b = getComputedStyle(q1, '::before');
        const r1 = q1.getBoundingClientRect(), r2 = q2.getBoundingClientRect(), r3 = q3.getBoundingClientRect();
        out[id] = {
          box: [c.backgroundColor, c.borderLeftWidth, c.borderTopLeftRadius, c.paddingLeft].join('/'),
          weak: c.color === weakRef,
          bar: [b.position, b.left, b.width, b.backgroundImage.includes(lineRef)].join('/'),
          // 入れ子は 1 段ごとに 16px 右へ。内の内の下には、外の下の余白（padding 2px）だけが残る
          step: [r2.left - r1.left, r3.left - r2.left],
          tail: [r1.bottom - r2.bottom, r2.bottom - r3.bottom],
        };
      }
      host.remove();
      return out;
    });
    for (const id of ['ai', 'user', 'post', 'log']) {
      check(`${theme}/${id}: 面・角丸・枠が無く、左に 2px の線（--line-strong）`, [got[id].box, got[id].bar], ['rgba(0, 0, 0, 0)/0px/0px/12px', 'absolute/0px/2px/true']);
      check(`${theme}/${id}: 字は --ink-weak`, got[id].weak, true);
      check(`${theme}/${id}: 入れ子は 16px ずつ右へ`, got[id].step, [16, 16]);
      check(`${theme}/${id}: 入れ子の下に余白が溜まらない（外の padding の 2px だけ）`, got[id].tail, [2, 2]);
    }
  }
  return { passed: true, checks: results };
}
