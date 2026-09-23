// 会話ごとのコンテキストの操作（会話の右パネル「この会話のコンテキスト」が使う）。
// 記録は store の contextSession（{ policy, pin, report, delivered }。core/server.mjs の runTurn が書く）。
//
// - refresh: 開始後に変わった指示・Skills を、今までのやり取りを引き継いだまま読み込み直す（pin を今の内容で取り直す）
// - diff:    開始時の内容（スナップショット）と今の内容
// - setMcp:  「この会話では外す」。方針（policy.removedMcp）に残し、次のターンから接続しない
// - agentMcp: エージェント任せの MCP。各エージェントの設定に登録されているもの（読むだけ。接続はしない）
import fs from 'node:fs/promises';
import { scanContext } from './context-scan.mjs';
import { KINDS } from './context-settings.mjs';
import { pinChanges, readSnapshot, resolveRuntime } from './context-runtime.mjs';
import { t } from './i18n.mjs';

const MAX_TEXT = 256 * 1024;
const NAME = /^[a-zA-Z0-9_.-]{1,128}$/;

export function createContextSession({ store, snapshots, plyServers = async () => null, liveRecord = () => null, isRunning = () => false, scanOptions = {} }) {
  async function saved(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error(t('context.session.sessionRequired'));
    const record = (await store.get(sessionId)).contextSession;
    if (!record?.report) throw new Error(t('context.session.noRecord'));
    return record;
  }

  /** 指示・Skills を読み込み直す。返答中は受け付けない（ターンの終わりに古い記録で上書きされるため） */
  async function refresh(sessionId) {
    const record = await saved(sessionId);
    if (!record.pin) throw new Error(t('context.session.notManaged'));
    if (isRunning(sessionId)) throw new Error(t('context.session.busy'));
    const runtime = await resolveRuntime(record.policy, { ...scanOptions, plyServers: await plyServers(), snapshots });
    // MCP は次のターンでつなぎ直す。それまでは直前のターンの様子（接続中・要ログイン・失敗と回数）を残す
    const before = new Map((record.report?.entries ?? []).filter(e => e.kind === 'mcp').map(e => [e.id, e]));
    for (const row of runtime.report.entries) {
      const was = before.get(row.id);
      if (row.kind !== 'mcp' || row.status !== 'pending' || !was || !['connected', 'needs-auth', 'failed'].includes(was.status)) continue;
      for (const k of ['status', 'reason', 'reasonCode', 'tools', 'calls', 'capabilities']) if (was[k] !== undefined) row[k] = was[k];
    }
    // 渡し済みの控え（delivered）は引き継がない。読み込み直した後は instructions_for_path / load_skill が本文をもう一度渡す
    const next = { policy: { ...record.policy, refreshedAt: new Date().toISOString() }, pin: runtime.pin, report: runtime.report };
    await store.setSessionData(sessionId, 'contextSession', next);
    return next;
  }

  /** 開始時と今の中身。開始時の中身が残っていないもの（この版より前に始めた会話）は before が null で beforeMissing */
  async function diff(sessionId) {
    const record = await saved(sessionId);
    const changed = await pinChanges(record, scanOptions);
    if (!changed?.differs) return { files: [] };
    const files = await Promise.all(changed.files.map(async f => {
      const before = f.before ? await readSnapshot(snapshots, f.before) : null;
      let after = null;
      if (f.after) {
        const stat = await fs.stat(f.path).catch(() => null);
        after = stat && stat.size <= MAX_TEXT ? (await fs.readFile(f.path, 'utf8').catch(() => null))?.replace(/^﻿/, '') ?? null : null;
      }
      return { path: f.path, name: f.name, kind: f.kind, modifiedAt: f.modifiedAt ?? null, before, after, beforeMissing: Boolean(f.before) && before === null, removed: !f.after };
    }));
    return { files };
  }

  /**
   * 「この会話では外す」（removed: true）/ 戻す（false）。走っているターンがあればその記録も同じに直す
   * （ターンの終わりに記録を書き戻すので、片方だけ直すと戻ってしまう）
   */
  async function setMcp(sessionId, name, removed) {
    if (typeof name !== 'string' || !NAME.test(name)) throw new Error(t('context.session.invalidMcpName'));
    const live = liveRecord(sessionId);
    const record = live ?? await saved(sessionId);
    const list = new Set(record.policy?.removedMcp ?? []);
    if (removed) list.add(name); else list.delete(name);
    record.policy = { ...record.policy, removedMcp: [...list].sort() };
    for (const row of record.report?.entries ?? []) {
      if (row.kind !== 'mcp' || row.name !== name) continue;
      if (removed && row.status !== 'shadowed' && row.status !== 'excluded' && row.status !== 'disabled') { row.status = 'removed'; row.reason = t('context.removedHere'); row.tools = 0; }
      else if (!removed && row.status === 'removed') { row.status = 'pending'; row.reason = t('context.session.reconnectNext'); }
    }
    await store.setSessionData(sessionId, 'contextSession', record);
    return record;
  }

  /**
   * 各エージェントの設定に登録されている外部 MCP（Claude・Codex）。担当がエージェントのときに見比べる用。
   * 探索の設定（探す形式・除外）には従わず、登録されているものをそのまま並べる。接続・起動はしない
   */
  async function agentMcp(cwd) {
    const scope = { sources: ['claude', 'codex'], excludePaths: [] };
    const kinds = Object.fromEntries(KINDS.map(k => [k, k === 'mcp' ? scope : null]));
    const scan = await scanContext({ cwd, plan: { user: { roots: [], kinds }, directory: { roots: [], kinds }, mcp: { disabled: [], prefer: {} } } }, scanOptions);
    const agents = { claude: [], codex: [] };
    for (const e of scan.entries) {
      if (e.kind !== 'mcp') continue;
      for (const source of new Set(e.origins.map(o => o.source))) {
        if (!agents[source] || agents[source].some(s => s.name === e.name)) continue;
        agents[source].push({ name: e.name, transport: e.transport, endpoint: e.endpoint ?? null, command: e.command ?? null, path: e.path, scope: e.scope, disabled: e.status === 'disabled' });
      }
    }
    return { cwd: scan.cwd, agents, diagnostics: scan.diagnostics };
  }

  return { refresh, diff, setMcp, agentMcp };
}
