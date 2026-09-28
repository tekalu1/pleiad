import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectFile, resolveReference } from '../../core/file-preview.mjs';

export const name = 'file-access';
export const title = 'ローカルファイルの許可・UNC とデータ置き場の拒否';

export default async function(t) {
  const originals = { realpath: fs.realpath, stat: fs.stat };
  let touches = 0;
  try {
    fs.realpath = fs.stat = async () => { touches++; throw new Error('unexpected filesystem access'); };
    for (const requested of [String.raw`\\server\share\x.html`, '//server/share/x.html',
      String.raw`\\?\UNC\server\share\x.html`, String.raw`\\?\C:\x.html`, String.raw`\\.\C:\x.html`, '/\\server/share/x.html']) {
      await assert.rejects(inspectFile(requested, {}), { code: 'network-path' });
      assert.throws(() => resolveReference(requested), { code: 'network-path' });
    }
    assert.equal(touches, 0);
    assert.equal(resolveReference(path.resolve('x.html'), String.raw`\\server\share`).path, path.resolve('x.html'));
    if (process.platform === 'win32') assert.throws(() => resolveReference('x.html', String.raw`\\server\share`), { code: 'network-path' });
    fs.realpath = async () => String.raw`\\server\share\x.html`;
    await assert.rejects(inspectFile(path.resolve('x.html'), {}), { code: 'network-path' });
    assert.equal(touches, 0, 'a resolved UNC target must not reach stat');
  } finally { Object.assign(fs, originals); }
  t.ok('UNC・デバイスパスはファイルシステムに触れる前に拒否し、解決後も再検査', true);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-file-access-'));
  const dataDir = path.join(scratch, 'private-data'), uploadDir = path.join(dataDir, 'uploads');
  const access = { dataDir, uploadDir };
  const link = (target, name) => fs.symlink(target, path.join(scratch, name), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(path.join(scratch, 'private-data-sibling'));
    const secret = path.join(dataDir, 'secret.txt'), upload = path.join(uploadDir, 'attachment.txt');
    await fs.writeFile(secret, 'secret'); await fs.writeFile(upload, 'attachment');
    await link(dataDir, 'data-alias'); await link(uploadDir, 'upload-alias');
    for (const file of [dataDir, secret, path.join(scratch, 'data-alias', 'secret.txt')]) {
      await assert.rejects(inspectFile(file, access), { code: 'protected-data' });
    }
    const aliasAccess = { dataDir: path.join(scratch, 'data-alias'), uploadDir };
    await assert.rejects(inspectFile(secret, aliasAccess), { code: 'protected-data' });
    assert.equal((await inspectFile(upload, access)).file, await fs.realpath(upload));
    assert.equal((await inspectFile(path.join(scratch, 'upload-alias', 'attachment.txt'), access)).file, await fs.realpath(upload));
    await fs.symlink(dataDir, path.join(uploadDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(inspectFile(path.join(uploadDir, 'escape', 'secret.txt'), access), { code: 'protected-data' });
    assert((await inspectFile(path.join(scratch, 'private-data-sibling'), access)).stat.isDirectory());
    if (process.platform === 'win32') {
      await assert.rejects(inspectFile(secret.toUpperCase(), access), { code: 'protected-data' });
      await assert.rejects(inspectFile(secret, { ...access, dataDir: dataDir.toUpperCase() }), { code: 'protected-data' });
    }
    await assert.rejects(inspectFile(secret, { dataDir, uploadDir: path.join(dataDir, 'missing') }), { code: 'protected-data' });
    t.ok('データ置き場は別名・大小文字・ジャンクション経由も拒否。uploads は許可し、その外へのリンクは再検査', true);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
