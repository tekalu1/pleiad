import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse, stringify } from 'yaml';
import { fileURLToPath } from 'node:url';

export async function prepareArtifacts(directory, version, percentage, notes, platforms) {
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) throw new Error('Rollout must be 0–100');
  if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error('Invalid version');
  const names = await fs.readdir(directory);
  let manifest;
  if (names.includes('RELEASE-PLATFORMS.json')) {
    manifest = JSON.parse(await fs.readFile(path.join(directory, 'RELEASE-PLATFORMS.json'), 'utf8'));
    if (manifest.version !== version || !['windows', 'all'].includes(manifest.platforms)) throw new Error('Invalid release platform manifest');
    if (platforms && platforms !== manifest.platforms) throw new Error('Release platforms cannot change after packaging');
  }
  platforms ||= manifest?.platforms || 'all';
  if (!['windows', 'all'].includes(platforms)) throw new Error('Release platforms must be windows or all');
  if (platforms === 'windows' && names.some(n => /\.(dmg|zip)$/.test(n) || n === 'latest-mac.yml')) throw new Error('Unexpected macOS assets in Windows release');
  // PrivateGitHubProvider always requests latest*.yml; the release's prerelease
  // flag separates beta from stable, including during staged rollout changes.
  const metadata = platforms === 'windows' ? ['latest.yml'] : ['latest.yml', 'latest-mac.yml'];
  const changes = [];
  for (const name of metadata) {
    const data = parse(await fs.readFile(path.join(directory, name), 'utf8'));
    if (data.version !== version || !data.files?.length) throw new Error(`Invalid metadata: ${name}`);
    for (const file of data.files) {
      if (path.basename(file.url) !== file.url || !names.includes(file.url)) throw new Error(`Missing or unsafe asset: ${file.url}`);
      const bytes = await fs.readFile(path.join(directory, file.url));
      if (crypto.createHash('sha512').update(bytes).digest('base64') !== file.sha512) throw new Error(`Checksum mismatch: ${file.url}`);
    }
    // Metadata must carry both CPU architectures; never publish a partial matrix.
    if (name.endsWith('-mac.yml')) {
      for (const arch of ['x64', 'arm64']) if (!data.files.some(f => f.url.includes(arch) && f.url.endsWith('.zip'))) throw new Error(`Missing macOS ${arch} ZIP`);
    }
    changes.push([name, { ...data, stagingPercentage: percentage, ...(notes ? { releaseNotes: notes } : {}) }]);
  }
  // NSIS builds one installer containing both architectures when built together.
  if (!names.some(n => n.endsWith('.exe')) || (platforms === 'all' && !names.some(n => n.endsWith('.dmg')))) throw new Error('Missing installer for a selected platform');
  for (const [name, data] of changes) await fs.writeFile(path.join(directory, name), stringify(data));
  await fs.writeFile(path.join(directory, 'RELEASE-PLATFORMS.json'), JSON.stringify({ version, platforms }, null, 2) + '\n');
  if (!names.includes('RELEASE-PLATFORMS.json')) names.push('RELEASE-PLATFORMS.json');
  const checksums = [];
  for (const name of names.filter(n => /\.(exe|dmg|zip|blockmap|yml)$/.test(n) || ['RELEASE-PLATFORMS.json', 'Pleiad-Evaluation.cer', 'evaluation-certificate.ps1', 'SIGNING-INFO.json', 'BUILD-INFO.json'].includes(n)).sort()) {
    checksums.push(`${crypto.createHash('sha256').update(await fs.readFile(path.join(directory, name))).digest('hex')}  ${name}`);
  }
  await fs.writeFile(path.join(directory, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, version, percentage, notesFile, platforms] = process.argv.slice(2);
  await prepareArtifacts(directory, version, Number(percentage), notesFile ? await fs.readFile(notesFile, 'utf8') : null, platforms);
}
