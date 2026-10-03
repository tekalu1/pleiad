// playwright-cli run-code --filename=tests/browser/scheduled-send.cjs
// 送信日時の指定（docs/design-system.md「送信日時の指定」、ADR 0103）。
// fake バックエンドを別ポート・別のデータ置き場で立て、最初の案内を済ませてから流す（AGENTS.md）。
// 送信の ▾・右クリック・Ctrl+Shift+Enter・日時の指定・送信予定の行（今すぐ送る・編集・取り消す）・脇の行の印・狭い幅のシートを確かめる。
async page => {
  const checks = [];
  const check = (label, ok, detail = '') => { checks.push(`${ok ? 'OK' : 'NG'} ${label}${detail ? ` — ${detail}` : ''}`); if (!ok) throw Error(`${label} ${detail}`); };
  const wait = (ms) => page.waitForTimeout(ms);
  const promptValue = () => page.evaluate(() => document.getElementById('prompt').value);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.locator('.row[data-session], #newSession').first().waitFor();
  await wait(800);
  // 最初の案内（初回だけ出る）が開いていたら閉じる
  await page.evaluate(() => { const d = document.getElementById('onboardingDialog'); if (d?.open) d.close(); });

  // 会話を 1 つ作って最初の発言を済ませる（送信予定は送れる会話に置く）
  await page.locator('#newSession').click();
  await wait(800);
  await page.locator('#prompt').fill('echo:first');
  await page.locator('#send').click();
  await page.locator('.m.user', { hasText: 'echo:first' }).waitFor();
  await wait(1200);

  // ---- ▾: 中身が無ければ押せず、書けば開く
  check('中身が無いと ▾ は押せない', await page.locator('#sendMore').isDisabled());
  await page.locator('#prompt').fill('echo:scheduled');
  await wait(200);
  check('書くと ▾ が押せる', await page.locator('#sendMore').isEnabled());
  await page.locator('#sendMore').click();
  await page.locator('#sendPop').waitFor({ state: 'visible' });
  const labels = await page.locator('#sendPop .copt .main').allTextContents();
  check('候補に明日の朝・日時を指定が出る', labels.includes('明日の朝 9:00') && labels.includes('日時を指定…'), labels.join(' | '));
  await page.keyboard.press('Escape');
  check('Esc で閉じる', !(await page.locator('#sendPop').isVisible()));

  // ---- 右クリック・Ctrl+Shift+Enter でも開く
  await page.locator('#send').click({ button: 'right' });
  check('送信の円の右クリックで開く', await page.locator('#sendPop').isVisible());
  await page.keyboard.press('Escape');
  await page.locator('#prompt').focus();
  await page.keyboard.press('Control+Shift+Enter');
  check('Ctrl+Shift+Enter で開く（送信はしない）', await page.locator('#sendPop').isVisible() && await page.locator('.m.user', { hasText: 'echo:scheduled' }).count() === 0);

  // ---- 候補を 1 回押せば決まる
  await page.locator('#sendPop .copt', { hasText: '明日の朝 9:00' }).click();
  await page.locator('.sched').first().waitFor();
  const rowText = await page.locator('.sched').first().textContent();
  check('送信予定の行に時刻と本文が出る', rowText.includes('9:00') && rowText.includes('echo:scheduled'), rowText);
  check('入力欄は空になり、送信の ▾ は押せない', (await promptValue()) === '' && await page.locator('#sendMore').isDisabled());
  const sideMark = await page.locator('.row.sel .row-sched').textContent();
  check('脇の行に「◷ 9:00 に送信」が出る', sideMark.includes('9:00'), sideMark);
  check('送った扱いにならない（会話に発言が増えない）', await page.locator('.m.user', { hasText: 'echo:scheduled' }).count() === 0);

  // ---- 編集: 本文を入力欄へ戻し、時刻のチップが付く。× で外せばふつうの送信
  await page.locator('.sched .acts button', { hasText: '編集' }).click();
  await wait(500);
  check('編集で行が消え、本文が入力欄へ戻る', await page.locator('.sched').count() === 0 && (await promptValue()) === 'echo:scheduled');
  check('時刻のチップと「送信予定にし直します」が出る', await page.locator('#armedChip').isVisible() && (await page.locator('#armedNote').textContent()).includes('送信予定にし直します'));
  await page.locator('#send').click();
  await page.locator('.sched').first().waitFor();
  check('そのまま送ると同じ時刻で予定し直す', (await page.locator('.sched').first().textContent()).includes('9:00') && !(await page.locator('#armedChip').isVisible()));
  await page.locator('.sched .acts button', { hasText: '編集' }).click();
  await wait(400);
  await page.locator('#armedRemove').click();
  check('× で時刻を外すとチップが消える', !(await page.locator('#armedChip').isVisible()));

  // ---- 日時を指定: 日のチップと時刻の欄（標準の日時の入力は使わない）
  await page.locator('#sendMore').click();
  await page.locator('#sendPop .copt', { hasText: '日時を指定…' }).click();
  await page.locator('.send-picker').waitFor();
  check('日のチップは 7 日分', await page.locator('.send-days button').count() === 7);
  check('標準の datetime-local は使わない', await page.locator('input[type=datetime-local]').count() === 0);
  await page.locator('.send-picker input').fill('7:30');
  await wait(150);
  const sum = await page.locator('.send-sum').textContent();
  check('結果が 1 行で出る', sum.includes('7:30') && sum.includes('あと'), sum);
  await page.locator('.send-picker input').fill('abc');
  await wait(150);
  check('読めない時刻は送信予定にできない', await page.locator('.send-foot .btn-primary').isDisabled());
  await page.locator('.send-days button').nth(2).click();
  await page.locator('.send-picker input').fill('7:30');
  await wait(150);
  await page.locator('.send-foot .btn-primary').click();
  await wait(600);
  check('指定した日時（10/5 7:30）の予定ができる', await page.locator('.sched').count() === 1 && (await page.locator('.sched').first().textContent()).includes('7:30'));
  await page.locator('#prompt').fill('echo:other');
  await wait(200);
  await page.locator('#sendMore').click();
  await page.locator('#sendPop .copt', { hasText: '明日の朝 9:00' }).click();
  await wait(600);
  check('予定は時刻順に並ぶ', await page.locator('.sched').count() === 2 && (await page.locator('.sched').first().textContent()).includes('echo:other'));

  // ---- 今すぐ送る / 取り消す
  await page.locator('.sched').nth(1).locator('.acts button', { hasText: '取り消す' }).click();
  await wait(500);
  check('取り消すと行が消える', await page.locator('.sched').count() === 1);
  await page.locator('.sched .acts button', { hasText: '今すぐ送る' }).click();
  await page.locator('.m.user', { hasText: 'echo:other' }).waitFor();
  await wait(1500);
  check('今すぐ送ると予定が消え、発言が会話に入る', await page.locator('.sched').count() === 0 && await page.locator('.m.user', { hasText: 'echo:other' }).count() === 1);
  check('脇の行の印も消える', await page.locator('.row.sel .row-sched').count() === 0);

  // ---- 狭い幅: ▾ は出さず、送信の円の長押し（contextmenu）で下からシート
  await page.setViewportSize({ width: 360, height: 780 });
  await wait(500);
  await page.locator('#prompt').fill('echo:phone');
  await wait(200);
  check('480px 以下では ▾ を出さない', !(await page.locator('#sendMore').isVisible()));
  await page.locator('#send').dispatchEvent('contextmenu');
  await page.locator('#sendPop.sheet').waitFor({ state: 'visible' });
  const sheetLabels = await page.locator('#sendPop .copt .main').allTextContents();
  check('シートに候補と「今すぐ送る」が出る', sheetLabels.includes('明日の朝 9:00') && sheetLabels.includes('今すぐ送る'), sheetLabels.join(' | '));
  check('幕が出る', await page.locator('#sendVeil').isVisible());
  await wait(400);   // 下から上がる動きが終わってから測る
  const box = await page.locator('#sendPop').boundingBox();
  check('シートは画面の下に付く', Math.abs(box.y + box.height - 780) < 4 && box.width >= 359, JSON.stringify(box));
  await page.locator('#sendVeil').click({ position: { x: 20, y: 20 } });
  check('幕を押すと閉じる', !(await page.locator('#sendPop').isVisible()) && !(await page.locator('#sendVeil').isVisible()));
  await page.setViewportSize({ width: 1280, height: 800 });
  return checks.join('\n');
}
