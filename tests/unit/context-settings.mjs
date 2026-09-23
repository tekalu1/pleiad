// コンテキストの設定の形式 2（種類ごとの設定と場所ごとの上書き）と、形式 1 からの移行。
//   - 移行: バックアップを取り、既定と場所ごとの上書きがそれぞれ同じ結果になる（担当・探索の計画・実際の探索結果・実行時の記録）
//   - 移行できないファイルは変えない
//   - 種類ごとの継承（一番近い上書き）と「既定に戻す」、追加ルートの継承、画面の形（view）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createContextSettings, containsPath, defaultKind, legacyPlan, migrateV1, sameMeaning, pathKey, KINDS } from '../../core/context-settings.mjs';
import { scanContext } from '../../core/context-scan.mjs';
import { followSettings, resolveRuntime } from '../../core/context-runtime.mjs';

export const name = 'context-settings';
export const title = 'コンテキストの設定: 形式 1 からの移行で意味が変わらない・種類ごとの継承・即時保存';

// 形式 1 の読み方（移行前の core/context-settings.mjs の get と同じ規則）。移行の実装とは独立に書く
function oldGet(old, dir) {
  const deepest = map => Object.keys(map).filter(p => containsPath(p, dir)).sort((a, b) => b.length - a.length)[0] ?? null;
  const from = deepest(old.directories), ownerFrom = deepest(old.directoryOwners);
  return { cwd: dir, owners: ownerFrom ? old.directoryOwners[ownerFrom] : old.owners, user: old.user,
    directory: from ? old.directories[from] : { sources: ['common', 'claude', 'codex'], kinds: ['instruction', 'skill', 'mcp'], additionalRoots: [], excludePaths: [] } };
}
const shape = scan => scan.entries.map(e => [e.id, e.kind, e.name, e.scope, e.status, e.appliesTo ?? '']).sort((a, b) => a.join().localeCompare(b.join()));

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-settings-')));
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  const home = path.join(tmp, 'home'), a = path.join(tmp, 'a'), ab = path.join(a, 'b'), abc = path.join(ab, 'c'), x = path.join(tmp, 'x'), other = path.join(tmp, 'other');
  const extra = path.join(tmp, 'extra'), extra2 = path.join(tmp, 'extra2');
  try {
    for (const dir of [abc, x, other, extra, extra2]) await fs.mkdir(dir, { recursive: true });
    await fs.mkdir(path.join(a, '.git'), { recursive: true });
    // 探索で見つかるもの（home・各場所・追加ルート。3 種とも）
    await write(path.join(home, '.claude/CLAUDE.md'), 'user claude');
    await write(path.join(home, '.codex/AGENTS.md'), 'user codex');
    await write(path.join(home, '.agents/skills/u/SKILL.md'), '---\nname: u\ndescription: user skill\n---\n');
    await write(path.join(home, '.claude/skills/c/SKILL.md'), '---\nname: c\ndescription: claude skill\n---\n');
    await write(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { home1: { command: 'node' } } }));
    await write(path.join(home, '.codex/config.toml'), '[mcp_servers.home2]\ncommand = "node"\n');
    for (const dir of [a, ab, abc, x]) {
      await write(path.join(dir, 'AGENTS.md'), `agents ${dir}`);
      await write(path.join(dir, 'CLAUDE.md'), `claude ${dir}`);
      await write(path.join(dir, '.agents/skills/s/SKILL.md'), `---\nname: s-${path.basename(dir)}\ndescription: d\n---\n`);
      await write(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [`m-${path.basename(dir)}`]: { command: 'node' } } }));
    }
    await write(path.join(extra, 'AGENTS.md'), 'extra');
    await write(path.join(extra2, '.agents/skills/e/SKILL.md'), '---\nname: e\ndescription: extra skill\n---\n');
    const options = { home, codexHome: path.join(home, '.codex'), claudeHome: path.join(home, '.claude') };

    // ---- 形式 1。担当と探索設定が別々の場所で上書きされ、対象（kinds）を絞ったもの・除外・追加ルート・旧探索元 ply を含む
    const v1 = {
      version: 1,
      owners: { instruction: 'ply', skill: 'native', mcp: 'ply' },
      directoryOwners: { [a]: { instruction: 'ply', skill: 'ply', mcp: 'native' }, [abc]: { instruction: 'native', skill: 'native', mcp: 'ply' } },
      user: { sources: ['ply', 'claude'], kinds: ['instruction', 'mcp'], additionalRoots: [extra], excludePaths: [path.join(home, '.claude', 'CLAUDE.md')] },
      directories: {
        [ab]: { sources: ['codex', 'claude'], kinds: ['skill', 'instruction'], additionalRoots: [extra2], excludePaths: ['CLAUDE.md'] },
        [x]: { sources: ['common'], kinds: ['instruction', 'skill', 'mcp'], additionalRoots: [], excludePaths: [] },
      },
    };
    const dataDir = path.join(tmp, 'data'), file = path.join(dataDir, 'context-scans.json');
    await write(file, JSON.stringify(v1, null, 2));
    const original = await fs.readFile(file, 'utf8');
    // 移行前の意味（旧来の規則で解いた担当と探索の結果）
    const normalizedOld = {
      owners: v1.owners, directoryOwners: v1.directoryOwners,
      user: { ...v1.user, sources: ['common', 'claude'] },
      directories: { [ab]: { ...v1.directories[ab], excludePaths: [path.join(ab, 'CLAUDE.md')] }, [x]: v1.directories[x] },
    };
    const places = [home, a, ab, abc, path.join(abc, 'deeper'), x, other];
    await fs.mkdir(path.join(abc, 'deeper'), { recursive: true });
    const before = {};
    for (const dir of places) {
      const old = oldGet(normalizedOld, dir);
      before[dir] = { owners: old.owners, scan: shape(await scanContext(old, options)),
        runtime: (await resolveRuntime({ version: 1, cwd: dir, owners: old.owners, user: old.user, directory: old.directory }, options).catch(e => ({ report: { error: e.message } }))).report.entries?.map(e => [e.id, e.status]) ?? 'error' };
    }

    const settings = createContextSettings(dataDir, home);
    const migrated = await settings.get(ab);
    t.ok('読み込むと形式 2 に置き換わる', JSON.parse(await fs.readFile(file, 'utf8')).version === 2 && migrated.owners.skill === 'ply');
    t.ok('移行の前にバックアップを取る（元のバイト列のまま）', (await fs.readFile(path.join(dataDir, 'context-scans.v1-backup.json'), 'utf8')) === original);
    let same = true;
    for (const dir of places) {
      const now = await settings.get(dir);
      const scan = shape(await scanContext(now, options));
      const runtime = (await resolveRuntime({ version: 2, cwd: dir, owners: now.owners, plan: now.plan }, options).catch(e => ({ report: { error: e.message } }))).report.entries?.map(e => [e.id, e.status]) ?? 'error';
      const ok = isDeepStrictEqual(now.owners, before[dir].owners) && isDeepStrictEqual(scan, before[dir].scan) && isDeepStrictEqual(runtime, before[dir].runtime);
      if (!ok) { same = false; t.note(`${dir}: owners ${JSON.stringify(now.owners)} / ${JSON.stringify(before[dir].owners)}`); }
    }
    t.ok('既定と場所ごとの上書きのどこでも、担当・探索結果・実行時の記録が移行前と同じ', same);
    t.ok('比べた探索結果は空ではない（3 種とも見つかり、実行時の記録もある）', places.every(d => before[d].scan.length > 0) && ['instruction', 'skill', 'mcp'].every(k => places.some(d => before[d].scan.some(e => e[1] === k))) && places.filter(d => Array.isArray(before[d].runtime) && before[d].runtime.length).length >= 4, places.map(d => `${before[d].scan.length}/${Array.isArray(before[d].runtime) ? before[d].runtime.length : before[d].runtime}`).join(' '));
    t.ok('探索設定だけの上書き（a/b）の下でも、担当は別の場所（a）から継承したまま', (await settings.get(abc)).owners.mcp === 'ply' && (await settings.get(path.join(ab))).owners.instruction === 'ply');
    t.ok('対象から外していた種類は探さないまま（ユーザー側の Skills）', (await settings.get(other)).plan.user.kinds.skill === null);
    const view = await settings.view(ab);
    t.ok('受け継ぐ値と同じ上書きは残さない（画面の「個別に変更」が実際の違いだけ）', view.places.find(p => p.path === ab)?.overrides >= 1
      && view.places.every(p => p.overrides <= 4));

    // 移行は 1 回だけ。2 回目の読み込みでバックアップを作り直さない
    await fs.writeFile(path.join(dataDir, 'context-scans.v1-backup.json'), 'KEEP');
    await settings.get(ab);
    t.ok('2 回目は移行しない（バックアップも触らない）', (await fs.readFile(path.join(dataDir, 'context-scans.v1-backup.json'), 'utf8')) === 'KEEP');

    // ---- 検証が働くこと（移行の結果を書き換えると違いを見つける）
    const pureOld = { ...normalizedOld, user: { ...normalizedOld.user } };
    const config = migrateV1(pureOld);
    t.ok('移行した結果は検証を通る', sameMeaning(pureOld, config) === null);
    const tampered = structuredClone(config);
    tampered.defaults.kinds.skill.owner = 'ply';
    t.ok('意味が変わる移行は検証で見つかる', sameMeaning(pureOld, tampered) !== null);
    const tampered2 = structuredClone(config);
    delete tampered2.places[ab];
    t.ok('場所の上書きが欠けても見つかる', sameMeaning(pureOld, tampered2) !== null);

    // ---- 移行できないファイルは変えない
    const badDir = path.join(tmp, 'bad'), badFile = path.join(badDir, 'context-scans.json');
    await write(badFile, JSON.stringify({ version: 1, owners: { instruction: 'always' }, user: v1.user, directories: {} }));
    const badText = await fs.readFile(badFile, 'utf8');
    const bad = createContextSettings(badDir, home);
    await bad.get(ab).then(() => t.ok('壊れた形式 1 は読めないと言って止まる', false), () => t.ok('壊れた形式 1 は読めないと言って止まる', true));
    t.ok('失敗したときは元のファイルを変えない', (await fs.readFile(badFile, 'utf8')) === badText);
    await bad.set({ place: null, kind: 'skill', value: defaultKind() }).then(() => t.ok('壊れたまま保存しない', false), () => t.ok('壊れたまま保存しない', true));
    t.ok('保存に失敗しても元のファイルはそのまま', (await fs.readFile(badFile, 'utf8')) === badText);

    // ---- 形式 2 の継承と即時保存
    const fresh = createContextSettings(path.join(tmp, 'fresh'), home);
    const start = await fresh.get(abc);
    t.ok('設定が無ければ 3 種とも既定（エージェント任せ）', KINDS.every(k => start.owners[k] === 'native' && start.kinds[k].from === null));
    await fresh.set({ place: null, kind: 'skill', value: { ...defaultKind(), owner: 'ply' } });
    t.ok('保存はその場でファイルに残る（即時保存）', JSON.parse(await fs.readFile(path.join(tmp, 'fresh', 'context-scans.json'), 'utf8')).defaults.kinds.skill.owner === 'ply');
    await fresh.set({ place: a, kind: 'instruction', value: { ...defaultKind(), owner: 'ply' } });
    await fresh.set({ place: ab, kind: 'skill', value: defaultKind() });
    let here = await fresh.get(abc);
    t.ok('種類ごとに一番近い上書きが勝つ', here.owners.instruction === 'ply' && here.kinds.instruction.from === pathKey(a)
      && here.owners.skill === 'native' && here.kinds.skill.from === pathKey(ab) && here.owners.mcp === 'native' && here.kinds.mcp.from === null);
    t.ok('上書きの外（別の場所）は既定のまま', (await fresh.get(x)).owners.skill === 'ply' && (await fresh.get(x)).owners.instruction === 'native');
    await fresh.set({ place: ab, kind: 'skill', value: null });
    here = await fresh.get(abc);
    t.ok('「既定に戻す」で上の設定に従う', here.owners.skill === 'ply' && here.kinds.skill.from === null);
    await fresh.set({ place: null, roots: ['~/extra-root'] });
    await fresh.set({ place: a, roots: ['sub-root'] });
    here = await fresh.get(abc);
    t.ok('追加ルート: 既定は home 基準、場所は保存した場所基準で解決して継承', here.plan.user.roots[0] === path.join(home, 'extra-root') && here.plan.directory.roots[0] === path.join(a, 'sub-root'));
    await fresh.set({ place: null, kind: 'mcp', value: { ...defaultKind(), owner: 'ply', disabled: ['b', 'a', 'a'], prefer: { dup: 'x/.mcp.json' } } });
    here = await fresh.get(abc);
    t.ok('外部 MCP の名前での除外と、同名の定義の選択を持てる', here.plan.mcp.disabled.join() === 'a,b' && here.plan.mcp.prefer.dup === path.join(home, 'x/.mcp.json'));
    await fresh.set({ place: other, add: true });
    const shown = await fresh.view(abc);
    const current = shown.places.find(p => p.current);
    t.ok('画面の形: 今の場所・保存した場所・既定が並び、どこから来ているか分かる', current?.path === abc && !current.saved
      && current.kinds.instruction.from === a && current.kinds.instruction.override === false
      && shown.places.some(p => p.path === other && p.saved && p.overrides === 0) && shown.defaults.id === 'default');
    t.ok('場所ごとの「個別に変更」の数', shown.places.find(p => p.path === a)?.overrides === 2);
    await fresh.set({ place: other, remove: true });
    t.ok('場所を一覧から外せる', !(await fresh.view(null)).places.some(p => p.path === other));
    // 上書きを持つ場所を、フォルダーが消えたあとで消す（設定のプルダウンの「この場所の設定を消す」）
    const gone = path.join(tmp, 'gone-place');
    await fs.mkdir(gone, { recursive: true });
    await fresh.set({ place: gone, kind: 'mcp', value: { ...defaultKind(), owner: 'ply' } });
    const goneKey = Object.keys(JSON.parse(await fs.readFile(path.join(tmp, 'fresh', 'context-scans.json'), 'utf8')).places).find(k => k.endsWith('gone-place'));
    await fs.rm(gone, { recursive: true });
    const storedPath = (await fresh.view(null)).places.find(p => p.path.endsWith('gone-place'))?.path;
    const afterGone = await fresh.set({ cwd: abc, place: storedPath, remove: true });
    t.ok('消えたフォルダーの場所も、保存した名前で一覧から外せる（上書きも消える）', Boolean(goneKey && storedPath)
      && !Object.hasOwn(JSON.parse(await fs.readFile(path.join(tmp, 'fresh', 'context-scans.json'), 'utf8')).places, goneKey)
      && !afterGone.places.some(p => p.path.endsWith('gone-place')));
    await fresh.set({ place: ab, kind: 'skill', value: defaultKind() });
    const afterCurrent = await fresh.set({ place: ab, remove: true });
    t.ok('外した場所を「今の場所」として一覧に戻さない（cwd を渡さないとき）', !afterCurrent.places.some(p => pathKey(p.path) === pathKey(ab)));
    t.ok('既定だけで解く（設定の「すべての場所」）', (await fresh.get(abc, { level: 'default' })).owners.instruction === 'native');
    // ---- 受け継ぐ値と同じ上書きは書かない（全体を変えたつもりで場所の設定ができ、以後の全体の変更が効かなくなるのを防ぐ）
    const prune = createContextSettings(path.join(tmp, 'prune'), home), pruneFile = path.join(tmp, 'prune', 'context-scans.json');
    const stored = async () => JSON.parse(await fs.readFile(pruneFile, 'utf8'));
    await prune.set({ place: null, kind: 'skill', value: { ...defaultKind(), owner: 'ply' } });
    await prune.set({ place: ab, kind: 'skill', value: { ...defaultKind(), owner: 'ply' } });
    t.ok('全体と同じ値を場所に保存しても、場所の設定は作らない', !Object.hasOwn((await stored()).places, pathKey(ab)));
    await prune.set({ place: null, kind: 'skill', value: defaultKind() });
    t.ok('だから全体の変更がその場所にもそのまま効く', (await prune.get(abc)).owners.skill === 'native' && (await prune.get(abc)).kinds.skill.from === null);
    await prune.set({ place: a, kind: 'mcp', value: { ...defaultKind(), owner: 'ply' } });
    await prune.set({ place: a, kind: 'instruction', value: defaultKind() });
    t.ok('場所で 1 項目変えても、ほかの項目は場所の設定にならない', Object.keys((await stored()).places[pathKey(a)].kinds).join() === 'mcp');
    await prune.set({ place: ab, kind: 'mcp', value: { ...defaultKind(), owner: 'ply' } });
    t.ok('上の場所と同じ値も書かない', !Object.hasOwn((await stored()).places, pathKey(ab)));
    await prune.set({ place: other, add: true });
    await prune.set({ place: other, kind: 'skill', value: defaultKind() });
    t.ok('一覧に足した場所は、上書きが無くても一覧に残る', Object.hasOwn((await stored()).places, pathKey(other)));
    // 前の版が保存した「全体と同じ上書き」は、読み込んだときに一度だけ掃除する
    const dirty = await stored();
    dirty.places[pathKey(ab)] = { path: ab, kinds: { skill: structuredClone(dirty.defaults.kinds.skill), mcp: { ...defaultKind(), owner: 'ply' } } };
    dirty.places[pathKey(x)] = { path: x, kinds: { instruction: structuredClone(dirty.defaults.kinds.instruction) }, roots: [] };
    await fs.writeFile(pruneFile, JSON.stringify(dirty));
    const cleaned = (await prune.view(null), await stored());
    t.ok('読み込み時に、受け継ぐ値と同じ上書きを消す（上の場所と同じものも）', !Object.hasOwn(cleaned.places, pathKey(ab)) && !Object.hasOwn(cleaned.places, pathKey(x)), JSON.stringify(Object.keys(cleaned.places)));
    t.ok('違いのある上書きと、一覧に足しただけの場所は残す', cleaned.places[pathKey(a)]?.kinds.mcp.owner === 'ply' && Object.hasOwn(cleaned.places, pathKey(other)));

    // ---- 始まっている会話の方針を、今の設定で解き直す（次のターンから効かせる）
    const first = followSettings(null, await prune.get(abc)).policy;
    await prune.set({ place: null, kind: 'instruction', value: { ...defaultKind(), owner: 'ply' } });
    const next = followSettings({ ...first, at: 'T0', removedMcp: ['gone'] }, await prune.get(abc));
    t.ok('設定の変更で担当が変わった種類を返し、会話ごとの決めごとは引き継ぐ', next.changed.join() === 'instruction' && next.policy.owners.instruction === 'ply'
      && next.policy.at === 'T0' && next.policy.removedMcp.join() === 'gone', JSON.stringify(next.changed));
    t.ok('変わっていなければ何も返さない', followSettings(next.policy, await prune.get(abc)).changed.length === 0);
    const legacyNative = followSettings(null, await prune.get(abc), { keepNative: true }).policy;
    const legacyNext = followSettings(legacyNative, await prune.get(abc)).policy;
    t.ok('記録の無いまま送信済みだった会話はエージェント任せのまま', KINDS.every(k => legacyNative.owners[k] === 'native' && legacyNext.owners[k] === 'native'));
    t.ok('作業場所が変わっただけなら設定の変更とは数えない', followSettings({ ...first, cwd: x }, await prune.get(abc)).changed.length === 0);

    // 形式 1 のまま記録された会話の方針も読める（計画に直す）
    const legacy = legacyPlan({ sources: ['common'], kinds: ['skill'], additionalRoots: [], excludePaths: [] }, { sources: [], kinds: [], additionalRoots: [], excludePaths: [] });
    t.ok('形式 1 の方針を計画に直す', legacy.user.kinds.skill.sources.join() === 'common' && legacy.user.kinds.instruction === null && legacy.directory.kinds.mcp === null);
  } finally {
    // Windows の実行環境では os.tmpdir() が 8.3 の短縮名（RUNNER~1）を返すので、実体のパスで比べる
    if (!containsPath(await fs.realpath(os.tmpdir()), tmp)) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
