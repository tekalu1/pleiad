// 入力欄の `!`（シェルの行。web/shell-composer.mjs、ADR 0054）。DOM は tests/lib/dom-stub.mjs。
//   - 空の欄の先頭で `!` を打ったときだけシェルの形になる（`!` は欄に残さない）。貼り付け・途中の `!`・IME の変換中では入らない
//   - 空の欄で Backspace を押すと元の欄に戻る
//   - 使えない会話では `!` を残し、頭に理由を出して送信を止める見た目にする（押せる。押すと光らせる）
//   - 「文として送る」は `!` を頭に戻して送る。下書きには `!` 付きで残す（復元ではシェルの形に入らない）
//   - 入力欄に写す: 空の欄で走らせられる会話なら、シェルの形でコマンドを入れる
// client.mjs の配線（submit の分岐・送信待ちに入れないこと）はコードの文字列で確かめる。
import { readFileSync } from 'node:fs';
import { N } from '../lib/dom-stub.mjs';
import { createShellComposer } from '../../web/shell-composer.mjs';

export const name = 'shell-composer';
export const title = '入力欄の `!`: 打つとシェルの形・貼り付けでは入らない・Backspace で戻る・使えない会話・文として送る';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

function setup({ ok = true, text = 'この会話ではシェルを実行できません', host = '' } = {}) {
  const box = new N('div'), prompt = new N('textarea'), head = new N('div'), send = new N('button');
  prompt.value = '';
  prompt.placeholder = 'Ctrl+Enter で送信';
  send.setAttribute('title', '送信');
  send.setAttribute('aria-label', '送信');
  head.hidden = true;
  const sent = [];
  let avail = { ok, ...(ok ? {} : { text }) };
  const c = createShellComposer({ box, prompt, head, send, t: (k, p) => (p ? `[${k}:${JSON.stringify(p)}]` : `[${k}]`),
    availability: () => avail, where: () => ({ cwd: 'D:/dev/pleiad', host }), onAsText: (s) => sent.push(s) });
  const key = (data, extra = {}) => {
    let prevented = false;
    const e = { inputType: 'insertText', data, isComposing: false, preventDefault: () => { prevented = true; }, ...extra };
    c.beforeinput(e);
    if (!prevented && e.inputType.startsWith('insert')) prompt.value += data;
    return prevented;
  };
  const backspace = () => { let prevented = false; c.keydown({ key: 'Backspace', preventDefault: () => { prevented = true; } }); if (!prevented) prompt.value = prompt.value.slice(0, -1); c.input(); return prevented; };
  return { c, box, prompt, head, send, sent, key, backspace, setAvail: (a) => { avail = a; } };
}
const texts = (n) => (n.children ?? []).map(x => x.textContent).join('|');

