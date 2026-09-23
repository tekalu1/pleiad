// playwright-cli run-code --filename=tests/browser/menu-input.cjs
// Open an authenticated isolated fake server first. No LLM calls.
async page => {
  return await page.evaluate(async () => {
    const { createContextMenu } = await import('/context-menu.mjs');
    const { createCombo } = await import('/combo.mjs');
    const assert = (ok, message) => { if (!ok) throw Error(message); };
    const wait = () => new Promise(resolve => setTimeout(resolve, 350));
    const pointer = (node, type, relatedTarget = null) => node.dispatchEvent(new PointerEvent(type, { pointerType: 'mouse', relatedTarget }));
    const key = (node, key, extra = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
      node.dispatchEvent(event);
      return event;
    };
    const menu = createContextMenu();
    const commits = [];
    const opener = document.createElement('button');
    document.body.append(opener);
    // Native dialogs in the app may be open on first launch.
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    const open = () => {
      opener.focus();
      menu.open(40, 40, [
        { label: 'Edit', sub: () => [{ input: { placeholder: 'Test name', onCommit: value => commits.push(value) } }] },
        { label: 'Sibling', sub: () => [{ label: 'Other' }] },
        { label: 'Leaf' },
      ]);
      const root = document.querySelector('.menu');
      root.querySelector('button').click();
      return { root, input: document.querySelector('.menu input') };
    };
    try {
      let { root, input } = open();
      input.value = 'abc';
      pointer(input.parentElement, 'pointerleave', document.body);
      await wait();
      assert(input.isConnected && document.activeElement === input && input.value === 'abc', 'pointer exit discarded focused input');
      // Hover must not replace the editing panel or remove it through a leaf row.
      pointer(root.querySelectorAll('button')[1], 'pointerenter');
      await wait();
      assert(input.isConnected, 'sibling hover discarded input');
      pointer(root.querySelectorAll('button')[2], 'pointerenter');
      await wait();
      assert(input.isConnected, 'leaf hover discarded input');
      // A pending timer must also be cancelled when keyboard focus enters the field.
      root.querySelector('button').focus();
      pointer(root.querySelectorAll('button')[2], 'pointerenter');
      pointer(input.parentElement, 'pointerleave', document.body);
      input.focus();
      await wait();
      assert(input.isConnected, 'pending timer survived input focus');
      for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
        for (const name of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
          const event = key(input, name, extra);
          assert(!event.defaultPrevented && input.isConnected && commits.length === 0, `IME ${name} intercepted`);
        }
      }
      input.value = '確認待ち';
      key(input, 'Enter');
      assert(commits.length === 1 && commits[0] === '確認待ち' && !input.isConnected, 'normal Enter did not commit once');
      assert(document.activeElement === opener, 'commit did not restore focus');
      ({ root, input } = open());
      key(input, 'Escape');
      assert(!input.isConnected && document.activeElement === root.querySelector('button'), 'Escape did not close submenu');
      key(document.activeElement, 'ArrowRight');
      input = document.querySelector('.menu input');
      assert(document.activeElement === input, 'keyboard submenu did not reopen');
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      assert(!input.isConnected && !root.isConnected, 'outside click did not close menu');
      ({ root, input } = open());
      root.querySelector('button').focus();
      pointer(input.parentElement, 'pointerleave', document.body);
      await wait();
      assert(!input.isConnected && root.isConnected, 'unfocused submenu no longer closes');
      menu.close();

      for (const strict of [false, true]) {
        const changes = [];
        const combo = createCombo({ strict, value: 'original', options: () => [{ value: 'original' }, { value: '確認待ち' }], onCommit: value => changes.push(value) });
        document.body.append(combo.root);
        try {
          const field = combo.root.querySelector('input');
          field.focus(); field.value = '確認待ち';
          field.dispatchEvent(new Event('input'));
          for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
            for (const name of ['Enter', 'Escape', 'ArrowDown', 'ArrowUp']) {
              assert(!key(field, name, extra).defaultPrevented, `combo intercepted IME ${name}`);
              assert(document.activeElement === field && field.value === '確認待ち' && changes.length === 0, 'combo lost composition');
            }
          }
          key(field, 'Enter');
          assert(changes.length === 1 && changes[0] === '確認待ち', 'combo normal confirmation failed');
        } finally { combo.root.remove(); }
      }
      return { passed: true, coverage: 'focus, hover timers, keyboard navigation, outside click, IME and normal commits in menus and free/strict combos' };
    } finally { menu.close(); opener.remove(); }
  });
}
