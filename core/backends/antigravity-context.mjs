// agy（Antigravity CLI）に Pleiad が担当するコンテキスト（指示・Skills・外部 MCP の中継）を渡す準備。
//
// agy には会話単位で MCP やシステムプロンプトを渡す CLI 引数・env が無い。使えるのはカスタムエージェント
// （Markdown の agent.md）で、agy 1.2.7 で次を実測した（報告書 temporary/reports/mcp-auth-agents.md）:
//   - `--agent <名前>` はワークスペースの `.agents/agents/<名前>/agent.md` を探す。`--add-dir` で足した
//     ディレクトリも対象になる。絶対パスは受け付けない（「not found, falling back to default」）
//     → Pleiad の置き場に作って `--add-dir` で見せる。利用者の作業ツリーにも ~/.gemini にも書かない
//   - frontmatter の `mcpServers`（リスト）に書いた stdio の MCP は、agy の環境変数を引き継いで起動する
//     → 接続先とトークンはファイルに書かず、agy を起こす env で渡す（core/agy-context-relay.mjs）
//   - 本文（H1 から）はシステムプロンプトに入る。MCP の initialize の instructions は入らない
//   - `inheritCustomizations: false` でネイティブの Skills と MCP が消える。`inheritMcp` で MCP だけ切り替えられる
//   - **`tools` を書かないとエージェントは書き込み系ツールを持たない**（agy 1.2.7、2026-09-20 実測）。
//     未指定の既定は send_message / view_file / read_url_content / search_web / schedule / generate_image /
//     manage_task だけで、write_to_file も run_command も replace_file_content も入らない。
//     `init` の `tools` は CLI のレジストリ全 57 個を出すので、**そこを見ても気づけない**
//     （気づける外形は入力トークンが既定エージェントの 1/4 に落ちること）。承認とは無関係で、
//     `--dangerously-skip-permissions` を付けても `permission_mode: always-proceed` のまま何も呼べない
//     → 下の TOOLS で明示する
//   - カスタムエージェントは、`inheritCustomizations: true` でもワークスペースの AGENTS.md / GEMINI.md を
//     読み込まない（既定のエージェントは読み込む）
//     → 指示の担当がエージェントのまま Pleiad のコンテキストを渡すと、指示が抜け落ちる。その組み合わせは受けない
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dir } from './antigravity-store.mjs';
import { t, agentT } from '../i18n.mjs';

export const AGENT_NAME = 'ply-context';
const RELAY = fileURLToPath(new URL('../agy-context-relay.mjs', import.meta.url));
const root = () => path.join(dir(), 'context');

/**
 * カスタムエージェントに渡すツール。**書かないと書き込みもコマンド実行もできない**（冒頭の実測）。
 *
 * agy 1.2.7 で確かめたこと:
 *   - `tools: "*"` は書き込み系こそ入るが、**mcpServers のツールを落とす**。ply_context が使えなくなるので採らない
 *   - 配列なら MCP のツールは書かなくても足される（`call_mcp_tool` / `list_resources` / `read_resource` は
 *     **書くと落ちる**。レジストリに名前が無い）
 *   - `init` が出す 57 個のうち、配列に名前を書けるのはここに並べた 22 個だけ。
 *     browser 系・`command_status` / `send_command_input` / `sed_file` / `notebook_execution` などは
 *     **名前で指定できず**、1 つでも混ぜると `unknown component: tool … not found in registry` で起動ごと失敗する
 *   - `finish` は外す。入れると応答本文に `{"toolAction":…}` の JSON が混ざる
 *
 * つまりこれが「既定のエージェントに最も近づけられる上限」で、それ以上は agy 側の都合で渡せない。
 * agy が新しいツールを足しても自動では増えない。増やすときは上の失敗の仕方に注意して実機で確かめる。
 */
const TOOLS = [
  'view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit',
  'grep_search', 'find_by_name', 'list_dir',
  'run_command',
  'read_url_content', 'search_web', 'generate_image',
  'define_subagent', 'invoke_subagent', 'manage_subagents',
  'ask_question', 'ask_permission', 'ask_custom_permission',
  'manage_task', 'schedule', 'send_message', 'wait',
];

/** Pleiad 担当のコンテキストを agy に渡せない担当の組み合わせなら、その理由。渡せるなら null */
export function contextRefusal(owners = {}) {
  const ply = Object.values(owners).some(owner => owner === 'ply');
  if (!ply || owners.instruction === 'ply') return null;
  return t('antigravity.contextRefusal');
}

/**
 * agent.md の中身。frontmatter の値は JSON で書く（YAML としても読める）。
 * locale は会話の言語（説明・見出し・注意書きはエージェントが読むので、その言語で書く。agent 名前空間）
 */
export function agentDefinition({ owners, prompt, cwd, home, locale, execPath = process.execPath, electron = Boolean(process.versions.electron) }) {
  const server = { serverName: 'ply_context', command: execPath, args: [RELAY],
    // 配布版の Pleiad は Electron。Node として動かす印が無いと、中継ではなく Pleiad 本体が立ち上がる
    ...(electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
  const front = [
    `name: ${AGENT_NAME}`,
    `description: ${JSON.stringify(agentT(locale, 'antigravity.description'))}`,
    'mainAgent: true',
    'subagent: false',
    'hidden: true',
    // Skills を Pleiad が持つならネイティブの Skills（と plugins・subagents）を切る。MCP は別に切り替える
    `inheritCustomizations: ${owners.skill !== 'ply'}`,
    `inheritMcp: ${owners.mcp !== 'ply'}`,
    `mcpServers: ${JSON.stringify([server])}`,
    // 書かないと書き込み系ツールが 1 つも渡らない（TOOLS のコメント）
    `tools: ${JSON.stringify(TOOLS)}`,
  ];
  const note = agentT(locale, 'antigravity.note', { home, cwd });
  return ['---', ...front, '---', '', agentT(locale, 'antigravity.heading'), '', String(prompt ?? '').trim(), '', note, ''].join('\n');
}

/**
 * 会話用のエージェントを Pleiad の置き場（<data>/antigravity/context/<pid>-<乱数>/）に書く。
 * `--add-dir <home> --agent ply-context` で agy に見せ、env を agy の環境変数に足す。agy が終わったら cleanup で消す
 */
export async function prepareAgent({ owners, prompt, cwd, url, authorization, locale }) {
  const home = path.join(root(), `${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const file = path.join(home, '.agents', 'agents', AGENT_NAME, 'agent.md');
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(file, agentDefinition({ owners, prompt, cwd, home, locale }), { encoding: 'utf8', mode: 0o600 });
  return {
    home,
    // PLY_CONTEXT_LOCALE は中継が agy へ返すエラーの言語（会話の言語。core/agy-context-relay.mjs）
    env: { PLY_CONTEXT_URL: url, PLY_CONTEXT_AUTHORIZATION: authorization, ...(locale ? { PLY_CONTEXT_LOCALE: locale } : {}) },
    cleanup: () => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 }),
  };
}

/** 前の起動が残した置き場を消す（持ち主の Pleiad が居ないものだけ）。強制終了では cleanup が走らないため */
export function sweep() {
  let names = [];
  try { names = fs.readdirSync(root()); } catch { return; }
  for (const name of names) {
    const owner = Number(/^(\d+)-/.exec(name)?.[1]);
    if (owner === process.pid) continue;
    if (Number.isInteger(owner) && owner > 0) {
      try { process.kill(owner, 0); continue; } catch (e) { if (e.code === 'EPERM') continue; }
    }
    try { fs.rmSync(path.join(root(), name), { recursive: true, force: true }); } catch {}
  }
}
