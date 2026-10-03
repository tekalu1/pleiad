// 実際の Codex 会話から、MCP の操作（ADR 0095）を ply_control の call_op で呼ぶ。
//   1. mcp.nativeRead: 作業場所の .mcp.json の登録を読む。env の値・引数の --token の値は伏せ字で返り、目印はツールの返りにも答えにも出ない
//   2. mcp.save（guarded）: 承認が要る会話（auto）では待たずに承認待ちで返り、会話に承認カードが出る。許可すると登録され、結果が会話に届いて Codex が答える
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'control-mcp-hooks';
export const title = 'Codex が ply_control の call_op で MCP の登録を読み（秘密は伏せ字）、mcp.save の承認待ちが許可で反映されて結果が会話に届く';
export const serverEnv = { AGENT_HOST_BACKENDS: 'codex' };

export default async function (t, ctx) {
  // 承認カード（settingChange）は受領証が要るので手で答える。それ以外の承認は通す
  const c = await ctx.open({ onEvent: (ev, api) => { if (ev.type === 'permission' && !ev.settingChange) api.cmd('resolvePermission', { id: ev.id, allow: true }).catch(() => {}); } });
  const marker = `E2E_SECRET_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  try {
    if (!(await c.cmd('backends')).some((a) => a.id === 'codex')) { t.ok('codex が利用可能', false); return; }
    await fs.writeFile(path.join(ctx.work, '.mcp.json'), JSON.stringify({ mcpServers: {
      'e2e-secret': { type: 'stdio', command: 'node', args: ['server.js', '--token', marker], env: { API_KEY: marker } },
    } }, null, 2));

    // 1. 読む（秘密は伏せ字）
    const { sessionId } = await c.cmd('newSession', { backend: 'codex', cwd: ctx.work, mode: 'auto' });
    const read = await c.runTurn({ sessionId,
      prompt: 'Pleiad の ply_control の MCP ツールを使って、call_op で op="mcp.nativeRead", args={"format":"claude","scope":"directory","name":"e2e-secret"} を一度だけ呼んでください（cwd は省く）。シェルやファイル操作は使わないでください。返ってきた value の args と env をそのまま 1 行ずつ書き写してください。',
    }, { ms: 240_000 });
    t.ok('Codex のターンが完了した', read.outcome === 'ok', read.outcome === 'ok' ? '' : JSON.stringify(read.events.filter((e) => e.error || e.type === 'turnResult')).slice(-1500));
    const called = read.events.some((e) => e.type === 'tool.start' && e.input?.server === 'ply_control' && e.input?.tool === 'call_op' && e.input?.arguments?.op === 'mcp.nativeRead');
    t.ok('Codex が ply_control の call_op で mcp.nativeRead を呼んだ', called, called ? '' : JSON.stringify(read.events.filter((e) => e.type === 'tool.start')).slice(0, 800));
    const results = JSON.stringify(read.events.filter((e) => e.type === 'tool.result'));
    const reply = (await c.cmd('loadSession', { sessionId })).messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
    t.ok('返りに登録が入っていて、env と --token の値は伏せ字（••••）', results.includes('server.js') && results.includes('••••'), results.slice(0, 600));
    t.ok('秘密の目印はツールの返りにも Codex の答えにも出ない', !results.includes(marker) && !reply.includes(marker), reply.slice(-400));

    // 2. guarded: 承認待ち → 許可 → 反映 → 結果が会話に届く
    const from = c.mark();
    const asked = await c.runTurn({ sessionId,
      prompt: 'Pleiad の ply_control の call_op で op="mcp.save", args={"name":"e2e-tool","mode":"add","value":{"transport":"stdio","command":"node","args":["tool.js"]},"reason":"e2e の確認"} を一度だけ呼び、返りの status を 1 行で書いてターンを終えてください。承認を待ったり、同じ呼び出しを繰り返したりしないでください。シェルやファイル操作は使わないでください。',
    }, { ms: 240_000 });
    const card = c.since(from).find((e) => e.type === 'permission' && e.settingChange && e.sessionId === sessionId);
    const pending = JSON.stringify(asked.events.filter((e) => e.type === 'tool.result'));
    t.ok('mcp.save は承認を待たずに承認待ち（PENDING_APPROVAL）で返り、ターンが終わった', asked.outcome === 'ok' && pending.includes('PENDING_APPROVAL') && pending.includes(card?.settingChange?.requestId ?? '-'),
      `${asked.outcome} ${pending.slice(0, 400)}`);
    t.ok('会話に承認カード（mcp.save・前後の行・説明）が出て、まだ登録されていない', card?.settingChange?.op === 'mcp.save' && card.settingChange.rows.length > 0 && Boolean(card.settingChange.note)
      && !(await c.cmd('listPlyMcp', {})).servers.some((s) => s.name === 'e2e-tool'), JSON.stringify(card?.settingChange));
    if (card) {
      const after = c.mark();
      await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
      const notice = await c.waitFor((e) => e.type === 'taskNotice' && e.sessionId === sessionId && String(e.text).includes(card.settingChange.requestId), { from: after, ms: 60_000 }).catch(() => null);
      t.ok('許可すると登録され、結果（許可）の通知が会話に届く', (await c.cmd('listPlyMcp', {})).servers.some((s) => s.name === 'e2e-tool' && s.command === 'node') && /結果: 許可/.test(notice?.text ?? ''), notice?.text);
      const ended = await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: after, ms: 240_000 }).catch(() => null);
      const answered = (await c.cmd('loadSession', { sessionId })).messages;
      const at = answered.findIndex((m) => m.internalTaskNotice && String(m.text).includes(card.settingChange.requestId));
      t.ok('通知で始まったターンで Codex が答えた', ended?.outcome === 'ok' && at >= 0 && answered.slice(at + 1).some((m) => m.role === 'assistant' && m.text),
        JSON.stringify(answered.slice(at >= 0 ? at : -2).map((m) => ({ role: m.role, notice: m.internalTaskNotice, text: String(m.text).slice(0, 160) }))));
      const changes = await c.cmd('sessionChanges', { sessionId });
      t.ok('会話の記録に、呼んだ操作（mcp.save）が agent として残る', changes.changes.some((x) => x.field === 'op' && x.to === 'mcp.save' && x.by === 'agent'));
    }
  } finally {
    await c.cmd('deletePlyMcp', { name: 'e2e-tool' }).catch(() => {});
    c.close();
  }
}
