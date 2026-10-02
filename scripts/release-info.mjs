import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// semver の順。文字列の比較だと 0.1.0-beta.74 が 0.1.0 より新しくなるので、先行版は同じ番号の正式な版より前に置く
export function compareVersions(a, b) {
  const [coreA, preA] = a.split('-'), [coreB, preB] = b.split('-');
  const core = coreA.localeCompare(coreB, undefined, { numeric: true });
  if (core || preA === preB) return core;
  if (!preA) return 1;
  if (!preB) return -1;
  return preA.localeCompare(preB, undefined, { numeric: true });
}
export async function generateReleaseInfo({ requireNewNotes = false } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await fs.readdir(path.join(root, 'releases'))).filter(f => f.endsWith('.json'));
  const releases = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.join(root, 'releases', file), 'utf8'))));
  const current = releases.find(r => r.version === pkg.version);
  if (!current || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(pkg.version)) throw new Error('Version and release notes must match');
  for (const r of releases) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !r.title || !r.sections?.length || !r.sections.every(s => s.title && s.items?.every(i => typeof i === 'string'))) throw new Error('Invalid release notes');
  }
  releases.sort((a, b) => compareVersions(b.version, a.version));
  // 版だけ上げてノートを写したまま出さない。直前の版と見出し・項目が同じなら止める（タグ付けの検証で使う）
  if (requireNewNotes) {
    const previous = releases[releases.indexOf(current) + 1];
    const notesOf = r => JSON.stringify([r.title, r.sections]);
    if (previous && notesOf(previous) === notesOf(current)) throw new Error(`Release notes for ${current.version} are unchanged from ${previous.version}`);
  }
  await fs.writeFile(path.join(root, 'web/release-info.json'), JSON.stringify({ version: pkg.version, releases }, null, 2) + '\n');
  const body = `# Pleiad ${current.version}\n\n${current.date} · ${current.title}\n\n` + current.sections.map(s => `## ${s.title}\n\n${s.items.map(i => `- ${i}`).join('\n')}`).join('\n\n') + '\n';
  await fs.mkdir(path.join(root, 'temporary'), { recursive: true });
  await fs.writeFile(path.join(root, 'temporary/release-notes.md'), body);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateReleaseInfo({ requireNewNotes: process.argv.includes('--require-new-notes') });
