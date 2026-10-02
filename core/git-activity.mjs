// 会話ごとの git の動き（docs/design.md「git の動き」、ADR 0085）。サーバーが 1 つ持つ。
//
//   - 状態（ブランチ・ahead/behind・変更の数）: cwd ごとに短い TTL のキャッシュ。取り直しは呼び出し側が決める
//   - ターンの始まりと終わりの撮影: 隠し ref refs/pleiad/turn/<会話 id>/<n>-start|end（一時 index → write-tree → commit-tree → update-ref）。
//     「この会話の間」の基準は最初の -start（前のターンの終わりではない。同じ場所でユーザーや別の会話が変えた分を取り込まないため）
//   - ターンの終わりの要約: ファイル・コミット・ブランチ・PR のどれかが動いたときだけ作る（返答の下の 1 行の元）
//   - パネル用の変更の一覧と差分（開いたときだけ）
// 会話ごとに直列化する。git が無い・git 管理外は、どの口も null（画面は「情報なし」）。
import * as git from './git-info.mjs';

const TTL_MS = 2_000;
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const SESSION_RANGES = ['uncommitted', 'session'];

export function createGitActivity({ now = Date.now, pruneAfterMs = PRUNE_AFTER_MS } = {}) {
  const chains = new Map();
  /** 同じ鍵の仕事を順に走らせる（会話ごと。鍵の無いものは cwd） */
  function serial(key, work) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(work, work);
    const tail = next.catch(() => {});
    chains.set(key, tail);
    tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }
  const cache = new Map();
  const pruned = new Set();

  /** 今のブランチと先頭のコミット。変更の数は数えない（ターンの始まりと終わりに使う軽い版） */
  async function readHead(root) {
    const r = await git.readGit(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']);
    if (!r.ok) return { branch: null, detached: false, head: null };
    const s = git.parseStatus(r.stdout);
    return { branch: s.branch, detached: s.detached, head: s.oid };
  }

  /** 状態。fresh でなければ TTL 内の前回の値を返す。git 管理外は null */
  function status(cwd, { fresh = false } = {}) {
    if (!cwd) return Promise.resolve(null);
    const hit = cache.get(cwd);
    if (!fresh && hit && now() - hit.at < TTL_MS) return hit.value;
    const value = serial(`cwd:${cwd}`, async () => {
      const s = await git.readStatus(cwd);
      return s ? { ...s, at: now() } : null;
    });
    cache.set(cwd, { at: now(), value });
    // 失敗（null）は覚えない。git の出入りがすぐ反映されるように
    value.then((v) => { if (!v && cache.get(cwd)?.value === value) cache.delete(cwd); }, () => cache.delete(cwd));
    return value;
  }
  const invalidate = (cwd) => { if (cwd) cache.delete(cwd); else cache.clear(); };

  // ------------------------------------------------------------ ターンの撮影

  /**
   * ターンの始まり。git の作業場所でなければ null。撮影できなかったときも、ブランチと HEAD は控えて要約に使う。
   * ref は会話の id が決まってから attach で書く（新しい会話は最初のターンの途中で決まる）
   */
  async function begin({ cwd }) {
    const info = await git.repoInfo(cwd);
    if (!info) return null;
    const [head, tree] = await Promise.all([readHead(info.root), git.snapshotTree(info.root)]);
    const parent = head.head;
    const commit = tree ? await git.commitTree(info.root, tree, parent) : null;
    return { cwd, root: info.root, linked: info.linked, headStart: head.head, branchStart: head.branch, detachedStart: head.detached,
      startTree: tree, startCommit: commit, n: null, first: false };
  }

  /** 会話の id が分かった。start の ref を書く（二度呼んでも 1 度だけ） */
  function attach(turn, sessionId) {
    if (!turn || !sessionId || turn.n != null) return Promise.resolve(turn);
    return serial(`session:${sessionId}`, async () => {
      if (turn.n != null) return turn;
      const refs = await git.listTurnRefs(turn.root, sessionId);
      turn.n = refs.reduce((m, r) => Math.max(m, r.n), 0) + 1;
      turn.first = refs.length === 0;
      if (turn.startCommit) await git.updateRef(turn.root, git.refName(sessionId, turn.n, 'start'), turn.startCommit);
      return turn;
    });
  }

  /**
   * ターンの終わり。何も動かなければ null（その場合、最初でない start の ref は消す）。
   * 動いていれば end の ref を書き、返答の下の 1 行の元になる要約を返す。events は git-timeline の createCallTracker().events()
   */
  async function finish(turn, sessionId, events = []) {
    if (!turn) return null;
    await attach(turn, sessionId);
    return serial(`session:${sessionId ?? turn.root}`, async () => {
      const [head, tree] = await Promise.all([readHead(turn.root), git.snapshotTree(turn.root)]);
      invalidate(turn.cwd);
      const endCommit = tree ? await git.commitTree(turn.root, tree, head.head) : null;
      const diff = turn.startTree && tree ? await git.diffFiles(turn.root, turn.startTree, tree) : null;
      const moved = head.head !== turn.headStart;
      const since = moved ? await git.commitsSince(turn.root, turn.headStart) : { count: 0, commits: [] };
      const switched = head.branch !== turn.branchStart || head.detached !== turn.detachedStart;
      const pr = [...events].reverse().find((e) => e.kind === 'pr') ?? null;
      const created = events.some((e) => e.kind === 'branch');
      const total = diff?.total ?? { files: 0, add: 0, del: 0 };
      const changed = total.files > 0 || since.count > 0 || switched || created || Boolean(pr);
      if (turn.n != null && sessionId) {
        if (changed && endCommit) await git.updateRef(turn.root, git.refName(sessionId, turn.n, 'end'), endCommit);
        else if (!changed && !turn.first) await git.deleteRefs(turn.root, [git.refName(sessionId, turn.n, 'start')]);
      }
      if (!pruned.has(turn.root)) { pruned.add(turn.root); git.pruneTurnRefs(turn.root, pruneAfterMs, now()).catch(() => {}); }
      if (!changed) return null;
      return {
        branch: head.branch, detached: head.detached, head: head.head ? head.head.slice(0, 7) : null, linked: turn.linked,
        files: total.files, add: total.add, del: total.del,
        commits: since.commits.slice(0, 5).map((c) => ({ hash: c.hash, subject: c.subject })), commitCount: since.count,
        pr: pr ? { number: pr.number, url: pr.url } : null,
        created,
        n: turn.n,
      };
    });
  }

  // ------------------------------------------------------------ パネル

  /** 会話の最初の start（「この会話の間」の基準）。無ければ null */
  async function sessionBase(root, sessionId) {
    if (!sessionId) return null;
    const refs = await git.listTurnRefs(root, sessionId);
    return refs.find((r) => r.kind === 'start') ?? null;
  }

  /** 今の作業ツリーの tree と、範囲ごとの比べる元。元が無いもの（会話の始まりの撮影が無い）は null */
  async function bases(root, sessionId) {
    const head = await git.headCommit(root);
    const first = await sessionBase(root, sessionId);
    return { head: head ?? EMPTY_TREE, session: first?.commit ?? null };
  }

  /**
   * パネルの変更の一覧。range は 'uncommitted'（HEAD と今）か 'session'（会話の最初の撮影と今）。
   * hasSession は「この会話の間」の基準があるか（無いと範囲の札を出さない）
   */
  function changes(cwd, sessionId, range = 'uncommitted') {
    return serial(`session:${sessionId ?? cwd}`, async () => {
      const info = await git.repoInfo(cwd);
      if (!info) return null;
      const b = await bases(info.root, sessionId);
      const use = range === 'session' && b.session ? 'session' : 'uncommitted';
      const tree = await git.snapshotTree(info.root);
      if (!tree) return { range: use, hasSession: Boolean(b.session), files: [], total: { files: 0, add: 0, del: 0 }, failed: true };
      const diff = await git.diffFiles(info.root, use === 'session' ? b.session : b.head, tree);
      if (!diff) return { range: use, hasSession: Boolean(b.session), files: [], total: { files: 0, add: 0, del: 0 }, failed: true };
      return { range: use, hasSession: Boolean(b.session), files: diff.files, total: diff.total };
    });
  }

  /** 1 ファイルの統一差分（path はルート相対）。範囲は changes と同じ */
  function diff(cwd, sessionId, range, file) {
    return serial(`session:${sessionId ?? cwd}`, async () => {
      const info = await git.repoInfo(cwd);
      if (!info || typeof file !== 'string' || !file || file.includes('\0')) return null;
      const b = await bases(info.root, sessionId);
      const tree = await git.snapshotTree(info.root);
      if (!tree) return null;
      const result = await git.diffFile(info.root, range === 'session' && b.session ? b.session : b.head, tree, file);
      return result ? { range: range === 'session' && b.session ? 'session' : 'uncommitted', path: file, ...result } : null;
    });
  }

  /**
   * 委譲カードと完了通知の 1 行の元。子の作業場所の状態と、会話の間（最初の撮影から今まで）のファイル・コミットの数。
   * 撮影が無ければ session は null（状態だけ）
   */
  function summary(cwd, sessionId) {
    return serial(`session:${sessionId ?? cwd}`, async () => {
      const s = await status(cwd, { fresh: true });
      if (!s) return null;
      const base = await sessionBase(s.root, sessionId);
      if (!base) return { ...s, session: null };
      const tree = await git.snapshotTree(s.root);
      const diff = tree ? await git.diffFiles(s.root, base.commit, tree) : null;
      const parent = await git.readGit(s.root, ['rev-parse', '--verify', '-q', `${base.commit}^`]);
      const since = await git.commitsSince(s.root, parent.ok ? parent.stdout.trim() : null, 0);
      return { ...s, session: { files: diff?.total.files ?? 0, add: diff?.total.add ?? 0, del: diff?.total.del ?? 0, commits: since.count } };
    });
  }

  /** 会話を消したときに、その会話の隠し ref を消す */
  async function forget(cwd, sessionId) {
    const info = await git.repoInfo(cwd);
    return info ? git.forgetSession(info.root, sessionId) : 0;
  }

  return { status, invalidate, begin, attach, finish, changes, diff, summary, forget, ranges: SESSION_RANGES };
}
