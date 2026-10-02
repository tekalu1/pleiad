// スマホのアプリ（モバイル版の殻）の中だけで効く、離れていても届く通知（ADR 0086）の画面側。
//
// - 通知の許可はインストール時に尋ねない。アプリを開いている間に最初の作業が終わったとき、会話の上に帯
//   「離れていても知らせますか？ [オンにする]」を出す。押すと殻が許可を尋ね、前面サービスを始める（plyRemote.notify.enable）
// - 「あとで」は殻に覚えさせる（もう帯は出さない。スマホのアプリの設定 › 通知からいつでもオンにできる）
// - 通知を押して開いたときの行き先: 殻が会話の id を渡す（開いた直後は URL の ?open=、開いている間は plyremote:open）
//
// 殻（mobile/android の HostActivity）が window.plyRemote.notify = { state(), enable(), dismiss() } を入れる。無い画面（デスクトップ・ブラウザー）では何もしない。
import { el, icon } from './dom.mjs';
import { t } from './i18n.mjs';

/**
 * @param host        window（試験では偽物）
 * @param band        帯を入れる要素（会話の上）
 * @param openSession (sessionId) => 会話を開く
 */
export function setupMobileNotify({ host = window, band, openSession }) {
  const api = host.plyRemote?.notify;
  let pending = false, shown = false;

  function hide() {
    shown = false;
    band.hidden = true;
    band.replaceChildren();
  }

  function show() {
    if (shown) return;
    shown = true;
    const text = el('span', 'nb-text', t('notify.mobile.band'));
    const enable = el('button', 'btn nb-enable', t('notify.mobile.enable'));
    enable.type = 'button';
    const later = el('button', 'btn btn-icon nb-later');
    later.type = 'button';
    later.setAttribute('aria-label', t('notify.mobile.later'));
    later.title = t('notify.mobile.later');
    later.append(icon('M6 6l12 12M18 6L6 18'));
    enable.onclick = async () => {
      enable.disabled = true;
      try { await api.enable(); } catch { /* 殻が案内を出す。帯は閉じる */ }
      hide();
    };
    later.onclick = () => { try { api.dismiss(); } catch { /* 済み */ } hide(); };
    band.replaceChildren(text, enable, later);
    band.hidden = false;
  }

  if (api) {
    host.addEventListener?.('plyremote:open', e => {
      const id = e?.detail?.sessionId;
      if (typeof id === 'string' && id) void openSession(id);
    });
  }

  return {
    /** 生きている完了（リプレイではない）を見たとき。通知がまだオンでなく、帯を閉じていなければ出す */
    async completed(replay = false) {
      if (!api || replay || shown || pending) return;
      pending = true;
      try {
        const st = await api.state();
        if (st && st.enabled !== true && st.dismissed !== true) show();
      } catch { /* 殻が答えないなら出さない */ }
      pending = false;
    },
    /** 開いた直後の URL の ?open=<会話> を 1 回だけ取り出す（取り出したら URL から消す） */
    takeOpenRequest() {
      try {
        const url = new URL(host.location.href);
        const id = url.searchParams.get('open');
        if (!id) return null;
        url.searchParams.delete('open');
        host.history?.replaceState?.(null, '', url.pathname + url.search + url.hash);
        return id;
      } catch { return null; }
    },
    hide,
    get available() { return Boolean(api); },
  };
}
