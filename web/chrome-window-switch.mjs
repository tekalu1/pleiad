// 右パネル「Chrome のウィンドウ」の、見るウィンドウを切り替える部品（docs/inapp-browser.md「見るウィンドウを選ぶ」、承認済み 2026-10-09）。
//   - 番号のチップの列（ウィンドウが 2 つ以上のときだけ出る）: 押すとそのウィンドウを固定して映像が替わる。エージェントが操作中のウィンドウには弧、操作していないときは点
//   - 「エージェントを追う」: 固定を外して、エージェントが操作するウィンドウを映す。固定していない間は押せる状態を示さない
//   - 閉じる前の確かめ: 小さなダイアログ。「やめる」に焦点が当たる。Esc・外側を押すのも「やめる」
// 文言は呼ぶ側の t で引く。DOM は document.createElement だけで作る（テストの代役の DOM で動く）。
import { el, svgEl } from './dom.mjs';
import { runMark } from './arc.mjs';

const FLASH_MS = 760;

/** 照準の絵（エージェントを追う）。24×24 の線画 */
function locateIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('circle', { cx: 12, cy: 12, r: 5.5 }), svgEl('path', { d: 'M12 3v3M12 18v3M3 12h3M18 12h3' }),
    svgEl('circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }));
  return svg;
}

/** 固定中の印（ピン）の絵 */
export function pinIcon() {
  const svg = svgEl('svg', { class: 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: 'M9 4h6l-1 6 3 3H7l3-3-1-6zM12 13v7' }));
  return svg;
}

/**
 * 番号のチップの列。
 * @param t        翻訳
 * @param onPick   (windowId) チップを押した・矢印で選んだ
 * @param onFollow ()         「エージェントを追う」を押した
 * @param getName  エージェントの名前
 */
