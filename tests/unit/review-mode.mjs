// 審査モード（ADR 0172。core/review-mode.mjs）の関所。
//   - 全命令の振り分け表（通す / 断る）が protocol の全命令と過不足なく一致する（載せ忘れが分かる）
//   - 操作の一覧: 許可の一覧にあるものだけ一覧に出て、呼べる。settings.set は許可したキーだけ
//   - 起動の条件: fake だけ・審査用の印のある置き場（空なら印を作る）。印の無い使用済みの置き場では起動しない
//   - ファイルの閉じ込め: listDirs・inspectFile の confine
//   - 本物のサーバー（AGENT_HOST_REVIEW=1）: 一覧に無い命令・台本が断られ、一覧のものは通る。作業フォルダー・ask-later・「端末を追加」の鍵
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as P from '../../core/protocol.mjs';
import { registry } from '../../core/ops/index.mjs';
import { inspectFile } from '../../core/file-preview.mjs';
import { listDirs } from '../../core/list-dirs.mjs';
import * as R from '../../core/review-mode.mjs';
import { startServer } from '../lib/server.mjs';
import { open, sleep } from '../lib/ws-client.mjs';

export const name = 'review-mode';
export const title = '審査モード（ADR 0172）: 全命令の通す/断る表・操作の一覧の許可・起動の条件・作業フォルダーへの閉じ込め・fake の台本の絞り込み';

