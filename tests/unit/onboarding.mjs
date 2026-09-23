import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeAuth } from '../../core/auth/claude-cli.mjs';
import { cliCommand, installation, findExecutable } from '../../core/cli-installation.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { shouldShowOnboarding } from '../../web/onboarding.mjs';

export const name = 'onboarding';
export const title = 'Installation, Claude authentication and persistent setup';
export default async function(t) {
  const agents = [{ id: 'fake', installed: true }];
  const ready = new Map([['fake', { supported: true, loggedIn: true }]]);
  const missing = new Map([['fake', { supported: true, loggedIn: false }]]);
  t.ok('First visit shows welcome even with an existing account', shouldShowOnboarding({ agents }, ready));
  t.ok('Dismissed welcome stays closed on reload when configured', !shouldShowOnboarding({ agents, seen: true }, ready));
  t.ok('No configured accounts shows welcome again', shouldShowOnboarding({ agents, seen: true }, missing));
  t.ok('Existing completed setup does not repeat', !shouldShowOnboarding({ agents, setupComplete: true }, ready));
  t.ok('Status errors do not count as unconfigured accounts', !shouldShowOnboarding({ agents, seen: true }, new Map([['fake', {error:'offline'}]])));
  t.ok('One ready account is sufficient', !shouldShowOnboarding({ agents: [...agents, {id:'other',installed:false}], seen:true }, ready));
  const saved = process.env.AGENT_HOST_CLAUDE_BIN;
  process.env.AGENT_HOST_CLAUDE_BIN = 'missing-ply-test-cli-912345';
  t.ok('Missing executable shows installation action', !cliCommand('claude') && !installation('claude').installed);
  if (saved === undefined) delete process.env.AGENT_HOST_CLAUDE_BIN; else process.env.AGENT_HOST_CLAUDE_BIN = saved;
  let authResult = { loggedIn: true, email: 'test@example.invalid', authMethod: 'oauth' };
  let loginChild;
  const auth = createClaudeAuth(args => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => child.emit('close', 1);
    if (args[1] === 'login') loginChild = child;
    else queueMicrotask(() => { child.stdout.write(JSON.stringify(authResult)); child.emit('close', authResult.loggedIn ? 0 : 1); });
    return child;
  });
  t.ok('Claude status uses CLI JSON', (await auth.status()).loggedIn);
  authResult = { loggedIn: false };
  t.ok('Logged out is distinct from unavailable', !(await auth.status()).loggedIn);
  const events = [];
  const login = auth.login({ emit: e => events.push(e) });
  t.ok('Pending status', (await auth.status()).pending);
  await auth.login({ emit() {} }).then(() => t.ok('Duplicate login rejected', false), () => t.ok('Duplicate login rejected', true));
  loginChild.stdout.write('https://claude.ai/oauth/authorize?code=test\n');
  loginChild.stdout.write('https://untrusted.invalid/\n');
  loginChild.emit('close', 0); await login;
  t.ok('Only official login URL forwarded', events.filter(e => e.phase === 'url').length === 1);
  t.ok('Login completion emitted', events.at(-1).phase === 'done');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-setup-'));
  await fs.writeFile(path.join(dir, 'agent'), '#!/bin/sh');
  await fs.writeFile(path.join(dir, 'agent.cmd'), '@echo off');
  t.ok('Windows chooses command shim instead of extensionless POSIX script', findExecutable(path.join(dir, 'agent'), {}, 'win32') === path.join(dir, 'agent.cmd'));

  // Antigravity の Windows インストーラは `%LOCALAPPDATA%gyin` へ置き、PATH はそのあと
  // `agy install` が書く。起動済みの Pleiad は PATH の変更を拾えないので、置き場を直接見ないと
  // 「入れたのに未インストールのまま」になる（再起動しないと直らない）
  const agyBin = path.join(dir, 'agy', 'bin');
  await fs.mkdir(agyBin, { recursive: true });
  await fs.writeFile(path.join(agyBin, 'agy.exe'), '');
  t.ok('Antigravity is found in its install directory without PATH',
    findExecutable('agy', { LOCALAPPDATA: dir }, 'win32') === path.join(agyBin, 'agy.exe'),
    String(findExecutable('agy', { LOCALAPPDATA: dir }, 'win32')));
  t.ok('Nothing is found when it is not installed there',
    findExecutable('agy', { LOCALAPPDATA: path.join(dir, 'empty') }, 'win32') === null);

  // installation() は **backend.id** で引かれる。実行ファイル名が agy でも、
  // 鍵を agy にすると INSTALL_URLS が引けず、インストール導線が一度も出ない
  const savedAgy = process.env.AGENT_HOST_AGY_BIN;
  process.env.AGENT_HOST_AGY_BIN = 'missing-ply-test-cli-912345';
  try {
    const missingAgy = installation('antigravity');
    t.ok('Antigravity reports not installed under its backend id',
      missingAgy.installed === false && missingAgy.installUrl.includes('antigravity.google'),
      JSON.stringify(missingAgy));
  } finally {
    if (savedAgy === undefined) delete process.env.AGENT_HOST_AGY_BIN;
    else process.env.AGENT_HOST_AGY_BIN = savedAgy;
  }
  let server, client;
  try {
    server = await startServer({ dataDir: dir, env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open(server);
    t.ok('Setup initially incomplete', !(await client.cmd('onboardingStatus')).setupComplete);
    await client.cmd('onboardingSeen');
    t.ok('First display persisted independently of completion', (await client.cmd('onboardingStatus')).seen);
    await client.cmd('completeSetup', { backend: 'fake', cwd: dir }).then(() => t.ok('Login required', false), () => t.ok('Login required', true));
    await client.cmd('authLogin', { backend: 'fake' });
    await client.cmd('completeSetup', { backend: 'fake', cwd: path.join(dir, 'missing') }).then(() => t.ok('Folder validated', false), () => t.ok('Folder validated', true));
    const result = await client.cmd('completeSetup', { backend: 'fake', cwd: dir });
    t.ok('Setup can complete', result.setupComplete && result.cwd === dir);
    const noCwdResult = await client.cmd('completeSetup', { backend: 'fake' });
    t.ok('Setup defaults to homedir when cwd omitted', noCwdResult.setupComplete && noCwdResult.cwd === os.homedir());
    client.close(); await server.stop();
    server = await startServer({ dataDir: dir, env: { AGENT_HOST_BACKENDS: 'fake' } }); client = await open(server);
    t.ok('Setup survives server restart and different port', (await client.cmd('onboardingStatus')).setupComplete);
    t.ok('First display survives restart', (await client.cmd('onboardingStatus')).seen);
  } finally { client?.close(); await server?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
}