export function createWindowSwitch({ t, onPick = () => {}, onFollow = () => {}, getName = () => 'Claude' } = {}) {
  const root = el('div', 'cp-sw');
  const inner = el('div', 'cp-sw-in');
  const row = el('div', 'cp-sw-row');
  const list = el('div', 'cp-sw-list'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', t('browser.chromeWindow.switchLabel'));
  const pad = el('span', 'cp-sw-pad'); pad.setAttribute('aria-hidden', 'true');
  const follow = el('button', 'btn btn-icon cp-sw-follow'); follow.type = 'button';
  follow.setAttribute('aria-label', t('browser.chromeWindow.follow')); follow.title = t('browser.chromeWindow.follow');
  follow.append(locateIcon());
  row.append(list, follow); inner.append(row); root.append(inner);

  const chips = new Map();   // windowId -> { node, number }
  let order = [], flashTimer = 0, followFlashTimer = 0, picked = null;

  const flashNode = (node, ms = FLASH_MS) => {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
    return setTimeout(() => node.classList.remove('flash'), ms);
  };

  function chipKeydown(windowId) {
    return event => {
      const open = order.filter(id => !chips.get(id)?.ghost);
      const index = open.indexOf(windowId);
      const target = { ArrowRight: open[Math.min(open.length - 1, index + 1)], ArrowLeft: open[Math.max(0, index - 1)], Home: open[0], End: open.at(-1) }[event.key];
      if (target == null) return;
      event.preventDefault();
      picked = target;
      onPick(target);
      chips.get(target)?.node.focus?.();
    };
  }

  function makeChip(windowId, number) {
    const node = el('button', 'cp-sw-chip'); node.type = 'button'; node.setAttribute('role', 'tab');
    const num = el('span', 'cp-sw-num', String(number));
    const mark = el('span', 'cp-sw-ag'); mark.setAttribute('aria-hidden', 'true');
    node.append(num, mark);
    node.onclick = () => onPick(windowId);
    node.onkeydown = chipKeydown(windowId);
    return { node, number, num, mark, ghost: false, running: null };
  }

  function placePad(selectedId) {
    const chip = chips.get(selectedId);
    const left = chip?.node.offsetLeft, width = chip?.node.offsetWidth;
    if (!Number.isFinite(left) || !Number.isFinite(width) || !width) return;
    pad.style.width = `${width}px`;
    pad.style.transform = `translateX(${left}px)`;
    const view = list.scrollLeft ?? 0, box = list.clientWidth ?? 0;
    if (box && left - 3 < view) list.scrollLeft = left - 3;
    else if (box && left + width + 3 > view + box) list.scrollLeft = left + width + 3 - box;
  }

  return {
    root, list, follow,
    /**
     * @param items    [{ windowId, number, selected, agent, ghost }]（窓の並び順）
     * @param agentRunning エージェントが操作中か
     * @param pinned   固定しているか（固定していなければ「追う」の状態）
     * @param away     固定していて、エージェントは別のウィンドウにいる
     * @param disabled 引き継ぎ中など、切り替えられない
     * @param flashId  印が移ったウィンドウ（1 回光らせる）
     */
    paint({ items = [], agentRunning = false, pinned = false, away = false, disabled = false, flashId = null } = {}) {
      const ids = new Set(items.map(item => item.windowId));
      for (const [id, chip] of [...chips]) if (!ids.has(id)) { chip.node.remove(); chips.delete(id); }
      for (const item of items) {
        let chip = chips.get(item.windowId);
        if (!chip) { chip = makeChip(item.windowId, item.number); chips.set(item.windowId, chip); }
        if (chip.number !== item.number) { chip.number = item.number; chip.num.textContent = String(item.number); }
        chip.ghost = item.ghost === true;
        chip.node.classList.toggle('ghost', chip.ghost);
        chip.node.setAttribute('aria-selected', String(item.selected === true));
        chip.node.tabIndex = item.selected ? 0 : -1;
        chip.node.disabled = disabled || chip.ghost;
        if (item.agent) chip.node.setAttribute('data-agent', ''); else chip.node.removeAttribute('data-agent');
        const name = getName();
        chip.node.setAttribute('aria-label', t('browser.chromeWindow.windowNumber', { n: item.number })
          + (item.agent ? `, ${agentRunning ? t('browser.chromeWindow.chipAgentRunning', { name }) : t('browser.chromeWindow.chipAgentIdle', { name })}` : '')
          + (item.selected && pinned ? `, ${t('browser.chromeWindow.pinned')}` : ''));
        // 印: 操作中は弧、そうでなければ点。窓が替わるときだけ作り直す
        if (item.agent && chip.running !== agentRunning) {
          chip.mark.replaceChildren(...(agentRunning ? [runMark()] : []));
          chip.running = agentRunning;
        } else if (!item.agent) { chip.mark.replaceChildren(); chip.running = null; }
      }
      // 並びを窓の順に揃える（先頭は pad。足りない分だけ足し、焦点のあるチップを入れ直さない）
      if (list.children[0] !== pad) list.prepend(pad);
      items.forEach((item, index) => {
        const node = chips.get(item.windowId).node, current = Array.from(list.children)[index + 1];
        if (current === node) return;
        if (current) current.before(node); else list.append(node);
      });
      order = items.map(item => item.windowId);
      root.toggleAttribute('data-open', items.length >= 2);
      root.toggleAttribute('data-run', agentRunning);
      root.toggleAttribute('data-paused', disabled);
      follow.disabled = disabled;
      follow.setAttribute('aria-pressed', String(!pinned));
      follow.classList.toggle('on', !pinned);
      follow.toggleAttribute('data-away', away);
      const selected = items.find(item => item.selected);
      if (selected) placePad(selected.windowId);
      if (flashId != null && chips.get(flashId)) { clearTimeout(flashTimer); flashTimer = flashNode(chips.get(flashId).node); }
    },
    /** 「エージェントを追う」を光らせる（固定を外した直後の戻りの動き） */
    flashFollow() { clearTimeout(followFlashTimer); followFlashTimer = flashNode(follow); },
    /** 矢印で選んだ直後の描き直しで、焦点を選んだチップに残す */
    focusPicked() { if (picked != null) { chips.get(picked)?.node.focus?.(); picked = null; } },
    focusChip(windowId) { chips.get(windowId)?.node.focus?.(); },
    chip: windowId => chips.get(windowId)?.node ?? null,
    dispose() { clearTimeout(flashTimer); clearTimeout(followFlashTimer); },
  };
}

/**
 * 閉じる前の確かめ（小さなダイアログ）。パネルの本体（position: relative）の中に重ねる。
 * 「やめる」に焦点。Esc・外側を押すのも「やめる」。引き継ぎ中・依頼待ちのときは注意の一文を足す。
 */
export function createCloseDialog({ t }) {
  const root = el('div', 'cp-dlg'); root.hidden = true;
  let returnTo = null, serial = 0;

  function dismiss(restore = true) {
    if (root.hidden) return;
    root.hidden = true; root.replaceChildren();
    const target = returnTo; returnTo = null;
    if (restore && target && !target.disabled) target.focus?.();
  }

  /**
   * @param number 閉じるウィンドウの番号（知らなければ null）
   * @param many   ウィンドウが 2 つ以上ある（番号を題に入れる）
   * @param agent  エージェントが操作しているウィンドウか（番号の横に印を添える）
   * @param running エージェントが操作中か
   * @param risk   'human'（引き継ぎ中）| 'waiting'（依頼待ち）| null
   * @param run    「閉じる」で呼ぶ
   * @param trigger 閉じたあとに焦点を返すボタン
   */
  function ask({ number = null, many = false, agent = false, running = false, risk = null, run, trigger = null }) {
    returnTo = trigger;
    const id = ++serial;
    const card = el('div', 'cp-dlg-card'); card.setAttribute('role', 'alertdialog'); card.setAttribute('aria-modal', 'true');
    const pic = el('div', 'cp-dlg-pic'); pic.setAttribute('aria-hidden', 'true');
    const chip = el('span', 'cp-dlg-chip', number == null ? '' : String(number));
    if (agent) chip.append(running ? runMark() : el('span', 'cp-sw-dot'));
    pic.append(chip);
    const title = el('p', 'cp-dlg-t', many && number != null ? t('browser.chromeWindow.closeAskNumber', { n: number }) : t('browser.chromeWindow.closeAsk'));
    title.id = `cp-dlg-t${id}`; card.setAttribute('aria-labelledby', title.id);
    card.append(pic, title);
    if (risk) {
      const note = el('p', 'cp-dlg-n', risk === 'human' ? t('browser.chromeWindow.closeRiskHuman') : t('browser.chromeWindow.closeRiskWaiting'));
      note.id = `cp-dlg-n${id}`; card.setAttribute('aria-describedby', note.id);
      card.append(note);
    }
    const no = el('button', 'btn btn-quiet', t('pending.cancel')); no.type = 'button';
    const yes = el('button', 'btn cp-dlg-yes', t('browser.chromeWindow.closeYes')); yes.type = 'button';
    const buttons = el('div', 'cp-dlg-b'); buttons.append(no, yes);
    card.append(buttons);
    no.onclick = () => dismiss();
    yes.onclick = () => { returnTo = null; root.hidden = true; root.replaceChildren(); run?.(); };
    root.onclick = event => { if (event.target === root) dismiss(); };
    root.onkeydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation?.(); dismiss(); }
      else if (event.key === 'Tab') { event.preventDefault(); const active = globalThis.document?.activeElement; (active === no ? yes : no).focus?.(); }
    };
    root.replaceChildren(card);
    root.hidden = false;
    no.focus?.();
    return { no, yes, card };
  }

  return { root, ask, dismiss, get open() { return !root.hidden; } };
}
