// --listen unix:// / ws:// の起動の様子を見る（バナー・作られるファイル・認証の要否）
import { makeEnv, spawnAppServer, killTree, log, sleep } from './lib.mjs';
import fs from 'node:fs'; import path from 'node:path';
const kind = process.argv[2] ?? 'ws';
const E = await makeEnv();
const listen = kind === 'ws' ? 'ws://127.0.0.1:0' : `unix://`;
const child = spawnAppServer(E.env, ['--listen', listen]);
let out = ''; child.stdout.on('data', (d) => out += d);
await sleep(4000);
log('listen =', listen, '\nstdout:', out.slice(0, 600), '\nstderr:', child.stderrBuf.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 800));
log('home files:', fs.readdirSync(E.home).join(','));
killTree(child); await sleep(800); await E.close();
