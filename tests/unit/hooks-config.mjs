import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { createHooksConfig, renderToml, applyCodexHooks, maskDefinition, trimHookRuns } from '../../core/hooks-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';
export const name = 'hooks-config';
export const title = 'Hooks の探索（3 エージェント × スコープ・壊れたファイル・伏せ字）と元ファイルへの書き込み（JSON / TOML・競合・enabled）';
export default async function(t) {
  const tempRoot = await fs.realpath(os.tmpdir());
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

    // ---- agy の enabled: false は同じ名前の定義をスコープをまたいで止める
    await write(path.join(cwd, '.agents', 'hooks.json'), { audit: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node w.cjs' }] }] } });
    const same = (await svc.scan({ cwd })).entries.find(e => e.agent === 'antigravity' && e.scope === 'project');
    t.ok('ユーザー側の enabled: false は作業場所の同じ名前の定義も止めると示す', same?.enabled === true && same.stoppedBySameName === true);
    await fs.rm(path.join(cwd, '.agents'), { recursive: true });

    // ---- Codex の hooks/list（信頼状態）を行に重ねる
    const codexUser = all.entries.find(e => e.agent === 'codex' && e.scope === 'user');
    const codexProject = all.entries.find(e => e.agent === 'codex' && e.scope === 'project');
    const listed = [{ cwd, hooks: [
      { key: `${codexUser.path}:pre_tool_use:0:0`, eventName: 'preToolUse', sourcePath: codexUser.path, source: 'user', enabled: true, trustStatus: 'trusted', currentHash: 'sha256:aa' },
      { key: `${codexProject.path}:stop:0:0`, eventName: 'stop', sourcePath: codexProject.path, source: 'project', enabled: false, trustStatus: 'modified', currentHash: 'sha256:bb' },
      { key: 'P:/plug/hooks.json:session_start:0:0', eventName: 'sessionStart', sourcePath: 'P:/plug/hooks.json', source: 'plugin', pluginId: 'plug', handlerType: 'command', command: 'run --token SECRET-PLUG', enabled: true, trustStatus: 'trusted' },
    ], errors: [], warnings: [] }];
    const merged = applyCodexHooks(structuredClone(all), listed);
    const mu = merged.entries.find(e => e.id === codexUser.id), mp = merged.entries.find(e => e.id === codexProject.id);
    t.ok('hooks/list の trustStatus・enabled・hash を key（パス・イベント・番号）で行に付ける', mu.trust?.status === 'trusted' && mu.trust.hash === 'sha256:aa' && mp.trust?.status === 'modified' && mp.trust.enabled === false);
    const plug = merged.entries.find(e => e.agent === 'codex' && e.scope === 'plugin');
    t.ok('プラグインの hooks は読み取りのみの行として足し、コマンドは伏せる', plug?.readOnly && !plug.editable && plug.event === 'SessionStart' && !JSON.stringify(plug).includes('SECRET-PLUG'));
    const failed = applyCodexHooks(structuredClone(all), null, 'timeout');
    t.ok('取れないときは trust: null（取得できません）', failed.entries.filter(e => e.agent === 'codex').every(e => e.trust === null));

    // ---- 書き込み: Claude（JSON。他のキーを残す）
    const claudeFile = path.join(home, '.claude', 'settings.json');
    const add = { op: 'add', agent: 'claude', scope: 'user', event: 'PostToolUse', matcher: 'Edit|Write', command: 'node changes.cjs', timeout: 20 };
    const dry = await svc.save({ items: [add], dryRun: true });
    t.ok('dryRun は書かずに書き先と前後の差分を返す', dry.results[0].ok && dry.results[0].path === claudeFile && dry.results[0].after.includes('"PostToolUse"') && !dry.results[0].before.includes('"PostToolUse"') && !(await readJson(claudeFile)).hooks.PostToolUse);
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
    t.ok('read は開いた handler の元の値を返す', opened.command.includes('SECRET-TOKEN-123456'));
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

    // ==== レビュー対応（2026-09-27）
    // ---- 予約のキー（__proto__ など）で prototype を触らない
    const polluted = await svc.save({ dryRun: true, items: [
      { op: 'enable', agent: 'antigravity', scope: 'user', file: agyFile, revision: 'missing', loc: { name: '__proto__' }, enabled: false },
      { op: 'delete', agent: 'claude', scope: 'user', file: claudeFile, revision: 'x', loc: { event: '__proto__', group: 0, handler: 0 } },
      { op: 'add', agent: 'antigravity', scope: 'user', name: 'constructor', event: 'Stop', command: 'x' },
    ] });
    t.ok('__proto__ などの名前・イベントは断り、Object.prototype を変えない', polluted.results.every(r => !r.ok) && ({}).enabled === undefined && !Object.hasOwn(Object.prototype, 'enabled'));

    // ---- Codex の TOML: 足すときは既存の表に触らない。書き直すときは消えるコメントを数えて許可を求める
    const tomlRepo = path.join(tmp, 'toml-repo');
    const tomlPath = path.join(tomlRepo, '.codex', 'config.toml');
    const tomlSource = ['# top comment', 'model = "gpt"', '', '[[hooks.PreToolUse]]', 'matcher = "Bash"', '[[hooks.PreToolUse.hooks]]', 'type = "command"',
      'command = "python guard.py" # inline note', '', '# [[hooks.Stop]]  <- disabled for now', '# command = "old"', '', '# ==== my projects (keep this) ====',
      '[projects."D:/dev/x"]', 'trust_level = "trusted"', '', '[mcp_servers.gh]', 'command = "npx"', '[mcp_servers.gh.env]', 'GITHUB_TOKEN = "ghp_SECRETSECRETSECRET1"', ''].join('\r\n');
    await write(tomlPath, tomlSource);
    const tomlAdd = { op: 'add', agent: 'codex', scope: 'project', base: tomlRepo, event: 'Stop', command: 'echo stop' };
    const tomlDry = (await svc.save({ items: [tomlAdd], dryRun: true })).results[0];
    t.ok('dryRun の前後は実際に書く本文（TOML のまま・伏せ字済み）', tomlDry.format === 'toml' && tomlDry.after.includes('[[hooks.Stop]]') && tomlDry.before.includes('# ==== my projects (keep this) ====')
      && !tomlDry.after.includes('"matcher":') && !tomlDry.before.includes('ghp_SECRET') && !tomlDry.after.includes('ghp_SECRET'), tomlDry.error);
    await svc.save({ items: [{ ...tomlAdd, revision: tomlDry.revision }] });
    let rtText = await fs.readFile(tomlPath, 'utf8');
    t.ok('足すときは既存の表・コメント・行末のコメントに触らず末尾に 1 ブロック足す（改行コードも保つ）', rtText.startsWith(tomlSource.trimEnd()) && rtText.includes('[[hooks.Stop]]')
      && !/[^\r]\n/.test(rtText) && parse(rtText).hooks.Stop[0].hooks[0].command === 'echo stop');
    const tomlRev = (await svc.scan({ cwd: tomlRepo })).files.find(f => f.path === tomlPath).revision;
    const tomlEdit = { op: 'edit', agent: 'codex', scope: 'project', base: tomlRepo, file: tomlPath, revision: tomlRev, loc: { event: 'PreToolUse', group: 0, handler: 0 }, event: 'PreToolUse', matcher: 'Bash', command: 'python guard2.py' };
    const editDry = (await svc.save({ items: [tomlEdit], dryRun: true })).results[0];
    t.ok('表の中のコメント（行末）が消える書き直しは、行数を数えて許可を求める', editDry.reformatsFile && editDry.reason === 'comments' && editDry.lostComments === 1);
    const refused = await svc.save({ items: [tomlEdit] });
    t.ok('許可なしには書き直さない', !refused.results[0].ok && await fs.readFile(tomlPath, 'utf8') === rtText);
    await svc.save({ items: [tomlEdit], allowReformat: true });
    rtText = await fs.readFile(tomlPath, 'utf8');
    t.ok('表の後ろのコメント付きの [projects] とコメントで止めた hook は残る', rtText.includes('# ==== my projects (keep this) ====\r\n[projects."D:/dev/x"]')
      && rtText.includes('# [[hooks.Stop]]  <- disabled for now') && rtText.includes('# command = "old"') && parse(rtText).hooks.PreToolUse[0].hooks[0].command === 'python guard2.py');
    const tomlRev2 = (await svc.scan({ cwd: tomlRepo })).files.find(f => f.path === tomlPath).revision;
    const noComment = (await svc.save({ dryRun: true, items: [{ ...tomlEdit, revision: tomlRev2, command: 'python guard3.py' }] })).results[0];
    t.ok('表の中にコメントが無ければ、書き直しの許可は要らない', noComment.ok && !noComment.reformatsFile);

    // ---- JSON: BOM・CRLF・字下げを保つ。値が変わる書き直し（桁の多い数・重複したキー）は許可を求める
    const styled = path.join(tmp, 'styled'), styledFile = path.join(styled, '.claude', 'settings.json');
    await write(styledFile, '\uFEFF{\r\n    "model": "keep",\r\n    "hooks": {}\r\n}\r\n');
    await svc.save({ items: [{ op: 'add', agent: 'claude', scope: 'project', base: styled, event: 'Stop', command: 'echo s' }] });
    const styledText = await fs.readFile(styledFile, 'utf8');
    t.ok('JSON は BOM・CRLF・4 字の字下げを保つ', styledText.startsWith('\uFEFF{\r\n    "model"') && !/[^\r]\n/.test(styledText) && JSON.parse(styledText.slice(1)).hooks.Stop[0].hooks[0].command === 'echo s');
    await write(styledFile, '{"n": 12345678901234567890, "hooks": {}}');
    const lossy = (await svc.save({ dryRun: true, items: [{ op: 'add', agent: 'claude', scope: 'project', base: styled, event: 'Stop', command: 'echo s' }] })).results[0];
    t.ok('読み直して値が変わる JSON は書き直しの許可を求める', lossy.reformatsFile && lossy.reason === 'jsonValues');

    // ---- プロジェクトの置き場所がリンクで作業場所の外を指していたら、読まず書かない
    const linked = path.join(tmp, 'linked'), outsideDir = path.join(tmp, 'outsideDir');
    await fs.mkdir(linked, { recursive: true });
    await write(path.join(outsideDir, 'settings.json'), '{"victim":true}');
    await fs.symlink(outsideDir, path.join(linked, '.claude'), 'junction');
    const linkedAdd = await svc.save({ items: [{ op: 'add', agent: 'claude', scope: 'project', base: linked, event: 'Stop', command: 'echo x' }] });
    const linkedScan = await svc.scan({ cwd: linked, agents: ['claude'] });
    t.ok('リンクの先が作業場所の外なら書かない・一覧はエラーにする', !linkedAdd.results[0].ok && await fs.readFile(path.join(outsideDir, 'settings.json'), 'utf8') === '{"victim":true}'
      && linkedScan.files.find(f => f.path === path.join(linked, '.claude', 'settings.json'))?.status === 'error');
    await fs.rm(path.join(linked, '.claude'));

    // ---- agy の改名で enabled を引き継ぐ。移し先の enabled が違えば断る
    const agyRepo = path.join(tmp, 'agy-repo'), agyPath = path.join(agyRepo, '.agents', 'hooks.json');
    await write(agyPath, { audit: { enabled: false, Stop: [{ command: 'node s.cjs' }] }, live: { Stop: [{ command: 'node l.cjs' }] } });
    const agyRev = () => svc.scan({ cwd: agyRepo, agents: ['antigravity'] }).then(r => r.files.find(f => f.path === agyPath).revision);
    const rename = async (to, revision) => (await svc.save({ items: [{ op: 'edit', agent: 'antigravity', scope: 'project', base: agyRepo, file: agyPath, revision,
      loc: { name: 'audit', event: 'Stop', group: -1, handler: 0 }, name: to, event: 'Stop', command: 'node s.cjs' }] })).results[0];
    const clash = await rename('live', await agyRev());
    t.ok('止めてある名前を、有効な既存の名前へ移すのは断る', !clash.ok);
    await rename('audit2', await agyRev());
    const agyJson = await readJson(agyPath);
    t.ok('改名しても enabled: false を引き継ぐ（止めていた hook を動かさない）', agyJson.audit2?.enabled === false && !agyJson.audit && agyJson.audit2.Stop[0].command === 'node s.cjs');

    // ---- readHook は command・timeout・async とキーの名前だけ。timeout が欄で扱えない値なら元の値を保てる
    const oddRepo = path.join(tmp, 'odd'), oddFile = path.join(oddRepo, '.claude', 'settings.json');
    await write(oddFile, { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo odd', timeout: '30', env: { API_KEY: 'SECRET-READ' } }] }] } });
    const oddScan = await svc.scan({ cwd: oddRepo, agents: ['claude'] });
    const oddRead = await svc.read({ agent: 'claude', scope: 'project', base: oddRepo, file: oddFile, loc: { event: 'Stop', group: 0, handler: 0 } });
    t.ok('readHook は env などの値を返さない（キーの名前だけ）', !JSON.stringify(oddRead).includes('SECRET-READ') && oddRead.keys.includes('env') && oddRead.command === 'echo odd' && oddRead.timeout === '30');
    await svc.save({ items: [{ op: 'edit', agent: 'claude', scope: 'project', base: oddRepo, file: oddFile, revision: oddScan.files.find(f => f.path === oddFile).revision,
      loc: { event: 'Stop', group: 0, handler: 0 }, event: 'Stop', matcher: '', command: 'echo odd2', keepTimeout: true }] });
    const oddJson = await readJson(oddFile);
    t.ok('keepTimeout なら扱えない timeout も元の値のまま残す', oddJson.hooks.Stop[0].hooks[0].timeout === '30' && oddJson.hooks.Stop[0].hooks[0].command === 'echo odd2' && oddJson.hooks.Stop[0].hooks[0].env.API_KEY === 'SECRET-READ');

    // An existing config can be scanned through an alias while base is resolved before editing.
    const realRepo = path.join(tmp, 'alias-real'), aliasRepo = path.join(tmp, 'alias-link');
    await write(path.join(realRepo, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo old' }] }] } });
    await fs.mkdir(path.join(realRepo, '.git'));
    await fs.symlink(realRepo, aliasRepo, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const aliasFile = path.join(aliasRepo, '.claude', 'settings.json');
      const scanned = await svc.scan({ cwd: aliasRepo, scopes: ['directory'], agents: ['claude'] });
      const found = scanned.entries.find(e => e.path === aliasFile && e.event === 'Stop');
      const openedAlias = await svc.read({ agent: 'claude', scope: 'project', base: aliasRepo, file: aliasFile, loc: { event: 'Stop', group: 0, handler: 0 } });
      const savedAlias = await svc.save({ items: [{ op: 'edit', agent: 'claude', scope: 'project', base: aliasRepo, file: aliasFile,
        revision: openedAlias.revision, loc: { event: 'Stop', group: 0, handler: 0 }, event: 'Stop', command: 'echo new' }] });
      t.ok('別名のパスで見つけた hook を開いて編集できる', found && openedAlias.command === 'echo old' && savedAlias.results[0].ok
        && (await readJson(path.join(realRepo, '.claude', 'settings.json'))).hooks.Stop[0].hooks[0].command === 'echo new');
    } finally { await fs.rm(aliasRepo); }

    // ---- 伏せ字: args の秘密のフラグの次・秘密らしい名前のキー（入れ子も）
    const masked = JSON.stringify(maskDefinition({ args: ['--token', 'SECRETARG', '-v'], extra: { apiKey: 'SECRETNESTED', deep: { password: 'hunter2' } } }));
    t.ok('args の --token の次の要素と、秘密らしい名前のキーの値を伏せる', !/SECRETARG|SECRETNESTED|hunter2/.test(masked) && masked.includes('-v'));

    // ---- 発火の記録は新しいほうを残し、開始と応答を組ごとに捨てる
    const runs = [];
    for (let i = 0; i < 40; i++) runs.push({ phase: 'started', hookId: `h${i}` }, { phase: 'response', hookId: `h${i}` });
    trimHookRuns(runs);
    t.ok('発火の記録は上限まで古いほうから組ごとに捨てる', runs.length === 60 && runs[0].hookId === 'h10' && runs[0].phase === 'started' && runs.at(-1).hookId === 'h39');
  } finally {
    if (!containsPath(tempRoot, await fs.realpath(tmp)) || !path.basename(tmp).startsWith('ply-hooks-config-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true });
  }
}
