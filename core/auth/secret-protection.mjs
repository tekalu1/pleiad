import { spawn } from 'node:child_process';

// DPAPI CurrentUser: secrets never enter arguments, shell interpolation or logs.
export function protectSecret(value, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('この環境では API キーを環境変数で指定してください');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const code = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${operation}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.resume();
    // PowerShell の起動と Add-Type は、混んだ PC や CI では 15 秒を超えることがある
    const timer = setTimeout(() => { child.kill(); reject(new Error('資格情報の保護が時間切れになりました')); }, 60000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('資格情報の保護を開始できませんでした')); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('資格情報を復号・保護できませんでした。同じ Windows ユーザーで再設定してください'));
      resolve(decrypt ? Buffer.from(output.trim(), 'base64').toString('utf8') : output.trim());
    });
    child.stdin.on('error', () => {});
    child.stdin.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'));
  });
}
