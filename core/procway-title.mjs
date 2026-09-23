import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConnection, procwaySource } from './procway-config.mjs';

// Compatible endpoints may serve arbitrary/local models. Their model IDs are
// not interchangeable with the official services' IDs.
export function titleProvider(provider) {
  const result = { ...provider, maxRetries: 0 };
  delete result.reasoningEffort;
  if (provider.type === 'openai-codex') {
    result.defaultModel = 'gpt-5.6-luna';
    result.reasoningEffort = 'low';
  } else if (provider.type === 'openai') {
    result.defaultModel = 'gpt-5.4-nano';
    result.reasoningEffort = 'low';
  } else if (provider.type === 'anthropic') {
    result.defaultModel = 'claude-haiku-4-5';
  }
  if (provider.type.startsWith('anthropic')) result.maxTokens = 256;
  return result;
}

export async function suggestProcwayTitle({ transcript, connection, cwd }) {
  // null bypasses the conversation's saved context/output budgets.
  const resolved = await resolveConnection(connection, cwd, null);
  const src = await procwaySource();
  const env = { ...process.env, PROCWAY_TELEMETRY_QUIET: '1' };
  if (process.env.AGENT_HOST_PROCWAY_HOME) {
    env.HOME = process.env.AGENT_HOST_PROCWAY_HOME;
    env.USERPROFILE = process.env.AGENT_HOST_PROCWAY_HOME;
  }
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./procway-title-worker.mjs', import.meta.url)), [], {
      cwd, env, execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    let settled = false;
    const finish = (error, title) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(new Error(error)); else resolve(title);
    };
    const timer = setTimeout(() => finish('procway のタイトル生成が時間内に完了しませんでした'), 90_000);
    child.once('error', () => finish('procway のタイトル生成を起動できません'));
    child.once('exit', () => finish('procway のタイトル生成が終了しました。接続先とモデルを確認してください'));
    child.once('message', message => {
      if (typeof message?.title === 'string' && message.title.trim()) finish(null, message.title);
      else finish(`procway でタイトルを生成できませんでした${message?.status ? `（HTTP ${message.status}）` : ''}。接続先とモデルを確認してください`);
    });
    child.send({ src, id: resolved.id, provider: titleProvider(resolved.provider), env: resolved.env, transcript },
      error => { if (error) finish('procway のタイトル生成に入力を渡せません'); });
  });
}
