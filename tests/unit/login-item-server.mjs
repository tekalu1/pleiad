// サインイン時の起動（launchAtLogin）のサーバー側: main への依頼の口（core/login-item.mjs）と、設定 launchAtLogin（ply_control・CLI・画面の setPref が通る道）。
// 実体は desktop/login-item.cjs（本物の OS には触らない。ここでは main の代わりの偽の口と偽の host を使う）
import { EventEmitter } from 'node:events';
import { createLoginItemClient } from '../../core/login-item.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'login-item-server';
export const title = 'サインイン時の起動: main への依頼の口と、設定 launchAtLogin（agent は承認が要る・使えない構成は断る）';

/** main の代わりの口。reply で main が返す内容を決める */
function fakePort({ hosted = true, connected = true, reply = null } = {}) {
  const emitter = new EventEmitter();
  const sent = [];
  return {
    hosted, sent,
    get connected() { return connected; },
    on: (type, listener) => emitter.on(type, listener),
    off: (type, listener) => emitter.off(type, listener),
    postMessage(message) {
      if (!connected) return false;
      sent.push(message);
      if (reply) queueMicrotask(() => emitter.emit('message', { data: { type: 'login-item', id: message.id, ...reply(message) } }));
      return true;
    },
  };
}

const ON = { supported: true, enabled: true, blocked: false };
const OFF = { supported: true, enabled: false, blocked: false };

export default async function(t) {
  // 口: get / set は main へ { type:'login-item', id, action, enabled } を送り、返事の state を返す
  {
    let state = OFF;
    const port = fakePort({ reply: message => { if (message.action === 'set') state = message.enabled ? ON : OFF; return { ok: true, state }; } });
    const client = createLoginItemClient({ port });
    t.ok('get は main に action:get を送って状態を返す', (await client.get()).enabled === false && port.sent[0].type === 'login-item' && port.sent[0].action === 'get');
    const after = await client.set(true);
    t.ok('set は action:set と enabled を送り、新しい状態を返す', after.enabled === true && port.sent[1].action === 'set' && port.sent[1].enabled === true);
    t.ok('依頼ごとに別の id', new Set(port.sent.map(m => m.id)).size === port.sent.length);
  }
  // 口: main の下で動いていない起動（npm start のサーバーなど）は使えない構成として返す
  {
    const client = createLoginItemClient({ port: fakePort({ hosted: false }) });
    const info = await client.get();
    t.ok('main が居ない起動の get は supported:false', info.supported === false && info.enabled === false && typeof info.reason === 'string', JSON.stringify(info));
    let code = null;
    try { await client.set(true); } catch (error) { code = error.code; }
    t.ok('main が居ない起動の set は unsupported で断る', code === 'unsupported', String(code));
  }
  // 口: 更新の切り替え中など main に届かない間は、待たずに使えないと返す
  {
    const port = fakePort({ connected: false });
    const client = createLoginItemClient({ port });
    const info = await client.get();
    t.ok('届かない間の get は supported:false', info.supported === false && info.reason === 'away', JSON.stringify(info));
    let code = null;
    try { await client.set(true); } catch (error) { code = error.code; }
    t.ok('届かない間の set は away で断る', code === 'away', String(code));
  }
  // 口: main が断ったら code をそのまま持つ。応答が無ければ時間切れ
  {
    const client = createLoginItemClient({ port: fakePort({ reply: () => ({ ok: false, code: 'unsupported' }) }) });
    let code = null;
    try { await client.set(true); } catch (error) { code = error.code; }
    t.ok('main が断った code を持って失敗する', code === 'unsupported', String(code));
    const silent = createLoginItemClient({ port: fakePort(), timeoutMs: 20 });
    t.ok('応答が無い get は時間切れで supported:false', (await silent.get()).reason === 'timeout');
    let timeout = null;
    try { await silent.set(true); } catch (error) { timeout = error.code; }
    t.ok('応答が無い set は timeout で失敗する', timeout === 'timeout', String(timeout));
  }

  // 設定 launchAtLogin
  const setting = registry.settings.find(s => s.key === 'launchAtLogin');
  t.ok('設定 launchAtLogin がある（guarded・真偽・既定はオフ・prefs には持たない）',
    Boolean(setting) && setting.risk === 'guarded' && setting.default === false && (setting.prefKeys ?? []).length === 0, JSON.stringify(setting?.risk));
  if (!setting) return;
  const unbound = { by: 'agent', via: 'cli' };
  const human = { by: 'human', via: 'ui', local: true };
  const bound = { by: 'agent', via: 'mcp', sessionId: 'bypass:1', mode: { scope: 'full', autonomy: 'never' } };

  function deps({ info = OFF } = {}) {
    const log = { writes: [], records: [] };
    let current = info;
    return {
      log,
      deps: {
        locale: 'ja',
        prefs: async () => ({}),
        modeOf: async () => bound.mode,
        host: { loginItem: { get: async () => current } },
        writes: { loginItem: async enabled => { log.writes.push(enabled); current = { ...current, enabled }; } },
        recordSetting: async entry => { log.records.push(entry); },
        audit: async () => {},
        approve: async () => ({ pending: true, requestId: 'r1' }),
      },
    };
  }

  {
    const f = deps();
    const got = await registry.invoke(human, 'settings.get', { key: 'launchAtLogin' }, f.deps);
    t.ok('get は OS の今の状態を返す（オフ）', got.ok && JSON.stringify(got.result).includes('false'), JSON.stringify(got));
    const on = await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: true }, f.deps);
    t.ok('人間はオンにでき、main の登録（writes.loginItem）が呼ばれる', on.ok && f.log.writes.join() === 'true' && on.result.changed === true, JSON.stringify(on));
    t.ok('真偽でない値は INVALID', (await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: 'yes' }, f.deps)).code === 'INVALID');
    t.ok('null は INVALID（既定に戻すのは false）', (await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: null }, f.deps)).code === 'INVALID');
    const same = await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: true }, f.deps);
    t.ok('同じ値なら changed:false で登録し直さない', same.ok && same.result.changed === false && f.log.writes.length === 1, JSON.stringify(same));
  }
  {
    const f = deps();
    const r = await registry.invoke(unbound, 'settings.set', { key: 'launchAtLogin', value: true }, f.deps);
    t.ok('束縛のない agent は guarded なので書けない（登録されない）', !r.ok && f.log.writes.length === 0, JSON.stringify(r));
  }
  {
    // 使えない構成（開発起動・Store・Linux・main が居ない）はオンにできない。オフは「元からオフ」なので通す
    const f = deps({ info: { supported: false, reason: 'dev', enabled: false, blocked: false } });
    const on = await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: true }, f.deps);
    t.ok('使えない構成でオンにしようとすると INVALID で、登録しない', on.code === 'INVALID' && f.log.writes.length === 0, JSON.stringify(on));
    t.ok('INVALID の文に理由（dev）が入る', String(on.error ?? '').includes('dev') || String(on.detail ?? '').includes('dev'), JSON.stringify(on));
    const off = await registry.invoke(human, 'settings.set', { key: 'launchAtLogin', value: false }, f.deps);
    t.ok('使えない構成でオフにするのは変更なし（登録しない）', off.ok && off.result.changed === false && f.log.writes.length === 0, JSON.stringify(off));
  }
}
