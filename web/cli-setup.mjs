// 設定 › アプリ情報・更新の「外の AI から Pleiad を使う」（ADR 0090）。外の AI（Claude Code など）の MCP の設定に貼る
// pleiad mcp の起動の仕方を、操作の一覧の app.cliSetup（ホストの画面だけ）から取ってクリップボードへ写す。
// 取れない（リモートの窓・古いサーバー）ときは節ごと出さない。
import { t } from './i18n.mjs';

const RESET_MS = 1800;

export function setupCliSetup({ cmd, root = document }) {
  const $ = (id) => root.getElementById(id);
  const box = $('cliSetup');
  if (!box) return { load: async () => null };
  let setup = null, loading = null;

  /** 一度だけ取る。失敗したら次に開いたときに取り直す */
  function load() {
    if (setup) return Promise.resolve(setup);
    loading ??= cmd('invoke', { op: 'app.cliSetup', args: {} })
      .then((value) => { setup = value; box.hidden = false; return value; })
      .catch(() => { box.hidden = true; return null; })
      .finally(() => { loading = null; });
    return loading;
  }

  async function copy(button, field, label) {
    let ok = false;
    try {
      const value = (await load())?.[field];
      if (!value || !navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch { /* 下で失敗を出す */ }
    button.textContent = ok ? t('settings.updates.copied') : t('settings.updates.copyFailed');
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => { button.textContent = t(label); }, RESET_MS);
  }

  $('copyMcpJson').onclick = (e) => copy(e.currentTarget, 'json', 'settings.updates.copyMcpJson');
  $('copyMcpClaude').onclick = (e) => copy(e.currentTarget, 'claude', 'settings.updates.copyMcpClaude');
  return { load };
}
