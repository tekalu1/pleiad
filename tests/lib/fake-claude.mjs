// 偽の Claude Code CLI（tests/lib/fake-claude-cli.mjs）を、Pleiad が CLI として見つける形で置く（AGENT_HOST_CLAUDE_BIN）。
// Windows は npm の包みと同じ形（<dir>/claude.cmd と <dir>/node_modules/@anthropic-ai/claude-code/package.json）にし、包みの bin を JS にする
// （core/cli-installation.mjs の cliCommand が node で起こす形に解き、SDK は node で起こす。保持役は claude-held.mjs の heldCommand で node に直す）。
// それ以外の OS は実行できるシェルスクリプト
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI = fileURLToPath(new URL('./fake-claude-cli.mjs', import.meta.url));

/** dir の下に偽の CLI を置き、サーバーに渡す env を返す */
export async function installFakeClaude(dir) {
  await fs.mkdir(dir, { recursive: true });
  if (process.platform === 'win32') {
    const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    await fs.mkdir(pkg, { recursive: true });
    await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.288', bin: { claude: 'cli.mjs' } }));
    await fs.writeFile(path.join(pkg, 'cli.mjs'), `import ${JSON.stringify(pathToFileURL(CLI).href)};\n`);
    const cmd = path.join(dir, 'claude.cmd');
    await fs.writeFile(cmd, `@"${process.execPath}" "${path.join(pkg, 'cli.mjs')}" %*\r\n`);
    return { bin: cmd, env: { AGENT_HOST_CLAUDE_BIN: cmd } };
  }
  const sh = path.join(dir, 'claude');
  await fs.writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 });
  return { bin: sh, env: { AGENT_HOST_CLAUDE_BIN: sh } };
}
