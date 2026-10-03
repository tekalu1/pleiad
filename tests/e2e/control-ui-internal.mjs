// 実際の Codex 会話から、画面の中だけ（ui-internal）から移した操作（ADR 0096）を ply_control の call_op で呼ぶ。
//   1. context.scan（コンテキストの中身を見る）: 作業場所の AGENTS.md の本文が返りに入る
//   2. sessions.switchBackend（guarded。バックエンドの切り替え）: 承認待ちで返り、会話に承認カード。許可すると別の会話のエージェントが替わり、結果が会話に届く
//   3. shell.run（guarded。会話のシェルでコマンドを動かす）: 承認待ち → 許可で、別の会話のシェルで動いて行が残る
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'control-ui-internal';
export const title = 'Codex が ply_control の call_op でコンテキストの中身を読み、別の会話のエージェントの切り替えとシェルの実行を承認待ち → 許可で反映する';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex,claude' };

export default async function (t, ctx) {
  // 承認カード（settingChange）は受領証が要るので手で答える。それ以外の承認は通す
  const c = await ctx.open({ onEvent: (ev, api) => { if (ev.type === 'permission' && !ev.settingChange) api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {}); } });
  const marker = `E2E_CONTEXT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const echo = `E2E_SHELL_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  try {
    const backends = (await c.cmd('backends')).map((a) => a.id);
    if (!backends.includes('codex') || !backends.includes('claude')) { t.ok('codex と claude が利用可能', false, backends.join(',')); return; }
    await fs.writeFile(path.join(ctx.work, 'AGENTS.md'), `# e2e\n\nThe project code word is ${marker}.\n`);

    // 切り替えとシェルの対象にする別の会話（Codex。スレッドを作っておく）
    const { sessionId: target } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'auto' });
    const warm = await c.runTurn({ sessionId: target, prompt: 'Reply with the single word OK. Do not use any tools.' }, { ms: 240_000 });
    t.ok('対象の会話（Codex）のターンが完了した', warm.outcome === 'ok', warm.outcome);

    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'auto' });
    const backendOf = async (id) => (await c.cmd('listSessions', {})).find((s) => s.id === id)?.backend;

    // 1. コンテキストの中身を見る
    const read = await c.runTurn({ sessionId,
      prompt: 'Pleiad の ply_control の MCP ツールを使って、call_op で op="context.scan", args={"kind":"instruction","scope":"directory"} を一度だけ呼んでください（cwd は省く）。シェルやファイル操作は使わないでください。返ってきた entries のうち name が AGENTS.md の行の content に書かれている code word を 1 行で答えてください。',
    }, { ms: 240_000 });
    t.ok('Codex のターンが完了した（context.scan）', read.outcome === 'ok', read.outcome === 'ok' ? '' : JSON.stringify(read.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1500));
    const scanned = read.events.some((e) => e.type === 'tool.start' && e.input?.server === 'ply_control' && e.input?.tool === 'call_op' && e.input?.arguments?.op === 'context.scan');
    t.ok('Codex が ply_control の call_op で context.scan を呼んだ', scanned, scanned ? '' : JSON.stringify(read.events.filter((e) => e.type === 'tool.start')).slice(0, 800));
    const scanResults = JSON.stringify(read.events.filter((e) => e.type === 'tool.result'));
    t.ok('context.scan の返りに作業場所の AGENTS.md の本文（code word）が入る', scanResults.includes(marker) && scanResults.includes('AGENTS.md'), scanResults.slice(0, 600));

    // 承認待ち → 許可 → 反映 → 結果が会話に届き、Codex が答える
    const approveFlow = async (op, prompt, reflected) => {
      const from = c.mark();
      const asked = await c.runTurn({ sessionId, prompt }, { ms: 240_000 });
      const card = c.since(from).find((e) => e.type === 'permission' && e.settingChange && e.sessionId === sessionId);
      const pending = JSON.stringify(asked.events.filter((e) => e.type === 'tool.result'));
      t.ok(`${op} は承認を待たずに承認待ち（PENDING_APPROVAL）で返り、ターンが終わった`, asked.outcome === 'ok' && pending.includes('PENDING_APPROVAL') && pending.includes(card?.settingChange?.requestId ?? '-'),
        `${asked.outcome} ${pending.slice(0, 400)}`);
      t.ok(`会話に承認カード（${op}・前後の行・説明）が出て、まだ反映されていない`, card?.settingChange?.op === op && card.settingChange.rows.length > 0 && Boolean(card.settingChange.note) && !(await reflected()),
        JSON.stringify(card?.settingChange));
      if (!card) return;
      const after = c.mark();
      await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
      const notice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === sessionId && String(e.text).includes(card.settingChange.requestId), { from: after, ms: 90_000 }).catch(() => null);
      t.ok(`許可すると反映され、結果（許可）の通知が会話に届く（${op}）`, (await reflected()) && /結果: 許可/.test(notice?.text ?? ''), notice?.text);
      const ended = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: after, ms: 240_000 }).catch(() => null);
      t.ok(`通知で始まったターンで Codex が答えた（${op}）`, ended?.outcome === 'ok', JSON.stringify(ended));
      const changes = await c.cmd('sessionChanges', { sessionId });
      t.ok(`会話の記録に、呼んだ操作（${op}）が agent として残る`, changes.changes.some((x) => x.field === 'op' && x.to === op && x.by === 'agent'));
    };

    // 2. バックエンドの切り替え（guarded）
    await approveFlow('sessions.switchBackend',
      `Pleiad の ply_control の call_op で op="sessions.switchBackend", args={"sessionId":"${target}","backend":"claude","reason":"e2e の確認"} を一度だけ呼び、返りの status を 1 行で書いてターンを終えてください。承認を待ったり、同じ呼び出しを繰り返したりしないでください。シェルやファイル操作は使わないでください。`,
      async () => (await backendOf(target)) === 'claude');

    // 3. 会話のシェルでコマンドを動かす（guarded）
    const shellRow = async () => (await c.cmd('loadSession', { sessionId: target })).messages.find((m) => m.kind === 'shell' && String(m.command).includes(echo));
    await approveFlow('shell.run',
      `Pleiad の ply_control の call_op で op="shell.run", args={"sessionId":"${target}","command":"echo ${echo}","reason":"e2e の確認"} を一度だけ呼び、返りの status を 1 行で書いてターンを終えてください。承認を待ったり、同じ呼び出しを繰り返したりしないでください。シェルやファイル操作は使わないでください。`,
      async () => Boolean(await shellRow()));
    const row = await shellRow();
    t.ok('シェルの行は対象の会話に残り、出力と終了コード 0 を持つ', row?.exitCode === 0 && String(row.stdout).includes(echo), JSON.stringify(row));
  } finally {
    c.close();
  }
}
