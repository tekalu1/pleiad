// Run on an authenticated isolated fake server. Creates one empty session; no LLM calls.
async page => {
  const later = page.getByRole('button', { name: 'あとで', exact: true });
  if (await later.isVisible()) await later.click();
  await page.locator('#newSession').click();
  await page.locator('.row.sel[data-session]').waitFor();
  const id = await page.locator('.row.sel').getAttribute('data-session');
  const status = `入力確認-${Date.now()}`;
  await page.locator('.row.sel').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '状態を変更', exact: false }).click();
  const input = page.getByPlaceholder('新しい状態を作る');
  await input.click();
  await input.pressSequentially('abc', { delay: 120 });
  await page.mouse.move(1100, 650);
  await input.pressSequentially('def', { delay: 120 });
  if (await input.inputValue() !== 'abcdef') throw Error('input lost while typing outside menu');
  await input.fill(status);
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true });
  if (!await input.isVisible()) throw Error('IME Enter closed status editor');
  await input.press('Enter');
  await page.getByRole('button', { name: status, exact: true }).waitFor();
  await page.reload();
  // Fake has no configured account, so onboarding reappears asynchronously.
  await later.waitFor();
  await later.click();
  await page.getByRole('button', { name: status, exact: true }).waitFor();
  await page.locator(`.row[data-session="${id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'タイトルを変更…', exact: false }).click();
  const title = page.getByPlaceholder('新しいタイトル');
  await title.fill('日本語タイトル');
  await title.dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  if (!await title.isVisible()) throw Error('IME Enter closed title editor');
  await title.press('Enter');
  await page.locator(`.row[data-session="${id}"]`).getByText('日本語タイトル', { exact: true }).waitFor();
  return { passed: true, statusPersisted: true, titleChanged: true };
}
