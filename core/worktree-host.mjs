// worktree を、ホストの会話・委譲・画面につなぐ層（docs/design.md「worktree」、ADR 0089）。
// core/worktrees.mjs（台帳・作成・片付け）は会話を知らない。ここが「使っているもの」「ぶつかり」「委譲で isolate が指定されたか」「画面に出す残り」を決める。
// 依存（会話の一覧・走っているターン・委譲の台帳）は引数で受けるので、サーバーなしで試せる。
import fs from 'node:fs/promises';
import * as git from './git-info.mjs';
import { createWorktrees, insideDir, sameDir, publicEntry } from './worktrees.mjs';
import { archiveMeta } from './git-worktree.mjs';
import { modePosition, scopeRank } from './modes.mjs';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
const ROOT_TTL_MS = 3_000;
/** 子の作業場所を作ってから、委譲の台帳に子が載るまでの間（この間は片付けない） */
const TASK_START_MS = 120_000;

/** 書き込みの範囲（読むだけより上）か。モードの宣言から */
export const writesScope = (entry) => scopeRank(modePosition(entry).scope) > scopeRank('readonly');

export function createWorktreeHost({ dataDir, store, turns, shellCwds = () => [], tasks = () => [], background = () => new Map(), emit = () => {},
  reason = () => ({}), now = Date.now, log = () => {}, worktreeOptions = {} }) {
  const exists = (p) => fs.stat(p).then((s) => s.isDirectory(), () => false);

  // ---------------------------------------------------------------- Git ルート（短いキャッシュ）
  const roots = new Map();
  const ignoring = new Set();   // 片付けの判定から外す委譲タスク（その子が今、終わったところ）
  async function repoOf(cwd) {
    if (!cwd) return null;
    const hit = roots.get(cwd);
    if (hit && now() - hit.at < ROOT_TTL_MS) return hit.value;
    const value = await git.repoInfo(cwd).catch(() => null);
    roots.set(cwd, { at: now(), value });
    if (roots.size > 200) roots.delete(roots.keys().next().value);
    return value;
  }
  const repoDirOf = (info) => (info.commonDir.endsWith('/.git') ? info.commonDir.slice(0, -5) : info.root);

  // ---------------------------------------------------------------- 使っているもの・戻す
  /** 走っているターン・シェル・委譲の子（busy）と、cwd（予約を含む）がその中の会話（attached） */
  async function users(entry, snapshot = null) {
    const busy = [], attached = [];
    for (const turn of turns().values()) if (insideDir(turn.info?.cwd, entry.path)) busy.push(`turn:${turn.info.sessionId ?? turn.key}`);
    for (const cwd of shellCwds()) if (insideDir(cwd, entry.path)) busy.push('shell');
    for (const task of tasks()) if (!ignoring.has(task.taskId) && (ACTIVE.has(task.status) || task.pendingMessages > 0) && insideDir(task.cwd, entry.path)) busy.push(`task:${task.taskId}`);
    // 子の作業場所を作った後、委譲の台帳に子が載る前（準備の途中）は、使っているものとして数える
    if (entry.purpose === 'task' && entry.taskId && !ignoring.has(entry.taskId) && now() - entry.createdAt < TASK_START_MS && !tasks().some((r) => r.taskId === entry.taskId)) busy.push(`task:${entry.taskId}`);
    const all = snapshot ?? await store.getAll();
    for (const [id, s] of Object.entries(all ?? {})) {
      const here = insideDir(s?.cwd, entry.path), reserved = insideDir(s?.nextSettings?.cwd, entry.path);
      if (!here && !reserved) continue;
      attached.push({ sessionId: id, kind: here ? 'cwd' : 'reserved' });
      if (background().get?.(id)?.tasks?.length) busy.push(`background:${id}`);
    }
    return { busy, attached };
  }

  /** 次のターンの予約から cwd を外す。ほかに変える物が無ければ予約ごと消す */
  function withoutReservedCwd(next, current) {
    const { cwd, ...rest } = next;
    const changed = rest.backend !== (current.backend ?? rest.backend) || (rest.model ?? '') !== (current.model ?? '') || (rest.effort ?? '') !== (current.effort ?? '')
      || rest.mode !== undefined || rest.account !== undefined || rest.endpoint !== undefined;
    return changed ? rest : null;
  }

  /** 消す前に、会話の cwd を元の場所へ戻す（履歴に残す）。予約も外す */
  async function release(entry, sessionIds) {
    const origin = (await exists(entry.origin)) ? entry.origin : entry.root;
    for (const id of sessionIds) {
      const s = await store.get(id);
      if (insideDir(s?.cwd, entry.path)) {
        await store.recordChange(id, { by: 'ply', field: 'cwd', from: s.cwd, to: origin, ...reason('worktreeBack') });
        emit({ type: 'cwd', sessionId: id, cwd: origin, by: 'ply', ...reason('worktreeBack') });
      }
      if (s?.nextSettings && insideDir(s.nextSettings.cwd, entry.path)) {
        const next = withoutReservedCwd(s.nextSettings, s);
        await store.setSessionData(id, 'nextSettings', next, { durable: true });
        emit({ type: 'nextSettings', sessionId: id, nextSettings: next });
      }
    }
  }

  const worktrees = createWorktrees({ dataDir, users, release, now, log, ...worktreeOptions });

  // ---------------------------------------------------------------- ぶつかり
  /** 同じ Git ルートで、書き込みの範囲のターンを走らせている別の会話（委譲の子を含む）。圧縮のターンは数えない */
  async function writers({ root, exceptSession = null }) {
    const out = [];
    for (const turn of turns().values()) {
      const sid = turn.info?.sessionId;
      if (turn.compactTrigger || !turn.info?.cwd || (sid && sid === exceptSession)) continue;
      if (!writesScope(turn.backend?.modes?.()?.[turn.info.mode])) continue;
      const info = await repoOf(turn.info.cwd);
      if (!info || !sameDir(info.root, root)) continue;
      const meta = sid ? await store.get(sid).catch(() => null) : null;
      out.push({ sessionId: sid ?? null, title: meta?.title ?? '', child: Boolean(meta?.delegation) });
    }
    return out;
  }

  /**
   * 入力欄の注記の元。cwd が git で、まだ worktree の中でなければ canSplit。conflicts は書き込み中の別の会話。
   * writes は今の会話の承認モードが書き込みの範囲か（読むだけの会話には何も出さない）
   */
  async function check({ sessionId = null, cwd, writes = true }) {
    const info = await repoOf(cwd);
    if (!info) return { git: false, current: null, conflicts: [], canSplit: false };
    const current = await worktrees.byPath(cwd);
    const conflicts = current || !writes ? [] : await writers({ root: info.root, exceptSession: sessionId });
    return { git: true, current: current ? publicEntry(current) : null, conflicts, canSplit: !current };
  }

  /** 人が分ける（または確認なしで分ける）。作った worktree の cwd を返す */
  async function split({ cwd, sessionId = null, purpose = 'conversation', parentSessionId = null, taskId = null }) {
    const made = await worktrees.create({ cwd, sessionId, parentSessionId, taskId, purpose });
    if (!made.ok) return made;
    return { ok: true, entry: publicEntry(made.entry), cwd: worktrees.cwdOf(made.entry) };
  }

  // ---------------------------------------------------------------- 委譲
  /** isolate: true が指定され、git の場所で作成が有効なときだけ分ける。 */
  async function decideIsolation({ cwd, isolate }) {
    if (isolate !== true) return { isolate: false, why: isolate === false ? 'explicit' : 'not-requested' };
    if (worktreeOptions.disabled) return { isolate: false, why: 'disabled' };
    const info = await repoOf(cwd);
    if (!info) return { isolate: false, why: 'not-git' };
    return { isolate: true, why: 'explicit' };
  }

  /** 子の作業場所を作る。作れなければ null（子は元の場所で走る。理由は reason に） */
  async function createForTask({ cwd, owner, taskId, sessionId = null }) {
    const made = await worktrees.create({ cwd, sessionId, parentSessionId: owner, taskId, purpose: 'task', nested: true });
    if (!made.ok) return { ok: false, reason: made.reason, error: made.error ?? null };
    return { ok: true, entry: made.entry, cwd: worktrees.cwdOf(made.entry) };
  }

  /**
   * 子の作業場所の今の状態（完了通知・ply_task_status・委譲カード）。
   * state: unmerged（取り込まれていない）/ merged / empty / unknown / gone（もう無い）。files は未取り込みのときのベースとの差
   */
  async function taskState(wt) {
    if (!wt?.id) return null;
    const entry = await worktrees.get(wt.id);
    if (!entry) return { ...wt, state: 'gone', files: 0 };
    const info = await worktrees.inspect(entry, { files: true });
    const kind = worktrees.classify(info);
    return { id: entry.id, branch: entry.branch, path: entry.path, origin: entry.origin, baseBranch: entry.baseBranch ?? null, state: kind === 'missing' ? 'gone' : kind,
      files: info.files ?? info.dirty ?? 0, ahead: info.ahead ?? 0, dirty: info.dirty ?? 0 };
  }

  /** 子が終わった。変わっていなければ・取り込み済みなら片付け、そうでなければ残す。子の会話の cwd は消すときに元の場所へ戻す。状態は片付ける前のもの */
  async function taskDone(task) {
    if (!task?.worktree?.id) return null;
    const before = await taskState(task.worktree);
    // 台帳の子のタスクはまだ「走っている」ことになっている（終わりはこの後に書かれる）。自分自身を使っているものに数えない
    ignoring.add(task.taskId);
    let settled;
    try { settled = await worktrees.settle(task.worktree.id, { release: [task.sessionId] }); }
    finally { ignoring.delete(task.taskId); }
    if (settled.action === 'removed') return { ...before, removed: true };
    // 消せなかった（掴まれている・外せないリンク）ものを「片付けた」と言わない
    const state = before?.state === 'empty' || before?.state === 'merged' ? 'unknown' : before?.state;
    return { ...before, state, removed: false, ...(settled.action === 'failed' ? { failed: settled.why } : {}) };
  }

  // ---------------------------------------------------------------- 画面（git パネル）
  /** 右パネルの「残っている worktree」。使っているもの・今いる場所・自動で消えるものは出さない */
  async function leftovers({ cwd }) {
    const info = await repoOf(cwd);
    if (!info) return [];
    const repoDir = repoDirOf(info);
    const snapshot = await store.getAll();
    const mine = (await worktrees.list()).filter((e) => e.state === 'ready' && sameDir(e.repoDir, repoDir) && !insideDir(cwd, e.path));
    // 1 つずつ数十 ms の git を何本も呼ぶので、作業場所ごとに並べて走らせる
    const rows = (await Promise.all(mine.map(async (e) => {
      const u = await users(e, snapshot);
      if (u.busy.length || (e.purpose === 'conversation' && u.attached.length)) return null;
      const state = await worktrees.inspect(e, { files: true });
      const kind = worktrees.classify(state);
      if (kind === 'empty' || kind === 'merged' || kind === 'missing') return null;
      // 取り込みを頼む会話。消した会話（sessions.delete。ADR 0147）は頼めない（画面は「取り込みを頼む」を押せなくする）
      const mergeSessionId = (e.purpose === 'task' ? e.parentSessionId : e.sessionId) ?? e.sessionId ?? e.parentSessionId ?? null;
      return { id: e.id, branch: e.branch, path: e.path, origin: e.origin, baseBranch: e.baseBranch ?? null, purpose: e.purpose, kept: e.kept,
        files: state.files ?? null, fileNames: state.fileList ?? [], at: state.at ?? e.createdAt, kind, mergeSessionId: mergeSessionId && snapshot[mergeSessionId] ? mergeSessionId : null };
    }))).filter(Boolean);
    return rows.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  }

  /**
   * 全部の片付け。終わったタスク（取り消した・失敗したものを含む）の作業場所は、子の会話の cwd を元の場所へ戻して判定し、
   * 残りは使っているものがあれば残す（worktrees.sweep）
   */
  async function sweep({ root = null } = {}) {
    const rows = tasks();
    for (const e of await worktrees.list()) {
      if (e.purpose !== 'task' || e.state !== 'ready' || e.kept || (root && !sameDir(e.root, root)) || now() - e.createdAt < (worktreeOptions.graceMs ?? 60_000)) continue;
      const row = rows.find((r) => r.taskId === e.taskId);
      if (row && (ACTIVE.has(row.status) || row.pendingMessages > 0)) continue;
      await worktrees.settle(e.id, { release: row?.sessionId ? [row.sessionId] : [] });
    }
    return worktrees.sweep({ root });
  }

  /** 委譲の準備に失敗した。作ったばかりの子の作業場所を、準備中の印を外して片付ける（変更が無ければ消える） */
  async function abandon(id) {
    const entry = await worktrees.get(id);
    if (!entry) return { action: 'skip' };
    if (entry.taskId) ignoring.add(entry.taskId);
    try { return await worktrees.settle(id, { release: entry.sessionId ? [entry.sessionId] : [] }); }
    finally { if (entry.taskId) ignoring.delete(entry.taskId); }
  }

  /**
   * 退避から作業場所を作り直す（「元に戻す」）。退避の隠し ref のコミットから、新しい worktree を作る
   * （作業ツリー全体が 1 つのコミットになった状態。ベースは元のまま）。ref は refs/pleiad/archive/ だけ
   */
  async function restore({ cwd, ref }) {
    if (!String(ref ?? '').startsWith(git.ARCHIVE_PREFIX)) return { ok: false, reason: 'git', error: 'not an archive' };
    const info = await repoOf(cwd);
    if (!info) return { ok: false, reason: 'not-git' };
    const tip = await git.readGit(info.root, ['rev-parse', '--verify', '-q', ref]);
    const commit = tip.ok ? tip.stdout.trim() : null;
    if (!commit) return { ok: false, reason: 'git', error: 'archive not found' };
    const meta = await archiveMeta(info.root, commit) ?? {};
    const origin = meta.origin && await exists(meta.origin) ? meta.origin : info.root;
    const made = await worktrees.create({ cwd: origin, purpose: meta.purpose === 'task' ? 'task' : 'conversation', sessionId: meta.sessionId || null,
      parentSessionId: meta.parentSessionId || null, taskId: meta.taskId || null, nested: true, from: { startPoint: commit, base: meta.base || undefined, baseBranch: meta.baseBranch || null } });
    if (!made.ok) return made;
    return { ok: true, entry: publicEntry(made.entry), cwd: worktrees.cwdOf(made.entry) };
  }

  /** 退避して消す。使っている会話が無ければ（委譲の子の会話は戻して）消す */
  async function archive(id) {
    const entry = await worktrees.get(id);
    if (!entry) return { action: 'skip' };
    const u = await users(entry);
    return worktrees.archive(id, { release: entry.purpose === 'task' ? u.attached.map((a) => a.sessionId) : [] });
  }

  return { worktrees, users, release, check, split, writers, decideIsolation, createForTask, taskState, taskDone, leftovers, archive, restore, abandon, sweep, repoOf, repoDirOf };
}
