// Claude を保持役に載せる部品（無停止の更新 段階 2 の 2c。core/backends/claude-held.mjs）。サーバーも CLI も起こさない:
//   - 付け直しを確かめた CLI の版の下限（以上・同じ major）・載せる切り替えの既定（off で載せない）と、--version の読み方・実体ごとに 1 回だけ聞く
//   - 保持役に起こさせるコマンド: npm の包み（claude.cmd）は中身の bin/claude.exe に解く（全体に入れた形・手元の .bin の形）。解けない .cmd は載せない。"node" はこのプロセスの node
//   - 偽の SpawnedProcess: spawn と印を SDK の最初の書き込みより前に送る・stdin の書き込みを保持役へ写す・ack は処理し終えた uuid の行・
//     手を離した（detach）後は write・end・kill を転送しない
//   - 付け直し: attach の答えの時点までの、答え済みの control_request と旧い親への control_response を SDK へ流さない。控えの渡し直しは流す
//   - 札のフラグ設定のファイル（名前の形だけを受ける）と、起動の掃除が札の指すファイルを外す
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { HELD_CLI_MIN_VERSION, heldVersionOk, parseCliVersion, heldCommand, heldEnabled, cliVersion, createHeldCli } from '../../core/backends/claude-held.mjs';
import { holderSource } from '../../core/adopt.mjs';
import { adoptClaudeFlagSettings, sweepClaudeFlagSettings } from '../../core/compat-endpoints.mjs';

export const name = 'claude-held';
export const title = 'Claude を保持役に載せる部品: 版の下限・既定・npm の包みの解き方・偽の SpawnedProcess・付け直しで流さない行・札のフラグ設定';

const tick = () => new Promise(resolve => setImmediate(resolve));

/** 保持役の口（core/holder/client.mjs の HolderClient）の身代わり。送ったものを順に覚える */
function fakeClient({ attached = null } = {}) {
  const client = new EventEmitter();
  client.sent = [];
  const note = (t, extra) => { client.sent.push({ t, ...extra }); return true; };
  Object.assign(client, {
    spawn: frame => note('spawn', frame),
    mark: (id, name) => note('mark', { id, name }),
    write: (id, data) => note('write', { id, data }),
    end: id => note('end', { id }),
    kill: (id, options) => note('kill', { id, ...options }),
    ack: (id, seq) => note('ack', { id, seq }),
    label: (id, label) => note('label', { id, label }),
    release: id => note('release', { id }),
    attach: async (id, { from } = {}) => { note('attach', { id, from }); return attached; },
    detach: async id => { note('detach', { id }); return { id, children: [] }; },
  });
  return client;
}
/** SDK の stdout の身代わり: 流れてきた行を集める */
const collect = stream => { const lines = []; let rest = ''; stream.on('data', chunk => { rest += chunk; const parts = rest.split('\n'); rest = parts.pop(); lines.push(...parts); }); return lines; };

