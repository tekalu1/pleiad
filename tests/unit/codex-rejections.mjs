// Codex の実行前の拒否を rollout から拾う（core/backends/codex-rejections.mjs）と、依頼元へ渡す文の伏せ方（core/redact.mjs）。
// 行の形は codex-cli 0.156.1 の実際の rollout に合わせ、値は作ったもの（tests/lib/codex-rollout.mjs）。ファイルは一時ディレクトリにだけ書く
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseRejection, rejectionsFromRollout, readTurnRejections, rolloutPathOf, rolloutSize, shlexSplit, decodeRustDebug } from '../../core/backends/codex-rejections.mjs';
import { redactForPeer, redactSecrets } from '../../core/redact.mjs';
import { normalizePlyInstructions, resolvePlyInstructions, turnInstructions, changePlyInstructions } from '../../core/ply-instructions.mjs';
import { agentT } from '../../core/i18n.mjs';
import { lines as rl, jsonl, policyRejection, spawnRejection, rustDebug } from '../lib/codex-rollout.mjs';

export const name = 'codex-rejections';
export const title = 'Codex の実行前の拒否を rollout から拾う・依頼元へ渡す文を伏せる・Codex の子だけへの指示';

const TURN = '01a0e000-0000-7000-8000-00000000aaaa';
const OTHER = '01a0e000-0000-7000-8000-00000000bbbb';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const text = rows => jsonl(rows).split('\n');

