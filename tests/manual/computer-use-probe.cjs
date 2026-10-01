// computer use の main 側（desktop/computer/*）を実機で確かめる手動のプローブ。docs/computer-use.md「実機（VM）での確認の手順」。
//
//   electron tests/manual/computer-use-probe.cjs            本物の入力を送る。Windows Sandbox か Hyper-V の VM の中でだけ使う
//   electron tests/manual/computer-use-probe.cjs --dry-run  SendInput を送らず、送るはずの INPUT を表示する（利用者の PC で動かしてよい。アプリも起動しない）
//
// 本物の入力はユーザーの画面・前面の窓に届く。**ユーザーが使っている PC では --dry-run 以外を動かさない。**
// Pleiad から起動されたシェルでは ELECTRON_RUN_AS_NODE=1 が引き継がれているので、`env -u ELECTRON_RUN_AS_NODE` で外す。
// 撮った画像は os.tmpdir() に置く。見終わったら消す。
const { app, screen, nativeImage } = require('electron');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadWin32 } = require('../../desktop/computer/win32.cjs');
const { attachComputerService } = require('../../desktop/computer/service.cjs');

const dryRun = process.argv.includes('--dry-run');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (label, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'OK' : 'NG'}  ${label}${detail ? '  — ' + detail : ''}`); };
const SHOT_ARGS = { display: 1, maxPixels: 1_200_000, maxEdge: 1568, quality: 75 };

app.setPath('userData', path.join(os.tmpdir(), 'computer-use-probe-userdata'));
app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    const win32 = loadWin32();
    if (dryRun) {
      win32.sendInput = inputs => { // 本物の SendInput は呼ばない
        for (const e of inputs) console.log('   [dry-run] INPUT', JSON.stringify(e));
        return { sent: inputs.length, error: 0 };
      };
    }
    const worker = new EventEmitter();
    const waiters = new Map();
    worker.postMessage = message => { if (message.id !== undefined) waiters.get(message.id)?.(message); else if (message.type === 'computer-ready') waiters.get('ready')?.(message); };
    const service = attachComputerService(worker, { electron: { screen, nativeImage }, app, win32, log: line => console.log('   [log]', line) });
    let serial = 0;
    const call = (op, args = {}, owner = 'probe') => new Promise(resolve => {
      const id = ++serial; waiters.set(id, resolve);
      worker.emit('message', { type: 'computer-call', id, owner, op, args });
    });
    const ready = await new Promise(resolve => { waiters.set('ready', resolve); worker.emit('message', { type: 'computer-ready-request' }); });
    check('computer-ready: supported', ready.supported === true, JSON.stringify({ reason: ready.reason, displays: ready.displays.length, version: ready.displaysVersion }));
    for (const d of ready.displays) console.log(`   display ${d.index}: ${d.bounds.width}x${d.bounds.height} at (${d.bounds.x}, ${d.bounds.y}) scale ${d.scale}${d.primary ? ' primary' : ''}`);
    console.log('   main thread DPI:', JSON.stringify(win32.dpi.get()));
    worker.emit('message', { type: 'computer-arm', owner: 'probe' });

    const shot = await call('screenshot', SHOT_ARGS);
    check('screenshot（主モニター）', shot.ok, shot.ok ? `${shot.data.width}x${shot.data.height} scale ${shot.data.scale.toFixed(4)} ${shot.data.jpeg.length} bytes` : JSON.stringify(shot.error));
    const keep = [];
    const save = (name, data) => { const file = path.join(os.tmpdir(), `computer-use-probe-${name}.jpg`); fs.writeFileSync(file, Buffer.from(data.jpeg)); keep.push(file); return file; };
    if (shot.ok) console.log('   saved', save('1-before', shot.data));
    check('foreground', (await call('foreground')).ok);
    check('cursor', (await call('cursor')).ok);

    if (!dryRun) {
      const found = (await call('findApp', { name: 'notepad' })).data?.apps ?? [];
      check('findApp notepad', found.length > 0, found.map(a => `${a.name} (${a.id})`).join(', '));
      const notepad = found[0];
      if (notepad) {
        const launched = await call('launch', { app: notepad });
        check('launch notepad', launched.ok, JSON.stringify(launched.ok ? { started: launched.data.started, alreadyRunning: launched.data.alreadyRunning } : launched.error));
        await sleep(2000);
        const fg = (await call('foreground')).data?.app;
        check('起動したメモ帳が前面', fg?.id === notepad.id || /notepad/i.test(fg?.name ?? ''), `${fg?.name} (${fg?.id})`);
        // メモ帳の窓が見つかる点を、画面を格子状に探す（窓の矩形を取る口は第 2 段階）
        const d1 = ready.displays[0].bounds;
        let target = null;
        for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) for (const fy of [0.5, 0.4, 0.6, 0.3, 0.7]) {
          if (target) break;
          const p = { x: Math.round(d1.x + d1.width * fx), y: Math.round(d1.y + d1.height * fy) };
          const app = (await call('appAt', p)).data?.app;
          if (app && (app.id === notepad.id || /notepad/i.test(app.name))) target = p;
        }
        check('appAt: 画面の格子の中にメモ帳の窓がある', !!target, JSON.stringify(target));
        if (target) {
          const click = await call('input', { actions: [{ type: 'click', x: target.x, y: target.y, button: 'left', count: 1 }] });
          check('click', click.ok, JSON.stringify(click.ok ? click.data : click.error));
          check('クリック後のカーソルは狙った位置（±1 画素）', click.ok && Math.abs(click.data.cursor.x - target.x) <= 1 && Math.abs(click.data.cursor.y - target.y) <= 1, click.ok ? JSON.stringify(click.data.cursor) : '');
          const typed = await call('input', { actions: [{ type: 'text', text: 'Hello 日本語 😀\nline2' }] });
          check('type（UNICODE。IME が有効でも素通りするか画像で見る）', typed.ok, JSON.stringify(typed.ok ? typed.data : typed.error));
          const keys = await call('input', { actions: [{ type: 'key', combo: 'ctrl+a' }, { type: 'key', combo: 'Left' }, { type: 'key', combo: 'Delete', repeat: 2 }] });
          check('key（ctrl+a・Left・Delete×2）', keys.ok, JSON.stringify(keys.ok ? keys.data : keys.error));
          const after = await call('screenshot', SHOT_ARGS);
          if (after.ok) console.log('   saved（メモ帳に Hello 日本語 😀 / line2 が入っているか目で見る）', save('2-after-typing', after.data));
          const drag = await call('input', { actions: [{ type: 'drag', from: { x: target.x, y: target.y }, to: { x: target.x + 120, y: target.y + 40 } }] });
          check('drag（範囲選択）', drag.ok);
          const scroll = await call('input', { actions: [{ type: 'scroll', x: target.x, y: target.y, direction: 'down', amount: 3 }] });
          check('scroll', scroll.ok);
        }
        const win = await call('input', { actions: [{ type: 'key', combo: 'super+r' }] });
        check('Windows キーは windows_key で拒む', win.error?.code === 'windows_key');
      }
    }

    const hold = await call('input', { actions: [{ type: 'keyDown', combo: 'shift' }, { type: 'down', button: 'right' }] });
    check('keyDown shift・down right（押したまま）', hold.ok);
    const released = await call('releaseAll');
    check('releaseAll は押したものだけを離す', released.ok && released.data.released.join() === 'right,shift', JSON.stringify(released.data));

    const zoom = await call('screenshot', { ...SHOT_ARGS, region: { x: ready.displays[0].bounds.x, y: ready.displays[0].bounds.y, width: 300, height: 200 }, upscale: true });
    check('zoom（region + upscale）', zoom.ok, zoom.ok ? `${zoom.data.width}x${zoom.data.height} scale ${zoom.data.scale.toFixed(2)}` : '');
    if (zoom.ok) console.log('   saved', save('3-zoom', zoom.data));

    worker.emit('message', { type: 'computer-turn-ended', owner: 'probe' });
    service.detach();
    console.log(`\n${results.filter(Boolean).length} / ${results.length} 通過${dryRun ? '（dry-run: 何も送っていない）' : ''}`);
    if (keep.length) console.log('撮った画像（見終わったら消す）:\n  ' + keep.join('\n  '));
    console.log(`\n手動で確かめる項目（このスクリプトでは出来ない）:
  - ロック画面（Win+L）で screenshot / input が locked になり、解除すると続けられる
  - 管理者で動かしたメモ帳・cmd に input を送ると uipi になる
  - 倍率の違う 2 枚のモニターで、display 2 のクリックが狙いの位置に当たる
  - IME が日本語入力のとき、key（ctrl+a など）と type（日本語）の挙動
  - Esc（オーバーレイの globalShortcut）で押したままの入力が離れる（オーバーレイ側の確認と一緒に）`);
    exitCode = results.every(Boolean) ? 0 : 1;
  } catch (error) {
    console.log('FAIL', error);
    exitCode = 2;
  }
  process.exitCode = exitCode;
  app.quit();
});
