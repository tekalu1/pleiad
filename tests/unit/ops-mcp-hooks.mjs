// MCP・Hooks・コンテキスト・リモートの操作（core/ops/mcp.mjs・hooks.mjs・context.mjs・remote.mjs。ADR 0095）を、依存を差し替えて確かめる（サーバーは立てない）。
//   - 伏せ字: agent にはコマンドの引数の秘密・承認の URL・ペアリングの番号・URL のクエリも伏せる。人（画面）には編集欄に要るものを返す
//   - 書き戻し: agent が読んだ（伏せた）値をそのまま保存したら、伏せ字の所は元の値を残す。合わない伏せ字は MASKED で断る
//   - 危険度: guarded は承認が要る会話でカード（approve）へ、承認なしの会話は通る、束縛なしは NEEDS_UI、読み取りの会話は READ_ONLY_MODE。
//     riskOf: dryRun は write、Hook を無効にする・会話の MCP を外す向きは write、有効にする・戻す向きは guarded
//   - 画面の外側（WS）と同じ返り: 人の呼び出しは引数を伏せない
import { registry } from '../../core/ops/index.mjs';
import { MASK } from '../../core/ops/registry.mjs';

export const name = 'ops-mcp-hooks';
export const title = 'MCP・Hooks・コンテキスト・リモートの操作: agent への伏せ字・伏せ字の書き戻し・危険度（guarded と riskOf）';

const MARKER = 'SECRET-MARKER-9e2b';
const human = { by: 'human', via: 'ui', local: true };
const agent = (mode) => ({ by: 'agent', via: 'mcp', sessionId: 's1', _mode: mode });
const MODES = { bypass: { scope: 'full', autonomy: 'never' }, ask: { scope: 'workspace', autonomy: 'ask' }, plan: { scope: 'readonly', autonomy: 'ask' } };

function fakeDeps() {
  const calls = [];
  const rawNative = { command: 'node', args: ['srv.js', '--token', MARKER, `--api-key=${MARKER}`, 'plain'], env: { API_KEY: MARKER }, url: undefined };
  delete rawNative.url;
  const plyRaw = { transport: 'stdio', command: 'node', args: ['srv.js', '--token', MARKER, 'keep'], envKeys: ['API_KEY'] };
  const hook = { id: 'h1', name: 'guard', agent: 'claude', event: 'PreToolUse', matcher: 'Bash', command: `curl -H "Authorization: Bearer ${MARKER}x" https://h.example`, targets: ['claude'], enabled: false };
  const deps = {
    locale: 'ja',
    calls,
    modeOf: async () => deps.mode,
    audit: async (e) => calls.push(['audit', e.op, e.risk]),
    approve: async (req) => { calls.push(['approve', req.op, req.change]); return { pending: true, requestId: 'setting-x' }; },
    sessionCwd: async () => 'C:/work',
    sessionBackend: async () => 'claude',
    mcp: {
      native: {
        list: async (a) => { calls.push(['native.list', a]); return { path: 'C:/work/.mcp.json', format: a.format, scope: a.scope, cwd: a.cwd, revision: 'rev1', servers: ['srv'] }; },
        get: async (a) => ({ name: a.name, revision: 'rev1', value: { ...rawNative, env: { API_KEY: MASK } } }),
        getWithSecrets: async (a) => ({ name: a.name, revision: 'rev1', value: structuredClone(rawNative) }),
        save: async (a) => { calls.push(['native.save', a]); return { name: a.name, revision: 'rev2' }; },
      },
      list: async () => ({ file: 'f', revision: 'r1', servers: [{ name: 'srv', ...plyRaw, authStatus: { name: 'srv', state: 'pending', url: `https://auth.example/authorize?state=${MARKER}&code_challenge=${MARKER}` } }] }),
      read: async (n) => ({ name: n, revision: 'r1', value: { transport: 'stdio', command: 'node', args: plyRaw.args, env: { API_KEY: MASK }, auth: 'none' } }),
      registration: async () => structuredClone(plyRaw),
      save: async (a) => { calls.push(['ply.save', a]); return { name: a.name, revision: 'r2' }; },
      remove: async (n) => { calls.push(['ply.remove', n]); return { name: n }; },
      authStatus: async () => ({ servers: [{ name: 'srv', state: 'pending', url: `https://auth.example/authorize?state=${MARKER}` }] }),
    },
    hooks: {
      scan: async () => ({ files: [], entries: [] }),
      session: async (a) => { calls.push(['hooks.session', a]); return { agent: a.backend, runs: [], unify: { registered: [{ command: `deploy --token ${MARKER}` }] } }; },
      view: async () => ({ revision: 'hv1', hooks: [{ ...hook, command: '••••' }] }),
      readPly: async () => structuredClone(hook),
      read: async () => ({ command: hook.command }),
      save: async (a) => { calls.push(['hooks.saveNative', a]); return { dryRun: a.dryRun === true, results: [{ agent: 'claude', op: 'edit', ok: true, revision: 'fr1', path: 'C:/home/.claude/settings.json' }] }; },
      saveHook: async (v) => { calls.push(['hooks.save', v]); return { hooks: [] }; },
      toggle: async (id, enabled) => { calls.push(['hooks.toggle', id, enabled]); return { hooks: [] }; },
    },
    context: {
      setSessionMcp: async (id, n, removed) => { calls.push(['setSessionMcp', id, n, removed]); },
      removedMcp: async () => ['srv'],
    },
    remote: { status: async () => ({ enabled: true, relayUrl: `https://relay.example/?key=${MARKER}`, connection: {}, devices: [], pairing: { requests: [{ id: 'q', code: '123456' }] } }) },
    endpoints: { list: async () => ({ endpoints: [{ id: 'e', baseUrl: `https://api.example/v1?key=${MARKER}`, hasKey: true }], defaults: {} }) },
  };
  return deps;
}

