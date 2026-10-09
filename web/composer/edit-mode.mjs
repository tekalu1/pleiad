// 入力欄の「編集中」の状態（docs/design-system.md「発言の操作 › 送り直し」、docs/message-fork.md、ADR 0177）。
// 発言の ⋯ › 「編集して再送信」「再送信」は、発言の場所に別の編集欄を開かず、いつもの入力欄（web/md-editor.mjs）に
// 元の本文と添付を入れて「編集中」にする。Chats の会話の欄とスレッドの欄が同じものを使う（web/composer/composer.mjs の useEdit）。
//
// - 入力欄の上に帯（role=group「編集中」）: 「HH:MM の発言を編集中」「元の位置へ」「取り消す」と、送り直すと消えるものの文
// - 送信の円は［分岐して送る］［送り直す］に替わる（走っている返答があれば［止めて送り直す］）。狭い幅は入力欄の下の 2 段目
// - 書きかけは聞かずに脇へ取り、送り直す・取り消すと戻す。別の発言の編集を選んだら、直していなければ黙って切り替え、直していれば帯の中で聞く
// - Ctrl/⌘+Enter = 送り直す、Ctrl/⌘+Shift+Enter = 分岐して送る（日時の予約は使わない）、Esc = 取り消す
// - 状態は下書きと一緒に保存する（snapshot / restore）。会話を切り替えても、読み込み直しても続く
//
// 何を送るか（巻き戻して送る・分岐して送る・元の位置の見せ方）は呼び出し側（host）が持つ。ここは状態・帯・ボタン・キー・書きかけの出し入れ。
import { el } from '../dom.mjs';
import { runMark } from '../arc.mjs';
import { isComposingKey } from '../keyboard.mjs';
import { branchGlyph, penGlyph, sendGlyph, sendLabels, tailLines } from '../resend-band.mjs';

let seq = 0;

/** 本文の添付の印の行（[添付] パス）と空白を除いた先頭の 1 行。帯の「」の中に出す */
export function quoteOf(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (s && !/^\[(添付|Attachment)\]/.test(s)) return s.length > 120 ? s.slice(0, 120) : s;
  }
  return '';
}

const pathsOf = (list) => JSON.stringify((list ?? []).map((a) => a.path).sort());

/** 直したか: 本文か添付が、編集を始めたときと違う */
export function changedFrom(base, now) {
  return String(now.text ?? '') !== String(base.text ?? '') || pathsOf(now.attached) !== JSON.stringify([...(base.paths ?? [])].sort());
}

/** 脇に取った書きかけを、編集中の中身へ足す（編集の相手が無くなったとき、書きかけを失わないように） */
export function mergeContent(edited, stash) {
  const text = [String(edited.text ?? '').trim(), String(stash?.text ?? '').trim()].filter(Boolean).join('\n\n');
  const seen = new Set();
  const attached = [...(edited.attached ?? []), ...(stash?.attached ?? [])].filter((a) => !seen.has(a.path) && seen.add(a.path));
  return { text, attached };
}

/**
 * @param {object} o
 * @param {ReturnType<import('./composer.mjs').createComposer>} o.composer
 * @param {Function} o.t
 * @param {(text: string) => void} [o.announce]
 * @param {object} o.host 面ごとの決まり
 * @param {() => { text: string, attached: object[] }} o.host.read 入力欄の今の中身
 * @param {(content: { text: string, attached: object[] }) => void} o.host.write 入力欄の中身を置き換える（添付の実体も）
 * @param {(ctx: object) => Promise<boolean>} o.host.send ［送り直す］。ctx = { id, text, attached, tail }。送れたら true
 * @param {(ctx: object) => Promise<boolean>} o.host.branch ［分岐して送る］。送れたら true（面が別の会話へ移ったなら、移った後に false でもよい）
 * @param {(id: string, on: boolean, tail?: object) => void} [o.host.decorate] 元の発言の「編集中」の札と、消える範囲の薄め
 * @param {(id: string) => void} [o.host.locate] 元の位置へ
 * @param {() => unknown} [o.host.takeExtra] 脇に取る書きかけの付属（日時を指定した送信の予約など）。取ったら欄からは外す
 * @param {(extra: unknown) => void} [o.host.putExtra] 戻す
 * @param {() => void} [o.host.change] 状態が変わった（下書きの保存）
 * @param {'message' | 'reply'} [o.kind] 帯の「発言」「返信」
 * @param {{ running?: string }} [o.texts] 文の差し替え
 */
