import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextSettings, DEFAULT_SCAN, KINDS, containsPath, defaultKind, pathKey } from '../../core/context-settings.mjs';
import { scanContext, skillList } from '../../core/context-scan.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
export const name = 'context-scan';
export const title = '探索範囲・重複・秘密情報・設定の永続化';
export default async function(t) {
  // 探索結果は実体パス（realpath）で返る。TEMP が 8.3 短縮名（RUNNER~1 など）でも比べられるよう、
  // 期待値の側も実体パスにそろえる。rawTmp は渡された表記のまま（保存済みキーの移行を確かめるのに使う）
  const rawTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-test-'));
  const tmp = await fs.realpath(rawTmp);
  const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), child = path.join(repo, 'sub'), extra = path.join(tmp, 'extra');
  let server, client;
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  try {
    await fs.mkdir(child, { recursive: true }); await fs.mkdir(path.join(repo, '.git'));
    await write(path.join(repo, 'AGENTS.md'), 'shared instructions');
    await write(path.join(repo, 'AGENTS.override.md'), 'override instructions');
    await write(path.join(child, 'AGENTS.md'), 'shared instructions');
    await write(path.join(repo, 'CLAUDE.md'), '@./shared.md\n');
    await write(path.join(repo, 'shared.md'), '@./CLAUDE.md\n');
    await write(path.join(repo, '.agents/skills/example/SKILL.md'), '---\nname: example\ndescription: >\n  multiline\n  description\n---\nDo something');
    await fs.mkdir(path.join(repo, '.codex'), { recursive: true });
    await fs.symlink(path.join(repo, '.agents/skills'), path.join(repo, '.codex/skills'), 'junction');
    await write(path.join(home, '.claude/skills/example/SKILL.md'), '---\nname: example\ndescription: personal\ncontext: fork\n---\nPersonal');
    await write(path.join(home, '.codex/config.toml'), '[mcp_servers."with.dot"]\ncommand = "node"\nargs = ["SECRET-ARG"]\n[mcp_servers."with.dot".env]\nTOKEN = "SECRET-TOKEN"\n[mcp_servers.off]\nenabled = false\nurl = "https://user:SECRET-PASSWORD@host/?key=SECRET-QUERY"\n');
    await write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'with.dot': { command: 'node', env: { KEY: 'SECRET-KEY' } } }, projects: { [child]: { mcpServers: { localOnly: { command: 'node' } } } } }));
    await write(path.join(extra, 'AGENTS.md'), 'extra context');
    await write(path.join(child, 'nested/AGENTS.md'), 'not global');
    const settings = createContextSettings(path.join(tmp, 'data'), home);
    // 種類ごとに「この場所だけ変更」する。除外（相対パス）は保存した場所から解決する
    const withDirectory = directory => ({ ...defaultKind(), directory: { sources: DEFAULT_SCAN.sources, excludePaths: [], ...directory } });
    const setAll = (place, value) => Promise.all(KINDS.map(kind => settings.set({ place, kind, value })));
    await settings.set({ place: null, roots: [extra] });
    await setAll(repo, withDirectory({ excludePaths: ['shared.md'] }));
    let effective = await settings.get(child);
    t.ok('親ディレクトリから継承し相対除外を保存元基準で解決', effective.kinds.instruction.from === pathKey(repo) && effective.plan.directory.kinds.instruction.excludePaths[0] === path.join(repo, 'shared.md'));
    let scan = await scanContext(effective, { home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') });
    t.ok('全探索元で指示・Skills・MCP を検出', ['instruction', 'skill', 'mcp'].every(k => scan.entries.some(e => e.kind === k)));
    t.ok('TOML の引用符付きキーを正しく読む', scan.entries.some(e => e.kind === 'mcp' && e.name === 'with.dot'));
    // 画面が表に出すのは command / args / env のキーだけ。値と URL は返さない
    const listed = JSON.stringify(scan.entries);
    t.ok('MCP 登録では env の値と URL を返さない', !['SECRET-TOKEN', 'SECRET-KEY', 'SECRET-PASSWORD', 'SECRET-QUERY'].some(s => listed.includes(s)));
    t.ok('起動の形は command・args・env のキーだけ返す', scan.entries.some(e => e.name === 'with.dot' && e.args?.join() === 'SECRET-ARG' && e.envKeys?.join() === 'TOKEN'));
    // 設定ファイルの行に出すのは MCP 登録の書き出しだけ。元ファイルの他の項目は送らない
    const codex = scan.configs.find(c => c.path === path.join(home, '.codex/config.toml'));
    const claude = scan.configs.find(c => c.path === path.join(home, '.claude.json'));
    t.ok('解析できた MCP 設定ファイルの登録を書き出す', codex?.content.includes('[mcp_servers."with.dot"]') && codex.content.includes('SECRET-ARG'));
    t.ok('書き出しに env の値を残さない', !JSON.stringify(scan.configs).includes('SECRET-TOKEN') && !JSON.stringify(scan.configs).includes('SECRET-KEY')
      && codex.content.includes('TOKEN = "••••"'));
    t.ok('書き出しの URL はクエリを伏せる', codex.content.includes('?••••') && !JSON.stringify(scan.configs).includes('SECRET-QUERY'));
    t.ok('書き出しに MCP 以外のキーを含めない', claude && !claude.content.includes('projects') && Object.keys(JSON.parse(claude.content)).join() === 'mcpServers');
    t.ok('書き出しの大きさは元ファイルではなく本文の長さ', scan.configs.every(c => c.bytes === Buffer.byteLength(c.content)));
    t.ok('ツリーの根になる home と Git ルートを返す', scan.home === home && scan.root === repo, `${scan.home} / ${scan.root}`);
    t.ok('元設定の MCP 無効状態を表示', scan.entries.some(e => e.name === 'off' && e.status === 'disabled'));
    t.ok('AGENTS.override.md の優先を可視化', scan.entries.some(e => e.path === path.join(repo, 'AGENTS.md') && e.status === 'shadowed'));
    t.ok('除外された参照先を展開しない', scan.entries.some(e => e.path === path.join(repo, 'shared.md') && e.status === 'excluded'));
    t.ok('子階層を全体へ混ぜない', !scan.entries.some(e => e.path.includes(`${path.sep}nested${path.sep}`)));
    t.ok('複数行 frontmatter と同名 Skill 競合を保持', scan.entries.some(e => e.description === 'multiline description\n' && e.conflicts.length === 1));
    t.ok('同じ Skill の別経路を実体パスでまとめる', scan.entries.filter(e => e.kind === 'skill' && e.scope === 'directory').length === 1 && scan.entries.find(e => e.kind === 'skill' && e.scope === 'directory').origins.length === 3);
    // 入力欄の「/」の候補。探索結果からスキルだけを、名前で 1 件にまとめて返す
    const skills = skillList(scan);
    t.ok('候補はスキルだけ', skills.length === 1 && skills[0].name === 'example', JSON.stringify(skills.map(s => s.name)));
    t.ok('同名は 1 件にまとめ、先に見つかった置き場所を出す', skills[0].from === 'ユーザー' && skills[0].description === 'personal', JSON.stringify(skills[0]));
    const shaped = skillList({ home, entries: [
      { kind: 'skill', name: 'no-meta', status: 'candidate', scope: 'directory', appliesTo: repo, content: '---\nname: no-meta\n---\n本文の一行目\n二行目' },
      { kind: 'skill', name: 'excluded', status: 'excluded', scope: 'user', description: '出さない' },
      { kind: 'skill', name: 'built', status: 'candidate', scope: 'user', description: '説明', metadata: { 'argument-hint': '[file]' } },
      { kind: 'skill', name: 'hidden', status: 'candidate', scope: 'directory', origins: [{ path: path.join(home, '.claude/skills/hidden/SKILL.md') }], description: '置き場所つき' },
      { kind: 'instruction', name: 'AGENTS.md', status: 'candidate', scope: 'user' },
    ] });
    t.ok('除外されたスキルは出さない', !shaped.some(s => s.name === 'excluded'));
    t.ok('スキル以外は出さない', !shaped.some(s => s.name === 'AGENTS.md'));
    t.ok('説明が無ければ本文の先頭を使う', shaped.find(s => s.name === 'no-meta')?.description === '本文の一行目 二行目', shaped.find(s => s.name === 'no-meta')?.description);
    t.ok('frontmatter の引数の書き方を拾う', shaped.find(s => s.name === 'built')?.hint === '[file]');
    t.ok('置き場所が分かるものはその名前を出す', shaped.find(s => s.name === 'hidden')?.from === 'claude', shaped.find(s => s.name === 'hidden')?.from);
    t.ok('追加フォルダーを標準探索元と独立して検索', scan.entries.some(e => e.path === path.join(extra, 'AGENTS.md')));
    await write(path.join(home, '.ply/AGENTS.md'), 'obsolete');
    await write(path.join(repo, '.ply/AGENTS.md'), 'obsolete');
    await write(path.join(home, '.agents/skills/shared/SKILL.md'), '---\nname: shared\ndescription: shared user skill\n---\n');
    const common = { ...DEFAULT_SCAN, sources: ['common'], additionalRoots: [] };
    const commonScan = await scanContext({ cwd: child, user: common, directory: common }, { home });
    t.ok('共通配置だけでプロジェクト指示と両スコープの Skills を探索', commonScan.entries.some(e => e.path === path.join(repo, 'AGENTS.md')) && commonScan.entries.filter(e => e.kind === 'skill').length === 2);
    t.ok('独自フォルダー・架空の共通 MCP 設定を探索しない', !commonScan.searched.some(e => e.path.includes('.ply') || e.kind === 'mcp'));
    // 旧版が書いたキーは実体パスとは限らない（短縮名のままの TEMP 等）。表記が違っても継承できること
    await write(path.join(tmp, 'legacy/context-scans.json'), JSON.stringify({ version: 1, user: { ...common, sources: ['ply', 'claude'] }, directories: { [path.join(rawTmp, 'repo')]: { ...common, sources: ['ply'] } } }));
    const legacy = createContextSettings(path.join(tmp, 'legacy'), home);
    const migrated = await legacy.get(child);
    t.ok('保存済みの ply 探索元を共通配置へ移行し継承を維持', migrated.plan.user.kinds.skill.sources.join() === 'common,claude' && migrated.plan.directory.kinds.skill.sources.join() === 'common' && migrated.kinds.skill.from === pathKey(repo));
    t.ok('移行した形式で保存し直し、旧探索元を残さない', !(await fs.readFile(path.join(tmp, 'legacy/context-scans.json'), 'utf8')).includes('"ply"'));
    await setAll(child, withDirectory({ sources: ['codex'] }));
    effective = await settings.get(child);
    scan = await scanContext(effective, { home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') });
    t.ok('ユーザーとディレクトリの探索元は独立', scan.entries.some(e => e.scope === 'user' && e.origins.some(o => o.source === 'claude')) && !scan.entries.some(e => e.name === 'localOnly'));
    await setAll(child, null);
    t.ok('ローカル解除後は親設定に戻る', (await settings.get(child)).kinds.instruction.from === pathKey(repo));
    await setAll(repo, defaultKind());
    scan = await scanContext(await settings.get(child), { home });
    t.ok('参照循環は診断して終了', scan.diagnostics.some(d => d.message.includes('循環')));
    await write(path.join(repo, '.mcp.json'), '{"mcpServers": { "secret": SECRET-INVALID');
    scan = await scanContext(await settings.get(child), { home });
    t.ok('パースエラーにも元の秘密文字列が漏れない', scan.diagnostics.some(d => d.message.includes('解析できません')) && !JSON.stringify(scan).includes('SECRET-INVALID'));
    t.ok('解析できなかったファイルは本文を返さない', !scan.configs.some(c => c.path === path.join(repo, '.mcp.json')));
    const before = JSON.stringify(await settings.get(child));
    await settings.set({ place: child, kind: 'skill', value: { ...defaultKind(), owner: 'always' } }).then(() => t.ok('不正な担当は拒否', false), () => t.ok('不正な担当は拒否', true));
    await settings.set({ place: child, kind: 'skill', value: { ...defaultKind(), disabled: ['x'] } }).then(() => t.ok('名前で外すのは外部 MCP だけ', false), () => t.ok('名前で外すのは外部 MCP だけ', true));
    t.ok('不正設定で保存済み設定を壊さない', JSON.stringify(await settings.get(child)) === before);
    const dataDir = path.join(tmp, 'server-data');
    server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } }); client = await open(server);
    const none = { sources: [], excludePaths: [] }, empty = { owner: 'native', user: none, directory: none };
    // 3 種を同時に保存しても、どれも欠けずに残る
    await Promise.all(KINDS.map(kind => client.cmd('setContextSettings', { place: null, kind, value: empty })));
    t.ok('認証付き API でプレビューが利用できる', (await client.cmd('scanContext', { cwd: child })).entries.length === 0);
    // 入力欄の候補も同じ設定に従う（この場所の共通配置だけを探す）
    await client.cmd('setContextSettings', { place: child, kind: 'skill', value: { ...empty, directory: { sources: ['common'], excludePaths: [] } } });
    const slash = await client.cmd('slashSkills', { cwd: child });
    t.ok('入力欄の候補を同じ探索結果から返す', slash.length === 1 && slash[0].name === 'example' && slash[0].from === 'プロジェクト', JSON.stringify(slash));
    await client.cmd('setContextSettings', { place: child, kind: 'skill', value: null });
    const turn = await client.cmd('newSession', { cwd: child, backend: 'fake' });
    await client.runTurn({ sessionId: turn.sessionId, prompt: 'echo:unchanged' });
    t.ok('スキャン設定で通常実行の本文は変わらない', (await client.cmd('loadSession', turn)).messages[0].text === 'echo:unchanged');
    client.close(); await server.stop();
    server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake' } }); client = await open(server);
    const restored = await client.cmd('contextSettings', { cwd: child });
    t.ok('同時保存した 3 種が再起動後にも残る', KINDS.every(k => restored.defaults.kinds[k].value.user.sources.length === 0 && restored.defaults.kinds[k].value.directory.sources.length === 0 && restored.defaults.kinds[k].value.owner === 'native'));
    await write(path.join(dataDir, 'context-scans.json'), 'broken');
    await client.cmd('setContextSettings', { place: null, kind: 'skill', value: empty }).then(() => t.ok('壊れた設定を黙って上書きしない', false), () => t.ok('壊れた設定を黙って上書きしない', true));
    t.ok('壊れたファイルはそのまま残る', (await fs.readFile(path.join(dataDir, 'context-scans.json'), 'utf8')) === 'broken');
  } finally {
    client?.close(); await server?.stop();
    if (!containsPath(os.tmpdir(), rawTmp) || !path.basename(rawTmp).startsWith('ply-context-test-')) throw new Error('unexpected test path');
    await fs.rm(rawTmp, { recursive: true });
  }
}