const call = async (who, id, args, deps = fakeDeps()) => {
  if (who._mode) deps.mode = MODES[who._mode];
  const { _mode, ...principal } = who;
  return { r: await registry.invoke(principal, id, args, deps), deps };
};
const has = (r) => JSON.stringify(r).includes(MARKER);

export default async function (t) {
  // ---- 伏せ字
  const nativeAgent = (await call(agent('bypass'), 'mcp.nativeRead', { format: 'claude', scope: 'directory', name: 'srv' })).r;
  t.ok('mcp.nativeRead: agent にはコマンドの引数の秘密（--token 値・--api-key=…）も env も伏せる', nativeAgent.ok && !has(nativeAgent)
    && nativeAgent.result.value.args[2] === MASK && nativeAgent.result.value.args[4] === 'plain' && nativeAgent.result.value.env.API_KEY === MASK, JSON.stringify(nativeAgent));
  const nativeHuman = (await call(human, 'mcp.nativeRead', { format: 'claude', scope: 'directory', cwd: 'C:/x', name: 'srv' })).r;
  t.ok('mcp.nativeRead: 人（画面の編集欄）には引数をそのまま返し、env は伏せる', nativeHuman.result.value.args[2] === MARKER && nativeHuman.result.value.env.API_KEY === MASK);
  const listed = await call(agent('bypass'), 'mcp.nativeList', { format: 'claude', scope: 'directory' });
  t.ok('会話から cwd を省くと、その会話の作業場所を使う', listed.deps.calls.find((c) => c[0] === 'native.list')?.[1].cwd === 'C:/work');
  const plyAgent = (await call(agent('bypass'), 'mcp.list', {})).r;
  t.ok('mcp.list: agent には引数の秘密と、ログインの途中の承認の URL（state・PKCE）を伏せる', plyAgent.ok && !has(plyAgent), JSON.stringify(plyAgent.result));
  const plyHuman = (await call(human, 'mcp.list', {})).r;
  t.ok('mcp.list: 人には承認の URL を返す（ブラウザーで開く）', plyHuman.result.servers[0].authStatus.url.includes(MARKER));
  t.ok('mcp.read・mcp.authStatus: agent に秘密が出ない', !has((await call(agent('bypass'), 'mcp.read', { name: 'srv' })).r) && !has((await call(agent('bypass'), 'mcp.authStatus', {})).r));
  const session = await call(agent('ask'), 'hooks.session', {});
  t.ok('hooks.session: 会話から省くとその会話・そのエージェント。会話の記録のコマンドも伏せる', session.r.ok && !has(session.r)
    && session.deps.calls.find((c) => c[0] === 'hooks.session')?.[1].sessionId === 's1' && session.deps.calls.find((c) => c[0] === 'hooks.session')?.[1].backend === 'claude', JSON.stringify(session.r));
  const remote = (await call(agent('bypass'), 'remote.status', {})).r;
  t.ok('remote.status: agent には中継の URL のクエリとペアリングの確認の番号を伏せる', !has(remote) && remote.result.pairing.requests[0].code === MASK);
  t.ok('remote.status: 人にはペアリングの番号を返す（端末と見比べる）', (await call(human, 'remote.status', {})).r.result.pairing.requests[0].code === '123456');
  t.ok('endpoints.list: agent には URL のクエリを伏せる（キーは元から返さない）', !has((await call(agent('bypass'), 'endpoints.list', {})).r));

  // ---- 書き戻し
  const back = await call(agent('bypass'), 'mcp.nativeSave', { format: 'claude', scope: 'directory', name: 'srv', mode: 'edit', revision: 'rev1', value: nativeAgent.result.value });
  const saved = back.deps.calls.find((c) => c[0] === 'native.save')?.[1];
  t.ok('mcp.nativeSave: 読んだ値をそのまま書き戻すと、伏せた引数と env は元の値になる', back.r.ok && saved.value.args[2] === MARKER && saved.value.args[3] === `--api-key=${MARKER}` && saved.value.env.API_KEY === MARKER && saved.cwd === 'C:/work', JSON.stringify(saved));
  const forged = await call(agent('bypass'), 'mcp.nativeSave', { format: 'claude', scope: 'directory', name: 'srv', mode: 'edit', revision: 'rev1', value: { command: 'node', args: ['other', MASK] } });
  t.ok('mcp.nativeSave: 読んだ形と合わない伏せ字は MASKED で断り、保存しない', forged.r.code === 'MASKED' && !forged.deps.calls.some((c) => c[0] === 'native.save'), JSON.stringify(forged.r));
  const plyRead = (await call(agent('bypass'), 'mcp.read', { name: 'srv' })).r.result.value;
  const plyBack = await call(agent('bypass'), 'mcp.save', { name: 'srv', mode: 'edit', value: plyRead });
  t.ok('mcp.save: 伏せた引数は元へ戻し、秘密（env の ••••）は登録のモジュールへそのまま渡す（前の値を残す）', plyBack.r.ok
    && plyBack.deps.calls.find((c) => c[0] === 'ply.save')?.[1].value.args[2] === MARKER && plyBack.deps.calls.find((c) => c[0] === 'ply.save')?.[1].value.env.API_KEY === MASK);
  const hookBack = await call(agent('bypass'), 'hooks.save', { value: { id: 'h1', name: 'guard', agent: 'claude', event: 'PreToolUse', command: '••••' } });
  t.ok('hooks.save: 伏せた形と合わないコマンドの伏せ字は断る', hookBack.r.code === 'MASKED');
  const { maskText } = await import('../../core/hooks-config.mjs');
  const hook = await fakeDeps().hooks.readPly('h1');
  const hookKeep = await call(agent('bypass'), 'hooks.save', { value: { id: 'h1', name: 'guard2', agent: 'claude', event: 'PreToolUse', command: maskText(hook.command) } });
  t.ok('hooks.save: 読んだ（伏せた）コマンドのまま名前だけ変えると、元のコマンドを残す', hookKeep.r.ok && hookKeep.deps.calls.find((c) => c[0] === 'hooks.save')?.[1].command === hook.command, JSON.stringify(hookKeep.r));
  const nativeHookKeep = await call(agent('bypass'), 'hooks.saveNative', { items: [{ op: 'edit', agent: 'claude', scope: 'user', file: 'f', revision: 'fr1', loc: { event: 'PreToolUse', group: 0, handler: 0 }, event: 'PreToolUse', command: maskText(hook.command) }] });
  t.ok('hooks.saveNative: 読んだ（伏せた）コマンドの編集は元のコマンドで書く', nativeHookKeep.r.ok && nativeHookKeep.deps.calls.find((c) => c[0] === 'hooks.saveNative')?.[1].items[0].command === hook.command);

  // ---- 危険度
  const asked = await call(agent('ask'), 'mcp.save', { name: 'new', mode: 'add', value: { transport: 'stdio', command: 'node', args: ['--token', MARKER] }, reason: '試す' });
  const card = asked.deps.calls.find((c) => c[0] === 'approve');
  t.ok('mcp.save: 承認が要る会話では承認待ち（PENDING_APPROVAL）を返し、まだ保存しない', asked.r.pending === true && asked.r.result.code === 'PENDING_APPROVAL' && !asked.deps.calls.some((c) => c[0] === 'ply.save'));
  t.ok('mcp.save: 承認カードは前後の行・説明・緩める印を持ち、引数の秘密は出さない', card?.[1] === 'mcp.save' && card[2].rows.length > 0 && card[2].note && card[2].loosens === true && !JSON.stringify(card[2]).includes(MARKER), JSON.stringify(card?.[2]));
  const bypass = await call(agent('bypass'), 'mcp.delete', { name: 'srv' });
  t.ok('承認なしの会話（bypass）の guarded は確認なしで通り、記録（audit）が残る', bypass.r.ok && bypass.deps.calls.some((c) => c[0] === 'ply.remove') && bypass.deps.calls.some((c) => c[0] === 'audit' && c[1] === 'mcp.delete' && c[2] === 'guarded'));
  t.ok('読み取りの会話の guarded は READ_ONLY_MODE、束縛されない呼び出しは NEEDS_UI', (await call(agent('plan'), 'mcp.delete', { name: 'srv' })).r.code === 'READ_ONLY_MODE'
    && (await registry.invoke({ by: 'agent', via: 'cli' }, 'mcp.delete', { name: 'srv' }, fakeDeps())).code === 'NEEDS_UI');
  const dry = await call(agent('ask'), 'hooks.saveNative', { items: [{ op: 'delete', agent: 'claude', scope: 'user' }], dryRun: true });
  t.ok('hooks.saveNative の dryRun は承認なしで通る（書かない）', dry.r.ok && !dry.r.pending && dry.deps.calls.find((c) => c[0] === 'hooks.saveNative')?.[1].dryRun === true);
  t.ok('hooks.saveNative の書き込みは承認が要る', (await call(agent('ask'), 'hooks.saveNative', { items: [{ op: 'delete', agent: 'claude', scope: 'user' }] })).r.pending === true);
  const off = await call(agent('ask'), 'hooks.toggle', { id: 'h1', enabled: false });
  const on = await call(agent('ask'), 'hooks.toggle', { id: 'h1', enabled: true });
  t.ok('hooks.toggle: 無効にする向きは承認なし（write）、有効にする向きは承認が要る（guarded）', off.r.ok && !off.r.pending && off.deps.calls.some((c) => c[0] === 'hooks.toggle' && c[2] === false)
    && on.r.pending === true && !on.deps.calls.some((c) => c[0] === 'hooks.toggle'));
  const removeMcp = await call(agent('ask'), 'context.setSessionMcp', { name: 'srv' });
  const restoreMcp = await call(agent('ask'), 'context.setSessionMcp', { name: 'srv', removed: false });
  t.ok('context.setSessionMcp: 外す向きは承認なしでその会話に、戻す向きは承認が要る', removeMcp.r.ok && removeMcp.deps.calls.some((c) => c[0] === 'setSessionMcp' && c[1] === 's1' && c[3] === true)
    && restoreMcp.r.pending === true);
  t.ok('人の画面からは guarded も承認なしで通る（画面の振る舞いは変えない）', (await call(human, 'mcp.delete', { name: 'srv' })).r.ok);
  const ids = ['mcp.nativeSave', 'mcp.save', 'mcp.delete', 'mcp.rename', 'mcp.import', 'mcp.setSettings', 'hooks.save', 'hooks.remove', 'hooks.setOwner', 'hooks.repair', 'context.setSettings', 'context.setPlyInstructions'];
  t.ok('任意のコマンド・文脈を変える書き込みと削除は guarded', ids.every((id) => registry.get(id)?.risk === 'guarded'), ids.filter((id) => registry.get(id)?.risk !== 'guarded').join(','));
  const writes = ['mcp.reconnect', 'context.refresh', 'remote.setResident'];
  t.ok('それ以外の書き込みは write（riskReason つき）', writes.every((id) => registry.get(id)?.risk === 'write' && registry.get(id).riskReason));
  t.ok('どの新しい操作も agent の一覧に出る（human-only は無い）', [...ids, ...writes].every((id) => registry.list({ by: 'agent', via: 'mcp' }).some((o) => o.id === id)));
}