export function createEditMode({ composer, t, announce = () => {}, host, kind = 'message', texts = {} }) {
  const { els } = composer;
  const form = els.composer;
  const prompt = els.prompt;
  /** @type {null | { id: string, time: string, quote: string, base: { text: string, paths: string[] }, stash: { text: string, attached: object[], extra?: unknown }, tail: object, confirm: null | object }} */
  let st = null;
  let ui = null;
  let sending = false;
  let narrow = null;

  const dirty = () => Boolean(st) && changedFrom(st.base, host.read());
  const valid = () => { const c = host.read(); return Boolean(c.text.trim() || c.attached.length); };
  const titleText = () => t(kind === 'reply' ? 'chat.resend.titleReply' : 'chat.resend.title', { time: st.time });

  function build() {
    const note = el('div', 'edit-note');
    note.id = `editNote${++seq}`;
    note.setAttribute('role', 'group');
    note.setAttribute('aria-label', t('chat.resend.group'));
    const inner = el('div');
    const head = el('div', 'en-1');
    const q = el('span', 'q');
    const acts = el('span', 'en-acts');
    const jump = el('button', 'en-act', t('chat.resend.jump'));
    const cancel = el('button', 'en-act', t('chat.resend.cancelEdit'));
    jump.type = cancel.type = 'button';
    jump.onclick = () => host.locate?.(st.id);
    cancel.onclick = () => api.cancel();
    acts.append(jump, cancel);
    const title = el('b');
    head.append(penGlyph(), title, q, acts);
    const lines = el('div', 'en-lines');
    const confirm = el('div', 'en-confirm-slot');
    inner.append(head, lines, confirm);
    note.append(inner);
    note.onkeydown = (e) => { if (!sending) api.key(e); };

    const row = el('div', 'erow');
    const branch = el('button', 'btn btn-quiet');
    const send = el('button', 'btn btn-primary');
    branch.type = send.type = 'button';
    const branchText = el('span', null, t('chat.resend.branch'));
    const sendText = el('span');
    branch.append(branchGlyph(), branchText);
    send.append(sendGlyph(), sendText);
    branch.setAttribute('aria-label', t('chat.resend.branchLabel'));
    branch.setAttribute('aria-keyshortcuts', 'Control+Shift+Enter Meta+Shift+Enter');
    branch.title = `${t('chat.resend.branch')} (Ctrl+Shift+Enter)`;
    send.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    branch.onclick = () => api.branch();
    send.onclick = () => api.send();
    row.append(branch, send);
    return { note, title, q, lines, confirm, jump, cancel, row, branch, send, sendText, mark: null };
  }

  /** 帯の文・ボタンの名前を今の状態から作り直す */
  function paint() {
    if (!st || !ui) return;
    const { tail } = st;
    ui.title.textContent = titleText();
    ui.q.textContent = st.quote ? `「${st.quote}」` : '';
    const lines = tailLines(tail, texts);
    ui.lines.replaceChildren(...lines.map((text) => el('div', 'en-2', text)));
    if (st.stash.text.trim() || st.stash.attached.length) ui.lines.append(el('div', 'en-2 sub', t('chat.resend.stashNote')));
    const { label, aria } = sendLabels(tail);
    ui.sendText.textContent = label;
    ui.send.setAttribute('aria-label', aria);
    ui.send.title = `${label} (Ctrl+Enter)`;
    // 同じ会話では送り直せないとき（委譲された作業の会話）は［送り直す］を出さず、分岐して送るが主になる
    ui.send.hidden = Boolean(tail.forkOnly);
    // 消えるものが無ければ、分岐しても同じなので出さない
    ui.branch.hidden = !tail.forkOnly && !tail.any;
    ui.branch.classList.toggle('btn-primary', Boolean(tail.forkOnly));
    ui.branch.classList.toggle('btn-quiet', !tail.forkOnly);
    paintConfirm();
    refresh();
    prompt.setAttribute('aria-label', t('chat.resend.inputLabel'));
    prompt.setAttribute('aria-describedby', ui.note.id);
    place();
    composer.controls?.fit();
  }

  function paintConfirm() {
    ui.confirm.replaceChildren();
    if (!st.confirm) return;
    const box = el('div', 'en-confirm');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', t('chat.resend.switchGroup'));
    const keep = el('button', 'btn btn-quiet', t('chat.resend.switchKeep'));
    const go = el('button', 'btn btn-primary', t('chat.resend.switchGo'));
    keep.type = go.type = 'button';
    keep.onclick = () => { st.confirm = null; paintConfirm(); composer.focus(); };
    go.onclick = () => { const next = st.confirm; st.confirm = null; switchTo(next); };
    box.append(el('span', null, t('chat.resend.switchAsk', { time: st.confirm.target.time })), keep, go);
    ui.confirm.append(box);
    keep.focus({ preventScroll: true });
  }

  /** 送れるか（空では送らせない）と、送っている間の止め方 */
  function refresh() {
    if (!ui) return;
    const off = sending || !valid();
    ui.send.disabled = ui.branch.disabled = off;
    ui.jump.disabled = ui.cancel.disabled = sending;
  }

  /** ボタンの置き場: 広い幅は送信の円のあった所（行の右端）、狭い幅は入力欄の下の 2 段目 */
  function place() {
    if (!ui) return;
    const crow = els.cbox.querySelector('.crow');
    const wide = !narrow;
    ui.row.classList.toggle('below', !wide);
    if (wide) { if (ui.row.parentElement !== crow) crow.insertBefore(ui.row, els.send); }
    else if (ui.row.previousElementSibling !== crow) crow.after(ui.row);
  }

  let watcher = null;
  function watch(on) {
    watcher?.disconnect();
    watcher = null;
    if (!on || typeof ResizeObserver !== 'function') return;
    const measure = () => {
      const next = els.cbox.clientWidth > 0 && els.cbox.clientWidth <= 480;
      if (next === narrow) return;
      narrow = next;
      place();
      composer.controls?.fit();
    };
    watcher = new ResizeObserver(measure);
    watcher.observe(els.cbox);
    narrow = els.cbox.clientWidth > 0 && els.cbox.clientWidth <= 480;
  }

  function mount({ enter }) {
    ui = build();
    els.cbox.before(ui.note);
    form.classList.add('editing');
    watch(true);
    if (enter) {
      ui.note.classList.add('enter');
      requestAnimationFrame(() => requestAnimationFrame(() => ui?.note.classList.remove('enter')));
      els.cbox.classList.remove('flash');
      void els.cbox.offsetWidth;
      els.cbox.classList.add('flash');
      els.cbox.addEventListener('animationend', () => els.cbox.classList.remove('flash'), { once: true });
    }
  }

  function unmount() {
    watch(false);
    ui?.note.remove();
    ui?.row.remove();
    ui = null;
    form.classList.remove('editing', 'busy-edit');
    els.cbox.classList.remove('flash');
    prompt.setAttribute('aria-label', t('chat.composer.editorLabel'));
    prompt.removeAttribute('aria-describedby');
    prompt.disabled = false;
    composer.controls?.fit();
  }

  function cursorToEnd() {
    composer.focus({ preventScroll: true });
    const n = String(prompt.value ?? '').length;
    prompt.setSelectionRange?.(n, n);
  }

  /** 入力欄が編集中になったことを読み上げに伝える（帯の文を添えて） */
  function say() {
    const lines = tailLines(st.tail, texts);
    announce(t(kind === 'reply' ? 'chat.resend.announceReply' : 'chat.resend.announce', { time: st.time }) + (lines.length ? ` ${lines.join(' ')}` : ''));
  }

  function switchTo(next) {
    const old = st;
    host.decorate?.(old.id, false);
    st = { ...old, id: next.target.id, time: next.target.time, quote: next.target.quote ?? quoteOf(next.content.text),
      base: { text: next.content.text, paths: next.content.attached.map((a) => a.path) }, tail: next.target.tail, confirm: null };
    host.write(next.content);
    host.decorate?.(st.id, true, st.tail);
    paint();
    ui.note.classList.remove('enter');
    cursorToEnd();
    say();
    host.change?.();
  }

  const api = {
    get active() { return Boolean(st); },
    get id() { return st?.id ?? null; },
    get sending() { return sending; },
    dirty,
    /**
     * 編集を始める。target = { id, time, quote?, tail }、content = { text, attached }（元の本文と添付）。
     * 編集中に別の発言を選んだら、直していなければ黙って切り替え、直していれば帯の中で聞く。focus: 'send' は［送り直す］へ
     */
    begin(target, content, { focus = 'text' } = {}) {
      if (sending) return;
      if (st) {
        if (st.id === target.id) { st.tail = target.tail; paint(); cursorToEnd(); return; }
        if (dirty()) { st.confirm = { target, content }; paint(); return; }
        switchTo({ target, content });
        return;
      }
      const extra = host.takeExtra?.();
      const current = host.read();
      st = {
        id: target.id, time: target.time, quote: target.quote ?? quoteOf(content.text),
        base: { text: content.text, paths: content.attached.map((a) => a.path) },
        stash: { text: current.text, attached: current.attached.slice(), ...(extra != null ? { extra } : {}) },
        tail: target.tail, confirm: null,
      };
      host.write(content);
      mount({ enter: true });
      host.decorate?.(st.id, true, st.tail);
      paint();
      if (focus === 'send') (st.tail.forkOnly ? ui.branch : ui.send).focus({ preventScroll: true });
      else cursorToEnd();
      say();
      host.change?.();
    },
    /** 状態を保存する形（下書きに載せる） */
    snapshot() {
      if (!st) return null;
      return { v: 1, id: st.id, time: st.time, quote: st.quote, base: { text: st.base.text, paths: st.base.paths.slice() },
        stash: { text: st.stash.text, attached: st.stash.attached.map((a) => ({ ...a })) } };
    },
    /**
     * 保存した状態を戻す（入力欄の中身は下書きの側で戻してある）。resolve(id) は { tail, time? }、元の発言が無ければ null。
     * 無いときは編集をやめ、脇の書きかけを今の中身に足す。戻したら true
     */
    restore(saved, resolve) {
      this.reset();
      if (!saved || typeof saved.id !== 'string') return false;
      const found = resolve(saved.id);
      const stash = { text: String(saved.stash?.text ?? ''), attached: Array.isArray(saved.stash?.attached) ? saved.stash.attached : [] };
      if (!found) {
        host.write(mergeContent(host.read(), stash));
        announce(t('chat.resend.lost'));
        host.change?.();
        return false;
      }
      st = { id: saved.id, time: found.time ?? String(saved.time ?? ''), quote: String(saved.quote ?? ''),
        base: { text: String(saved.base?.text ?? ''), paths: Array.isArray(saved.base?.paths) ? saved.base.paths : [] },
        stash, tail: found.tail, confirm: null };
      mount({ enter: false });
      host.decorate?.(st.id, true, st.tail);
      paint();
      return true;
    },
    /** 画面だけ片付ける（入力欄の中身には触れない）。会話の切り替えで、持ち主が変わるとき */
    reset() {
      if (!st) return;
      host.decorate?.(st.id, false);
      st = null;
      sending = false;
      unmount();
    },
    /** 元の発言が無くなった: 編集をやめ、書きかけを今の中身に足す */
    targetLost() {
      if (!st) return;
      const stash = st.stash;
      this.reset();
      host.write(mergeContent(host.read(), stash));
      announce(t('chat.resend.lost'));
      host.change?.();
    },
    /** 消えるものの見立てが変わった（走り出した・履歴が増えた）。文とボタンの名前を作り直す */
    setTail(tail) {
      if (!st) return;
      st.tail = tail;
      host.decorate?.(st.id, true, tail);
      paint();
    },
    get tail() { return st?.tail ?? null; },
    /** 脇に取った書きかけ（分岐して送ったあと、元の会話の下書きへ戻すため） */
    stashed() { return st ? { text: st.stash.text, attached: st.stash.attached.slice(), ...(st.stash.extra != null ? { extra: st.stash.extra } : {}) } : null; },
    /** 元の発言の札・薄めを付け直す（履歴を描き直したあと） */
    redecorate() { if (st) host.decorate?.(st.id, true, st.tail); },
    /** 編集をやめて、書きかけを戻す。restore: false なら入力欄を触らない（送れたあと、別の会話へ移ったあと） */
    end({ restore = true, focus = false } = {}) {
      if (!st) return;
      const { stash, id } = st;
      host.decorate?.(id, false);
      st = null;
      sending = false;
      unmount();
      if (restore) {
        host.write({ text: stash.text, attached: stash.attached });
        if (stash.extra != null) host.putExtra?.(stash.extra);
      }
      if (focus) composer.focus({ preventScroll: true });
      host.change?.();
    },
    /** 取り消す（Esc・［取り消す］）。直した内容は捨て、書きかけが戻る */
    cancel() {
      if (!st || sending) return;
      this.end({ restore: true, focus: true });
      announce(t('chat.resend.cancelled'));
    },
    async send() {
      if (!st || sending || !valid()) return false;
      return run('send');
    },
    async branch() {
      if (!st || sending || !valid()) return false;
      return run('branch');
    },
    /** 帯の中の再描画（走り出した直後など、送る前に呼び手が見直したいとき） */
    refresh,
    /** 入力欄・帯のキー。日本語入力の変換中は受けない。受けたら true */
    key(event) {
      if (!st || isComposingKey(event)) return false;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.cancel(); return true; }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey) this.branch(); else this.send();
        return true;
      }
      return false;
    },
    destroy() { this.reset(); },
  };

  async function run(which) {
    const c = host.read();
    const ctx = { id: st.id, text: c.text, attached: c.attached, tail: st.tail, edit: api };
    const id = st.id;
    sending = true;
    prompt.disabled = true;
    ui.note.toggleAttribute('aria-busy', true);
    refresh();
    const target = which === 'branch' || st.tail.forkOnly ? ui.branch : ui.send;
    ui.mark = runMark();
    target.prepend(ui.mark);
    let ok = false;
    try { ok = await (which === 'branch' || st.tail.forkOnly ? host.branch(ctx) : host.send(ctx)); }
    finally {
      sending = false;
      if (ui) {
        ui.mark?.remove();
        ui.mark = null;
        ui.note.removeAttribute('aria-busy');
        prompt.disabled = false;
        refresh();
      }
    }
    // 送れたら編集を終えて、書きかけを戻す。面が別の会話へ移っていたら（分岐）、持ち主はもう別なので入力欄は触らない
    if (ok && st?.id === id) api.end({ restore: true });
    return ok;
  }

  return api;
}
