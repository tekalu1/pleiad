// 指示の量の面の「気になる所」（ADR 0056「② 気になる所を知らせる」、docs/context-runtime.md「気になる所」）。LLM は呼ばない
//   - Markdown のブロックの分け方（段落・箇条の 1 項目・frontmatter とコードブロックを除く）
//   - 重複の近さ（しきい値を決めた架空の文）・違うファイルどうしだけ・短いブロックは比べない・共通の部分
//   - 無いパス: 調べるパスの形・コードブロックの中は見ない・Git のルートから見る・ユーザーの指示は調べない
//   - サーバー越し: Pleiad がそろえる会話の記録の行が対象になる・エージェント任せは同じ規則で探したもの
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markdownBlocks, similarity, findDuplicates, pathCandidate, pathMentions, findMissingPaths, contextFindings,
  DUPLICATE_THRESHOLD, DUPLICATE_MIN_CHARS } from '../../core/context-findings.mjs';
import { createContextSession } from '../../core/context-session.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'context-findings';
export const title = '気になる所: 違うファイルのほぼ同じ段落と、もう無いパス（言語に依存しない判定）';

// しきい値を決めた架空の文（docs に載せる値の根拠）
const COPY_JA = ['シェルから起動したときは FOO_MODE=1 が引き継がれている。そのまま app.exe を起動すると CLI として動き、require(\'app\').ui が undefined で落ちる。',
  '同じく FOO_MODE=1 も引き継がれている。そのまま app.exe を起動すると CLI として動き、require(\'app\').ui が undefined で落ちる。'];
const COPY_EN = ['Always run the test suite inside the task worktree. Running it from the main checkout does not exercise the worktree changes.',
  'Always run the test suite inside the task worktree; running it from the main checkout does not exercise your worktree changes.'];
const RULE_JA = 'テストは必ず作業用の worktree の中で実行する。main の作業ディレクトリで走らせても worktree の変更は検証できない。';
const EXTENDED_JA = `${RULE_JA}以前、通ったことにしてしまった例がある。依存を入れていない worktree ではジャンクションを張る。`;
const TOPIC_JA = 'worktree を消す前に、中のリンクをすべて外す。外さないと、リンク先の本体まで消える。main の作業ディレクトリから操作する。';
const TOPIC_EN = 'Before removing a worktree, unlink every junction inside it, otherwise the target directory of the link is deleted as well.';
const START_JA = ['WebSocket のコマンドを足すときは、server の case に加えて protocol の COMMANDS にも登録する。',
  'WebSocket のイベントを足すときは、protocol のファイルに中身の形を書き、画面の側に受け取る処理を足す。'];