export default async function (t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-held-'));
  try {
    // 版の一覧と --version
    {
      assert.equal(HELD_CLI_MIN_VERSION, '2.1.284', '確かめた最も古い版が下限');
      for (const ok of ['2.1.284', '2.1.288', '2.1.290', '2.2.0', '2.10.1', '2.1.1000']) assert.ok(heldVersionOk(ok), `${ok} は載せる（下限以上・同じ major）`);
      for (const no of ['2.1.283', '2.1.267', '2.0.999', '1.9.9', '3.0.0', '3.1.284', null, '', 'nope', '2.1', '2.1.284-beta']) assert.ok(!heldVersionOk(no), `${no} は載せない`);
      assert.equal(parseCliVersion('2.1.284 (Claude Code)\n'), '2.1.284');
      assert.equal(parseCliVersion('nope'), null);
      const exe = path.join(scratch, 'claude.exe');
      await fs.writeFile(exe, 'x');
      let asked = 0;
      const run = async () => { asked++; return '2.1.288'; };
      assert.equal(await cliVersion(exe, { run }), '2.1.288');
      assert.equal(await cliVersion(exe, { run }), '2.1.288');
      assert.equal(asked, 1, '同じ実体には 1 回だけ聞く');
      await fs.writeFile(exe, 'xy');
      assert.equal(await cliVersion(exe, { run }), '2.1.288');
      assert.equal(asked, 2, '実体が変わったら（claude update）聞き直す');
      assert.equal(await cliVersion(path.join(scratch, 'missing.exe'), { run }), null);
      const saved = process.env.AGENT_HOST_CLAUDE_HOLDER;
      delete process.env.AGENT_HOST_CLAUDE_HOLDER;
      assert.equal(heldEnabled(), true, '既定は載せる');
      for (const [value, expected] of [['on', true], ['ON', true], ['', true], ['off', false], [' OFF ', false]]) {
        process.env.AGENT_HOST_CLAUDE_HOLDER = value;
        assert.equal(heldEnabled(), expected, `AGENT_HOST_CLAUDE_HOLDER=${JSON.stringify(value)}`);
      }
      delete process.env.AGENT_HOST_CLAUDE_HOLDER;
      assert.equal(heldEnabled({ AGENT_HOST_CLAUDE_HOLDER: 'off' }), false, '渡した env も読む');
      if (saved === undefined) delete process.env.AGENT_HOST_CLAUDE_HOLDER; else process.env.AGENT_HOST_CLAUDE_HOLDER = saved;
      t.ok('版の下限（2.1.284 以上・同じ major）・--version は実体ごとに 1 回・切り替えの既定は載せる（off で載せない）', true);
    }

    // npm の包みの解き方
    {
      const global = path.join(scratch, 'npm');
      const pkg = path.join(global, 'node_modules', '@anthropic-ai', 'claude-code');
      await fs.mkdir(path.join(pkg, 'bin'), { recursive: true });
      await fs.writeFile(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'bin/claude.exe' } }));
      await fs.writeFile(path.join(pkg, 'bin', 'claude.exe'), 'x');
      await fs.writeFile(path.join(global, 'claude.cmd'), '@echo off');
      const resolved = heldCommand({ command: path.join(global, 'claude.cmd'), args: ['--x'] }, { platform: 'win32' });
      assert.deepEqual(resolved, { command: path.resolve(pkg, 'bin', 'claude.exe'), args: ['--x'] }, '全体に入れた包みは bin/claude.exe に解く');
      const local = path.join(scratch, 'proj', 'node_modules');
      const lpkg = path.join(local, '@anthropic-ai', 'claude-code');
      await fs.mkdir(path.join(lpkg, 'bin'), { recursive: true });
      await fs.mkdir(path.join(local, '.bin'), { recursive: true });
      await fs.writeFile(path.join(lpkg, 'package.json'), JSON.stringify({ bin: 'cli-wrapper.cjs' }));
      await fs.writeFile(path.join(lpkg, 'bin', 'claude.exe'), 'x');
      assert.equal(heldCommand({ command: path.join(local, '.bin', 'claude.cmd') }, { platform: 'win32' })?.command, path.resolve(lpkg, 'bin', 'claude.exe'), '手元の .bin の包みも解く');
      assert.equal(heldCommand({ command: path.join(scratch, 'other', 'claude.cmd') }, { platform: 'win32' }), null, '解けない .cmd は載せない');
      assert.deepEqual(heldCommand({ command: 'node', args: ['cli.js'] }, { execPath: 'C:/node.exe' }), { command: 'C:/node.exe', args: ['cli.js'] });
      assert.deepEqual(heldCommand({ command: '/usr/bin/claude', args: [] }, { platform: 'linux' }), { command: '/usr/bin/claude', args: [] });
      t.ok('npm の包み（claude.cmd）は中身の bin/claude.exe に解く。解けない .cmd は載せない', true);
    }

    // 起こす: spawn と印は最初の書き込みより前。stdin は保持役へ写す。ack は処理し終えた uuid の行。手を離した後は転送しない
    {
      const client = fakeClient();
      let spawned = null;
      const held = createHeldCli({ mode: 'spawn', client, onSpawn: source => { spawned = source; } });
      const proc = held.spawnClaudeCodeProcess({ command: 'node', args: ['cli.js', '--input-format', 'stream-json'], cwd: scratch, env: { A: '1' } });
      const lines = collect(proc.stdout);
      proc.stdin.write('{"type":"control_request","request":{"subtype":"initialize"}}\n');
      await tick();
      assert.deepEqual(client.sent.slice(0, 3).map(x => x.t), ['spawn', 'mark', 'write'], 'spawn と印が最初の書き込みより前');
      assert.equal(client.sent[0].policy, 'claude-control');
      assert.equal(client.sent[0].command, process.execPath);
      assert.deepEqual(client.sent[0].env, { A: '1' });
      assert.ok(spawned && held.id === client.sent[0].id);
      const id = held.id;
      client.emit('out', { id, seq: 1, line: '{"type":"control_response"}' });
      client.emit('out', { id, seq: 2, line: '{"type":"system","subtype":"init","uuid":"u-2"}' });
      client.emit('out', { id, seq: 3, line: '{"type":"assistant","uuid":"u-3"}' });
      client.emit('out', { id: 'other', seq: 9, line: '{"type":"x"}' });
      await tick(); await tick();
      assert.equal(lines.length, 3, '子の行をそのまま SDK の stdout へ流す（ほかの子の行は流さない）');
      held.ack('u-2');
      held.ack('missing');
      assert.deepEqual(client.sent.filter(x => x.t === 'ack').map(x => x.seq), [2], 'ack は処理し終えた uuid の行');
      await held.handOff({ sessionId: 's' });
      assert.deepEqual(client.sent.slice(-2).map(x => x.t), ['label', 'detach'], '手を離す: 札を置いてから detach');
      const count = client.sent.length;
      proc.stdin.write('{"type":"control_response"}\n');
      proc.stdin.end();
      proc.kill('SIGTERM');
      await tick();
      assert.equal(client.sent.length, count, 'detach の後は write・end・kill を転送しない');
      assert.deepEqual(await held.exit, { code: null, signal: null, handedOff: true });
      assert.equal(held.handedOff, true);
      await held.finish();
      assert.ok(!client.sent.some(x => x.t === 'release' || x.t === 'kill'), '手を離した子は止めず、記録も捨てない');
      t.ok('起こす: spawn と印が最初の書き込みより前・stdin を写す・ack は uuid の行・手を離した後は write・end・kill を転送しない', true);
    }

    // 終わった子: SDK の kill は木ごと止める。終わりを見たら記録を捨てる
    {
      const client = fakeClient();
      const held = createHeldCli({ mode: 'spawn', client });
      const proc = held.spawnClaudeCodeProcess({ command: 'node', args: [], env: {} });
      collect(proc.stdout);
      let exitCode;
      proc.on('exit', code => { exitCode = code; });
      proc.kill('SIGTERM');
      assert.deepEqual(client.sent.at(-1), { t: 'kill', id: held.id, tree: true }, 'SDK の kill は保持役に木ごと止めさせる');
      client.emit('exit', { id: held.id, code: 0, signal: null });
      await held.exit; await tick(); await tick();
      assert.equal(exitCode, 0);
      await held.finish();
      assert.deepEqual(client.sent.at(-1), { t: 'release', id: held.id }, '終わった子の記録を捨てる');
      t.ok('終わった子: SDK の kill は木ごと・終わりを見てから記録を捨てる', true);
    }

    // 付け直し: attach の答えの時点までの答え済みの依頼と旧い親への応答は流さない。答えを待っている依頼・控えの渡し直し・続きは流す
    {
      const client = fakeClient({ attached: { id: 'c1', seq: 6, pendingRequests: [{ requestId: 'r-wait', seq: 4, subtype: 'can_use_tool' }] } });
      const source = holderSource(client, { id: 'c1', seq: 6, acked: 2, marks: { turn: 1 } }, { redelivered: true });
      const held = createHeldCli({ mode: 'adopt', source, from: 3 });
      const proc = held.spawnClaudeCodeProcess({ command: 'ignored', args: [], env: {} });
      const lines = collect(proc.stdout);
      proc.stdin.write('{"type":"control_request","request_id":"init-2","request":{"subtype":"initialize"}}\n');
      await tick(); await tick();
      assert.deepEqual(client.sent.map(x => x.t), ['attach', 'write'], 'spawn しない。attach の答えの後に、溜めた書き込みを送る');
      assert.equal(client.sent[0].from, 3);
      client.emit('out', { id: 'c1', seq: 1, line: '{"type":"control_request","request_id":"r-mcp","request":{"subtype":"mcp_message"}}', redelivered: true });
      client.emit('out', { id: 'c1', seq: 3, line: '{"type":"control_request","request_id":"r-done","request":{"subtype":"hook_callback"}}' });
      client.emit('out', { id: 'c1', seq: 4, line: '{"type":"control_request","request_id":"r-wait","request":{"subtype":"can_use_tool"}}' });
      client.emit('out', { id: 'c1', seq: 5, line: '{"type":"control_response","response":{"request_id":"old"}}' });
      client.emit('out', { id: 'c1', seq: 6, line: '{"type":"assistant","uuid":"u-6"}' });
      client.emit('out', { id: 'c1', seq: 7, line: '{"type":"control_response","response":{"request_id":"init-2"}}' });
      await tick(); await tick();
      const types = lines.map(l => JSON.parse(l)).map(m => m.request_id ?? m.response?.request_id ?? m.uuid);
      assert.deepEqual(types, ['r-mcp', 'r-wait', 'u-6', 'init-2'], '答え済みの依頼（r-done）と旧い親への応答（old）は流さない');
      held.ack('u-6');
      assert.deepEqual(client.sent.filter(x => x.t === 'ack').map(x => x.seq), [6]);
      source.stop();
      await held.exit;
      t.ok('付け直し: attach の答えの時点までの答え済みの依頼・旧い親への応答は流さず、答えを待っている依頼・控えの渡し直し・続きを流す', true);
    }

    // 札のフラグ設定のファイル
    {
      const dataDir = path.join(scratch, 'data');
      await fs.mkdir(path.join(dataDir, 'run'), { recursive: true });
      const keep = 'claude-compat-0d0a5b1c-0000-4000-8000-000000000001.json', drop = 'claude-compat-0d0a5b1c-0000-4000-8000-000000000002.json';
      for (const name of [keep, drop]) await fs.writeFile(path.join(dataDir, 'run', name), '{}');
      assert.equal(adoptClaudeFlagSettings(dataDir, '../prefs.json'), null, '名前の形が違えば null');
      assert.equal(adoptClaudeFlagSettings(dataDir, null), null);
      assert.equal(await sweepClaudeFlagSettings(dataDir, { except: [keep] }), 1);
      assert.deepEqual(await fs.readdir(path.join(dataDir, 'run')), [keep], '起動の掃除は札が指すファイルを外す');
      const flag = adoptClaudeFlagSettings(dataDir, keep);
      assert.equal(flag.file, path.join(dataDir, 'run', keep));
      await flag.dispose();
      assert.deepEqual(await fs.readdir(path.join(dataDir, 'run')), [], '付け直したターンの終わりに消す');
      t.ok('札のフラグ設定のファイル: 名前の形だけを受け、起動の掃除は札の指すファイルを外し、付け直したターンの終わりに消す', true);
    }
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
