'use strict';
// xdotool の形のキー名（`ctrl+s`・`Return`・`F5`）→ 仮想キー。Windows キーはここで拒む。
// 表の下書きは sshh12/windows-computer-use-mcp と Jason26214/omni-computer-use（どちらも MIT。NOTICE）。
const { ComputerError } = require('./errors.cjs');

const VK = { BACK: 0x08, TAB: 0x09, RETURN: 0x0d, SHIFT: 0x10, CONTROL: 0x11, MENU: 0x12, PAUSE: 0x13, CAPITAL: 0x14, ESCAPE: 0x1b, SPACE: 0x20,
  PRIOR: 0x21, NEXT: 0x22, END: 0x23, HOME: 0x24, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, SNAPSHOT: 0x2c, INSERT: 0x2d, DELETE: 0x2e,
  APPS: 0x5d, NUMLOCK: 0x90, SCROLL: 0x91, LSHIFT: 0xa0, RSHIFT: 0xa1, LCONTROL: 0xa2, RCONTROL: 0xa3, LMENU: 0xa4, RMENU: 0xa5 };

/** 押すときに KEYEVENTF_EXTENDEDKEY を付けるキー（MapVirtualKey が前置を返さないときの備え） */
const EXTENDED = new Set([0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2c, 0x2d, 0x2e, 0x5d, 0xa3, 0xa5, 0x90, 0x6f]);
const MODIFIERS = new Set([VK.SHIFT, VK.CONTROL, VK.MENU, VK.LSHIFT, VK.RSHIFT, VK.LCONTROL, VK.RCONTROL, VK.LMENU, VK.RMENU]);

const NAMED = {
  return: VK.RETURN, enter: VK.RETURN, kp_enter: VK.RETURN, ret: VK.RETURN, tab: VK.TAB, space: VK.SPACE, spacebar: VK.SPACE,
  escape: VK.ESCAPE, esc: VK.ESCAPE, backspace: VK.BACK, bksp: VK.BACK, delete: VK.DELETE, del: VK.DELETE, insert: VK.INSERT, ins: VK.INSERT,
  home: VK.HOME, end: VK.END, prior: VK.PRIOR, page_up: VK.PRIOR, pageup: VK.PRIOR, pgup: VK.PRIOR,
  next: VK.NEXT, page_down: VK.NEXT, pagedown: VK.NEXT, pgdn: VK.NEXT,
  up: VK.UP, down: VK.DOWN, left: VK.LEFT, right: VK.RIGHT,
  caps_lock: VK.CAPITAL, capslock: VK.CAPITAL, num_lock: VK.NUMLOCK, numlock: VK.NUMLOCK, scroll_lock: VK.SCROLL, scrolllock: VK.SCROLL,
  print: VK.SNAPSHOT, printscreen: VK.SNAPSHOT, prtsc: VK.SNAPSHOT, pause: VK.PAUSE, break: VK.PAUSE, menu: VK.APPS, apps: VK.APPS,
  ctrl: VK.CONTROL, control: VK.CONTROL, ctrl_l: VK.LCONTROL, control_l: VK.LCONTROL, lctrl: VK.LCONTROL, ctrl_r: VK.RCONTROL, control_r: VK.RCONTROL, rctrl: VK.RCONTROL,
  shift: VK.SHIFT, shift_l: VK.LSHIFT, lshift: VK.LSHIFT, shift_r: VK.RSHIFT, rshift: VK.RSHIFT,
  alt: VK.MENU, option: VK.MENU, alt_l: VK.LMENU, lalt: VK.LMENU, alt_r: VK.RMENU, ralt: VK.RMENU,
  // xdotool の記号の名前（JIS 配列でも ASCII の文字で解く。ここに無い 1 文字は VkKeyScan に任せる）
  plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', apostrophe: "'", quoteright: "'",
  grave: '`', bracketleft: '[', bracketright: ']', underscore: '_', colon: ':', quotedbl: '"', less: '<', greater: '>', question: '?', exclam: '!',
  at: '@', numbersign: '#', dollar: '$', percent: '%', asciicircum: '^', ampersand: '&', asterisk: '*', parenleft: '(', parenright: ')',
  braceleft: '{', braceright: '}', bar: '|', asciitilde: '~',
  kp_multiply: 0x6a, kp_add: 0x6b, kp_subtract: 0x6d, kp_decimal: 0x6e, kp_divide: 0x6f,
};
for (let i = 1; i <= 24; i++) NAMED[`f${i}`] = 0x6f + i;
for (let i = 0; i <= 9; i++) { NAMED[`kp_${i}`] = 0x60 + i; NAMED[`numpad${i}`] = 0x60 + i; }

