// The shell's strings (ja / en). The shell is bundled in the app, so it keeps its own small dictionary
// (the host UI's dictionaries live in web/locales/ and are served by the host). Terms follow the i18n glossary:
// host / device / relay / pair (ホスト / 端末 / 中継 / ペアリング).
(function () {
  const dict = {
    en: {
      'hosts.title': 'Hosts',
      'hosts.add': 'Add host',
      'hosts.empty': 'No hosts yet. Add the Pleiad running on your PC.',
      'hosts.foot': 'On the host, open Settings › Remote › "Add device" and scan the QR code shown there.',
      'hosts.notEncrypted': 'Credentials could not be encrypted on this device.',
      'hosts.more': 'Actions for {host}',
      'hosts.rename': 'Rename',
      'hosts.renamePrompt': 'Name shown in this app',
      'hosts.remove': 'Delete',
      'hosts.removeConfirm': "Delete {host} from this device? To stop this device from connecting, also revoke it in the host's device list.",
      'hosts.lastUsed': 'Last used {when}',
      'hosts.neverUsed': 'Not opened yet',
      'state.connecting': 'Connecting…',
      'state.connected': 'Online',
      'state.offline': "Can't reach the relay",
      'state.host-offline': 'Host offline',
      'state.revoked': 'Removed on the host · pair again',
      'pair.title': 'Add host',
      'pair.scan': 'Scan QR code',
      'pair.pasteLabel': 'Or paste the pairing code',
      'pair.pastePlaceholder': 'pleiad://pair?…',
      'pair.add': 'Add',
      'pair.confirmLead': 'Add this host?',
      'pair.relay': 'Relay:',
      'pair.known': 'This host is already paired. Adding it again replaces the credentials.',
      'pair.connecting': 'Connecting to the host…',
      'pair.approveOn': 'Approve on the screen of {host}',
      'pair.codeNote': 'Check that the host shows the same number before approving.',
      'pair.fullAccess': "A paired device can do everything the host's user can. If you lose it, revoke it in the host's device list.",
      'pair.done': 'Added {host}',
      'pair.scanUnavailable': 'Google Play services is installing the QR scanner. Try again in a moment, or paste the code.',
      'pair.scanFailed': "Couldn't scan. Paste the code instead.",
      'pair.cameraDenied': 'Camera access was denied. Paste the code instead.',
      'err.payload': 'This is not a Pleiad pairing code.',
      'err.relay-url': 'The relay address in the code is not usable.',
      'err.denied': 'The host declined the request.',
      'err.expired': 'The request expired while waiting for approval. Create a new code on the host.',
      'err.ticket': "This pairing code can't be used (already used or expired). Create a new one on the host.",
      'err.rate': 'Too many pairing attempts. Wait a moment and try again.',
      'err.host-offline': "Can't reach the host. Make sure Pleiad is running on the host.",
      'err.offline': "Can't reach the relay. Check your network.",
      'err.cancelled': 'The connection dropped during pairing.',
      'err.aborted': 'Pairing was canceled.',
      'err.timeout': 'Timed out waiting for approval on the host.',
      'err.handshake': "The host's key doesn't match the pairing code.",
      'err.bad-response': "The host's response was malformed.",
      'err.storage': "Couldn't read the saved credentials on this device.",
      'err.unknown-host': 'This host is not paired.',
      'err.internal': 'Something went wrong: {detail}',
      'common.back': 'Back',
      'common.cancel': 'Cancel',
    },
    ja: {
      'hosts.title': 'ホスト',
      'hosts.add': 'ホストを追加',
      'hosts.empty': 'まだホストがありません。PC で動いている Pleiad を追加します。',
      'hosts.foot': 'ホストの Pleiad の 設定 › リモート ›「端末を追加」で出る QR を読みます。',
      'hosts.notEncrypted': 'この端末では資格情報を暗号化できませんでした。',
      'hosts.more': '{host} の操作',
      'hosts.rename': '名前を変える',
      'hosts.renamePrompt': 'このアプリでの表示名',
      'hosts.remove': '削除',
      'hosts.removeConfirm': '{host} をこの端末から削除しますか？ この端末からつながらないようにするには、ホストの端末一覧でも取り消してください。',
      'hosts.lastUsed': '{when}に使用',
      'hosts.neverUsed': 'まだ開いていません',
      'state.connecting': '確認中…',
      'state.connected': 'オンライン',
      'state.offline': '中継につながりません',
      'state.host-offline': 'ホストがオフライン',
      'state.revoked': 'ホストで取り消されました · もう一度ペアリング',
      'pair.title': 'ホストを追加',
      'pair.scan': 'QR を読む',
      'pair.pasteLabel': 'またはペアリングのコードを貼り付け',
      'pair.pastePlaceholder': 'pleiad://pair?…',
      'pair.add': '追加',
      'pair.confirmLead': 'このホストを追加しますか？',
      'pair.relay': '中継:',
      'pair.known': 'このホストはペアリング済みです。追加し直すと資格情報を差し替えます。',
      'pair.connecting': 'ホストにつないでいます…',
      'pair.approveOn': '{host} の画面で承認してください',
      'pair.codeNote': 'ホストの画面に同じ数字が出ていることを確かめてから承認します。',
      'pair.fullAccess': '追加した端末は、ホストの利用者と同じようにすべての操作ができます。失くしたときはホストの端末一覧から取り消してください。',
      'pair.done': '{host} を追加しました',
      'pair.scanUnavailable': 'QR の読み取り機能を Google Play 開発者サービスが準備しています。少し待ってからもう一度試すか、コードを貼り付けてください。',
      'pair.scanFailed': '読み取れませんでした。コードを貼り付けてください。',
      'pair.cameraDenied': 'カメラの使用が許可されていません。コードを貼り付けてください。',
      'err.payload': 'Pleiad のペアリングのコードではありません。',
      'err.relay-url': 'コードの中継のアドレスが使えません。',
      'err.denied': 'ホストで断られました。',
      'err.expired': 'ホストの承認を待つ間に期限が切れました。ホストでコードを作り直してください。',
      'err.ticket': 'このペアリングのコードは使えません（使用済みか期限切れ）。ホストで作り直してください。',
      'err.rate': 'ペアリングの試行が多すぎます。少し待ってからもう一度試してください。',
      'err.host-offline': 'ホストにつながりません。ホストの Pleiad が起動しているか確かめてください。',
      'err.offline': '中継につながりません。ネットワークを確かめてください。',
      'err.cancelled': 'ペアリングの途中で接続が切れました。',
      'err.aborted': 'ペアリングをやめました。',
      'err.timeout': 'ホストの承認を待つ間に時間切れになりました。',
      'err.handshake': 'ホストの鍵がペアリングのコードと合いません。',
      'err.bad-response': 'ホストの応答の形が違います。',
      'err.storage': 'この端末に保存した資格情報を読めませんでした。',
      'err.unknown-host': 'このホストはペアリングされていません。',
      'err.internal': 'うまくいきませんでした: {detail}',
      'common.back': '戻る',
      'common.cancel': 'やめる',
    },
  };
  const lang = (navigator.language || 'en').toLowerCase().startsWith('ja') ? 'ja' : 'en';
  function t(key, vars) {
    const s = dict[lang][key] ?? dict.en[key] ?? '';
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s;
  }
  function apply(root) {
    root.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.dataset.t); });
    root.querySelectorAll('[data-t-label]').forEach(n => { n.setAttribute('aria-label', t(n.dataset.tLabel)); });
    root.querySelectorAll('[data-t-placeholder]').forEach(n => { n.setAttribute('placeholder', t(n.dataset.tPlaceholder)); });
  }
  const rtf = typeof Intl.RelativeTimeFormat === 'function' ? new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }) : null;
  function ago(ms) {
    const s = Math.round((ms - Date.now()) / 1000);
    const abs = Math.abs(s);
    if (!rtf) return new Date(ms).toLocaleString(lang);
    if (abs < 60) return rtf.format(s, 'second');
    if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(s / 3600), 'hour');
    return rtf.format(Math.round(s / 86400), 'day');
  }
  document.documentElement.lang = lang;
  window.shellI18n = { t, apply, ago, lang, dict };
})();
