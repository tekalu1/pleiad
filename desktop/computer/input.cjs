'use strict';
// SendInput で入力を送る。マウスは VIRTUALDESK の絶対座標、キーはスキャンコード、文字は KEYEVENTF_UNICODE（同じ流儀の
// sshh12/windows-computer-use-mcp の input.py・MIT。NOTICE）。押したままのキーとボタンを覚え、releaseAll で押したものだけを離す。
// 座標は物理画素の仮想デスクトップ座標。win32 の表（win32.cjs と同じ形の偽物でも動く）と sleep は注入する。
const { ComputerError } = require('./errors.cjs');
const { VK, EXTENDED, parseCombo, keyName } = require('./keymap.cjs');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const KEYEVENTF_SCANCODE = 0x0008;
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_HWHEEL = 0x1000;
const BUTTON_DOWN = { left: 0x0002, right: 0x0008, middle: 0x0020 };
const BUTTON_UP = { left: 0x0004, right: 0x0010, middle: 0x0040 };
const WHEEL_DELTA = 120;
const TEXT_CHUNK = 40; // 1 回の SendInput に入れる文字数
const MAX_SCROLL = 200;
const MAX_REPEAT = 100;
const MODIFIER_NAMES = { ctrl: VK.CONTROL, shift: VK.SHIFT, alt: VK.MENU };

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 仮想デスクトップの物理座標 → SendInput の絶対座標（0..65535）。Windows が戻す floor(abs * w / 65536) がちょうど x になる値 */
function toAbsolute(value, origin, size) {
  const abs = Math.ceil(((value - origin) * 65536) / size);
  return Math.min(65535, Math.max(0, abs));
}

