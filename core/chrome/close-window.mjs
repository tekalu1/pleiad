// 会話の Chrome の窓を閉じる共通の口。静止画は uploads に置き、会話の present にはパスだけを残す（ADR 0115）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_IMAGE = 10 * 1024 * 1024;
const folderOf = (dataDir, sessionId) => path.join(dataDir, 'uploads', 'chrome-window', crypto.createHash('sha256').update(sessionId).digest('hex'));

export function createChromeWindowCloser({ relay, screencast, handoffs, dataDir, record, log = () => {} }) {
  const active = new Map();
  const pending = new Map();
  const forgotten = new Set();
  const known = new Map();

  async function save(sessionId, base64, format) {
    if (typeof base64 !== 'string' || !base64) return null;
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE) return null;
    const dir = folderOf(dataDir, sessionId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.${format}`);
    await fs.writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
    return file;
  }

  async function capture(sessionId, fallbackOnly) {
    if (!fallbackOnly) {
      const targetId = relay.view.current(sessionId);
      if (targetId) {
        let view;
        try {
          view = await relay.view.attach(sessionId, targetId, () => {});
          const shot = await view.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          if (shot?.data) return save(sessionId, shot.data, 'png');
        } catch (error) { log(`chrome-close: capture failed: ${error?.message ?? error}`); }
        finally { await view?.detach().catch(() => {}); }
      }
    }
    return save(sessionId, screencast?.lastFrame(sessionId), 'jpg');
  }

  async function recordClose(sessionId, by, file) {
    if (forgotten.has(sessionId)) return;
    await record(sessionId, { kind: 'chromeClosed', chromeClosed: { by }, path: file });
    screencast?.forgetFrame(sessionId);
  }

  function close(sessionId, { by = 'agent', discard = false } = {}) {
    if (active.has(sessionId)) return active.get(sessionId);
    if (forgotten.has(sessionId) && !discard) return Promise.resolve({ closed: false });
    const run = (async () => {
      const hadWindow = relay.view.summary(sessionId).tabs > 0 || relay.scope.windows?.(sessionId)?.length > 0;
      if (!hadWindow) return { closed: false };
      const file = discard ? null : await capture(sessionId, false).catch(error => { log(`chrome-close: save failed: ${error?.message ?? error}`); return null; });
      handoffs?.forget(sessionId); // 操作待ちのカードを中断し、hand_to_user の待ちも解く
      let recorded = false;
      try {
        const result = await relay.closeConversationWindows(sessionId);
        if (!discard && result.closed) { await recordClose(sessionId, by, file); recorded = true; }
        return result;
      } finally {
        if (file && !recorded) await fs.rm(file, { force: true }).catch(() => {});
      }
    })();
    active.set(sessionId, run);
    run.finally(() => { if (active.get(sessionId) === run) active.delete(sessionId); }).catch(() => {});
    return run;
  }

  // 人が Chrome の × で最後の窓を直接閉じた。CDP の撮影はもうできないので直近の映像を残す。
  const off = relay.view.onChange((sessionId, kind, from) => {
    if (kind === 'rebind') { if (known.has(from)) { known.set(sessionId, known.get(from)); known.delete(from); } return; }
    if (kind === 'reset' || kind === 'forget') { known.delete(sessionId); return; }
    if (kind !== 'tabs') return;
    const tabs = relay.view.summary(sessionId).tabs;
    const was = known.get(sessionId) ?? 0;
    known.set(sessionId, tabs);
    if (was > 0 && tabs === 0 && !active.has(sessionId)) {
      handoffs?.forget(sessionId);
      relay.unpause(sessionId);
      if (forgotten.has(sessionId)) return;
      const task = capture(sessionId, true).then(file => recordClose(sessionId, 'human', file));
      pending.set(sessionId, task);
      task.finally(() => { if (pending.get(sessionId) === task) pending.delete(sessionId); })
        .catch(error => log(`chrome-close: record failed: ${error?.message ?? error}`));
    }
  });

  return {
    close,
    async forget(sessionId) {
      forgotten.add(sessionId);
      await close(sessionId, { discard: true });
      await pending.get(sessionId)?.catch(error => log(`chrome-close: record failed: ${error?.message ?? error}`));
      known.delete(sessionId);
      screencast?.forgetFrame(sessionId);
      await fs.rm(folderOf(dataDir, sessionId), { recursive: true, force: true });
    },
    revive(sessionId) { forgotten.delete(sessionId); },
    stop() { off(); forgotten.clear(); },
  };
}
