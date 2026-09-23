import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function generateReleaseInfo({ requireNewNotes = false } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const files = (await fs.readdir(path.join(root, 'releases'))).filter(f => f.endsWith('.json'));
  const releases = await Promise.all(files.map(async file => JSON.parse(await fs.readFile(path.join(root, 'releases', file), 'utf8'))));
  const current = releases.find(r => r.version === pkg.version);
  if (!current || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(pkg.version)) throw new Error('Version and release notes must match');
  for (const r of releases) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !r.title || !r.sections?.length || !r.sections.every(s => s.title && s.items?.every(i => typeof i === 'string'))) throw new Error('Invalid release notes');
  }
  releases.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
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