const WINDOWS = new Set(['super', 'super_l', 'super_r', 'win', 'windows', 'meta', 'meta_l', 'meta_r', 'cmd', 'command', 'lwin', 'rwin']);

const NAMES = new Map();
for (const [name, vk] of Object.entries(NAMED)) if (typeof vk === 'number' && !NAMES.has(vk)) NAMES.set(vk, name);
for (const [vk, name] of [[VK.CONTROL, 'ctrl'], [VK.SHIFT, 'shift'], [VK.MENU, 'alt'], [VK.RETURN, 'Return'], [VK.ESCAPE, 'Escape'], [VK.LCONTROL, 'ctrl_l'], [VK.RCONTROL, 'ctrl_r'],
  [VK.LSHIFT, 'shift_l'], [VK.RSHIFT, 'shift_r'], [VK.LMENU, 'alt_l'], [VK.RMENU, 'alt_r']]) NAMES.set(vk, name);

/** releaseAll の報告に使う名前 */
function keyName(vk) {
  if (NAMES.has(vk)) return NAMES.get(vk);
  if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5a)) return String.fromCharCode(vk).toLowerCase();
  return `vk_${vk.toString(16)}`;
}

function splitCombo(combo) {
  const text = String(combo ?? '').trim();
  if (!text) throw new ComputerError('failed', 'empty key');
  if (text === '+') return ['plus'];
  const tokens = text.split('+').map(s => s.trim());
  // `ctrl++` は ctrl と +（空の要素が最後に残る）
  if (tokens.length > 1 && tokens[tokens.length - 1] === '' && tokens[tokens.length - 2] === '') { tokens.length -= 2; tokens.push('plus'); }
  if (tokens.some(token => !token)) throw new ComputerError('failed', `empty key in "${text}"`);
  return tokens;
}

/**
 * "ctrl+shift+s" → { keys: [{ vk, extended }], escape: boolean }。順に押して、逆順に離す。
 * 1 文字は vkKeyScan（配列に従う）で仮想キーにし、シフトが要る文字（A・!・@）はシフトを足す。
 * @param {string} combo
 * @param {{ vkKeyScan(ch: string): number }} win32
 */
function parseCombo(combo, win32) {
  const keys = [];
  for (const token of splitCombo(combo)) {
    const lower = token.toLowerCase();
    if (WINDOWS.has(lower)) throw new ComputerError('windows_key', 'Windows key is not allowed');
    let vk = NAMED[lower];
    let shift = false;
    if (typeof vk === 'string') { // 記号の名前 → 1 文字
      const scan = win32.vkKeyScan(vk);
      if (scan === -1) throw new ComputerError('failed', `unknown key: ${token}`);
      vk = scan & 0xff; shift = (scan & 0x100) !== 0;
    } else if (vk === undefined) {
      if ([...token].length !== 1) throw new ComputerError('failed', `unknown key: ${token}`);
      const scan = win32.vkKeyScan(token);
      if (scan === -1) throw new ComputerError('failed', `unknown key: ${token}`);
      vk = scan & 0xff; shift = (scan & 0x100) !== 0;
    }
    if (shift && !keys.some(k => k.vk === VK.SHIFT || k.vk === VK.LSHIFT || k.vk === VK.RSHIFT)) keys.push({ vk: VK.SHIFT, extended: false });
    keys.push({ vk, extended: EXTENDED.has(vk) });
  }
  return { keys, escape: keys.some(k => k.vk === VK.ESCAPE) };
}

module.exports = { VK, EXTENDED, MODIFIERS, parseCombo, keyName };