const human = { by: 'human', via: 'ui', local: true };
const refusedBy = (promise) => promise.then(() => null, (e) => e);
const isRefused = (e) => Boolean(e) && (e.code === 'REVIEW_MODE' || /REVIEW_MODE/.test(String(e.message)));

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-review-'));
  const servers = [];
  try {
    // ---- 1. 全命令の振り分け表: protocol の全命令と一致する
    {
      const pass = new Set(R.COMMAND_PASS);
      const refuse = new Set(R.COMMAND_REFUSE);
      t.ok('通す表に重複が無い', pass.size === R.COMMAND_PASS.length);
      t.ok('断る表に重複が無い', refuse.size === R.COMMAND_REFUSE.length);
      t.ok('通す表と断る表に同じ命令が無い', [...pass].every((c) => !refuse.has(c)), [...pass].filter((c) => refuse.has(c)).join());
      const all = [...P.COMMANDS];
      const missing = all.filter((c) => !pass.has(c) && !refuse.has(c));
      t.ok('protocol の全命令が、通す / 断るのどちらかに振ってある（載せ忘れ）', missing.length === 0, missing.join());
      const stale = [...pass, ...refuse].filter((c) => !P.COMMANDS.has(c));
      t.ok('表にあって protocol に無い命令が無い', stale.length === 0, stale.join());
      t.ok('commandAllowed: 通す表だけ true', all.every((c) => R.commandAllowed(c) === pass.has(c)));
      t.ok('commandAllowed: 知らない命令は断る', R.commandAllowed('nope') === false && R.commandAllowed(undefined) === false);
      for (const c of ['runShell', 'uploadStart', 'attachFile', 'setApiKey', 'switchBackend', 'setMode', 'authLogin', 'saveMcpServer', 'gitCommit', 'chromeConnect', 'setRemoteSettings', 'remotePairingStart']) {
        t.ok(`断る: ${c}`, R.commandAllowed(c) === false);
      }
      for (const c of ['invoke', 'runTurn', 'sendMessage', 'newSession', 'listSessions', 'loadSession', 'resolvePermission', 'listDirs', 'setPref', 'hostCapabilities']) {
        t.ok(`通す: ${c}`, R.commandAllowed(c) === true);
      }
    }

    // ---- 2. 操作の一覧: 許可の一覧だけ見せる・呼べる
    {
      const gate = R.reviewRegistry(registry);
      const ids = gate.list(human).map((o) => o.id);
      t.ok('一覧に出るのは許可の一覧のものだけ', ids.length > 0 && ids.every((id) => R.OP_ALLOW.has(id)), ids.filter((id) => !R.OP_ALLOW.has(id)).join());
      t.ok('許可した操作は一覧に出る（sessions.list・settings.set・files.listDirs）', ['sessions.list', 'settings.set', 'files.listDirs'].every((id) => ids.includes(id)));
      t.ok('describe も許可の一覧だけ', gate.describe(human, 'ja').every((e) => R.OP_ALLOW.has(e.id)));
      t.ok('get: 許可の外は無い', gate.get('shell.run') === undefined && gate.get('sessions.list') !== undefined);
      const all = registry.list(human).map((o) => o.id);
      t.ok('許可の一覧に、本物の操作に無い id が混じっていない（綴りの違い）', [...R.OP_ALLOW].every((id) => all.includes(id)), [...R.OP_ALLOW].filter((id) => !all.includes(id)).join());
      for (const id of ['shell.run', 'settings.reset', 'files.read', 'attachments.add']) {
        const out = await gate.invoke(human, id, {}, { locale: 'ja' });
        t.ok(`許可の外は REVIEW_MODE で断る: ${id}`, out.ok === false && out.code === 'REVIEW_MODE' && out.error.length > 0, JSON.stringify(out));
      }
      const set = (key, value) => gate.invoke(human, 'settings.set', { key, value }, { locale: 'ja' });
      for (const key of ['backend', 'mode', 'remote.enabled', 'computerUse']) {
        const out = await set(key, 'x');
        t.ok(`settings.set: 許可したキーの外は断る: ${key}`, out.ok === false && out.code === 'REVIEW_MODE', JSON.stringify(out));
      }
      t.ok('settings.set の許可キーに、バックエンド・モードが無い', !R.SETTING_SET_ALLOW.has('backend') && !R.SETTING_SET_ALLOW.has('mode'));
      const en = await gate.invoke(human, 'shell.run', {}, { locale: 'en' });
      t.ok('断る文は英語でも出る', en.code === 'REVIEW_MODE' && /review/i.test(en.error), JSON.stringify(en));
    }

    // ---- 3. 台本の判定
    for (const s of ['echo:hi', 'ask', 'ask permission', 'ask-later', 'ask-later now', 'question', 'question x', 'fail', 'fail now']) {
      t.ok(`台本を通す: ${s}`, R.fakeScriptAllowed(s));
    }
    for (const s of ['steps:@x', 'control:{}', 'computer:x', 'browser:x', 'context:x', 'held:x', 'bg-shell', 'term', 'asked', 'questionable', 'failure', 'ask-slow', 'slow', 'hello', '', undefined]) {
      t.ok(`台本を通さない: ${JSON.stringify(s)}`, !R.fakeScriptAllowed(s));
    }
    t.ok('isReviewMode: 環境の引数で判定できる', R.isReviewMode({ AGENT_HOST_REVIEW: '1' }) === true && R.isReviewMode({}) === false && R.isReviewMode({ AGENT_HOST_REVIEW: '0' }) === false);
    t.ok('isReviewMode: このテストのプロセスは審査モードではない', R.isReviewMode() === false);

    // ---- 4. 起動の条件
    {
      const prepare = (dataDir, backendIds = ['fake']) => { try { return R.prepareReviewHost({ dataDir, backendIds }); } catch (e) { return e; } };
      const fresh = path.join(scratch, 'fresh');
      const made = prepare(fresh);
      t.ok('空（無い）の置き場なら印と作業フォルダーを作る', !(made instanceof Error) && (await fs.stat(path.join(fresh, R.REVIEW_MARK)).then(() => true, () => false)), String(made?.message));
      t.ok('作業フォルダーは置き場の中の空のフォルダー', made.workDir === await fs.realpath(path.join(fresh, R.REVIEW_WORK)) && (await fs.readdir(made.workDir)).length === 0);
      t.ok('reviewWorkDir() が同じ場所を返す', R.reviewWorkDir() === made.workDir);
      const again = prepare(fresh);
      t.ok('印のある置き場は、中身があっても起動できる（2 回目）', !(again instanceof Error) && again.workDir === made.workDir, String(again?.message));
      const empty = path.join(scratch, 'empty');
      await fs.mkdir(empty);
      t.ok('空のフォルダーも印を作って使える', !(prepare(empty) instanceof Error) && (await fs.readdir(empty)).includes(R.REVIEW_MARK));
      const used = path.join(scratch, 'used');
      await fs.mkdir(used);
      await fs.writeFile(path.join(used, 'prefs.json'), '{}');
      const refused = prepare(used);
      t.ok('印の無い使用済みの置き場では起動しない', refused instanceof R.ReviewModeError, String(refused?.message));
      t.ok('使用済みの置き場に印を作らない', !(await fs.readdir(used)).includes(R.REVIEW_MARK));
      for (const ids of [['claude'], ['fake', 'claude'], []]) {
        const e = prepare(path.join(scratch, `ids-${ids.join('_') || 'none'}`), ids);
        t.ok(`fake だけでなければ起動しない: [${ids.join(',')}]`, e instanceof R.ReviewModeError, String(e?.message));
      }
      R.prepareReviewHost({ dataDir: fresh, backendIds: ['fake'] });
    }

    // ---- 5. ファイルの閉じ込め
    {
      const data = path.join(scratch, 'confine');
      const work = path.join(data, 'review-work');
      await fs.mkdir(path.join(work, 'sub'), { recursive: true });
      await fs.writeFile(path.join(work, 'a.txt'), 'a');
      await fs.writeFile(path.join(data, 'prefs.json'), '{}');
      const outside = path.join(scratch, 'outside');
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, 'o.txt'), 'o');
      const access = { dataDir: data, uploadDir: path.join(data, 'uploads'), confine: work };
      t.ok('inspectFile: 作業フォルダーの中は読める', (await inspectFile(path.join(work, 'a.txt'), access)).stat.isFile());
      const e1 = await refusedBy(inspectFile(path.join(outside, 'o.txt'), access));
      t.ok('inspectFile: 置き場の外は断る', e1?.code === 'protected-data', String(e1?.code));
      const e2 = await refusedBy(inspectFile(path.join(data, 'prefs.json'), access));
      t.ok('inspectFile: 置き場の中でも作業フォルダーの外は断る', e2?.code === 'protected-data', String(e2?.code));
      const e3 = await refusedBy(inspectFile(path.join(work, '..', 'prefs.json'), access));
      t.ok('inspectFile: .. で出ても断る', e3?.code === 'protected-data', String(e3?.code));
      const e4 = await refusedBy(inspectFile(path.join(work, 'a.txt'), { dataDir: data, uploadDir: path.join(data, 'uploads') }));
      t.ok('（閉じ込め無しなら、置き場の中は従来どおり断る）', e4?.code === 'protected-data');

      const top = await listDirs(work, { confine: work });
      t.ok('listDirs: 作業フォルダーは一番上（parent・roots なし）', top.parent === null && top.roots.length === 0 && top.dirs.includes('sub'), JSON.stringify(top));
      t.ok('listDirs: 指定が無ければ作業フォルダー', (await listDirs(undefined, { confine: work })).path === path.resolve(work));
      const sub = await listDirs(path.join(work, 'sub'), { confine: work });
      t.ok('listDirs: 中のフォルダーの親は作業フォルダー', path.resolve(sub.parent) === path.resolve(work));
      for (const bad of [outside, data, path.join(work, '..'), os.homedir()]) {
        const e = await refusedBy(listDirs(bad, { confine: work }));
        t.ok(`listDirs: 外は断る: ${path.basename(bad)}`, Boolean(e), JSON.stringify(e && e.message));
      }
    }

    // ---- 6. 本物のサーバー
    const boot = async (name, env = {}) => {
      const dataDir = path.join(scratch, name);
      // dataDir は startServer に渡さない（渡すと prefs.json を先に置き、使用済みの置き場になる）。空の置き場から起動する
      const server = await startServer({ env: { AGENT_HOST_DATA: dataDir, AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_REVIEW: '1', AGENT_HOST_FAKE_ASK_LATER_MS: '700', ...env } });
      servers.push(server);
      return { server, dataDir };
    };
    // 起動前に終わる条件
    {
      const bad = async (dataDir, env, pre) => {
        if (pre) { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(path.join(dataDir, 'prefs.json'), '{}'); }
        return refusedBy(startServer({ dataDir, timeoutMs: 20000, env: { AGENT_HOST_REVIEW: '1', ...env } }));
      };
      const usedErr = await bad(path.join(scratch, 'boot-used'), { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_DATA: path.join(scratch, 'boot-used') }, true);
      t.ok('印の無い使用済みの置き場では、サーバーが起動前に終わる', /起動前に終了/.test(String(usedErr?.message)), String(usedErr?.message).slice(0, 300));
      const notFakeDir = path.join(scratch, 'boot-notfake');
      const notFake = await bad(notFakeDir, { AGENT_HOST_BACKENDS: 'fake,claude', AGENT_HOST_DATA: notFakeDir });
      t.ok('fake 以外のバックエンドがあると、サーバーが起動前に終わる', /起動前に終了/.test(String(notFake?.message)), String(notFake?.message).slice(0, 300));
    }

    const { server, dataDir } = await boot('review-host');
    t.ok('審査モードのサーバーが起動する', Number.isFinite(server.port), server.tail());
    t.ok('空の置き場に印ができる', await fs.stat(path.join(dataDir, R.REVIEW_MARK)).then(() => true, () => false));
    const c = await open({ port: server.port, token: server.token });
    const op = (id, args = {}) => c.cmd('invoke', { op: id, args });
    const work = await fs.realpath(path.join(dataDir, R.REVIEW_WORK));

    // 断る命令
    {
      const e = await refusedBy(c.cmd('runShell', { sessionId: 'x', command: 'echo hi' }));
      t.ok('runShell は REVIEW_MODE で断る', e?.code === 'REVIEW_MODE', String(e?.code));
      const up = await refusedBy(c.cmd('uploadStart', { name: 'a.txt', size: 1 }));
      t.ok('uploadStart は REVIEW_MODE で断る', up?.code === 'REVIEW_MODE', String(up?.code));
      const sw = await refusedBy(c.cmd('switchBackend', { backend: 'claude' }));
      t.ok('switchBackend は REVIEW_MODE で断る', sw?.code === 'REVIEW_MODE', String(sw?.code));
      const keys = await refusedBy(c.cmd('setApiKey', { provider: 'openrouter', key: 'x' }));
      t.ok('setApiKey は REVIEW_MODE で断る', keys?.code === 'REVIEW_MODE', String(keys?.code));
      const bk = await refusedBy(op('shell.run', { sessionId: 'x', command: 'echo hi' }));
      t.ok('操作の一覧: 許可の外は断る', isRefused(bk), String(bk?.message));
      const pref = await refusedBy(c.cmd('setPref', { key: 'mode', value: 'full' }));
      const prefOps = await refusedBy(op('settings.set', { key: 'mode', value: 'full' }));
      t.ok('設定の変更（許可したキーの外）は断る', isRefused(prefOps) || isRefused(pref), `${prefOps?.message} / ${pref?.message}`);
      const list = await op('settings.list').catch((e) => e);
      const listed = JSON.stringify(list);
      t.ok('操作の一覧に shell.run が出ない', !/shell\.run/.test(JSON.stringify(await c.cmd('invoke', { op: 'app.status', args: {} }).catch(() => ''))) && !listed.includes('"shell.run"'));
    }

    // 通る命令・作業フォルダー
    {
      const caps = await c.cmd('hostCapabilities');
      t.ok('hostCapabilities が reviewMode: true を返す（画面が「端末を追加」を隠す）', caps.reviewMode === true, JSON.stringify(caps));
      t.ok('listSessions は通る', Array.isArray(await c.cmd('listSessions')));
      t.ok('backends は fake だけ', (await c.cmd('backends')).every((b) => b.id === 'fake'));
      const created = await c.cmd('newSession', { backend: 'fake', cwd: os.homedir() });
      const info = (await c.cmd('listSessions')).find((s) => s.id === created.sessionId);
      t.ok('newSession: cwd を渡しても作業フォルダーに固定', path.resolve(info.cwd) === path.resolve(work), `${info?.cwd} / ${work}`);
      const dirs = await c.cmd('listDirs', { path: os.homedir() }).then((r) => r, (e) => e);
      t.ok('listDirs: 作業フォルダーの外は開けない', dirs instanceof Error || dirs?.path === undefined || path.resolve(dirs.path) === path.resolve(work), JSON.stringify(dirs).slice(0, 200));
      const own = await c.cmd('listDirs', {});
      t.ok('listDirs: 既定は作業フォルダー、一番上', path.resolve(own.path) === path.resolve(work) && own.parent === null, JSON.stringify(own).slice(0, 200));

      // 台本: 通すものは動き、通さないものは言葉をそのまま返す
      const say = async (prompt) => {
        const from = c.mark();
        const r = await c.runTurn({ sessionId: created.sessionId, prompt }, { ms: 20000 });
        const msgs = (await c.cmd('loadSession', { sessionId: created.sessionId })).messages.filter((m) => m.role === 'assistant');
        return { r, text: msgs.at(-1)?.text ?? '', from };
      };
      const echo = await say('echo:こんにちは');
      t.ok('echo: は通る', echo.r.outcome === 'ok' && /こんにちは/.test(echo.text), echo.text);
      const steps = await say('steps:@[{"say":"hi"}]');
      t.ok('steps:@ は台本として読まず、言葉をそのまま返す', steps.r.outcome === 'ok' && steps.text.includes('steps:@'), steps.text);
      const ctl = await say('control: {"cmd":"x"}');
      t.ok('control: は台本として読まず、言葉をそのまま返す', ctl.r.outcome === 'ok' && ctl.text.includes('control:') && ctl.r.tools.length === 0, ctl.text);
      for (const s of ['computer: screenshot', 'browser: open', 'context: x', 'held: x', 'bg-shell', 'term', 'slow', 'limit 1']) {
        const r = await say(s);
        t.ok(`通さない台本は言葉のまま返し、道具を呼ばない: ${s}`, r.r.outcome === 'ok' && r.text.includes(s.split(' ')[0]) && r.r.tools.length === 0 && r.r.permissions.length === 0, `${r.r.outcome} ${r.text}`);
      }
      const fail = await say('fail');
      t.ok('fail は通る', fail.r.outcome === 'error', String(fail.r.outcome));

      // ask は承認を求め、ask-later は待ってから求める
      const ask = c.runTurn({ sessionId: created.sessionId, prompt: 'ask' }, { ms: 20000 });
      const permission = await c.waitFor((e) => e.type === 'permission', { from: c.mark(), ms: 10000 }).catch(() => null);
      if (permission) await c.cmd('resolvePermission', { id: permission.id, allow: true });
      await ask;
      t.ok('ask は承認を求める', Boolean(permission));
      const startedAt = Date.now();
      const from = c.mark();
      const later = c.runTurn({ sessionId: created.sessionId, prompt: 'ask-later' }, { ms: 20000 });
      await sleep(250);
      t.ok('ask-later: 待っているあいだは承認を求めない', !c.since(from).some((e) => e.type === 'permission'));
      const lp = await c.waitFor((e) => e.type === 'permission', { from, ms: 10000 }).catch(() => null);
      const waited = Date.now() - startedAt;
      t.ok('ask-later: 待ってから承認を求める', Boolean(lp) && waited >= 600, `${waited}ms`);
      if (lp) await c.cmd('resolvePermission', { id: lp.id, allow: true });
      const end = await later;
      t.ok('ask-later: 承認すると終わる', end.outcome === 'ok', String(end.outcome));

      // 閉じる口
      const base = `http://127.0.0.1:${server.port}`;
      for (const p of ['/mcp/agents', '/mcp/computer', '/mcp/browser', '/mcp/control', '/mcp/context']) {
        const res = await fetch(`${base}${p}?token=${server.token}`).catch(() => null);
        t.ok(`エージェント向けの口は閉じている: ${p}`, res && (res.status === 404 || res.status === 403 || res.status === 401), String(res?.status));
      }
    }
    c.close();
  } finally {
    for (const s of servers) await s.stop().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
