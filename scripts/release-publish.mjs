import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
const [mode, directory] = process.argv.slice(2);
const tag = process.env.RELEASE_TAG, repo = process.env.GH_REPO;
if (!/^v\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(tag || '') || !/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !process.env.GH_TOKEN) throw new Error('Release tag, repository and token required');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const files = (await fs.readdir(directory)).filter(n => /\.(exe|dmg|zip|blockmap|yml|txt)$/.test(n) || ['RELEASE-PLATFORMS.json', 'Pleiad-Evaluation.cer', 'evaluation-certificate.ps1', 'SIGNING-INFO.json', 'BUILD-INFO.json'].includes(n)).map(n => path.join(directory, n));
if (mode === 'draft') {
  let exists = false;
  try { gh(['release', 'view', tag, '--repo', repo]); exists = true; } catch (e) { if (!String(e.stderr).includes('release not found')) throw e; }
  if (exists) throw new Error('Release already exists; never overwrite published versions');
  gh(['release', 'create', tag, ...files, '--repo', repo, '--verify-tag', '--draft', '--title', `Pleiad ${tag.slice(1)}`, '--notes-file', 'temporary/release-notes.md', ...(tag.includes('-beta.') ? ['--prerelease'] : [])]);
} else if (mode === 'publish' || mode === 'rollout') {
  const release = JSON.parse(gh(['release', 'view', tag, '--repo', repo, '--json', 'isDraft,isPrerelease']));
  if (mode === 'publish' && !release.isDraft) throw new Error('Already published');
  if (mode === 'rollout' && release.isDraft) throw new Error('Publish the draft first');
  // Only channel metadata changes after publication. Binary assets are immutable.
  gh(['release', 'upload', tag, ...files.filter(n => /\.(yml|txt)$/.test(n) || path.basename(n) === 'RELEASE-PLATFORMS.json'), '--repo', repo, '--clobber']);
  if (mode === 'publish') gh(['release', 'edit', tag, '--repo', repo, '--draft=false', `--latest=${release.isPrerelease ? 'false' : 'true'}`]);
} else throw new Error('Unknown release operation');
