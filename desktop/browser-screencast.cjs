// A browser-only CDP screencast endpoint for one Pleiad conversation.
// This module manages CDP Page.startScreencast on WebContentsView's webContents.debugger for remote viewing of the PC's built-in browser.

/**
 * @param {object} panel - The browser panel instance (from browser-panel.cjs)
 * @returns {object} screencast API
 */
function createBrowserScreencast(panel) {
  // Track active screencasts per session (conversation)
  // Each session can have at most one active screencast
  // セッションごとのアクティブなスクリーンキャストを追跡する
  const sessions = new Map(); // sessionId -> { tabId, listeners: Set<ws>, ackPending, stopped, width, quality, frameCount, totalBytes, lastFrameAt }

  /**
   * Start screencast for a conversation's browser tab.
   * If no tab exists, creates one via panel.createFor.
   * Uses CDP Page.startScreencast on webContents.debugger.
   * @param {string} sessionId - Conversation session ID
   * @param {object} options - { url?, width?, quality? }
   * @returns {{ tabId: string }}
   */
  async function start(sessionId, { url, width = 800, quality = 40 } = {}) {
    // Get or create a tab for this session
    let tabs = panel.tabsFor(sessionId);
    if (!tabs.length) {
      panel.createFor(sessionId, url || 'about:blank');
      tabs = panel.tabsFor(sessionId);
    }
    const tab = tabs[0];
    const c = tab.webContents;
    if (c.isDestroyed()) throw new Error('tab destroyed');
    
    // Attach debugger if not already
    if (!c.debugger.isAttached()) c.debugger.attach('1.3');
    
    // If url provided, navigate
    if (url && url !== 'about:blank') {
      if (!safeUrl(url)) throw new Error('invalid url');
      await c.debugger.sendCommand('Page.navigate', { url });
    }
    
    // Stop any existing screencast for this session
    const existing = sessions.get(sessionId);
    if (existing && existing.tabId !== tab.id) {
      await stop(sessionId);
    }
    
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = { 
        tabId: tab.id, 
        listeners: new Set(), 
        ackPending: false, 
        stopped: false, 
        width, 
        quality, 
        frameCount: 0, 
        totalBytes: 0, 
        lastFrameAt: 0 
      };
      sessions.set(sessionId, entry);
      
      // Listen for screencast frames
      const onMessage = (_event, method, params) => {
        if (method !== 'Page.screencastFrame') return;
        entry.frameCount++;
        const frameBytes = params.data ? Math.ceil(params.data.length * 3 / 4) : 0;
        entry.totalBytes += frameBytes;
        entry.lastFrameAt = Date.now();
        entry.ackPending = true;
        
        // Send frame to all listeners
        const frame = {
          data: params.data, // base64 JPEG
          metadata: params.metadata,
          sessionId: params.sessionId
        };
        for (const send of entry.listeners) {
          try { send(frame); } catch {}
        }
      };
      entry.debuggerListener = onMessage;
      c.debugger.on('message', onMessage);
    }
    entry.width = width;
    entry.quality = quality;
    
    // Start CDP screencast
    await c.debugger.sendCommand('Page.startScreencast', {
      format: 'jpeg',
      quality: Math.max(10, Math.min(80, quality)),
      maxWidth: Math.max(320, Math.min(1280, width)),
      maxHeight: Math.round(Math.max(320, Math.min(1280, width)) * 16 / 9),
      everyNthFrame: 1
    });
    
    return { tabId: tab.id };
  }

  /**
   * Acknowledge a received frame (required by CDP to get the next one).
   */
  function ack(sessionId, frameSessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || !entry.ackPending) return;
    entry.ackPending = false;
    const tabs = panel.tabsFor(sessionId);
    const tab = tabs.find(t => t.id === entry.tabId);
    if (!tab || tab.webContents.isDestroyed()) return;
    try {
      tab.webContents.debugger.sendCommand('Page.screencastFrameAck', { sessionId: frameSessionId }).catch(() => {});
    } catch {}
  }

  /**
   * Add a listener (WebSocket send function) that receives frames.
   * Returns a cleanup function.
   */
  function addListener(sessionId, send) {
    const entry = sessions.get(sessionId);
    if (!entry) return () => {};
    entry.listeners.add(send);
    return () => {
      entry.listeners.delete(send);
      // If no more listeners, stop screencast
      if (entry.listeners.size === 0) {
        stop(sessionId).catch(() => {});
      }
    };
  }

  /**
   * Stop screencast for a session.
   */
  async function stop(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    sessions.delete(sessionId);
    entry.stopped = true;
    const tabs = panel.tabsFor(sessionId);
    const tab = tabs.find(t => t.id === entry.tabId);
    if (tab && !tab.webContents.isDestroyed()) {
      tab.webContents.debugger.off('message', entry.debuggerListener);
      try { await tab.webContents.debugger.sendCommand('Page.stopScreencast'); } catch {}
    }
    for (const send of entry.listeners) {
      try { send(null); } catch {} // null signals stop
    }
    entry.listeners.clear();
  }

  /**
   * Dispatch input event to the browser tab.
   * @param {string} sessionId
   * @param {object} input - { type: 'mouse'|'scroll'|'key'|'text', ... }
   */
  async function dispatchInput(sessionId, input) {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error('no screencast');
    const tabs = panel.tabsFor(sessionId);
    const tab = tabs.find(t => t.id === entry.tabId);
    if (!tab || tab.webContents.isDestroyed()) throw new Error('tab destroyed');
    const dbg = tab.webContents.debugger;
    if (!dbg.isAttached()) throw new Error('debugger detached');

    switch (input.type) {
      case 'mouse': {
        // Convert coordinates from remote screen to actual page coordinates
        // Remote sends coords relative to the screencast image dimensions
        // Note: screencast metadata includes deviceWidth/deviceHeight that the client uses to scale
        const x = input.x;
        const y = input.y;
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: input.action, // mousePressed, mouseReleased, mouseMoved
          x, y,
          button: input.button || 'left',
          clickCount: input.clickCount || 1
        });
        break;
      }
      case 'scroll': {
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x || 0,
          y: input.y || 0,
          deltaX: input.deltaX || 0,
          deltaY: input.deltaY || 0
        });
        break;
      }
      case 'key': {
        // Only allow a small set of keys for safety
        const ALLOWED_KEYS = [
          'Enter', 'Escape', 'Tab', 'Backspace', 'Delete',
          'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
          'Home', 'End', 'PageUp', 'PageDown'
        ];
        if (!ALLOWED_KEYS.includes(input.key)) break;
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyDown', key: input.key,
          code: input.code || input.key,
          windowsVirtualKeyCode: input.keyCode || 0
        });
        await dbg.sendCommand('Input.dispatchKeyEvent', {
          type: 'keyUp', key: input.key,
          code: input.code || input.key,
          windowsVirtualKeyCode: input.keyCode || 0
        });
        break;
      }
      case 'text': {
        if (typeof input.text === 'string' && input.text.length > 0 && input.text.length <= 1000) {
          await dbg.sendCommand('Input.insertText', { text: input.text });
        }
        break;
      }
    }
  }

  /**
   * Navigate the tab.
   * @param {string} sessionId
   * @param {'back'|'forward'|'reload'|'navigate'} action
   * @param {object} args - { url? }
   */
  async function navigate(sessionId, action, args = {}) {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error('no screencast');
    const tabs = panel.tabsFor(sessionId);
    const tab = tabs.find(t => t.id === entry.tabId);
    if (!tab || tab.webContents.isDestroyed()) throw new Error('tab destroyed');
    const c = tab.webContents;
    switch (action) {
      case 'back':
        if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack();
        break;
      case 'forward':
        if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward();
        break;
      case 'reload':
        c.reload();
        break;
      case 'navigate': {
        if (!args.url) throw new Error('url required');
        if (!safeUrl(args.url)) throw new Error('invalid url');
        const href = args.url === 'about:blank' ? args.url : new URL(args.url).href;
        c.loadURL(href).catch(() => {});
        break;
      }
    }
  }

  /**
   * Get current tab info for the session's screencast.
   */
  function info(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    const tabs = panel.tabsFor(sessionId);
    const tab = tabs.find(t => t.id === entry.tabId);
    if (!tab || tab.webContents.isDestroyed()) return null;
    const c = tab.webContents;
    return {
      url: c.getURL() || '',
      title: c.getTitle() || '',
      canGoBack: c.navigationHistory.canGoBack(),
      canGoForward: c.navigationHistory.canGoForward(),
      loading: c.isLoading()
    };
  }

  /**
   * Get bandwidth stats.
   */
  function stats(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    return {
      frameCount: entry.frameCount,
      totalBytes: entry.totalBytes,
      avgFrameBytes: entry.frameCount > 0 ? Math.round(entry.totalBytes / entry.frameCount) : 0
    };
  }

  function close() {
    for (const sessionId of sessions.keys()) stop(sessionId).catch(() => {});
  }

  return { start, stop, ack, addListener, dispatchInput, navigate, info, stats, close };
}

function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password || url.href === 'about:blank'; } catch { return false; } }

module.exports = { createBrowserScreencast };
