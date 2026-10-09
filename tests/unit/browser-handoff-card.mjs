import { browserHandoffView } from '../../web/browser-handoff-card.mjs';

export const name = 'browser-handoff-card';
export const title = 'Chrome の操作待ちのカード: 人が操作している間も、頼まれた本文を「Claude に戻す」まで出し続ける';

const el = (tag, cls = null, value = '') => ({ tag, className: cls, textContent: value, children: [],
  append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
  setAttribute() {}, removeAttribute() {} });
const words = { 'chat.browserHandoff.operating': 'あなたが操作中', 'chat.browserHandoff.operatingNote': 'Chrome のウィンドウで操作して、終わったら「Claude に戻す」を押してください。',
  'chat.browserHandoff.resume': 'Claude に戻す', 'chat.browserHandoff.operate': 'Chrome で操作する' };
const t = key => words[key] ?? key;
const texts = view => view.body.children.map(child => child.textContent);
const message = view => view.body.children.find(child => child.className === 'bh-message');

export default async function (t_) {
  const commands = [];
  const view = browserHandoffView({ id: 'card', sessionId: 's', browserHandoff: { reason: 'other', state: 'asked', message: '同意のチェックを入れて「アプリを作成」を押してください', dialog: false } },
    { el, t, cmd: async (name, args) => { commands.push([name, args]); } });
  t_.ok('お願いの段階では本文を出す', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));

  await view.buttons.at(-1).onclick();
  // サーバーの差し替えの便りは変わった項目だけを運ぶ（handoff.mjs の patch）。本文はその前の値のまま残る
  view.update({ state: 'operating', by: 'pc', windowTitle: 'アプリを作成 - Google Cloud' });
  t_.ok('引き継いだあと（あなたが操作中）も本文が消えない', message(view)?.textContent === '同意のチェックを入れて「アプリを作成」を押してください', JSON.stringify(texts(view)));
  t_.ok('本文は見出しの次、操作の案内の前に出る', texts(view).indexOf('あなたが操作中') === 0 && texts(view).indexOf(message(view).textContent) === 1 && texts(view)[2].includes('Claude に戻す'), JSON.stringify(texts(view)));
  t_.ok('「Claude に戻す」のボタンを出し、押すと戻す', view.buttons.length === 1 && view.buttons[0].textContent === 'Claude に戻す');
  await view.buttons[0].onclick();
  t_.ok('戻すとき会話の id を付けて chromeResume を送る', commands.at(-1)?.[0] === 'chromeResume' && commands.at(-1)[1].sessionId === 's', JSON.stringify(commands));

  // 端末で操作している間も同じ
  const device = browserHandoffView({ id: 'card2', sessionId: 's', browserHandoff: { reason: 'login', state: 'asked', message: 'ログインしてください' } }, { el, t, cmd: async () => {} });
  device.update({ state: 'operating', by: 'device' });
  t_.ok('別の端末で操作している間も本文が消えない', message(device)?.textContent === 'ログインしてください', JSON.stringify(texts(device)));

  // 本文の無い依頼（message 無し）は空の行を作らない
  const bare = browserHandoffView({ id: 'card3', sessionId: 's', browserHandoff: { reason: 'captcha', state: 'asked', message: null } }, { el, t, cmd: async () => {} });
  bare.update({ state: 'operating', by: 'pc' });
  t_.ok('本文が無い依頼は、操作中に空の行を足さない', !message(bare) && texts(bare).length === 2, JSON.stringify(texts(bare)));
}
