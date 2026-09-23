import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { t } from '../i18n.mjs';

export function createClaudeAuth(launch = (args) => spawnCli(cliCommand('claude'), args, { stdio: ['ignore', 'pipe', 'pipe'] })) {
  let pending = null;
  function run(args, { emit, timeout = 15_000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = launch(args);
      let output = '';
      let stdout = '';
      let lastUrl = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(t('claude.auth.timeout'))); }, timeout);
      const read = data => {
        output = (output + data.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-64_000);
        const urls = output.match(/https:\/\/[^\s<>"\x1b]+/g) || [];
        for (const url of urls) {
          let parsed; try { parsed = new URL(url); } catch { continue; }
          if (!['claude.ai', 'console.anthropic.com', 'platform.claude.com'].includes(parsed.hostname) || url === lastUrl) continue;
          lastUrl = url;
          emit?.({ type: 'auth', phase: 'url', url });
        }
      };
      child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-64_000); read(data); });
      child.stderr.on('data', read);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, output: stdout }); });
    });
  }
  return {
    async status() {
      if (pending) return { loggedIn: false, pending: true };
      const result = await run(['auth', 'status', '--json']);
      let value; try { value = JSON.parse(result.output); } catch {
        throw new Error(t('claude.auth.statusUnreadable'));
      }
      return { loggedIn: result.code === 0 && value.loggedIn === true, account: value.email || undefined, detail: value.authMethod || undefined };
    },
    async login({ emit }) {
      if (pending) throw new Error(t('claude.auth.loginPending'));
      pending = run(['auth', 'login'], { emit, timeout: 10 * 60_000 });
      try {
        const result = await pending;
        if (result.code !== 0) throw new Error(t('claude.auth.loginFailed'));
        emit({ type: 'auth', phase: 'done', message: t('claude.auth.loggedIn') });
      } finally { pending = null; }
    },
    async logout() {
      if (pending) throw new Error(t('claude.auth.waitLogin'));
      const result = await run(['auth', 'logout']);
      if (result.code !== 0) throw new Error(t('claude.auth.logoutFailed'));
    },
  };
}

export const claudeAuth = createClaudeAuth();
