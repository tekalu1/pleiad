'use strict';
// macOS の入力（ADR 0173 §3）。input.cjs と同じ面（perform・validate・releaseAll・pressed）を、ヘルパーの CGEvent で満たす。
// 座標は CoreGraphics のグローバル座標（point）。待ち時間は input.cjs にそろえる。
// 押したままのキーとボタンはここでも覚え、releaseAll は名前をすぐ返し、ヘルパーへの releaseAll は投げっぱなしにする（service の releaseAll は同期）。
const { ComputerError } = require('./errors.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { KVK, parseCombo, resolveKeys, keyName, systemComboOf } = require('./mac-keymap.cjs');

const BUTTONS = new Set(['left', 'right', 'middle']);
const TEXT_CHUNK = 40; // 1 回の text の頼みに入れる文字数
const SCROLL_LINES = 3; // ホイールの 1 目盛り（Windows の WHEEL_DELTA）を何行にするか
const MAX_SCROLL = 200;
const MAX_REPEAT = 100;
const MODIFIER_NAMES = { ctrl: KVK.CONTROL, shift: KVK.SHIFT, alt: KVK.OPTION, cmd: KVK.COMMAND, command: KVK.COMMAND };

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param {{ call(op: string, args?: object): Promise<object> }} helper
 * @param {{ suspend(): () => void }|null} escape Esc の globalShortcut を外す（オーバーレイの suspendEscape）
 */
function createMacInput({ helper, sleep = defaultSleep, escape = null, log = () => {} }) {
  const pressedKeys = new Map(); // code → 名前
  const pressedButtons = new Set();
  let resumeEscapeHook = null;
  const operation = new AsyncLocalStorage();
  const running = new Set();

  // await の後も、その動作の中断状態を引き継ぐ。releaseAll 後に古い動作から次の入力を送らない。
  const check = () => aborted(operation.getStore());
  const call = (op, args) => { check(); return helper.call(op, args, { signal: operation.getStore() }); };

  function suspendEscape() { if (escape && !resumeEscapeHook) resumeEscapeHook = escape.suspend(); }
  function resumeEscape() {
    if (!resumeEscapeHook || pressedKeys.has(KVK.ESCAPE)) return;
    const resume = resumeEscapeHook;
    resumeEscapeHook = null;
    resume();
  }

  async function moveTo(x, y) { await call('mouse', { event: 'move', x, y }); await sleep(20); }

  async function buttonDown(button, clickState = 1) {
    check();
    pressedButtons.add(button); // 送る前に覚える（送った後に落ちても離す）
    await call('mouse', { event: 'down', button, clickState });
  }
  async function buttonUp(button, clickState = 1) {
    await call('mouse', { event: 'up', button, clickState });
    pressedButtons.delete(button);
  }

  async function keysDown(keys) {
    for (const key of keys) { check(); pressedKeys.set(key.code, key.name ?? keyName(key.code)); await call('key', { code: key.code, down: true }); }
  }
  async function keysUp(keys) {
    for (const key of [...keys].reverse()) { await call('key', { code: key.code, down: false }); pressedKeys.delete(key.code); }
  }

  function modifierKeys(names) {
    return (names ?? []).map(name => {
      const code = MODIFIER_NAMES[String(name).toLowerCase()];
      if (code === undefined) throw new ComputerError('failed', `unsupported modifier: ${name}`);
      return { code, name: String(name).toLowerCase() };
    });
  }

  const aborted = signal => { if (signal?.aborted) throw new ComputerError('stopped', 'stopped'); };

  /** 押したままの修飾キーと合わせて、OS の機能を呼ぶ組み合わせにならないか（keyDown で ⌘ を押してから key で space など） */
  function checkSystem(keys) {
    const held = [...pressedKeys].filter(([code]) => !keys.some(k => k.code === code)).map(([code, name]) => ({ code, ...([...name].length === 1 ? { char: name } : {}) }));
    const system = systemComboOf([...held, ...keys]);
    if (system) throw new ComputerError('system_key', `this key combination opens ${system.why} and is not allowed`);
  }

  async function resolved(combo) {
    const parsed = parseCombo(combo);
    const keys = await resolveKeys(parsed, async chars => (await call('keys', { chars })).keys ?? []);
    checkSystem(parsed.keys.map(k => (k.char !== undefined ? { char: k.char } : k)));
    return { keys, escape: parsed.escape };
  }

  async function click(action, signal) {
    const button = action.button ?? 'left';
    if (!BUTTONS.has(button)) throw new ComputerError('failed', `unknown button: ${button}`);
    const count = Math.min(3, Math.max(1, action.count ?? 1));
    const mods = modifierKeys(action.modifiers);
    if (action.x !== undefined) await moveTo(action.x, action.y);
    try {
      await keysDown(mods);
      for (let i = 0; i < count; i++) {
        aborted(signal);
        await buttonDown(button, i + 1); // macOS はダブルクリックを clickState（1・2・3）で見分ける
        await sleep(30);
        await buttonUp(button, i + 1);
        if (i < count - 1) await sleep(40);
      }
    } finally {
      if (pressedButtons.has(button)) await buttonUp(button).catch(() => {});
      await keysUp(mods.filter(m => pressedKeys.has(m.code))).catch(() => {});
    }
  }

  async function drag(action, signal) {
    const { from, to } = action;
    await moveTo(from.x, from.y);
    try {
      await buttonDown('left');
      await sleep(60);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const steps = Math.min(40, Math.max(5, Math.ceil(distance / 40)));
      for (let i = 1; i <= steps; i++) {
        aborted(signal);
        // ボタンを押したままの移動は、ヘルパーが leftMouseDragged にする
        await call('mouse', { event: 'move', x: Math.round(from.x + ((to.x - from.x) * i) / steps), y: Math.round(from.y + ((to.y - from.y) * i) / steps) });
        await sleep(8);
      }
      await sleep(30);
    } finally { if (pressedButtons.has('left')) await buttonUp('left').catch(() => {}); }
  }

  async function scroll(action) {
    await moveTo(action.x, action.y);
    const amount = Math.min(MAX_SCROLL, Math.max(1, Math.round(action.amount ?? 1)));
    const horizontal = action.direction === 'left' || action.direction === 'right';
    const sign = action.direction === 'up' || action.direction === 'right' ? 1 : -1;
    await call('scroll', horizontal ? { dx: sign * SCROLL_LINES, dy: 0, count: amount } : { dy: sign * SCROLL_LINES, dx: 0, count: amount });
  }

  async function typeText(text, signal) {
    const chars = [...String(text ?? '')];
    for (let i = 0; i < chars.length; i += TEXT_CHUNK) {
      aborted(signal);
      await call('text', { text: chars.slice(i, i + TEXT_CHUNK).join('') });
      if (i + TEXT_CHUNK < chars.length) await sleep(5);
    }
  }

  async function key(action, signal) {
    const parsed = await resolved(action.combo);
    const repeat = Math.min(MAX_REPEAT, Math.max(1, action.repeat ?? 1));
    if (parsed.escape) suspendEscape();
    try {
      for (let i = 0; i < repeat; i++) {
        aborted(signal);
        const added = parsed.keys.filter(k => !pressedKeys.has(k.code));
        try { await keysDown(added); } finally { await keysUp(added.filter(k => pressedKeys.has(k.code))); }
        if (i < repeat - 1) await sleep(10);
      }
    } finally { resumeEscape(); }
  }

  async function keyDown(action) {
    const parsed = await resolved(action.combo);
    if (parsed.escape) suspendEscape();
    await keysDown(parsed.keys.filter(k => !pressedKeys.has(k.code)));
  }
  async function keyUp(action) {
    const parsed = await resolved(action.combo);
    await keysUp(parsed.keys.filter(k => pressedKeys.has(k.code)));
    resumeEscape();
  }

  /** 1 つの動作を送る。signal が止まっていれば `stopped`。送る前の判定（自分の窓）は呼ぶ側（service）の仕事 */
  async function perform(action, signal) {
    const controller = new AbortController();
    running.add(controller);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try { return await operation.run(combined, () => performAction(action, combined)); }
    finally { running.delete(controller); }
  }

  async function performAction(action, signal) {
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

  /** 送る前の検査（座標の範囲・キーの名前・OS の機能の組み合わせ）。1 文字のキーが今の配列で打てるかは送るときに分かる */
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
          if ((action.type === 'down' || action.type === 'up') && action.button !== undefined && !BUTTONS.has(action.button)) throw new ComputerError('failed', `unknown button: ${action.button}`);
          break;
        case 'drag': point(action.from?.x, action.from?.y); point(action.to?.x, action.to?.y); break;
        case 'key': case 'keyDown': case 'keyUp': parseCombo(action.combo); break;
        case 'text': break;
        default: throw new ComputerError('failed', `unknown action: ${action?.type}`);
      }
    }
  }

  /** 押したままのキーとボタンを離す。押したものの名前をすぐ返し、ヘルパーには releaseAll を頼む（ヘルパーも押したものを覚えている） */
  function releaseAll() {
    for (const controller of running) controller.abort();
    const released = [...[...pressedButtons].reverse(), ...[...pressedKeys.values()].reverse()];
    pressedButtons.clear();
    pressedKeys.clear();
    try {
      if (released.length) Promise.resolve(helper.call('releaseAll', {})).catch(error => log(`releaseAll failed: ${error.message}`));
    } finally { resumeEscape(); }
    return released;
  }

  return { perform, validate, releaseAll, pressed: () => ({ keys: [...pressedKeys.keys()], buttons: [...pressedButtons] }) };
}

module.exports = { createMacInput, SCROLL_LINES, TEXT_CHUNK };
