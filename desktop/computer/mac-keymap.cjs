'use strict';
// xdotool の形のキー名（`cmd+s`・`Return`・`F5`）→ macOS の仮想キーコード（Carbon の kVK_*。ADR 0173 §3・§4）。
// 1 文字のキー（`a`・`/`・`@`）はここでは決めず { char } で返し、ヘルパーが今のキー配列で引く（keys の頼み）。
// ⌘（cmd・command・super・meta）は通す。Spotlight・強制終了・ロック・ログアウトの組み合わせは system_key で拒む。
const { ComputerError } = require('./errors.cjs');

const KVK = {
  RETURN: 0x24, TAB: 0x30, SPACE: 0x31, DELETE: 0x33, ESCAPE: 0x35, RIGHT_COMMAND: 0x36, COMMAND: 0x37, SHIFT: 0x38, CAPS_LOCK: 0x39,
  OPTION: 0x3a, CONTROL: 0x3b, RIGHT_SHIFT: 0x3c, RIGHT_OPTION: 0x3d, RIGHT_CONTROL: 0x3e,
  KEYPAD_DECIMAL: 0x41, KEYPAD_MULTIPLY: 0x43, KEYPAD_PLUS: 0x45, KEYPAD_CLEAR: 0x47, KEYPAD_DIVIDE: 0x4b, KEYPAD_ENTER: 0x4c, KEYPAD_MINUS: 0x4e,
  HELP: 0x72, HOME: 0x73, PAGE_UP: 0x74, FORWARD_DELETE: 0x75, END: 0x77, PAGE_DOWN: 0x79,
  LEFT: 0x7b, RIGHT: 0x7c, DOWN: 0x7d, UP: 0x7e, JIS_EISU: 0x66, JIS_KANA: 0x68,
};

const FUNCTION_KEYS = [0x7a, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6d, 0x67, 0x6f, 0x69, 0x6b, 0x71, 0x6a, 0x40, 0x4f, 0x50, 0x5a]; // F1〜F20
const KEYPAD_DIGITS = [0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5b, 0x5c]; // 0〜9

const MODIFIER_CODES = new Set([KVK.COMMAND, KVK.RIGHT_COMMAND, KVK.SHIFT, KVK.RIGHT_SHIFT, KVK.OPTION, KVK.RIGHT_OPTION, KVK.CONTROL, KVK.RIGHT_CONTROL]);
const IS_COMMAND = new Set([KVK.COMMAND, KVK.RIGHT_COMMAND]);
const IS_SHIFT = new Set([KVK.SHIFT, KVK.RIGHT_SHIFT]);
const IS_OPTION = new Set([KVK.OPTION, KVK.RIGHT_OPTION]);
const IS_CONTROL = new Set([KVK.CONTROL, KVK.RIGHT_CONTROL]);

const COMMAND_NAMES = ['cmd', 'command', 'cmd_l', 'command_l', 'cmd_r', 'command_r', 'super', 'super_l', 'super_r', 'meta', 'meta_l', 'meta_r'];

