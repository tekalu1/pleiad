// 設定 › API キーの打鍵（実ブラウザー。承認済み 2026-10-07、docs/design-system.md「設定 › API キー」）:
//   移行の案内（まとめる）→ 差し替えの確かめ直し → 削除の確認 → 通話・委譲の「使うキー」→ 接続先のフォームの「登録済みのキー」。
//   ライト・ダーク・1280・360 で横にはみ出さない。キーの値が DOM に出ない。
// 実行: node tests/browser/api-keys.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる。API_KEYS_SHOTS=<ディレクトリ> で場面ごとに撮る）
// 本物のサーバー（fake と codex の身代わり・一時のデータ置き場・別ポート）、偽の OpenRouter・偽の互換 API だけと話す。実データには触れない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, ROOT } from '../lib/server.mjs';
import { startFakeOpenRouter } from '../lib/fake-openrouter.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');
const SHOTS = process.env.API_KEYS_SHOTS || '';
const results = [];
const check = (ok, label, detail) => { if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` ${JSON.stringify(detail)}`}`); results.push(label); };

const A = 'sk-or-v1-' + 'a'.repeat(24), B = 'sk-or-v1-' + 'b'.repeat(24), C = 'csk-' + 'c'.repeat(24), L = 'sk-lite-' + 'l'.repeat(24);

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter(n => n.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-apikeys-ui-'));
const fakeOr = await startFakeOpenRouter();
const compatApi = await startFakeCompatApi({ keys: [A, B, L] });
let server, browser;
try {
  // 古い置き場を仕込む。偽の互換 API は 127.0.0.1 なので、接続先は URL のホストが openrouter.ai ではなく、プロバイダーは custom（ホストごとに別の件）。
  // OpenRouter のキーは判定器（A）と通話（B）の 2 件で値が違う → 案内。接続先は custom の A（OpenRouter 互換）と L（社内 LiteLLM）、Cerebras の C
  const ep = (id, agent, name, preset) => ({ id, agent, name, preset, baseUrl: compatApi.url + (agent === 'codex' ? '/v1' : ''), authMode: 'bearer', auth: 'bearer',
    roles: agent === 'codex' ? { main: 'fake-large' } : { main: 'fake-large', opus: 'fake-large', sonnet: 'fake-large', haiku: 'fake-large' }, options: {}, models: ['fake-large'] });
  fs.writeFileSync(path.join(dataDir, 'compat-endpoints.json'), JSON.stringify({ version: 1, defaults: { claude: '', codex: '' }, endpoints: [
    ep('ep-111111111111', 'codex', 'OpenRouter 互換', 'custom'), ep('ep-333333333333', 'codex', '社内 LiteLLM', 'custom')] }));
  const compat = createSecretStore({ file: path.join(dataDir, 'compat-endpoint-secrets.json'), cipher: plainCipher });
  await compat.set('compat-endpoint:ep-111111111111', { key: A });
  await compat.set('compat-endpoint:ep-333333333333', { key: L });
  await compat.set('delegation-routing:openrouter', { key: A });
  await compat.set('delegation-routing:cerebras', { key: C });
  await createSecretStore({ file: path.join(dataDir, 'voice-secrets.json'), cipher: plainCipher }).set('openrouter', { key: B });

  server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_VOICE_API: fakeOr.url,
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"`, FAKE_CODEX_LOG: path.join(dataDir, 'fake-codex.log') } });
  const url = `http://127.0.0.1:${server.port}/?token=${server.token}`;
  browser = await chromium.launch({ executablePath: chromiumPath() });

  async function session({ width = 1280, scheme = 'light' } = {}) {
    const ctx = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme, locale: 'ja-JP' });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
    await page.evaluate(() => document.getElementById('settings')?.click());
    return { ctx, page };
  }
  const tab = async (page, id) => { await page.evaluate(x => document.getElementById(x)?.click(), id); await page.waitForTimeout(500); };
  const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `api-keys-${name}.png`) }); };
  const text = (page, sel) => page.locator(sel).innerText();

  const { ctx, page } = await session();
  await tab(page, 'apiKeysTab');
  const panel = '#apiKeysPanel';
  check((await page.locator(`${panel} .ak-card`).count()) === 5, '移行: 5 件（OpenRouter ×2（判定器 A・通話 B）・Cerebras・custom ×2（OpenRouter 互換・社内 LiteLLM）。URL のホストが openrouter.ai でない接続先は OpenRouter のキーにならない）', await page.locator(`${panel} .ak-card strong`).allInnerTexts());
  check((await text(page, panel)).includes('OpenRouter のキーが 2 つあります'), '移行の案内が先頭に 1 回出る');
  check(!(await page.locator(panel).innerHTML()).includes(A) && !(await page.locator(panel).innerHTML()).includes(B), 'DOM にキーの値が無い');
  await shot(page, 'guide');

  // まとめる
  await page.locator(`${panel} button:has-text("まとめる…")`).click();
  await page.locator(`${panel} input[type=radio][name=ak-keep]`).first().check();
  await page.locator(`${panel} .ak-guide button.btn-primary`).click();
  await page.waitForSelector(`${panel} .ak-result button:has-text("閉じる")`, { timeout: 20000 });
  check((await page.locator(`${panel} .ak-card`).count()) === 4 && !(await text(page, panel)).includes('キーが 2 つあります'), 'まとめる: OpenRouter の 2 件が 1 件になって 4 件、案内は消える');
  check((await text(page, `${panel} .ak-result`)).includes('すべてつながりました'), 'まとめた後は使っている所を確かめ直して、結果を並べる');
  await shot(page, 'merged');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1200);
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await tab(page, 'apiKeysTab');
  check(!(await text(page, panel)).includes('キーが 2 つあります'), '案内は二度と出ない（再読み込みしても）');

  // 差し替え: Esc で閉じて元のボタンへ戻る
  const orCard = page.locator(`${panel} .ak-card`, { hasText: 'OpenRouter 互換' }).first();
  await orCard.locator('button[aria-label^="差し替える"]').click();
  await page.waitForTimeout(400);
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.includes('新しいキー')), '差し替えの欄を開くと入力へフォーカス');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  check(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('差し替える')), 'Esc で閉じて元の［差し替える］へ戻る');
  await orCard.locator('button[aria-label^="差し替える"]').click();
  await page.locator(`${panel} .rt-key-form input`).first().fill(A);
  await page.locator(`${panel} .rt-key-form button[type=submit]`).first().click();
  await page.waitForSelector(`${panel} .ak-result button:has-text("閉じる")`, { timeout: 20000 });
  check((await text(page, `${panel} .ak-result`)).includes('つながりました'), '差し替え: 使っている接続先を確かめ直して ✓ を並べる');
  check(fakeOr.records.key >= 1, '差し替え: キーそのものの確認（GET /key）も走る');

  // 削除の確認: やめるに最初のフォーカス
  await page.locator(`${panel} .ak-card`, { hasText: '社内 LiteLLM' }).first().locator('button[aria-label^="削除"]').click();
  await page.waitForTimeout(400);
  check((await text(page, `${panel} .ak-confirm`)).includes('選び直しが必要'), '削除: 使っている所と削除後に起きることを並べて聞く');
  check(await page.evaluate(() => document.activeElement?.textContent === 'やめる'), '削除の確認は［やめる］に最初のフォーカス');
  await shot(page, 'delete');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // 通話: 使うキーを選ぶ・使わない
  await tab(page, 'voiceTab');
  await page.locator('#voicePanel .ak-selbtn').click();
  check((await page.locator('#voicePanel [role=listbox] [role=option]').count()) >= 2, '通話: 使うキーの選択に登録済みのキーと「使わない」');
  await shot(page, 'voice-popup');
  await page.locator('#voicePanel [role=option]', { hasText: '使わない' }).click();
  await page.waitForTimeout(800);
  check((await text(page, '#voicePanel')).includes('通話は使えません'), '通話: 「使わない」にすると通話は使えない');
  check(!(await fs.promises.readFile(path.join(dataDir, 'voice-secrets.json'), 'utf8')).includes('"openrouter"'), '通話: 古い置き場の通話のキーも消える（古い版も送らない）');

  // 委譲: Cerebras の判定器
  await tab(page, 'delegationTab');
  check((await page.locator('#delegationPanel .rt-key').count()) === 2 && (await text(page, '#delegationPanel')).includes('判定器が使うキー'), '委譲: 判定器ごとに「使うキー」');

  // 接続先のフォーム: 登録済みのキーが既定
  await tab(page, 'setupTab');
  await page.locator('#setupPanel button:has-text("接続先")').first().click();
  await page.waitForTimeout(700);
  await page.locator('#compatEndpointsPanel button:has-text("追加")').first().click();
  await page.waitForTimeout(500);
  check((await text(page, '#compatEndpointsPanel')).includes('登録済み') && await page.locator('#compatEndpointsPanel input[type=radio]').count() === 2, '接続先: 「登録済みのキー／別のキーを入れる」');
  check(!(await page.locator('#compatEndpointsPanel input[type=password]').count()), '接続先: 登録済みを選んでいる間は貼る欄が無い');
  await page.locator('#compatEndpointsPanel label:has-text("別のキーを入れる")').click();
  check(await page.locator('#compatEndpointsPanel input[type=password]').count() === 1, '接続先: 別のキーを入れるを選ぶと欄が出る');
  await shot(page, 'endpoint');
  await ctx.close();

  // 360・ダーク: 横にはみ出さない
  for (const [width, scheme] of [[360, 'light'], [360, 'dark'], [1280, 'dark']]) {
    const s = await session({ width, scheme });
    for (const id of ['apiKeysTab', 'voiceTab', 'delegationTab']) {
      await tab(s.page, id);
      const over = await s.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      check(!over, `${width}px・${scheme}・${id}: 横にはみ出さない`);
    }
    await s.ctx.close();
  }
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`\n全て通過 ${results.length} 判定`);
} catch (e) {
  console.log(results.map(r => `  OK  ${r}`).join('\n'));
  console.log(`  NG  ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await server?.stop();
  await fakeOr.close();
  await compatApi.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