export default function (t) {
  {
    const s = setup();
    t.ok('空の欄の先頭で `!` を打つとシェルの形（`!` は欄に入れない）', s.key('!') === true && s.c.active && s.prompt.value === '' && s.box.classList.contains('shell'));
    t.ok('頭の行に「シェル · 作業ディレクトリの名前」と「文として送る」', !s.head.hidden && texts(s.head).includes('[chat.shell.label]') && texts(s.head).includes('pleiad') && texts(s.head).includes('[chat.shell.asText]'), texts(s.head));
    t.ok('送信の名前は「実行」、プレースホルダーは実行するコマンド', s.send.getAttribute('title') === '[chat.shell.run]' && s.send.getAttribute('aria-label') === '[chat.shell.run]' && s.prompt.placeholder === '[chat.shell.placeholder]');
    s.key('l'); s.key('s');
    t.ok('シェルの形でも字は書ける', s.prompt.value === 'ls' && s.c.active);
    t.ok('字がある間の Backspace は字を消すだけ', s.backspace() === false && s.prompt.value === 'l' && s.c.active);
    s.backspace();
    t.ok('空の欄で Backspace を押すと元の欄に戻る', s.backspace() === true && !s.c.active && !s.box.classList.contains('shell') && s.head.hidden);
    t.ok('戻ると送信の名前とプレースホルダーも戻る', s.send.getAttribute('title') === '送信' && s.prompt.placeholder === 'Ctrl+Enter で送信');
  }
  {
    const s = setup();
    s.prompt.value = 'see ';
    t.ok('文の途中の `!` では入らない', s.key('!') === false && !s.c.mode && s.prompt.value === 'see !');
    const p = setup();
    t.ok('貼り付けでは入らない', p.key('!ls', { inputType: 'insertFromPaste' }) === false && !p.c.mode && p.prompt.value === '!ls');
    const i = setup();
    t.ok('IME の変換中では入らない', i.key('!', { isComposing: true }) === false && !i.c.mode);
    const d = setup();
    d.prompt.value = '!git status';   // 下書きの復元（値を差し替えるだけで、打鍵は無い）
    t.ok('下書きの復元では入らない', !d.c.mode && d.c.draftText() === '!git status');
  }
  {
    const s = setup({ host: 'desk-pc' });
    s.key('!');
    t.ok('遠隔の画面では頭の行にホスト名も出す', texts(s.head).includes('desk-pc'), texts(s.head));
    s.key('g'); s.key('s');
    t.ok('下書きには `!` を頭に戻して残す', s.c.draftText() === '!gs');
    s.c.sendAsText();
    t.ok('「文として送る」は `!` を戻した文をふつうに送る', s.sent[0] === '!gs' && s.prompt.value === '!gs' && !s.c.mode);
  }
  {
    const s = setup({ ok: false, text: 'Antigravity の会話ではシェルを実行できません' });
    t.ok('使えない会話では `!` を欄に残す（等幅にしない）', s.key('!') === false && s.prompt.value === '!' && s.c.blocked && !s.box.classList.contains('shell'));
    t.ok('頭の行に理由と「文として送る」', !s.head.hidden && s.head.classList.contains('unavail') && texts(s.head).includes('Antigravity の会話ではシェルを実行できません') && texts(s.head).includes('[chat.shell.asText]'));
    t.ok('送信は押せない見た目（disabled にはしない）', s.send.classList.contains('shell-blocked') && !s.send.disabled);
    s.c.flash();
    t.ok('Ctrl+Enter では理由の一行を光らせる', s.head.classList.contains('flash'));
    s.key('l');
    s.c.sendAsText();
    t.ok('使えない会話でも「文として送る」は送れる', s.sent[0] === '!l' && !s.c.mode);
    const b = setup({ ok: false });
    b.key('!');
    b.backspace();
    t.ok('`!` を消すと理由の一行を下げる', !b.c.mode && b.head.hidden && !b.send.classList.contains('shell-blocked'));
  }
  {
    const s = setup();
    t.ok('入力欄に写す: 空の欄ならシェルの形でコマンドを入れる（走らせない）', s.c.copy('git status') === true && s.c.active && s.prompt.value === 'git status');
    const w = setup();
    w.prompt.value = 'draft';
    t.ok('入力欄に写す: 書きかけがあれば入らない（文として足す）', w.c.copy('ls') === false && !w.c.mode);
    const n = setup({ ok: false });
    t.ok('入力欄に写す: 使えない会話では入らない', n.c.copy('ls') === false && !n.c.mode);
    const x = setup();
    x.key('!'); x.key('a');
    x.setAvail({ ok: false, text: 'no' });
    x.c.sync();
    t.ok('エージェントを替えて使えなくなったら、`!` を戻して理由を出す', x.c.blocked && x.prompt.value === '!a' && texts(x.head).includes('no'));
  }

  // client.mjs の配線（submit の分岐・送信待ちに積まない・走らせたら欄を空に）
  const client = read('web/client.mjs');
  const runFn = client.slice(client.indexOf('async function runShellFromComposer'), client.indexOf('/** 入力欄に字を入れる'));
  t.ok('submit はシェルの形なら走らせ、使えない会話では光らせるだけ（文として黙って送らない）',
    /if \(shellComposer\.active\) return runShellFromComposer\(\);\s*if \(shellComposer\.blocked\) return shellComposer\.flash\(\);/.test(client));
  t.ok('走らせるのは runShell だけ（sendMessage・receipts に積まない）', runFn.includes("cmd('runShell'") && !runFn.includes('sendMessage') && !runFn.includes('receipts'));
  t.ok('走らせたら欄はすぐ空に戻る', runFn.indexOf("$('prompt').value = ''") < runFn.indexOf("cmd('runShell'"));
  t.ok('beforeinput で `!` を見る（貼り付け・復元は insertText ではない）', client.includes("addEventListener('beforeinput', e => shellComposer.beforeinput(e))"));
  const server = read('core/server.mjs');
  const protocol = read('core/protocol.mjs');
  t.ok('runShell / stopShell / skipShell はサーバーの case とプロトコルの COMMANDS の両方にある',
    server.includes("case 'runShell':") && server.includes("case 'stopShell':") && protocol.includes("'runShell',") && protocol.includes("'stopShell',")
    && server.includes("case 'skipShell':") && protocol.includes("'skipShell',"));
}