export default async function (t) {
  // ---- ブロック
  const blocks = markdownBlocks('---\ndescription: x\n---\n# 見出し\n\n一行目\n続きの行\n\n- 項目 A\n  続き\n  - 入れ子\n1. 番号\n\n```sh\n- コードの中\n```\n@AGENTS.md\n| a | b |\n');
  t.ok('段落は続きの行とつなぎ、箇条は 1 項目ずつ、frontmatter・コードブロック・@参照の行は除く',
    JSON.stringify(blocks.map(b => b.text)) === JSON.stringify(['# 見出し', '一行目 続きの行', '項目 A 続き', '入れ子', '番号', '| a | b |']), JSON.stringify(blocks));
  t.ok('ブロックは始まりの行を持つ（開くときの位置）', blocks.find(b => b.text === '項目 A 続き')?.line === 9 && blocks.find(b => b.text === '番号')?.line === 12, JSON.stringify(blocks));

  // ---- 近さとしきい値
  t.ok('語を少し変えた写しは重複（日本語・英語）', similarity(...COPY_JA) >= DUPLICATE_THRESHOLD && similarity(...COPY_EN) >= DUPLICATE_THRESHOLD,
    `${similarity(...COPY_JA)} ${similarity(...COPY_EN)}`);
  t.ok('写しに文を書き足したものも重複', similarity(RULE_JA, EXTENDED_JA) >= DUPLICATE_THRESHOLD, String(similarity(RULE_JA, EXTENDED_JA)));
  t.ok('同じ話題の別の段落・書き出しだけ同じ段落は重複にしない（しきい値との間を空ける）',
    similarity(RULE_JA, TOPIC_JA) < DUPLICATE_THRESHOLD / 2 && similarity(COPY_EN[0], TOPIC_EN) < DUPLICATE_THRESHOLD / 2 && similarity(...START_JA) < DUPLICATE_THRESHOLD / 2,
    `${similarity(RULE_JA, TOPIC_JA)} ${similarity(COPY_EN[0], TOPIC_EN)} ${similarity(...START_JA)}`);
  t.ok('全角・半角と大文字・小文字、記号と空白の違いは見ない', similarity('ＦＯＯ＿ＭＯＤＥ を 必ず 外す。', 'foo-mode を必ず外す') === 1);

  const dup = findDuplicates([
    { path: '/u/CLAUDE.md', scope: 'user', content: `# 共通\n\n${COPY_JA[0]}\n\n${RULE_JA}\n\n${RULE_JA}\n\n- 短い注意\n` },
    { path: '/r/AGENTS.md', scope: 'directory', content: `- ${COPY_JA[1]}\n- ${TOPIC_JA}\n\n- 短い注意\n` },
  ]);
  t.ok('違うファイルのほぼ同じ段落だけを出す（同じファイルの中の繰り返し・別の段落・短いブロックは出さない）',
    dup.items.length === 1 && dup.items[0].sides.map(s => `${s.path}:${s.line}`).join() === '/u/CLAUDE.md:3,/r/AGENTS.md:1' && dup.more === 0, JSON.stringify(dup.items.map(i => i.sides.map(s => s.line))));
  const [a, b] = dup.items[0].sides;
  const common = s => s.segments.filter(x => x.common).map(x => x.text).join('|');
  t.ok('両側の文を切らずに返し、共通の部分に印を付ける', a.segments.map(x => x.text).join('') === COPY_JA[0] && b.segments.map(x => x.text).join('') === COPY_JA[1]
    && common(a).includes('そのまま app.exe を起動すると CLI として動き') && !common(a).includes('シェルから起動') && !common(b).includes('同じく'), `${common(a)} / ${common(b)}`);
  t.ok('比べない短さは、ならした後の字数で決める', DUPLICATE_MIN_CHARS === 40
    && findDuplicates([{ path: '/a', content: 'x'.repeat(39) }, { path: '/b', content: 'x'.repeat(39) }]).items.length === 0
    && findDuplicates([{ path: '/a', content: 'x'.repeat(40) }, { path: '/b', content: 'x'.repeat(40) }]).items.length === 1);

  // ---- 無いパスの形
  const yes = ['docs/design.md', 'tests/unit/old.mjs', './web/app.css', 'core/server.mjs:120', 'temporary/reports/', '.github/workflows/ci.yml', '../sibling/README.md'];
  const no = ['https://example.com/a.md', 'C:/Users/x/a.md', '/etc/hosts.conf', '~/.claude/CLAUDE.md', 'src/**/*.ts', 'temporary/reports/<題>.md', 'docs/{a,b}.md',
    'npm test', 'feat/context-review', 'origin/main', 'package.json', 'example.com/page.html', '$HOME/x/a.md', 'a/.../b.md', '--out=dist/a.js'];
  t.ok('相対パスの形（/ を含み、拡張子で終わるかディレクトリの形）だけを調べる', yes.every(pathCandidate), yes.filter(s => !pathCandidate(s)).join());
  t.ok('URL・絶対パス・~・glob・置き換え用の書き方・空白・ブランチ名のようなもの・ドメインは調べない', no.every(s => pathCandidate(s) === null), no.filter(pathCandidate).join());
  t.ok('行番号は落として調べる', pathCandidate('core/server.mjs:120') === 'core/server.mjs' && pathCandidate('core/server.mjs:12:5') === 'core/server.mjs');
  const mentions = pathMentions('見る: `docs/a.md` と `docs/b.md`\n```\n`docs/in-fence.md`\n```\n``docs/c.md``');
  t.ok('コードブロックの中は見ない・行を持つ', mentions.map(m => `${m.target}:${m.line}`).join() === 'docs/a.md:1,docs/b.md:1,docs/c.md:5', JSON.stringify(mentions));

  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-context-findings-')));
  const home = path.join(tmp, 'home'), repo = path.join(tmp, 'repo'), sub = path.join(repo, 'pkg'), dataDir = path.join(tmp, 'data');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  let host, client;
  try {
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await write(path.join(repo, 'docs', 'here.md'), 'x');
    await write(path.join(sub, 'local.md'), 'x');
    await fs.mkdir(path.join(repo, 'web'), { recursive: true });
    const repoAgents = `- 設計は \`docs/here.md\`、画面は \`web/\`、古い \`docs/gone.md\` と \`docs/gone.md\`\n- ${COPY_EN[1]}\n`;
    const subAgents = '- ここだけ `local.md` と `./local.md` と `pkg/local.md` と `pkg/missing/x.ts`\n';
    const userClaude = `- ユーザーの \`tests/nowhere.mjs\`\n- ${COPY_EN[0]}\n`;
    await write(path.join(repo, 'AGENTS.md'), repoAgents);
    await write(path.join(sub, 'AGENTS.md'), subAgents);
    await write(path.join(home, '.codex', 'AGENTS.md'), userClaude);

    const files = [
      { path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user', content: userClaude },
      { path: path.join(repo, 'AGENTS.md'), scope: 'directory', content: repoAgents },
      { path: path.join(sub, 'AGENTS.md'), scope: 'directory', content: subAgents },
      { path: path.join(tmp, 'extra', 'AGENTS.md'), scope: 'directory', root: path.join(tmp, 'extra'), content: '`docs/extra-gone.md`' },
    ];
    const missing = await findMissingPaths(files, { root: repo });
    const shown = missing.items.map(m => `${path.basename(path.dirname(m.path))}/${m.target}:${m.line}`).join();
    t.ok('Git のルートから見て無いパスだけを出す（同じファイルの同じパスは 1 回。指示のあるフォルダーから見て有るものは出さない）',
      shown === 'repo/docs/gone.md:1,pkg/pkg/missing/x.ts:1', shown);
    t.ok('ユーザーの指示・足した場所の指示は調べない', !missing.items.some(m => m.target === 'tests/nowhere.mjs' || m.target === 'docs/extra-gone.md'));
    const noRoot = await findMissingPaths([{ path: path.join(sub, 'AGENTS.md'), scope: 'directory', content: '`pkg/local.md` `x/local.md`' }], { root: null });
    t.ok('Git のルートが無ければ、その指示ファイルのあるフォルダーから見る', noRoot.items.map(m => m.target).join() === 'pkg/local.md,x/local.md', JSON.stringify(noRoot.items));

    const all = await contextFindings([
      { path: path.join(home, '.codex', 'AGENTS.md'), scope: 'user' },
      { path: path.join(repo, 'AGENTS.md'), scope: 'directory' },
      { path: path.join(repo, '.', 'AGENTS.md'), scope: 'user' },
      { path: path.join(repo, 'nothing.md'), scope: 'directory' },
    ], { cwd: sub });
    t.ok('ファイルを読み、同じ実体は 1 つにし、読めないものは飛ばす', all.duplicates.length === 1 && all.missing.map(m => m.target).join() === 'docs/gone.md'
      && all.duplicates[0].sides.every(s => Array.isArray(s.segments)), JSON.stringify({ d: all.duplicates.length, m: all.missing }));

    // ---- エージェント任せ: nativeInstructions と同じ探索が対象
    const scanOptions = { home, claudeHome: path.join(home, '.claude'), codexHome: path.join(home, '.codex') };
    const record = { report: { status: 'native', cwd: repo, owners: { instruction: 'native' }, entries: [] }, policy: { owners: { instruction: 'native' } } };
    const session = createContextSession({ store: { get: async () => ({ contextSession: record }) }, snapshots: null, scanOptions });
    const native = await session.findings('s1', repo, 'codex');
    t.ok('エージェント任せの会話は、そのエージェントの規則で探したファイルが対象', native.duplicates.length === 1 && native.missing.map(m => m.target).join() === 'docs/gone.md', JSON.stringify(native.missing));
    t.ok('規則を知らないエージェントは null', await session.findings('s1', repo, 'antigravity') === null);
    const plain = await session.nativeInstructions(repo, 'codex');
    t.ok('nativeInstructions は本文を返さない（量だけ）', plain.entries.length === 2 && plain.entries.every(e => !('content' in e) && !('realPath' in e)));

    // ---- サーバー越し: Pleiad がそろえる会話
    host = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude') } });
    client = await open(host);
    await client.cmd('setContextSettings', { cwd: repo, place: repo, kind: 'instruction', value: { owner: 'ply', user: { sources: ['codex'], excludePaths: [] }, directory: { sources: ['common'], excludePaths: [] } } });
    const s = await client.cmd('newSession', { cwd: repo, backend: 'fake' });
    const turn = await client.runTurn({ ...s, prompt: 'hello' }, { ms: 60_000 });
    const found = await client.cmd('contextFindings', { sessionId: s.sessionId, cwd: repo, backend: 'fake' });
    t.ok('Pleiad がそろえる会話は、渡した指示ファイルが対象（重複と無いパス）', turn.outcome === 'ok' && found?.duplicates.length === 1
      && found.duplicates[0].sides.map(x => x.scope).sort().join() === 'directory,user' && found.missing.map(m => m.target).join() === 'docs/gone.md', JSON.stringify(found));
    t.ok('記録の無い会話は断る', await client.cmd('contextFindings', { sessionId: 'nope', cwd: repo }).then(() => false, () => true));
  } finally {
    client?.close();
    await host?.stop?.();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