function createInput({ win32, sleep = defaultSleep, virtualBounds, escape = null }) {
  const pressedKeys = new Map(); // vk → { vk, extended }
  const pressedButtons = new Set();
  let escapeSuspended = false;

  const keyEvent = (key, up) => {
    const sc = win32.mapVirtualKey(key.vk, 4);
    const scan = sc & 0xff;
    const extended = key.extended || (sc & 0xff00) === 0xe000 || (sc & 0xff00) === 0xe100;
    if (!scan) return { type: INPUT_KEYBOARD, ki: { wVk: key.vk, wScan: 0, dwFlags: up ? KEYEVENTF_KEYUP : 0, time: 0, dwExtraInfo: 0 } };
    return { type: INPUT_KEYBOARD, ki: { wVk: 0, wScan: scan, dwFlags: KEYEVENTF_SCANCODE | (extended ? KEYEVENTF_EXTENDEDKEY : 0) | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } };
  };
  const unicodeEvent = (unit, up) => ({ type: INPUT_KEYBOARD, ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0), time: 0, dwExtraInfo: 0 } });
  const mouseEvent = (flags, data = 0, dx = 0, dy = 0) => ({ type: INPUT_MOUSE, mi: { dx, dy, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } });

  function send(events) {
    if (!events.length) return;
    const { sent, error } = win32.sendInput(events);
    if (sent !== events.length) throw new ComputerError('failed', `SendInput sent ${sent}/${events.length} (Win32 error ${error})`);
  }

  function suspendEscape() { if (escape && !escapeSuspended) { escape.suspend(); escapeSuspended = true; } }
  function resumeEscape() { if (escapeSuspended && !pressedKeys.has(VK.ESCAPE)) { escapeSuspended = false; escape.resume(); } }

  const moveEvent = (x, y) => {
    const v = virtualBounds();
    return mouseEvent(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, 0, toAbsolute(x, v.x, v.width), toAbsolute(y, v.y, v.height));
  };
  async function moveTo(x, y) { send([moveEvent(x, y)]); await sleep(20); }

  function buttonDown(button) { send([mouseEvent(BUTTON_DOWN[button])]); pressedButtons.add(button); }
  function buttonUp(button) { send([mouseEvent(BUTTON_UP[button])]); pressedButtons.delete(button); }

  function keysDown(keys) {
    for (const key of keys) { send([keyEvent(key, false)]); pressedKeys.set(key.vk, key); }
  }
  function keysUp(keys) {
    for (const key of [...keys].reverse()) { send([keyEvent(key, true)]); pressedKeys.delete(key.vk); }
  }

  function modifierKeys(names) {
    return (names ?? []).map(name => {
      const vk = MODIFIER_NAMES[String(name).toLowerCase()];
      if (!vk) throw new ComputerError('failed', `unsupported modifier: ${name}`);
      return { vk, extended: false };
    });
  }

  const aborted = signal => { if (signal?.aborted) throw new ComputerError('stopped', 'stopped'); };

  async function click(action, signal) {
    const button = action.button ?? 'left';
    if (!BUTTON_DOWN[button]) throw new ComputerError('failed', `unknown button: ${button}`);
    const count = Math.min(3, Math.max(1, action.count ?? 1));
    const mods = modifierKeys(action.modifiers);
    if (action.x !== undefined) await moveTo(action.x, action.y);
    try {
      keysDown(mods);
      for (let i = 0; i < count; i++) {
        aborted(signal);
        buttonDown(button);
        await sleep(30);
        buttonUp(button);
        if (i < count - 1) await sleep(40);
      }
    } finally { // 例外でも押したままにしない
      if (pressedButtons.has(button)) buttonUp(button);
      keysUp(mods.filter(m => pressedKeys.has(m.vk)));
    }
  }

  async function drag(action, signal) {
    const { from, to } = action;
    await moveTo(from.x, from.y);
    try {
      buttonDown('left');
      await sleep(60);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.min(40, Math.max(5, Math.ceil(distance / 40)));
      for (let i = 1; i <= steps; i++) {
        aborted(signal);
        send([moveEvent(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps))]);
        await sleep(8);
      }
      await sleep(30);
    } finally { if (pressedButtons.has('left')) buttonUp('left'); }
  }

  async function scroll(action) {
    await moveTo(action.x, action.y);
    const amount = Math.min(MAX_SCROLL, Math.max(1, Math.round(action.amount ?? 1)));
    const horizontal = action.direction === 'left' || action.direction === 'right';
    const positive = action.direction === 'up' || action.direction === 'right';
    const flag = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
    send(Array.from({ length: amount }, () => mouseEvent(flag, positive ? WHEEL_DELTA : -WHEEL_DELTA)));
  }

  async function typeText(text, signal) {
    let batch = [];
    const flush = () => { send(batch); batch = []; };
    const tap = vk => { flush(); send([keyEvent({ vk, extended: EXTENDED.has(vk) }, false), keyEvent({ vk, extended: EXTENDED.has(vk) }, true)]); };
    const chars = [...String(text ?? '')];
    for (let i = 0; i < chars.length; i++) {
      aborted(signal);
      const ch = chars[i];
      if (ch === '\r') { if (chars[i + 1] === '\n') continue; tap(VK.RETURN); continue; }
      if (ch === '\n') { tap(VK.RETURN); continue; }
      if (ch === '\t') { tap(VK.TAB); continue; }
      if (ch.codePointAt(0) < 0x20) continue;
      for (let j = 0; j < ch.length; j++) { batch.push(unicodeEvent(ch.charCodeAt(j), false), unicodeEvent(ch.charCodeAt(j), true)); }
      if (batch.length >= TEXT_CHUNK * 2) { flush(); await sleep(5); }
    }
    flush();
  }

  async function key(action, signal) {
    const parsed = parseCombo(action.combo, win32);
    const repeat = Math.min(MAX_REPEAT, Math.max(1, action.repeat ?? 1));
    if (parsed.escape) suspendEscape();
    try {
      for (let i = 0; i < repeat; i++) {
        aborted(signal);
        const added = parsed.keys.filter(k => !pressedKeys.has(k.vk));
        try { keysDown(added); } finally { keysUp(added.filter(k => pressedKeys.has(k.vk))); }
        if (i < repeat - 1) await sleep(10);
      }
    } finally { resumeEscape(); }
  }

  function keyDown(action) {
    const parsed = parseCombo(action.combo, win32);
    if (parsed.escape) suspendEscape();
    keysDown(parsed.keys.filter(k => !pressedKeys.has(k.vk)));
  }
  function keyUp(action) {
    const parsed = parseCombo(action.combo, win32);
    keysUp(parsed.keys.filter(k => pressedKeys.has(k.vk)));
    resumeEscape();
  }

  /** 1 つの動作を送る。signal が止まっていれば `stopped`。送る前の判定（昇格・自分の窓）は呼ぶ側（service）の仕事 */
  async function perform(action, signal) {
    aborted(signal);
    switch (action.type) {
      case 'move': return moveTo(action.x, action.y);
      case 'click': return click(action, signal);
      case 'down': {
        if (action.x !== undefined) await moveTo(action.x, action.y);
        return buttonDown(action.button ?? 'left');
      }
      case 'up': {
        if (action.x !== undefined) await moveTo(action.x, action.y);
        return buttonUp(action.button ?? 'left');
      }
      case 'drag': return drag(action, signal);
      case 'scroll': return scroll(action);
      case 'text': return typeText(action.text, signal);
      case 'key': return key(action, signal);
      case 'keyDown': return keyDown(action);
      case 'keyUp': return keyUp(action);
      default: throw new ComputerError('failed', `unknown action: ${action?.type}`);
    }
  }

  /** 送る前の検査（座標の範囲・キーの名前・Windows キー）。1 つでも不正なら何も送らない */
  function validate(actions, { inDisplay }) {
    if (!Array.isArray(actions) || !actions.length) throw new ComputerError('failed', 'no actions');
    const point = (x, y) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ComputerError('failed', 'coordinates must be numbers');
      if (!inDisplay(x, y)) throw new ComputerError('outside', `(${x}, ${y}) is outside every display`);
    };
    for (const action of actions) {
      switch (action?.type) {
        case 'move': case 'scroll': point(action.x, action.y); break;
        case 'click': case 'down': case 'up':
          if (action.x !== undefined || action.y !== undefined) point(action.x, action.y);
          if (action.type === 'click') modifierKeys(action.modifiers);
          break;
        case 'drag': point(action.from?.x, action.from?.y); point(action.to?.x, action.to?.y); break;
        case 'key': case 'keyDown': case 'keyUp': parseCombo(action.combo, win32); break;
        case 'text': break;
        default: throw new ComputerError('failed', `unknown action: ${action?.type}`);
      }
    }
  }

  /** 押したままのキーとボタンを離す。押したものだけを返す（名前の一覧） */
  function releaseAll() {
    const released = [];
    const events = [];
    for (const button of [...pressedButtons].reverse()) { events.push(mouseEvent(BUTTON_UP[button])); released.push(button); }
    for (const key of [...pressedKeys.values()].reverse()) { events.push(keyEvent(key, true)); released.push(keyName(key.vk)); }
    pressedButtons.clear();
    pressedKeys.clear();
    try { if (events.length) send(events); } finally { if (escapeSuspended) { escapeSuspended = false; escape.resume(); } }
    return released;
  }

  return { perform, validate, releaseAll, pressed: () => ({ keys: [...pressedKeys.keys()], buttons: [...pressedButtons] }) };
}

module.exports = { createInput, toAbsolute, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, KEYEVENTF_KEYUP, KEYEVENTF_EXTENDEDKEY, WHEEL_DELTA };
