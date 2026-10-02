import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { createMcpConfig, MASK, maskUrl } from '../../core/mcp-config.mjs';
import { containsPath } from '../../core/context-settings.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
export const name = 'mcp-config';
export const title = '標準 MCP 登録の保存・競合検出・既存設定の保持';
export default async function(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-mcp-config-'));
  const home = path.join(tmp, 'home'), cwd = path.join(tmp, 'repo');
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
  const reject = async (label, fn) => { try { await fn(); t.ok(label, false); } catch { t.ok(label, true); } };
  let server, client;
  try {
    await fs.mkdir(cwd, { recursive: true });
    const service = createMcpConfig({ home, codexHome: path.join(home, '.codex') });
    for (const format of ['claude', 'codex']) for (const scope of ['user', 'directory']) {
      const args = { cwd, format, scope }, initial = await service.list(args);
      t.ok(`${format}/${scope} は既存標準パス、読込だけでは作成しない`, !initial.path.includes('.ply') && initial.revision === 'missing');
      await service.save({ ...args, revision: initial.revision, mode: 'add', name: 'example', value: { command: 'node', args: ['SECRET-ARG'], env: { TOKEN: 'SECRET-TOKEN' } } });
      const list = await service.list(args), edit = await service.get({ ...args, name: 'example' });
      t.ok(`${format}/${scope} は一覧にも明示編集の読み出しにも秘密の値を返さない（env の値は伏せ字）`, list.servers.join() === 'example' && !JSON.stringify(list).includes('SECRET') && !JSON.stringify(edit).includes('SECRET-TOKEN') && edit.value.env.TOKEN === MASK && edit.value.command === 'node');
      // 伏せ字のまま編集して保存すると、今の値が残る。伏せ字を実際の値として書かない
      await service.save({ ...args, revision: edit.revision, mode: 'edit', name: 'example', value: { ...edit.value, args: ['CHANGED-ARG'] } });
      const kept = JSON.stringify(await service.getWithSecrets({ ...args, name: 'example' }));
      t.ok(`${format}/${scope} 伏せ字のまま保存しても env の値は前のまま`, kept.includes('SECRET-TOKEN') && kept.includes('CHANGED-ARG') && !kept.includes(MASK));
      const edit2 = await service.get({ ...args, name: 'example' });
      await reject(`${format}/${scope} 前の値が無い伏せ字は保存しない`, () => service.save({ ...args, revision: edit2.revision, mode: 'edit', name: 'example', value: { command: 'node', env: { NEW: MASK } } }));
      const edit3 = await service.get({ ...args, name: 'example' });
      edit.revision = edit3.revision;
      await service.save({ ...args, revision: edit.revision, mode: 'edit', name: 'example', value: { url: 'https://example.com/mcp' } });
      t.ok(`${format}/${scope} の編集が再読込に反映`, (await service.get({ ...args, name: 'example' })).value.url === 'https://example.com/mcp');
      await reject(`${format}/${scope} は古い編集の上書きを拒否`, () => service.save({ ...args, revision: edit.revision, mode: 'edit', name: 'example', value: { command: 'changed' } }));
    }
    t.ok('URL のクエリと userinfo を伏せる', maskUrl('https://user:pw@example.com/mcp?key=SECRET#x') === `https://${MASK}@example.com/mcp?${MASK}#x` && maskUrl('https://example.com/mcp') === 'https://example.com/mcp');
    {
      const args = { cwd, format: 'claude', scope: 'directory' };
      const meta = await service.list(args);
      await service.save({ ...args, revision: meta.revision, mode: 'add', name: 'remote', value: { url: 'https://example.com/mcp?key=SECRET-KEY', headers: { Authorization: 'Bearer SECRET-HDR' }, oauth: { clientId: 'id', clientSecret: 'SECRET-CS' } } });
      const shown = await service.get({ ...args, name: 'remote' });
      t.ok('HTTP の MCP: URL のクエリ・ヘッダーの値・OAuth のクライアントシークレットを伏せ、名前と clientId は見せる',
        !JSON.stringify(shown).includes('SECRET') && shown.value.headers.Authorization === MASK && shown.value.oauth.clientId === 'id' && shown.value.url === `https://example.com/mcp?${MASK}`, JSON.stringify(shown.value));
      await service.save({ ...args, revision: shown.revision, mode: 'edit', name: 'remote', value: shown.value });
      const back = await service.getWithSecrets({ ...args, name: 'remote' });
      t.ok('伏せ字のまま保存しても、URL・ヘッダー・OAuth の値は前のまま', back.value.url.endsWith('key=SECRET-KEY') && back.value.headers.Authorization === 'Bearer SECRET-HDR' && back.value.oauth.clientSecret === 'SECRET-CS');
      await reject('URL が伏せ字のままでも、前の URL と合わなければ保存しない', () => service.save({ ...args, revision: back.revision, mode: 'edit', name: 'remote', value: { url: `https://other.example.com/mcp?${MASK}` } }));
    }
    const claude = { cwd, format: 'claude', scope: 'user' };
    const file = path.join(home, '.claude.json');
    const original = { oauth: { token: 'SECRET-OAUTH' }, projects: { [cwd]: { trust: true, mcpServers: { personal: { command: 'x' } } } }, mcpServers: { existing: { command: 'before' } } };
    await write(file, JSON.stringify(original));
    await service.save({ ...claude, ...(await service.list(claude)), mode: 'add', name: 'added', value: { command: 'node' } });
    const preserved = JSON.parse(await fs.readFile(file, 'utf8'));
    t.ok('Claude の認証・project・他 MCP を保持', JSON.stringify(preserved.projects) === JSON.stringify(original.projects) && preserved.oauth.token === original.oauth.token && preserved.mcpServers.existing.command === 'before');
    const codex = { cwd, format: 'codex', scope: 'directory' }, tomlFile = path.join(cwd, '.codex/config.toml');
    const source = '# Keep global comment\nmodel = "test"\n[mcp_servers."with.dot"]\ncommand = "old"\n[mcp_servers."with.dot".env]\nTOKEN = "OLD"\n[projects."somewhere"]\n# Keep trust comment\ntrust_level = "trusted"\n[mcp_servers.other]\ncommand = "other"\n';
    await write(tomlFile, source);
    await service.save({ ...codex, ...(await service.list(codex)), mode: 'edit', name: 'with.dot', value: { command: 'new', args: ['ok'] } });
    const text = await fs.readFile(tomlFile, 'utf8'), parsed = parse(text);
    t.ok('TOML の引用キーと子テーブルを置換し他の本文とコメントを保持', text.includes('# Keep global comment') && text.includes('[projects."somewhere"]\n# Keep trust comment') && parsed.mcp_servers.other.command === 'other' && parsed.mcp_servers['with.dot'].command === 'new' && !parsed.mcp_servers['with.dot'].env);
    await write(tomlFile, '[mcp_servers]\ninline = { command = "old" }\n');
    const inline = { ...codex, ...(await service.list(codex)), mode: 'edit', name: 'inline', value: { command: 'new' } };
    t.ok('インライン TOML は再整形の必要性を事前に返す', (await service.get({ ...codex, name: 'inline' })).reformatsFile);
    await reject('再整形を黙って実行しない', () => service.save(inline));
    await service.save({ ...inline, allowReformat: true });
    t.ok('明示的な再整形でインライン TOML も編集可能', parse(await fs.readFile(tomlFile, 'utf8')).mcp_servers.inline.command === 'new');
    const latest = await service.list(codex);
    const concurrent = await Promise.allSettled(['one', 'two'].map(name => service.save({ ...codex, revision: latest.revision, mode: 'add', name, value: { command: 'node' } })));
    t.ok('同じリビジョンへの同時保存は一方だけ成功', concurrent.filter(r => r.status === 'fulfilled').length === 1);
    const valid = { ...codex, ...(await service.list(codex)), mode: 'add', name: 'valid', value: { command: 'node' } };
    await reject('予約名を拒否', () => service.save({ ...valid, name: '__proto__' }));
    await reject('引数の型が不正なら保存を拒否', () => service.save({ ...valid, value: { command: 'node', args: 'secret' } }));
    await reject('同名追加は既存登録を上書きしない', () => service.save({ ...valid, name: 'inline' }));
    await write(tomlFile, 'SECRET-INVALID = [');
    try { await service.list(codex); t.ok('壊れた TOML は秘密を漏らさず拒否', false); }
    catch (e) { t.ok('壊れた TOML は秘密を漏らさず拒否', !e.message.includes('SECRET')); }
    await reject('壊れた設定は保存で上書きしない', () => service.save(valid));
    t.ok('壊れたファイルの原文を保持', await fs.readFile(tomlFile, 'utf8') === 'SECRET-INVALID = [');
    server = await startServer({ dataDir: path.join(tmp, 'data'), env: { AGENT_HOST_BACKENDS: 'fake' } });
    client = await open(server);
    const api = { cwd, format: 'claude', scope: 'directory' }, inventory = await client.cmd('listMcpConfig', api);
    await client.cmd('saveMcpServer', { ...api, revision: inventory.revision, mode: 'add', name: 'api', value: { command: 'this-command-must-not-run' } });
    t.ok('認証付き API から追加・編集でき、サーバー起動はしない', (await client.cmd('readMcpServer', { ...api, name: 'api' })).value.command === 'this-command-must-not-run');
    await client.cmd('saveMcpServer', { ...api, ...(await client.cmd('listMcpConfig', api)), mode: 'add', name: 'api2', value: { command: 'x', env: { TOKEN: 'SECRET-WS' } } });
    const viaWs = await client.cmd('readMcpServer', { ...api, name: 'api2' });
    t.ok('WS の readMcpServer も env の値を伏せ字で返す', viaWs.value.env.TOKEN === MASK && !JSON.stringify(viaWs).includes('SECRET-WS'));
  } finally {
    client?.close(); await server?.stop();
    if (!containsPath(os.tmpdir(), tmp) || !path.basename(tmp).startsWith('ply-mcp-config-')) throw new Error('unexpected test path');
    await fs.rm(tmp, { recursive: true });
  }
}