const NAMED = {
  return: KVK.RETURN, enter: KVK.RETURN, ret: KVK.RETURN, kp_enter: KVK.KEYPAD_ENTER, tab: KVK.TAB, space: KVK.SPACE, spacebar: KVK.SPACE,
  escape: KVK.ESCAPE, esc: KVK.ESCAPE, backspace: KVK.DELETE, bksp: KVK.DELETE, delete: KVK.FORWARD_DELETE, del: KVK.FORWARD_DELETE,
  insert: KVK.HELP, ins: KVK.HELP, help: KVK.HELP,
  home: KVK.HOME, end: KVK.END, prior: KVK.PAGE_UP, page_up: KVK.PAGE_UP, pageup: KVK.PAGE_UP, pgup: KVK.PAGE_UP,
  next: KVK.PAGE_DOWN, page_down: KVK.PAGE_DOWN, pagedown: KVK.PAGE_DOWN, pgdn: KVK.PAGE_DOWN,
  up: KVK.UP, down: KVK.DOWN, left: KVK.LEFT, right: KVK.RIGHT,
  caps_lock: KVK.CAPS_LOCK, capslock: KVK.CAPS_LOCK, num_lock: KVK.KEYPAD_CLEAR, numlock: KVK.KEYPAD_CLEAR, clear: KVK.KEYPAD_CLEAR,
  ctrl: KVK.CONTROL, control: KVK.CONTROL, ctrl_l: KVK.CONTROL, control_l: KVK.CONTROL, lctrl: KVK.CONTROL, ctrl_r: KVK.RIGHT_CONTROL, control_r: KVK.RIGHT_CONTROL, rctrl: KVK.RIGHT_CONTROL,
  shift: KVK.SHIFT, shift_l: KVK.SHIFT, lshift: KVK.SHIFT, shift_r: KVK.RIGHT_SHIFT, rshift: KVK.RIGHT_SHIFT,
  alt: KVK.OPTION, option: KVK.OPTION, opt: KVK.OPTION, alt_l: KVK.OPTION, lalt: KVK.OPTION, option_l: KVK.OPTION, alt_r: KVK.RIGHT_OPTION, ralt: KVK.RIGHT_OPTION, option_r: KVK.RIGHT_OPTION,
  eisu: KVK.JIS_EISU, kana: KVK.JIS_KANA,
  // xdotool の記号の名前（1 文字にして、ヘルパーが今のキー配列で引く）
  plus: '+', minus: '-', equal: '=', comma: ',', period: '.', slash: '/', backslash: '\\', semicolon: ';', apostrophe: "'", quoteright: "'",
  grave: '`', bracketleft: '[', bracketright: ']', underscore: '_', colon: ':', quotedbl: '"', less: '<', greater: '>', question: '?', exclam: '!',
  at: '@', numbersign: '#', dollar: '$', percent: '%', asciicircum: '^', ampersand: '&', asterisk: '*', parenleft: '(', parenright: ')',
  braceleft: '{', braceright: '}', bar: '|', asciitilde: '~',
  kp_multiply: KVK.KEYPAD_MULTIPLY, kp_add: KVK.KEYPAD_PLUS, kp_subtract: KVK.KEYPAD_MINUS, kp_decimal: KVK.KEYPAD_DECIMAL, kp_divide: KVK.KEYPAD_DIVIDE,
};
for (const name of COMMAND_NAMES) NAMED[name] = name.endsWith('_r') ? KVK.RIGHT_COMMAND : KVK.COMMAND;
FUNCTION_KEYS.forEach((code, i) => { NAMED[`f${i + 1}`] = code; });
KEYPAD_DIGITS.forEach((code, i) => { NAMED[`kp_${i}`] = code; NAMED[`numpad${i}`] = code; });

const NAMES = new Map();
for (const [code, name] of [[KVK.COMMAND, 'cmd'], [KVK.RIGHT_COMMAND, 'cmd_r'], [KVK.CONTROL, 'ctrl'], [KVK.RIGHT_CONTROL, 'ctrl_r'], [KVK.SHIFT, 'shift'],
  [KVK.RIGHT_SHIFT, 'shift_r'], [KVK.OPTION, 'alt'], [KVK.RIGHT_OPTION, 'alt_r'], [KVK.RETURN, 'Return'], [KVK.ESCAPE, 'Escape'], [KVK.DELETE, 'backspace']]) NAMES.set(code, name);
for (const [name, code] of Object.entries(NAMED)) if (typeof code === 'number' && !NAMES.has(code)) NAMES.set(code, name);

/** releaseAll の報告に使う名前（1 文字のキーは押したときの文字を覚えておき、それを使う） */
function keyName(code) { return NAMES.get(code) ?? `kVK_${code.toString(16)}`; }

function splitCombo(combo) {
  const text = String(combo ?? '').trim();
  if (!text) throw new ComputerError('failed', 'empty key');
  if (text === '+') return ['plus'];
  const tokens = text.split('+').map(s => s.trim());
  if (tokens.length > 1 && tokens[tokens.length - 1] === '' && tokens[tokens.length - 2] === '') { tokens.length -= 2; tokens.push('plus'); }
  if (tokens.some(token => !token)) throw new ComputerError('failed', `empty key in "${text}"`);
  return tokens;
}

