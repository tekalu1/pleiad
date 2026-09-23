const fs = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { authMessage } = require('./update-auth.cjs');
const { t } = require('./i18n.cjs');

// No Electron dependency: the state machine is tested with a fake updater.
class Updates extends EventEmitter {
  constructor({ updater, version, file, enabled, install, prepareCheck = async () => {} }) {
    super();
    Object.assign(this, { updater, version, file, enabled, install, prepareCheck });
    this.state = { version, enabled, phase: enabled ? 'idle' : 'unavailable', channel: version.includes('-') ? 'beta' : 'stable', autoCheck: true, autoDownload: true, notice: false, lastChecked: null };
    this.busy = false;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    // 準備済みの更新があるときの確認（recheck）では、同じ版なら準備済みのまま置き、より新しい版だけを知らせる
    updater.on('update-available', info => this.recheck === info.version ? undefined : this.patch({ phase: 'available', target: info.version, notes: notesText(info.releaseNotes), progress: null, error: null }));
    updater.on('update-not-available', () => this.recheck ? undefined : this.patch({ phase: 'current', target: null, notes: '', error: null }));
    updater.on('download-progress', p => this.patch({ phase: 'downloading', progress: Math.round(p.percent) }));
    updater.on('update-downloaded', () => this.patch({ phase: 'downloaded', progress: 100, error: null }));
    updater.on('error', e => {
      // The install lifecycle restores the downloaded state and releases its lock.
      if (this.state.phase !== 'installing' && !this.recheck) this.patch({ phase: 'error', error: updateError(e) });
    });
  }
  snapshot() { return { ...this.state }; }
  patch(value) { Object.assign(this.state, value); this.emit('state', this.snapshot()); }
  async init() {
    let saved = {};
    try { saved = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error(t('update.settingsReadFailed')); }
    this.state.channel = ['stable', 'beta'].includes(saved.channel) ? saved.channel : this.state.channel;
    this.state.autoDownload = saved.autoDownload !== false;
    this.state.autoCheck = saved.autoCheck !== false;
    this.state.notice = Boolean(saved.lastVersion && saved.lastVersion !== this.version);
    this.applyChannel();
    await this.save();
    return this.snapshot();
  }
  applyChannel() {
    this.updater.channel = this.state.channel === 'beta' ? 'beta' : 'latest';
    this.updater.allowPrerelease = this.state.channel === 'beta';
    // Setting channel enables downgrade in electron-updater: always override it.
    this.updater.allowDowngrade = false;
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file + '.tmp', JSON.stringify({ channel: this.state.channel, autoCheck: this.state.autoCheck, autoDownload: this.state.autoDownload, lastVersion: this.version }));
    await fs.rename(this.file + '.tmp', this.file);
  }
  /**
   * 自動の確認。前回の確認（手動も含む）から minGap ミリ秒たっていなければ何もしない。
   * 失敗は state.error に出るので、ここでは投げない
   */
  async auto(minGap = 0) {
    // 見つけた版を利用者の操作待ちで出している間は確認し直さない（案内が一瞬消える）
    if (!this.enabled || !this.state.autoCheck || this.busy || this.state.phase === 'available') return false;
    if (this.lastAttempt && Date.now() - this.lastAttempt < minGap) return false;
    try { await this.command('check'); } catch { /* state に出ている */ }
    return true;
  }
  async command(action, value) {
    if (action === 'status') return this.snapshot();
    if (this.busy) throw new Error(t('update.busy'));
    this.busy = true;
    try {
      if (action === 'dismiss') { this.patch({ notice: false }); return this.snapshot(); }
      if (action === 'preferences') {
        if (!['stable', 'beta'].includes(value?.channel) || typeof value.autoDownload !== 'boolean' || typeof value.autoCheck !== 'boolean') throw new Error(t('update.invalidSettings'));
        if (['downloaded', 'downloading', 'installing'].includes(this.state.phase)) throw new Error(t('update.applyDownloadedFirst'));
        const previous = this.snapshot();
        Object.assign(this.state, { channel: value.channel, autoCheck: value.autoCheck, autoDownload: value.autoDownload });
        try { await this.save(); } catch (e) { this.state = previous; throw e; }
        this.applyChannel();
        this.patch({ phase: this.enabled ? 'idle' : 'unavailable', target: null, notes: '', error: null });
      } else {
        if (!this.enabled) throw new Error(t('update.unavailable'));
        if (action === 'check') {
          // ダウンロード済みでも確認は続ける。その後に出た新しい版を見逃さないため。
          // 確認に失敗しても、準備済みの更新はそのまま適用できる
          const ready = this.state.phase === 'downloaded' ? this.state.target : null;
          this.lastAttempt = Date.now();
          if (!ready) this.patch({ phase: 'checking', error: null });
          this.recheck = ready;
          try {
            await this.prepareCheck();
            await this.updater.checkForUpdates();
          } catch (e) {
            if (ready && this.state.phase === 'downloaded') return this.snapshot();
            throw e;
          } finally { this.recheck = null; }
          this.patch({ lastChecked: new Date().toISOString() });
          if (this.state.phase === 'available' && this.state.autoDownload) await this.download();
        } else if (action === 'download') {
          if (this.state.phase !== 'available') throw new Error(t('update.checkFirst'));
          await this.download();
        } else if (action === 'install') {
          if (this.state.phase !== 'downloaded') throw new Error(t('update.notDownloaded'));
          this.patch({ phase: 'installing', error: null });
          try { await this.install(); }
          catch (e) { this.patch({ phase: 'downloaded', error: e.message }); throw e; }
        } else throw new Error(t('update.unknownAction'));
      }
      return this.snapshot();
    } catch (e) {
      if (['checking', 'downloading', 'error'].includes(this.state.phase)) this.patch({ phase: 'error', error: updateError(e) });
      throw e;
    } finally { this.busy = false; }
  }
  async download() { this.patch({ phase: 'downloading', progress: 0 }); await this.updater.downloadUpdate(); }
}
function updateError(error) {
  if (error?.code === 'PLY_UPDATE_AUTH' || [401, 403, 404].includes(error?.statusCode)) return authMessage();
  if (['ERR_UPDATER_INVALID_SIGNATURE', 'ERR_CHECKSUM_MISMATCH', 'ERR_UPDATER_NO_CHECKSUM'].includes(error?.code)) return t('update.verifyFailed');
  return t('update.networkFailed');
}
function notesText(notes) {
  return (typeof notes === 'string' ? notes : Array.isArray(notes) ? notes.map(n => `${n.version}\n${n.note || ''}`).join('\n\n') : '').slice(0, 30000);
}
module.exports = { Updates, notesText };
