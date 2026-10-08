import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { windowShotFolder, windowShotGuard, copyWindowShot } from '../../core/chrome/window-shots.mjs';
import { inspectFile, PreviewError } from '../../core/file-preview.mjs';
import { readLocalFile } from '../../core/local-files.mjs';

export const name = 'chrome-window-shots';
export const title = '閉じた Chrome の窓の静止画は持ち主の会話を見ている要求にだけ見せる・分岐した会話へ複製する';

export default async function (t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'window-shots-'));
  try {
    const uploadDir = path.join(dataDir, 'uploads');
    const deny = () => new PreviewError('protected-data', 'denied');
    const accessFor = sessionId => ({ dataDir, uploadDir, guard: windowShotGuard({ uploadDir, sessionId, deny }) });
    const folderA = windowShotFolder(dataDir, 'conv-a');
    await fs.mkdir(folderA, { recursive: true });
    const shot = path.join(folderA, '1-x.png');
    await fs.writeFile(shot, 'A-IMAGE');
    await fs.writeFile(path.join(uploadDir, 'attached.png'), 'ATTACH');
    const allowed = async (file, sessionId) => { try { await inspectFile(file, accessFor(sessionId)); return true; } catch (error) { if (error instanceof PreviewError) return false; throw error; } };

    t.ok('持ち主の会話を見ている要求は読める', await allowed(shot, 'conv-a'));
    t.ok('別の会話を見ている要求は断る', !(await allowed(shot, 'conv-b')));
    t.ok('どの会話か名乗らない要求は断る', !(await allowed(shot, null)) && !(await allowed(shot, '')));
    t.ok('置き場そのもの・会話ごとのフォルダー（一覧）も持ち主以外には見せない', !(await allowed(path.join(uploadDir, 'chrome-window'), 'conv-a')) && !(await allowed(folderA, 'conv-b')) && await allowed(folderA, 'conv-a'));
    t.ok('ふつうの添付（uploads の置き場の外）は今までどおり読める', await allowed(path.join(uploadDir, 'attached.png'), null));

    const body = (await readLocalFile(shot, accessFor('conv-a'))).body.toString();
    let refused = false;
    try { await readLocalFile(shot, accessFor('conv-b')); } catch (error) { refused = error instanceof PreviewError; }
    t.ok('/local-file の読み取りも同じ（持ち主は読め、他の会話は断る）', body === 'A-IMAGE' && refused);

    const copied = await copyWindowShot({ dataDir, from: 'conv-a', to: 'conv-c', file: shot });
    t.ok('分岐した会話へ複製した画像は、新しい持ち主だけが読める', copied && path.dirname(copied) === windowShotFolder(dataDir, 'conv-c') && await allowed(copied, 'conv-c') && !(await allowed(copied, 'conv-a')));
    t.ok('元の会話の置き場の外のパス・無いファイルは複製しない', await copyWindowShot({ dataDir, from: 'conv-a', to: 'conv-c', file: path.join(uploadDir, 'attached.png') }) === null
      && await copyWindowShot({ dataDir, from: 'conv-a', to: 'conv-c', file: path.join(folderA, '..', '..', 'attached.png') }) === null
      && await copyWindowShot({ dataDir, from: 'conv-a', to: 'conv-c', file: path.join(folderA, 'missing.png') }) === null);
  } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
}