/**
 * OS の機能を呼ぶ組み合わせ（Windows キー・「ファイル名を指定して実行」に当たるもの）。
 * mods は押す修飾キーの集合（cmd・shift・alt・ctrl）、key は最後のキー（名前か小文字の 1 文字）
 */
const SYSTEM_COMBOS = [
  { mods: ['cmd'], key: 'space', why: 'Spotlight' },
  { mods: ['alt', 'cmd'], key: 'space', why: 'Finder search' },
  { mods: ['alt', 'cmd'], key: 'escape', why: 'Force Quit' },
  { mods: ['ctrl', 'cmd'], key: 'q', why: 'Lock Screen' },
  { mods: ['shift', 'cmd'], key: 'q', why: 'Log Out' },
  { mods: ['alt', 'shift', 'cmd'], key: 'q', why: 'Log Out' },
];

function modifierSet(keys) {
  const set = new Set();
  for (const k of keys) {
    if (k.code === undefined) continue;
    if (IS_COMMAND.has(k.code)) set.add('cmd');
    else if (IS_SHIFT.has(k.code)) set.add('shift');
    else if (IS_OPTION.has(k.code)) set.add('alt');
    else if (IS_CONTROL.has(k.code)) set.add('ctrl');
  }
  return set;
}

function systemComboOf(keys) {
  // cmd+space+a のように後ろにキーを足しても、途中の Spotlight を通さない。
  for (let i = 0; i < keys.length; i++) {
    const item = keys[i];
    const key = item.char === ' ' ? 'space' : item.char ? item.char.toLowerCase() : item.code === KVK.SPACE ? 'space' : item.code === KVK.ESCAPE ? 'escape' : null;
    if (!key) continue;
    for (const mods of [modifierSet(keys.slice(0, i)), modifierSet(keys)]) {
      if (item.char && /^[A-Z]$/.test(item.char)) mods.add('shift');
      const system = SYSTEM_COMBOS.find(c => c.key === key && c.mods.length === mods.size && c.mods.every(m => mods.has(m)));
      if (system) return system;
    }
  }
  return null;
}

/**
 * "cmd+shift+s" → { keys: [{ code } | { char }], escape }。順に押して、逆順に離す。
 * { char } はヘルパーの keys で { code, shift } に解く（resolveKeys）。
 */
function parseCombo(combo) {
  const keys = [];
  for (const token of splitCombo(combo)) {
    const lower = token.toLowerCase();
    const named = NAMED[lower];
    if (typeof named === 'number') keys.push({ code: named, name: lower });
    else if (typeof named === 'string') keys.push({ char: named });
    else if ([...token].length === 1) keys.push({ char: token });
    else throw new ComputerError('failed', `unknown key: ${token}`);
  }
  const system = systemComboOf(keys);
  if (system) throw new ComputerError('system_key', `${combo} opens ${system.why} and is not allowed`);
  return { keys, escape: keys.some(k => k.code === KVK.ESCAPE) };
}

/**
 * { char } をヘルパーの答え（{ code, shift } か null）で { code } にし、シフトが要る文字にはシフトを足す。
 * @param {{ keys: object[] }} parsed parseCombo の結果
 * @param {(chars: string[]) => Promise<({ code: number, shift: boolean }|null)[]>} lookup
 */
async function resolveKeys(parsed, lookup) {
  const chars = parsed.keys.filter(k => k.char !== undefined).map(k => k.char);
  const found = chars.length ? await lookup(chars) : [];
  const out = [];
  let i = 0;
  for (const key of parsed.keys) {
    if (key.char === undefined) { out.push({ code: key.code, name: key.name }); continue; }
    const hit = found[i++];
    if (!hit || !Number.isInteger(hit.code)) throw new ComputerError('failed', `no key types "${key.char}" on this keyboard layout`);
    if (hit.shift && !out.some(k => IS_SHIFT.has(k.code))) out.push({ code: KVK.SHIFT, name: 'shift' });
    out.push({ code: hit.code, name: key.char.toLowerCase() });
  }
  return out;
}

module.exports = { KVK, MODIFIER_CODES, parseCombo, resolveKeys, keyName, systemComboOf };
