// ホストの鍵・リモートの設定・端末一覧の置き場（docs/remote.md §3.1・§3.3・§6.1）。
//
//   <data>/remote/secrets.json   ホストの静的鍵（秘密鍵）と中継の登録用の秘密。core/secret-store.mjs
//                                （デスクトップは safeStorage、npm start は 0600 の平文）
//   <data>/remote/settings.json  { enabled, relayUrl, hostName }（秘密は入れない）
//   <data>/remote/devices.json   { version: 1, devices: [{ id, name, platform, app, publicKey, tokenHash, createdAt, lastSeenAt }] }
//                                公開鍵は base64url、tokenHash は中継用トークン（生の 32 バイト）の SHA-256 の 16 進。トークンそのものは持たない
//
// ファイルは一時ファイル + rename で 0600、フォルダーは 0700 で作る（Windows では効かないが、利用者のフォルダーの中に置く）。
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSecretStore, plainCipher, withFileLock } from '../secret-store.mjs';
import { generateKeyPair, keyPairFromPrivate, hostIdFor } from './noise.mjs';
import { t } from '../i18n.mjs';

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error(t('remote.store.unreadable', { file: path.basename(file) }));
  }
}

export async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.chmod(tmp, 0o600).catch(() => {});
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); break; }
      catch (e) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise(done => setTimeout(done, 20 * (attempt + 1)));
      }
    }
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}

export const DEFAULT_SETTINGS = Object.freeze({ enabled: false, relayUrl: '', hostName: '' });

/**
 * リモートの置き場。dataDir は store.dataDir（AGENT_HOST_DATA を尊重する）。
 * cipher は server の暗号器（デスクトップは safeStorage に頼む）を渡す。
 */
export function createRemoteStore({ dataDir, cipher = plainCipher }) {
  const dir = path.join(dataDir, 'remote');
  const settingsFile = path.join(dir, 'settings.json');
  const devicesFile = path.join(dir, 'devices.json');
  const secrets = createSecretStore({ file: path.join(dir, 'secrets.json'), cipher });
  let identity = null;
  let queue = Promise.resolve();
  const serial = fn => { const run = queue.catch(() => {}).then(fn); queue = run; return run; };
  const lockedDevices = fn => serial(() => withFileLock(`${devicesFile}.lock`, fn));

  function keyFrom(priv) {
    const kp = keyPairFromPrivate(Buffer.from(priv, 'base64url'));
    return { ...kp, hostId: hostIdFor(kp.publicKey) };
  }

  async function readDevices() {
    const raw = await readJson(devicesFile, { version: 1, devices: [] });
    if (raw?.version !== 1 || !Array.isArray(raw.devices)) throw new Error(t('remote.store.badFormat', { file: 'devices.json' }));
    return raw;
  }

  return {
    dir,
    secrets,

    /** ホストの鍵。無ければ作る（プロセスをまたいで 1 つだけになるよう、秘密の置き場の排他の中で）。 */
    async identity() {
      if (identity) return identity;
      const priv = await secrets.update('hostKey', cur => cur ?? generateKeyPair().privateKey.toString('base64url'));
      identity = keyFrom(priv);
      return identity;
    },
    /** 作らずに読む。無ければ null。 */
    async peekIdentity() {
      if (identity) return identity;
      const priv = await secrets.get('hostKey');
      if (!priv) return null;
      identity = keyFrom(priv);
      return identity;
    },

    async settings() {
      const raw = await readJson(settingsFile, {});
      return {
        enabled: raw.enabled === true,
        relayUrl: typeof raw.relayUrl === 'string' ? raw.relayUrl : '',
        hostName: typeof raw.hostName === 'string' ? raw.hostName : '',
      };
    },
    async saveSettings(patch) {
      return serial(async () => {
        const next = { ...(await this.settings()), ...patch };
        await writeJson(settingsFile, next);
        return next;
      });
    },
    enrollSecret: () => secrets.get('enrollSecret'),
    setEnrollSecret: value => value ? secrets.set('enrollSecret', value) : secrets.delete('enrollSecret'),
    storageStatus: () => secrets.status(),

    async devices() { return (await readDevices()).devices; },
    async addDevice(device) {
      return lockedDevices(async () => {
        const data = await readDevices();
        data.devices = data.devices.filter(d => d.id !== device.id).concat(device);
        await writeJson(devicesFile, data);
        return device;
      });
    },
    /** 一覧から消す。消したものを返す（無ければ null）。 */
    async removeDevice(id) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id) ?? null;
        if (!hit) return null;
        data.devices = data.devices.filter(d => d.id !== id);
        await writeJson(devicesFile, data);
        return hit;
      });
    },
    async touchDevice(id, at = new Date().toISOString()) {
      return lockedDevices(async () => {
        const data = await readDevices();
        const hit = data.devices.find(d => d.id === id);
        if (!hit) return null;
        hit.lastSeenAt = at;
        await writeJson(devicesFile, data);
        return hit;
      });
    },
  };
}
