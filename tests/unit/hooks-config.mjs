import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { createHooksConfig, renderToml } from '../../core/hooks-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';
export const name = 'hooks-config';
export const title = 'Hooks の探索（3 エージェント × スコープ・壊れたファイル・伏せ字）と元ファイルへの書き込み（JSON / TOML・競合・enabled）';
export default async function(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-hooks-config-'));
  const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), cwd = path.join(repo, 'pkg');
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2)); };
  const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  try {
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(cwd, { recursive: true });
    const svc = createHooksConfig({ home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude'), geminiHome: path.join(home, '.gemini') });

    // ---- 何も無い: 0 件で、ファイルは missing
    const empty = await svc.scan({ cwd });
    t.ok('何も無ければ 0 件・ファイルは missing（エラーではない）', empty.entries.length === 0 && empty.files.every(f => f.status === 'missing'));

    // ---- 3 エージェント × スコープ
    await write(path.join(home, '.claude', 'settings.json'), { model: 'keep', permissions: { allow: ['Bash'] }, hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node audit.cjs --token SECRET-TOKEN-123456', timeout: 10, statusMessage: 'keep-me' }, { type: 'http', url: 'https://example.com/hook?key=SECRET-Q', headers: { Authorization: 'Bearer SECRET-H' } }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'node stop.cjs', async: true, env: { API_KEY: 'SECRET-ENV' } }] }],
    } });
    await write(path.join(repo, '.claude', 'settings.local.json'), { hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo local' }] }] } });
    await write(path.join(home, '.codex', 'config.toml'), '# user comment\nmodel = "gpt"\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "python guard.py"\ntimeout = 30\ncommand_windows = "py guard.py"\n\n[projects."x"]\ntrust_level = "trusted"\n');
    await write(path.join(cwd, '.codex', 'hooks.json'), { description: 'keep', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo codex-project' }] }] } });
    await write(path.join(home, '.gemini', 'config', 'hooks.json'), { audit: { enabled: false, PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node a.cjs', timeout: 5 }] }], Stop: [{ command: 'node s.cjs', custom: 1 }] } });
    await write(path.join(repo, '.agents', 'hooks.json'), 'SECRET-BROKEN {');
    await write(path.join(home, '.claude', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\nhooks:\n  PostToolUse:\n    - matcher: Edit\n      hooks:\n        - type: command\n          command: echo skill\n---\nbody\n');

    const all = await svc.scan({ cwd });
    const by = (agent, scope) => all.entries.filter(e => e.agent === agent && e.scope === scope);
    t.ok('Claude のユーザー: 2 イベント・3 handler', by('claude', 'user').length === 3, JSON.stringify(by('claude', 'user').map(e => e.event)));
    t.ok('Claude のプロジェクトローカル（Git のルートの .claude/settings.local.json）', by('claude', 'local').length === 1 && by('claude', 'local')[0].matcher === 'startup');
    t.ok('Codex のユーザー（config.toml の [[hooks.X]]）', by('codex', 'user').length === 1 && by('codex', 'user')[0].format === 'toml' && by('codex', 'user')[0].matcher === 'Bash');
    t.ok('Codex のプロジェクト（作業場所の .codex/hooks.json）', by('codex', 'project').length === 1 && by('codex', 'project')[0].event === 'Stop');
    const agy = by('antigravity', 'user');
    t.ok('Antigravity: 名前 → イベント。非ツールのイベントは handler を直接並べる', agy.length === 2 && agy.every(e => e.name === 'audit' && e.enabled === false) && agy.find(e => e.event === 'Stop').group === -1);
    t.ok('Skill の frontmatter の hooks は読み取りのみの行', all.entries.some(e => e.scope === 'skill' && e.readOnly && !e.editable && e.skill === 'demo'));
    const http = all.entries.find(e => e.type === 'http');
    t.ok('command 以外の型は編集不可として行にする', http && !http.editable);
    const shown = JSON.stringify(all);
    t.ok('秘密（env・headers・トークンらしい値・クエリ）は伏せる', !shown.includes('SECRET-TOKEN') && !shown.includes('SECRET-ENV') && !shown.includes('SECRET-H') && !shown.includes('SECRET-Q') && !shown.includes('SECRET-BROKEN'));
    t.ok('知らないキーの名前は行に残る', all.entries.find(e => e.command.startsWith('node audit')).unknownKeys.includes('statusMessage'));
    const broken = all.files.find(f => f.agent === 'antigravity' && f.scope === 'project');
    t.ok('壊れた JSON は error（登録 0 件の none とは別）', broken.status === 'error' && broken.error);
    const none = { home: path.join(home, '.gemini', 'antigravity-cli', 'settings.json') };
    await write(none.home, { theme: 'dark' });
    const again = await svc.scan({ cwd, scopes: ['user'] });
    t.ok('ファイルはあるが hooks が無ければ none', again.files.find(f => f.path === none.home).status === 'none');
    t.ok('scopes: [user] は作業場所を探さない', again.entries.every(e => e.scope === 'user' || (e.scope === 'skill' && e.skillScope === 'user')));

    // ---- 書き込み: Claude（JSON。他のキーを残す）
    const claudeFile = path.join(home, '.claude', 'settings.json');
    const add = { op: 'add', agent: 'claude', scope: 'user', event: 'PostToolUse', matcher: 'Edit|Write', command: 'node changes.cjs', timeout: 20 };
    const dry = await svc.save({ items: [add], dryRun: true });
    t.ok('dryRun は書かずに書き先と前後の差分を返す', dry.results[0].ok && dry.results[0].path === claudeFile && dry.results[0].after.PostToolUse && !(await readJson(claudeFile)).hooks.PostToolUse);
    await svc.save({ items: [{ ...add, revision: dry.results[0].revision }] });
    let cj = await readJson(claudeFile);
    t.ok('Claude に追加し、他のキー（model・permissions・他の hooks・知らないキー）を残す', cj.model === 'keep' && cj.permissions.allow[0] === 'Bash'
      && cj.hooks.PostToolUse[0].matcher === 'Edit|Write' && cj.hooks.PostToolUse[0].hooks[0].timeout === 20 && cj.hooks.PreToolUse[0].hooks[0].statusMessage === 'keep-me'
      && cj.hooks.PreToolUse[0].hooks[0].command.includes('SECRET-TOKEN-123456') && cj.hooks.Stop[0].hooks[0].env.API_KEY === 'SECRET-ENV');
    const stale = dry.results[0].revision;
    const r1 = await svc.save({ items: [{ ...add, revision: stale }] });
    t.ok('古い revision の追加は拒否（競合）', !r1.results[0].ok);
    // 編集: 元の値は read だけが返す。知らないキーは残す
    let scan = await svc.scan({ scopes: ['user'] });
    const audit = scan.entries.find(e => e.agent === 'claude' && e.command.startsWith('node audit'));
    const opened = await svc.read({ agent: 'claude', scope: 'user', file: audit.path, loc: { event: audit.event, group: audit.group, handler: audit.handler } });
    t.ok('read は開いた handler の元の値を返す', opened.handler.command.includes('SECRET-TOKEN-123456'));
    await svc.save({ items: [{ op: 'edit', agent: 'claude', scope: 'user', file: audit.path, revision: opened.revision, loc: { event: 'PreToolUse', group: 0, handler: 0 }, event: 'PreToolUse', matcher: '*', command: 'node audit2.cjs', timeout: 15 }] });
    cj = await readJson(claudeFile);
    t.ok('編集は command・timeout だけ変え、同じ group の他の handler と知らないキーを残す', cj.hooks.PreToolUse[0].hooks[0].command === 'node audit2.cjs' && cj.hooks.PreToolUse[0].hooks[0].statusMessage === 'keep-me' && cj.hooks.PreToolUse[0].hooks[1].type === 'http');
    scan = await svc.scan({ scopes: ['user'] });
    let rev = scan.files.find(f => f.path === claudeFile).revision;
    await svc.save({ items: [{ op: 'edit', agent: 'claude', scope: 'user', file: claudeFile, revision: rev, loc: { event: 'PreToolUse', group: 0, handler: 0 }, event: 'PreToolUse', matcher: 'Bash', command: 'node audit2.cjs' }] });
    cj = await readJson(claudeFile);
    t.ok('handler を共有する group の matcher を変えると、新しい group に移す（http の定義は元の group に残る）', cj.hooks.PreToolUse.length === 2 && cj.hooks.PreToolUse[0].hooks.length === 1 && cj.hooks.PreToolUse[0].hooks[0].type === 'http' && cj.hooks.PreToolUse[1].matcher === 'Bash');
    rev = (await svc.scan({ scopes: ['user'] })).files.find(f => f.path === claudeFile).revision;
    const ro = await svc.save({ items: [{ op: 'delete', agent: 'claude', scope: 'user', file: claudeFile, revision: rev, loc: { event: 'PreToolUse', group: 0, handler: 0 } }] });
    t.ok('command 以外（http）は削除も拒否', !ro.results[0].ok);
    await svc.save({ items: [{ op: 'delete', agent: 'claude', scope: 'user', file: claudeFile, revision: rev, loc: { event: 'PostToolUse', group: 0, handler: 0 } }] });
    cj = await readJson(claudeFile);
    t.ok('削除で空になったイベントはキーごと消す', !cj.hooks.PostToolUse && cj.hooks.Stop);
    const bad = await svc.save({ items: [{ op: 'add', agent: 'antigravity', scope: 'user', name: 'x', event: 'SessionStart', command: 'echo' }] });
    t.ok('非対応のイベントは保存しない', !bad.results[0].ok);
    const outside = await svc.save({ items: [{ op: 'edit', agent: 'claude', scope: 'user', file: path.join(tmp, 'other.json'), revision: 'missing', loc: { event: 'Stop', group: 0, handler: 0 } }] });
    t.ok('置き場所以外のファイルには書かない', !outside.results[0].ok);

    // ---- Codex（TOML を局所的に置き換える。既存が TOML なら JSON を足さない）
    const tomlFile = path.join(home, '.codex', 'config.toml');
    const targets = await svc.targets({ scope: 'user' });
    t.ok('Codex の既存の定義が TOML にあれば、追加の書き先も TOML', targets.codex.path === tomlFile);
    await svc.save({ items: [{ op: 'add', agent: 'codex', scope: 'user', event: 'Stop', command: 'echo done' }] });
    const tomlText = await fs.readFile(tomlFile, 'utf8'), toml = parse(tomlText);
    t.ok('TOML: コメント・他の表・知らないキー（command_windows）を残して追加', tomlText.includes('# user comment') && toml.projects.x.trust_level === 'trusted'
      && toml.hooks.PreToolUse[0].hooks[0].command_windows === 'py guard.py' && toml.hooks.Stop[0].hooks[0].command === 'echo done' && toml.model === 'gpt');
    t.ok('hooks.json は作らない（二重に登録しない）', !(await fs.stat(path.join(home, '.codex', 'hooks.json')).then(() => true, () => false)));
    const inline = renderToml('hooks = { Stop = [{ hooks = [{ type = "command", command = "a" }] }] }\n', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'b' }] }] } });
    t.ok('インラインの TOML は書き直しが要ると返す', inline.reformatsFile);
    // 同時に同じ revision で保存すると一方だけ通る
    const trev = (await svc.scan({ scopes: ['user'] })).files.find(f => f.path === tomlFile).revision;
    const both = await Promise.all(['one', 'two'].map(c => svc.save({ items: [{ op: 'add', agent: 'codex', scope: 'user', revision: trev, event: 'SessionEnd', command: c }] })));
    t.ok('同じ revision への同時保存は一方だけ成功', both.filter(r => r.results[0].ok).length === 1);

    // ---- Antigravity（名前単位の enabled、async は不可）
    const agyFile = path.join(home, '.gemini', 'config', 'hooks.json');
    const arev = (await svc.scan({ scopes: ['user'] })).files.find(f => f.path === agyFile).revision;
    await svc.save({ items: [{ op: 'enable', agent: 'antigravity', scope: 'user', file: agyFile, revision: arev, loc: { name: 'audit' }, enabled: true }] });
    const aj = await readJson(agyFile);
    t.ok('agy の enabled を名前に書き、定義と知らないキーを残す', aj.audit.enabled === true && aj.audit.Stop[0].custom === 1 && aj.audit.PreToolUse[0].hooks[0].timeout === 5);
    const asy = await svc.save({ items: [{ op: 'add', agent: 'antigravity', scope: 'user', name: 'n', event: 'Stop', command: 'x', async: true }] });
    t.ok('agy に async は書かない', !asy.results[0].ok);
    await svc.save({ items: [{ op: 'add', agent: 'antigravity', scope: 'user', name: 'lint', event: 'PostToolUse', matcher: '', command: 'lint' }, { op: 'add', agent: 'antigravity', scope: 'user', name: 'lint', event: 'Stop', command: 'bye' }] });
    const aj2 = await readJson(agyFile);
    t.ok('agy の追加: ツールのイベントは matcher group（空は *）、Stop は handler を直接', aj2.lint.PostToolUse[0].matcher === '*' && aj2.lint.Stop[0].command === 'bye' && !aj2.lint.Stop[0].hooks);
    // 壊れたファイルには書かない
    const brokenSave = await svc.save({ items: [{ op: 'add', agent: 'antigravity', scope: 'project', base: repo, name: 'x', event: 'Stop', command: 'x' }] });
    t.ok('壊れたファイルは上書きしない', !brokenSave.results[0].ok && await fs.readFile(path.join(repo, '.agents', 'hooks.json'), 'utf8') === 'SECRET-BROKEN {' && !brokenSave.results[0].error.includes('SECRET'));
    // 部分成功: 書けた先は ok のまま、失敗した先だけ理由を返す
    const mixed = await svc.save({ items: [{ op: 'add', agent: 'claude', scope: 'project', base: repo, event: 'Stop', command: 'echo p' }, { op: 'add', agent: 'antigravity', scope: 'project', base: repo, name: 'x', event: 'Stop', command: 'x' }] });
    t.ok('複数の書き先は 1 件ずつ。書けた先と失敗した先を分けて返す', mixed.results[0].ok && !mixed.results[1].ok && (await readJson(path.join(repo, '.claude', 'settings.json'))).hooks.Stop[0].hooks[0].command === 'echo p');
  } finally {
    if (!containsPath(os.tmpdir(), tmp) || !path.basename(tmp).startsWith('ply-hooks-config-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true });
  }
}
