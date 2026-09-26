// 探す場所を足す（追加ルート）を種類ごとに持つ形式 3 と、形式 2 からの移行（docs/context-management.md「保存と継承」、ADR 0025）。
//   - 形式 2 の追加ルート（種類によらない並び 1 つ）は 3 種すべてへ写し、既定と各場所で今までと同じ探索結果になる
//   - バックアップを取り、移行は 1 回だけ。壊れた形式 2 は変えない
//   - 足した場所はその種類にだけ効き、その範囲の探す形式で探す。見つかった行には root（足した場所）が付く
//   - scanContext の scopes: ['user'] は作業場所のファイルを混ぜない（設定の画面のユーザーの段）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContextSettings, containsPath, defaultKind, pathKey, KINDS } from '../../core/context-settings.mjs';
import { scanContext } from '../../core/context-scan.mjs';

export const name = 'context-roots';
export const title = '探す場所を足す: 種類ごと・探す形式に従う・形式 2 からの移行で意味が変わらない';

const shape = scan => scan.entries.map(e => [e.kind, e.name, e.path, e.scope, e.status, e.appliesTo ?? '']).sort((a, b) => a.join().localeCompare(b.join()));

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-roots-')));
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), sub = path.join(repo, 'sub'), extra = path.join(tmp, 'extra'), extra2 = path.join(tmp, 'extra2');
  const options = { home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') };
  try {
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    await write(path.join(home, '.claude/CLAUDE.md'), 'user claude');
    await write(path.join(repo, 'AGENTS.md'), 'repo agents');
    // 足す場所には 3 種と 3 形式を置く
    for (const dir of [extra, extra2]) {
      await write(path.join(dir, 'AGENTS.md'), `agents ${dir}`);
      await write(path.join(dir, 'CLAUDE.md'), `claude ${dir}`);
      await write(path.join(dir, '.agents/skills/common-skill/SKILL.md'), '---\nname: common-skill\ndescription: d\n---\n');
      await write(path.join(dir, '.claude/skills/claude-skill/SKILL.md'), '---\nname: claude-skill\ndescription: d\n---\n');
      await write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [`m-${path.basename(dir)}`]: { command: 'node' } } }));
    }

    // ---- 形式 2 → 3
    const ply = { ...defaultKind(), owner: 'ply' };
    const v2 = { version: 2,
      defaults: { roots: [extra], kinds: { instruction: ply, skill: ply, mcp: { ...ply, disabled: ['x'] } } },
      places: { [pathKey(repo)]: { path: repo, roots: [extra2], kinds: { skill: { ...ply, directory: { sources: ['claude'], excludePaths: [] } } } } } };
    const dataDir = path.join(tmp, 'data'), file = path.join(dataDir, 'context-scans.json');
    await write(file, JSON.stringify(v2, null, 2));
    const original = await fs.readFile(file, 'utf8');
    // 移行前の探索結果（形式 2 の計画 = 追加ルートがすべての種類。移行前の設定の読み方と同じ形を手で作る）
    const plan2 = (dir, withPlace) => ({ cwd: dir, plan: {
      user: { roots: [extra], kinds: { instruction: ply.user, skill: ply.user, mcp: ply.user } },
      directory: { roots: withPlace ? [extra2] : [], kinds: { instruction: ply.directory, skill: withPlace ? { sources: ['claude'], excludePaths: [] } : ply.directory, mcp: ply.directory } },
      mcp: { disabled: ['x'], prefer: {} } } });
    const before = { [home]: shape(await scanContext(plan2(home, false), options)), [sub]: shape(await scanContext(plan2(sub, true), options)) };

    const settings = createContextSettings(dataDir, home);
    const now = await settings.get(sub);
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('読み込むと形式 3 に置き換わる', stored.version === 3);
    t.ok('移行の前に形式 2 のバックアップを取る（元のバイト列のまま）', (await fs.readFile(path.join(dataDir, 'context-scans.v2-backup.json'), 'utf8')) === original);
    t.ok('既定の追加ルートは 3 種すべてへ写す', KINDS.every(k => stored.defaults.roots[k]?.[0] === extra), JSON.stringify(stored.defaults.roots));
    t.ok('場所の追加ルートも 3 種すべてへ写す', KINDS.every(k => stored.places[pathKey(repo)].roots[k]?.[0] === extra2));
    t.ok('担当・探す形式・名前での除外はそのまま', stored.defaults.kinds.mcp.disabled.join() === 'x' && stored.places[pathKey(repo)].kinds.skill.directory.sources.join() === 'claude');
    let same = true;
    for (const [dir, want] of Object.entries(before)) {
      const got = shape(await scanContext(await settings.get(dir), options));
      if (JSON.stringify(got) !== JSON.stringify(want)) { same = false; t.note(`${dir}: ${got.length} / ${want.length}`); }
    }
    t.ok('既定と場所のどちらでも、移行の前と同じものが見つかる', same && before[sub].length > 5, `${before[sub].length}`);
    t.ok('解いた計画は種類ごとの追加ルート', now.plan.user.roots.skill[0] === extra && now.plan.directory.roots.mcp[0] === extra2 && now.roots.instruction.from === pathKey(repo));
    await fs.writeFile(path.join(dataDir, 'context-scans.v2-backup.json'), 'KEEP');
    await settings.get(sub);
    t.ok('2 回目は移行しない（バックアップも触らない）', (await fs.readFile(path.join(dataDir, 'context-scans.v2-backup.json'), 'utf8')) === 'KEEP');

    // 壊れた形式 2 はそのまま
    const badDir = path.join(tmp, 'bad'), badFile = path.join(badDir, 'context-scans.json');
    await write(badFile, JSON.stringify({ version: 2, defaults: { roots: 'not-a-list', kinds: {} }, places: {} }));
    const badText = await fs.readFile(badFile, 'utf8');
    await createContextSettings(badDir, home).get(sub).then(() => t.ok('壊れた形式 2 は読めないと言って止まる', false), () => t.ok('壊れた形式 2 は読めないと言って止まる', true));
    t.ok('失敗したときは元のファイルを変えず、バックアップも残さない', (await fs.readFile(badFile, 'utf8')) === badText
      && !(await fs.stat(path.join(badDir, 'context-scans.v2-backup.json')).then(() => true, () => false)));

    // ---- 種類ごと・探す形式に従う
    const fresh = createContextSettings(path.join(tmp, 'fresh'), home);
    for (const k of KINDS) await fresh.set({ place: null, kind: k, value: ply });
    await fresh.set({ place: null, kind: 'skill', roots: [extra] });
    let scan = await scanContext(await fresh.get(sub), options);
    const fromExtra = scan.entries.filter(e => e.root === extra);
    t.ok('Skills に足した場所は Skills だけを探す', fromExtra.length > 0 && fromExtra.every(e => e.kind === 'skill'), JSON.stringify(fromExtra.map(e => e.kind)));
    t.ok('足した場所の行はユーザーの範囲で、足した場所（root）が付く', fromExtra.every(e => e.scope === 'user' && e.appliesTo === null && e.root === extra));
    await fresh.set({ place: null, kind: 'instruction', roots: [extra] });
    await fresh.set({ place: null, kind: 'instruction', value: { ...ply, user: { sources: ['claude'], excludePaths: [] } } });
    scan = await scanContext(await fresh.get(sub), options);
    const instr = scan.entries.filter(e => e.kind === 'instruction' && e.root === extra).map(e => e.name);
    t.ok('足した場所は、その段の探す形式で探す（CLAUDE.md だけなら AGENTS.md は探さない）', instr.includes('CLAUDE.md') && !instr.includes('AGENTS.md'), instr.join());
    const view = await fresh.view(sub);
    t.ok('画面の形も種類ごとの追加ルート', view.defaults.roots.skill.value[0] === extra && view.defaults.roots.mcp.value.length === 0);
    await fresh.set({ place: null, kind: 'skill', roots: [] });
    t.ok('足した場所を外せる（その種類だけ）', (await fresh.get(sub)).plan.user.roots.skill.length === 0 && (await fresh.get(sub)).plan.user.roots.instruction[0] === extra);

    // ---- ユーザーの範囲だけを探す（設定の画面のユーザーの段）
    const userOnly = await scanContext(await fresh.get(repo, { level: 'default' }), { ...options, scopes: ['user'] });
    t.ok('scopes: [user] は作業場所（Git のルートから作業フォルダーまで）のファイルを混ぜない', !userOnly.entries.some(e => e.scope === 'directory')
      && !userOnly.entries.some(e => e.path === path.join(repo, 'AGENTS.md')) && userOnly.entries.some(e => e.path === path.join(home, '.claude', 'CLAUDE.md')));
  } finally {
    if (!containsPath(await fs.realpath(os.tmpdir()), tmp)) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
