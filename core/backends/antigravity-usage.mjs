import { cliCommand, spawnCli } from '../cli-installation.mjs';
import { number, usageWindow } from '../usage.mjs';

// Read-only print commands landed in 1.1.11. Older CLIs send /usage to the
// model as a prompt, so check the version before ever submitting the command.
export function supportsUsage(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 1 || (major === 1 && (minor > 1 || (minor === 1 && patch >= 11)));
}

export function antigravityQuota(result) {
  if (result?.status !== 'SUCCESS' || result.num_turns !== 0 || result.command?.name !== 'usage'
    || !Array.isArray(result.command.data?.groups)) throw new Error('使用枠の応答形式が不正です');
  const windows = result.command.data.groups.flatMap(group => (Array.isArray(group?.buckets) ? group.buckets : []).map(bucket => {
    const fraction = number(bucket?.remaining_fraction);
    const used = fraction != null && fraction <= 1 ? (1 - fraction) * 100 : null;
    const minutes = bucket?.window === '5h' ? 300 : bucket?.window === 'weekly' ? 10080 : null;
    const period = minutes === 300 ? '5時間' : minutes === 10080 ? '週次（7日間）' : bucket?.name || '期間不明';
    return usageWindow(`${group.name || 'モデル'} · ${period}`, used, bucket?.reset_time, minutes);
  }));
  return { windows, message: windows.length
    ? '同じモデルグループ内で使用枠を共有します。5時間と週次の両方の制限が適用されます。'
    : 'Antigravity の使用枠が返されませんでした。ログイン状態と契約を確認してください。' };
}

// Never expose stderr: authentication errors can contain credentials/URLs.
// Bound both the lifetime and output, and only terminate our own child.
function capture(argv, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const proc = spawnCli(argv, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { proc.kill(); reject(error); } else resolve(output.trim());
    };
    const timer = setTimeout(() => finish(new Error('使用枠の取得が時間切れです')), timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return finish(new Error('使用枠の応答が大きすぎます'));
      output += chunk;
    });
    proc.stderr.on('data', () => {});
    proc.on('error', () => finish(new Error('Antigravity を起動できません')));
    proc.on('close', code => finish(code === 0 ? null : new Error('Antigravity の使用枠を取得できません')));
  });
}

export async function readAntigravityUsage({ argv = cliCommand('antigravity'), timeoutMs = 25_000 } = {}) {
  const version = await capture(argv, ['--version'], timeoutMs);
  if (!supportsUsage(version)) return { windows: [], message: '使用枠の表示には Antigravity CLI 1.1.11 以降が必要です。端末で agy update を実行してください。' };
  const output = await capture(argv, ['--print', '/usage', '--output-format', 'json', '--print-timeout', '20s'], timeoutMs);
  return antigravityQuota(JSON.parse(output));
}
