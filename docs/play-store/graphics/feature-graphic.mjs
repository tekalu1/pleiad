// Google Play のフィーチャー グラフィック（1024×500、透過なしの PNG）を、サイトの見出しと星図（site/index.html の .hero）から撮る。
// 実行: node docs/play-store/graphics/feature-graphic.mjs   （playwright-core は playwright-cli 同梱のもの。PW_CORE・PW_CHROMIUM で替えられる）
// site/ をその場の静的サーバーで配り、headless の Chromium（1024×500）で開く。見出しを短い一言に差し替え、
// 他社のロゴと名前（lede・星図の札のアイコン）・ボタン・ナビの字を隠し、星図が落ち着いてから撮る。前面の窓には触れない。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(HERE, 'feature-graphic.png');

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core');

function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
  const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  return path.join(base, dirs[0], 'chrome-headless-shell-win64/chrome-headless-shell.exe');
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html');
  const file = path.join(SITE, rel);
  if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: chromiumPath() });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 500 }, deviceScaleFactor: 1, locale: 'ja-JP', colorScheme: 'light' });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  // 札は「承認待ち」の 1 枚だけ（アプリの用途に合う。札のアイコンは他社のロゴなので隠す）
  await page.addStyleTag({ content: `
    .nav, .hero-copy .lede, .hero-copy .cta, .hero-copy .meta, .sky-label img, .sky-label:not(.is-wait) { display: none !important; }
    .hero { height: 500px !important; min-height: 0 !important; }
    .hero-copy { left: 64px !important; bottom: 112px !important; }
    .hero-copy .brand { margin-bottom: 26px; }
    .hero-copy .brand-mark { width: 40px; height: 40px; }
    .hero-copy .brand-word { width: 96px; height: 29px; }
    .hero-copy h1 { font-size: 60px !important; }
  ` });
  // 印と字（Pleiad）を見出しの上へ移し、見出しを短い一言に（2 行。右の星図が切れても、左の一言だけで意味が通る）
  await page.evaluate(() => {
    const copy = document.querySelector('.hero-copy');
    copy.prepend(document.querySelector('.nav .brand'));
    const [a, b] = copy.querySelectorAll('h1 .ln > span');
    a.textContent = 'PC のエージェントを、';
    b.textContent = '手元から。';
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(4000);   // 星図の線が伸び切るまで
  // 「承認待ち」の札が出切るまで（札は順に入れ替わる）
  await page.waitForFunction(() => Number(document.querySelector('.sky-label.is-wait')?.style.opacity) > 0.97, null, { timeout: 60_000 });
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1024, height: 500, scale: 1 } });
  fs.writeFileSync(OUT, Buffer.from(data, 'base64'));
  console.log(`wrote ${path.relative(ROOT, OUT)}`);
} finally {
  await browser.close();
  server.close();
}
