// playwright-cli run-code --filename=tests/browser/composer-fit.cjs
// 入力欄の下の行の詰め方（docs/design-system.md「入力欄と上端」・web/composer-controls.mjs の fitComposerRow）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（AGENTS.md）。
// 新しい会話の入力欄で、幅（360・412）× 状態（待機・実行中 = 中断のボタン・通話中 = マイクとスピーカー）× 作業ディレクトリの名前（短い・長い）を作り、
// 詰める順が「段 → 名前を … で詰める（宛先とモデル 4 字・作業ディレクトリ 7 字まで）→ 作業ディレクトリ → 承認モード → 宛先とモデル の順にアイコンだけ」で、
// 送信が行に収まることを確かめる。実行中・通話中は DOM で形だけ作る（fake では止まったまま走らせ続けられず、headless ではマイクが無い）。
async page => {
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  await page.evaluate(() => document.querySelector('#newSession')?.click());
  await page.waitForFunction(() => document.querySelector('#modelChip .v .mn')?.textContent);
  const shortCwd = await page.evaluate(() => document.querySelector('#cwdChip .v').textContent);
  for (const width of [360, 412]) {
    await page.setViewportSize({ width, height: 780 });
    for (const state of ['wait', 'run', 'call']) {
      for (const cwd of [shortCwd, 'very-long-workspace-name']) {
        const r = await page.evaluate(({ state, cwd }) => {
          const row = document.querySelector('#composer .crow');
          document.querySelector('#abort').hidden = state !== 'run';
          document.documentElement.classList.toggle('vc-in-call', state === 'call');
          document.querySelector('#cwdChip .v').textContent = cwd;
          dispatchEvent(new Event('resize'));
          const ctx = document.createElement('canvas').getContext('2d');
          // 名前の先頭 n 字と … が見えているか（もともと n 字以下なら全部）
          const shows = (name, n) => {
            const chars = [...name.textContent.trim()];
            ctx.font = getComputedStyle(name).font;
            const need = ctx.measureText(chars.length <= n ? chars.join('') : `${chars.slice(0, n).join('')}…`).width;
            return name.getBoundingClientRect().width + 1 >= need;
          };
          const last = [...row.children].reverse().find((n) => n.offsetParent);
          const has = (c) => row.classList.contains(c);
          return {
            fits: last.getBoundingClientRect().right <= row.getBoundingClientRect().right + 0.5,
            cwdIcon: has('fit-cwd-icon'), modeIcon: has('fit-mode-icon'), whoIcon: has('fit-model-icon'),
            who: has('fit-model-icon') || shows(document.querySelector('#modelChip .v .mn'), 4),
            cwdName: has('fit-cwd-icon') || shows(document.querySelector('#cwdChip .v'), 7),
            cls: row.className,
          };
        }, { state, cwd });
        const tag = `${width} ${state} ${cwd.length > 12 ? '長い作業場所' : '短い作業場所'}`;
        check(`${tag}: 送信が行に収まる`, r.fits, r.cls);
        check(`${tag}: 宛先とモデルの名前は 4 字より削らない（アイコンだけになるまで）`, r.who, r.cls);
        check(`${tag}: 作業ディレクトリの名前は 7 字より削らない（アイコンだけになるまで）`, r.cwdName, r.cls);
        check(`${tag}: アイコンだけにする順は 作業ディレクトリ → 承認モード → 宛先とモデル`, (!r.modeIcon || r.cwdIcon) && (!r.whoIcon || r.modeIcon), r.cls);
      }
    }
  }
  await page.evaluate((cwd) => { document.querySelector('#cwdChip .v').textContent = cwd; document.documentElement.classList.remove('vc-in-call'); }, shortCwd);
  return checks.join('\n');
}
