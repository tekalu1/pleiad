import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { savedPort, rememberPort } = createRequire(import.meta.url)('../../desktop/server-port.cjs');

export const name = 'desktop-port';
export const title = '起動し直しても同じポート（origin）で開き、画面の保存内容を失わない';

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-port-test-'));
  const file = path.join(dir, 'server-port.json');
  try {
    t.ok('初回は空きポートに任せる', savedPort(file) === 0);
    rememberPort(file, 51234);
    t.ok('次の起動は前回のポートを使う', savedPort(file) === 51234);
    rememberPort(file, 51999);
    t.ok('塞がって逃げた先を覚え直す', savedPort(file) === 51999);
    await fs.writeFile(file, 'broken');
    t.ok('壊れた記録で起動を妨げない', savedPort(file) === 0);
    await fs.writeFile(file, JSON.stringify({ port: 80 }));
    t.ok('特権ポートは使わない', savedPort(file) === 0);
    rememberPort(path.join(dir, 'missing', 'x.json'), 51234);
    t.ok('保存できなくても落ちない', true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