export default async function (t) {
  // ---- 1 件の出力の解析
  const script = "Remove-Item -LiteralPath 'C:\\work\\tmp\\a.bin' -Force";
  const p = parseRejection(policyRejection(script));
  t.ok('直接の exec_command の形（出力の先頭）: ポリシーの拒否・シェル・スクリプト・理由に戻す', p?.kind === 'policy' && p.shell === 'powershell.exe' && p.command === script && p.reason === 'blocked by policy'
    && p.raw.startsWith('exec_command failed: CreateProcess'), JSON.stringify(p));
  const code = parseRejection(`Script error:\n${policyRejection(script)}`);
  t.ok('code mode の形（Script error:\\n の直後）も拾う', code?.kind === 'policy' && code.command === script && code.afterScriptError === true);
  t.ok('出力の途中に引用されただけの文は拾わない', parseRejection(`issue の本文: ${policyRejection(script)}`) === null
    && parseRejection(`見出し Script error:\n${policyRejection(script)}`) === null);
  const tick = parseRejection(policyRejection('Write-Host "a`tb` rejected: b"; Remove-Item x'));
  t.ok('PowerShell の ` を含むコマンドは最後の「` rejected: 」で切る', tick?.command === 'Write-Host "a`tb` rejected: b"; Remove-Item x' && tick.reason === 'blocked by policy', JSON.stringify(tick));
  const custom = parseRejection(policyRejection('del x', { reason: 'rm -f style commands are not permitted. Use a safer approach' }));
  t.ok('理由は blocked by policy に限らない', custom?.reason === 'rm -f style commands are not permitted. Use a safer approach');
  const unsplit = parseRejection(`exec_command failed: CreateProcess { message: ${rustDebug(`Rejected(${rustDebug('`pwsh.exe -Command "unterminated` rejected: blocked by policy')})`)} }`);
  t.ok('語分けに失敗したら描いた文字列をそのまま出す（シェルは分からない）', unsplit?.kind === 'policy' && unsplit.command === 'pwsh.exe -Command "unterminated' && unsplit.shell === null, JSON.stringify(unsplit));
  const spawn = parseRejection(spawnRejection('SetTokenInformation(TokenDefaultDacl) failed: 1344'));
  t.ok('プロセス作成の失敗は kind spawn（ポリシーの拒否と混ぜない）', spawn?.kind === 'spawn' && spawn.reason === 'SetTokenInformation(TokenDefaultDacl) failed: 1344' && spawn.command === null);
  const other = parseRejection(`exec_command failed: CreateProcess { message: ${rustDebug(`Rejected(${rustDebug('something new')})`)} }`);
  const notRejected = parseRejection(`exec_command failed: CreateProcess { message: ${rustDebug('Io(Os { code: 5 })')} }`);
  t.ok('どちらでもない文は kind other で生の文を残す', other?.kind === 'other' && other.raw.includes('something new') && notRejected?.kind === 'other');
  t.ok('Rust の Debug 形式を戻す・POSIX の語分け', decodeRustDebug('a\\"b\\\\c\\nd\\u{1F600}') === 'a"b\\c\nd😀'
    && JSON.stringify(shlexSplit(`"C:\\\\x y\\\\p.exe" -Command 'a b'`)) === JSON.stringify(['C:\\x y\\p.exe', '-Command', 'a b']) && shlexSplit('"open') === null);

  // ---- rollout の行から、このターンの分
  const rows = [
    rl.taskStarted(OTHER),
    rl.codeCall(OTHER, 'call_old', script), rl.codeOutput(OTHER, 'call_old', policyRejection(script)),
    rl.taskComplete(OTHER),
    rl.taskStarted(TURN), rl.userMessage(TURN, 'x'),
    rl.codeCall(TURN, 'call_code', script), rl.codeOutput(TURN, 'call_code', policyRejection(script)),
    rl.directCall(TURN, 'call_direct', 'Stop-Process -Id 42'), rl.directOutput(TURN, 'call_direct', policyRejection('Stop-Process -Id 42', { shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })),
    rl.waitCall(TURN, 'call_wait'), rl.waitOutput(TURN, 'call_wait', spawnRejection()),
    rl.directCall(TURN, 'call_spawn', 'git status'), rl.directOutput(TURN, 'call_spawn', spawnRejection('SetTokenInformation(TokenDefaultDacl) failed: 1344')),
    rl.codeCall(TURN, 'call_quote', 'gh issue view 24'), rl.quotedOutput(TURN, 'call_quote', policyRejection(script)),
    rl.assistant(TURN, 'done'), rl.taskComplete(TURN),
  ];
  const got = rejectionsFromRollout([...text(rows), '{"broken', 'not json'], TURN);
  const by = id => got.rejections.find(r => r.callId === id);
  t.ok('このターンの分だけ（前のターンの拒否・引用だけの出力は入らない）', got.rejections.map(r => r.callId).join() === 'call_code,call_direct,call_wait,call_spawn' && got.complete && got.pending === 0,
    JSON.stringify(got.rejections.map(r => r.callId)));
  t.ok('code mode の exec（custom_tool_call_output）', by('call_code')?.via === 'code_mode' && by('call_code').kind === 'policy' && by('call_code').command === script
    && by('call_code').tool === 'exec_command' && by('call_code').turnId === TURN && by('call_code').shell === 'powershell.exe');
  t.ok('直接の exec_command（function_call_output）', by('call_direct')?.via === 'direct' && by('call_direct').command === 'Stop-Process -Id 42' && by('call_direct').shell === 'pwsh.exe');
  t.ok('code mode の wait（function_call_output に Script error）', by('call_wait')?.via === 'code_mode' && by('call_wait').kind === 'spawn' && by('call_wait').reason.includes('os error 267'));
  t.ok('直接の exec_command のプロセス作成の失敗は、コマンドを引数から取る', by('call_spawn')?.via === 'direct' && by('call_spawn').kind === 'spawn' && by('call_spawn').command === 'git status');
  t.ok('ターンを絞らなければ全部', rejectionsFromRollout(text(rows), null).rejections.length === 5);
  const pendingRows = rejectionsFromRollout(text([rl.taskStarted(TURN), rl.codeCall(TURN, 'c1', script)]), TURN);
  t.ok('呼び出しに出力がまだ無ければ pending、終わりの行が無ければ complete ではない', pendingRows.pending === 1 && !pendingRows.complete);
  const noMeta = rows.map(r => r.type === 'response_item' ? { ...r, payload: { ...r.payload, internal_chat_message_metadata_passthrough: undefined } } : r);
  t.ok('形が変わった（ターンの印が無い）行からは何も拾わない', rejectionsFromRollout(text(noMeta), TURN).rejections.length === 0);

  // ---- ファイルから読む
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-codex-rollout-'));
  try {
    const file = path.join(dir, 'rollout-test.jsonl');
    t.ok('thread.path は絶対パスだけ', rolloutPathOf({ thread: { path: file } }) === file && rolloutPathOf({ thread: { path: 'rel/x.jsonl' } }) === null && rolloutPathOf({ thread: {} }) === null);
    t.ok('まだ無いファイルの長さは 0（最初のターンでできる）', await rolloutSize(file) === 0 && await rolloutSize(null) === null);
    await fs.writeFile(file, jsonl(rows.slice(0, 4)));
    const from = await rolloutSize(file);
    await fs.writeFile(file, jsonl(rows.slice(0, 4)) + jsonl(rows.slice(4)) + '{"type":"response_item","payload":{"type":"custom_tool_call_output"');
    const read = await readTurnRejections({ file, from, turnId: TURN, waits: [] });
    t.ok('turn/start の前の長さから後だけを読む（書きかけの最後の行は捨てる）', read.map(r => r.callId).join() === 'call_code,call_direct,call_wait,call_spawn', JSON.stringify(read.map(r => r.callId)));
    // 書き込みが遅れる: 出力とターンの終わりの行が後から来る
    const late = path.join(dir, 'rollout-late.jsonl');
    await fs.writeFile(late, jsonl([rl.taskStarted(TURN), rl.codeCall(TURN, 'call_late', script)]));
    setTimeout(() => { void fs.appendFile(late, jsonl([rl.codeOutput(TURN, 'call_late', policyRejection(script)), rl.taskComplete(TURN)])); }, 80);
    const waited = await readTurnRejections({ file: late, from: 0, turnId: TURN, waits: [50, 100, 200, 400] });
    t.ok('出力の行がまだ無ければ少し待って読み直す', waited.length === 1 && waited[0].callId === 'call_late');
    t.ok('読めない・渡すものが無いときは黙って []', (await readTurnRejections({ file: path.join(dir, 'missing.jsonl'), from: 0, turnId: TURN })).length === 0
      && (await readTurnRejections({ file: null, from: 0, turnId: TURN })).length === 0 && (await readTurnRejections({ file, from: null, turnId: TURN })).length === 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }

  // ---- 依頼元へ渡す文の伏せ方
  const cmd = 'curl -H "Authorization: Bearer abcDEF0123456789" "https://alice:hunter2@api.example.invalid/v1?key=s3cr3t&page=2#top" && echo sk-proj-AbCdEf0123456789XYZ ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 github_pat_11ABCDEFG0123456789_abcdefghijklmnop';
  const red = redactSecrets(cmd);
  t.ok('URL の userinfo とクエリの値を伏せる（キーとフラグメントは残す）', red.includes('https://***@api.example.invalid/v1?key=***&page=***#top') && !red.includes('hunter2') && !red.includes('s3cr3t'), red);
  t.ok('Bearer・sk-・ghp_・github_pat_ を伏せる', red.includes('Bearer ***') && red.includes('sk-***') && red.includes('ghp_***') && red.includes('github_pat_***')
    && !/abcDEF0123456789|AbCdEf0123456789|ABCDEFGHIJKLMNOP|11ABCDEFG/.test(red), red);
  const named = redactSecrets('mysql --password=pw123 -u root; {"api_key": "zzz"}; export CLIENT_SECRET=abc');
  t.ok('名前付きの値（password= / "api_key": / CLIENT_SECRET=）を伏せる', named === 'mysql --password=*** -u root; {"api_key": "***"}; export CLIENT_SECRET=***', named);
  t.ok('秘密の無い文は変えない', redactSecrets("Remove-Item -LiteralPath 'C:\\work\\a.txt' -Force") === "Remove-Item -LiteralPath 'C:\\work\\a.txt' -Force");
  const long = redactForPeer('x'.repeat(298) + ' sk-abcdefghijklmnop0123', 300);
  t.ok('伏せてから長さを切る（途中で切れたトークンを残さない）', long.length === 301 && long.endsWith('…') && !long.includes('abcdefghij'), long.slice(-20));
  t.ok('文字列でなければ null', redactForPeer(null) === null && redactForPeer(undefined) === null);

  // ---- 子への指示（Codex の子だけ）
  const list = normalizePlyInstructions(undefined);
  const item = resolvePlyInstructions(list, 'ja').find(i => i.id === 'codexPolicy');
  t.ok('既定の項目 codexPolicy は委譲された会話・Codex だけ', item?.tag === 'default' && item.target === 'child' && item.agents.join() === 'codex' && item.body === agentT('ja', 'guide.codexPolicy'));
  const forCodexChild = turnInstructions({ list, locale: 'ja', child: true, routing: true, supported: true, canDelegate: true, agent: 'codex' });
  const forClaudeChild = turnInstructions({ list, locale: 'ja', child: true, routing: true, supported: true, canDelegate: true, agent: 'claude' });
  const forCodexParent = turnInstructions({ list, locale: 'ja', child: false, routing: true, supported: true, canDelegate: true, agent: 'codex' });
  t.ok('Codex の子には入り、Claude の子・依頼元には入らない', forCodexChild.find(r => r.id === 'codexPolicy')?.inserted === true
    && forClaudeChild.find(r => r.id === 'codexPolicy')?.reason === 'agent' && forCodexParent.find(r => r.id === 'codexPolicy')?.reason === 'target');
  t.ok('前の版で委譲の指示を切っていても codexPolicy は入れたまま', normalizePlyInstructions(undefined, { delegation: false }).find(i => i.id === 'codexPolicy')?.on === true);
  t.ok('保存済みの並びに無ければ既定の位置に足す', normalizePlyInstructions({ items: [{ id: 'delegate', on: true }, { id: 'child', on: false }] }).map(i => i.id).join() === 'delegate,child,codexPolicy');
  const same = changePlyInstructions(list, { action: 'save', id: 'codexPolicy', name: item.name, body: item.body, target: 'child', agents: ['codex'] }, 'ja');
  const both = changePlyInstructions(list, { action: 'save', id: 'codexPolicy', name: item.name, body: item.body, target: 'child', agents: ['claude', 'codex'] }, 'ja');
  t.ok('既定と同じ値（Codex だけ）で保存しても「既定から変更」にしない。Claude も選ぶと変更', !resolvePlyInstructions(same, 'ja').find(i => i.id === 'codexPolicy').modified
    && resolvePlyInstructions(both, 'ja').find(i => i.id === 'codexPolicy').modified);
}
