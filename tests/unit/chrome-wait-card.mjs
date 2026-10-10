import { readFileSync } from 'node:fs';
import { chromeWaitView, chromeSettledLine, waitedMinutes, waitState } from '../../web/chrome-wait-card.mjs';

export const name = 'chrome-wait-card';
export const title = 'ホストの Chrome の操作待ちのカード（端末の依頼元）: 1 行目で「どの PC の Chrome で何をするか」を言い、状態で中身を替え、「許可」は出さず「Chrome を使わずに続けてもらう」だけを置く';

const el = (tag, cls = null, value = '') => {
  const attrs = {};
  return { tag, className: cls, textContent: value, children: [], attrs, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return attrs[k] ?? null; }, removeAttribute(k) { delete attrs[k]; } };
};
const words = {
  'chat.chromeWait.skip': 'Chrome を使わずに続けてもらう', 'chat.chromeWait.skipSending': '伝えています…', 'chat.chromeWait.skipFailed': '伝えられませんでした · {{error}}',
  'chat.chromeWait.waited': '待って {{minutes}} 分', 'chat.chromeWait.waitedNow': '待っています', 'chat.chromeWait.join': ' · ',
  'chat.chromeWait.setup.lead': '{{host}} の Chrome で、リモート デバッグをオンにしてください',
  'chat.chromeWait.setup.step1': '{{host}} の Chrome のアドレス欄で {{address}} を開く',
  'chat.chromeWait.setup.step2': '「Allow remote debugging」をオンにする', 'chat.chromeWait.setup.auto': 'オンになると自動で進みます',
  'chat.chromeWait.permission.lead': '{{host}} の画面に Chrome の確認が出ています。「許可する」を押してください',
  'chat.chromeWait.denied.lead': '{{host}} の Chrome で接続が断られました', 'chat.chromeWait.denied.note': 'つなぐなら、{{host}} の Pleiad のカードで「もう一度」を押してください',
  'chat.chromeWait.asked.lead': '{{host}} の Chrome で操作してください（{{reason}}）', 'chat.chromeWait.operating.lead': '{{host}} で操作しています',
  'chat.chromeWait.offline': '{{host}} がオフラインです',
  'chat.chromeWait.done.connected': '{{host}} の Chrome につながりました', 'chat.chromeWait.done.resumed': '{{host}} での操作が済みました',
  'chat.chromeWait.done.skipped': 'Chrome を使わずに続けてもらいました', 'chat.chromeWait.done.declined': '{{host}} で断りました', 'chat.chromeWait.done.aborted': '子が待つのをやめました',
  'chat.browserHandoff.reason.login': 'ログイン', 'chat.browserHandoff.reason.other': 'その他',
};
const t = (key, vars = {}) => (words[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
const flat = node => (typeof node === 'string' ? node : [node.textContent, ...(node.children ?? []).map(flat)].join(''));
const bodyText = view => view.body.children.map(flat).join('\n');
const lead = view => flat(view.body.children[0]);
const T0 = Date.parse('2026-10-11T00:00:00Z');

export default async function (t_) {
  t_.ok('待った分数: 1 分に満たなければ null、それ以上は切り捨て', waitedMinutes('2026-10-11T00:00:00Z', T0 + 59_000) === null && waitedMinutes('2026-10-11T00:00:00Z', T0 + 125_000) === 2 && waitedMinutes(null, T0) === null);
  t_.ok('状態の名前: connect は setup/permission/denied、知らない値は setup と asked に倒す',
    waitState({ reason: 'connect', state: 'permission' }) === 'permission' && waitState({ reason: 'connect', state: '???' }) === 'setup'
    && waitState({ reason: 'login', state: 'operating' }) === 'operating' && waitState({ reason: 'login', state: 'asked' }) === 'asked' && waitState(null) === 'asked');

  const calls = [];
  let now = T0;
  const folded = [];
  const mk = (extra = {}) => chromeWaitView({ id: 'card-1', remote: { hostName: 'MSI', online: true }, chromeWait: { reason: 'connect', state: 'setup', since: '2026-10-11T00:00:00Z' }, ...extra },
    { el, t, cmd: async (n, a) => { calls.push([n, a]); }, now: () => now, foldElsewhere: id => folded.push(id) });

  const v = mk();
  t_.ok('最初の 1 行が「どの PC の Chrome で何をするか」（setup）', lead(v) === 'MSI の Chrome で、リモート デバッグをオンにしてください', lead(v));
  t_.ok('ホスト名は太字、アドレスは等幅の要素になる', v.body.children[0].children.some(c => c.tag === 'b' && c.textContent === 'MSI') && JSON.stringify(v.body.children[1].children).includes('chrome://inspect/#remote-debugging'));
  t_.ok('手順は 2 つの番号つきの行で、生の JSON や「承認」は出さない', v.body.children[1].tag === 'ol' && v.body.children[1].children.length === 2 && !/承認|\{"|許可しないと/.test(bodyText(v)), bodyText(v));
  t_.ok('ボタンは「Chrome を使わずに続けてもらう」の 1 つだけ（許可は出さない）', v.skip.textContent === 'Chrome を使わずに続けてもらう' && v.skip.className === 'btn' && !v.skip.disabled);
  t_.ok('本文は aria-live=polite（状態が替わっても読み上げは 1 回）', v.body.getAttribute('aria-live') === 'polite');
  t_.ok('足の左には「オンになると自動で進みます」（1 分未満は時間を付けない）', flat({ textContent: '', children: v.res.children }) === 'オンになると自動で進みます', flat({ textContent: '', children: v.res.children }));
  now = T0 + 3 * 60_000; v.tick();
  t_.ok('1 分を超えたら tick で「待って N 分」が付く', flat({ textContent: '', children: v.res.children }) === 'オンになると自動で進みます · 待って 3 分', flat({ textContent: '', children: v.res.children }));

  // 状態が替わると、同じカードの中身が入れ替わる
  v.update({ state: 'permission' });
  t_.ok('permission: 「許可する」を押してほしい先は MSI の画面だと書き、手順は消える', lead(v) === 'MSI の画面に Chrome の確認が出ています。「許可する」を押してください' && v.body.children.length === 1);
  t_.ok('permission でも、ここに「許可」のボタンは出ない', v.skip.textContent === 'Chrome を使わずに続けてもらう');
  v.update({ state: 'denied' });
  t_.ok('denied: 断られたことと「もう一度」はホストのカードで押すことを書く', lead(v) === 'MSI の Chrome で接続が断られました' && bodyText(v).includes('MSI の Pleiad のカードで「もう一度」'), bodyText(v));
  const op = mk({ chromeWait: { reason: 'login', state: 'asked', message: 'ログインしてください' } });
  t_.ok('操作の依頼（asked）: 理由と、依頼の本文を出す', lead(op) === 'MSI の Chrome で操作してください（ログイン）' && bodyText(op).includes('ログインしてください'), bodyText(op));
  op.update({ state: 'operating' });
  t_.ok('操作中（operating）でも、依頼の本文を消さない', lead(op) === 'MSI で操作しています' && bodyText(op).includes('ログインしてください'), bodyText(op));

  // オフライン
  v.setOnline(false);
  t_.ok('オフラインの間は押せず、足の左は空にして、本文にオフラインと書く', v.skip.disabled === true && v.res.children.length === 0 && bodyText(v).includes('MSI がオフラインです'));
  v.setOnline(true);
  t_.ok('つながると押せるに戻り、オフラインの文は消える', v.skip.disabled === false && !bodyText(v).includes('オフライン'));

  // 押す
  await v.skip.onclick();
  t_.ok('押すと resolvePermission（allow:false・messageKey: userDenied）を送る', calls.length === 1 && calls[0][0] === 'resolvePermission' && calls[0][1].id === 'card-1' && calls[0][1].allow === false && calls[0][1].always === false && calls[0][1].messageKey === 'userDenied', JSON.stringify(calls));

  const failing = chromeWaitView({ id: 'c2', remote: { hostName: 'MSI' }, chromeWait: { reason: 'connect', state: 'setup' } },
    { el, t, cmd: async () => { throw new Error('boom'); }, now: () => now });
  await failing.skip.onclick();
  t_.ok('送れなかったら足の左に理由を出し（role=alert）、押し直せる', failing.res.getAttribute('role') === 'alert' && flat({ textContent: '', children: failing.res.children }).includes('boom') && failing.skip.disabled === false);
  const gone = chromeWaitView({ id: 'c3', remote: { hostName: 'MSI' }, chromeWait: { reason: 'connect', state: 'setup' } },
    { el, t, cmd: async () => { const e = new Error('x'); e.code = 'ALREADY_RESOLVED'; throw e; }, foldElsewhere: id => folded.push(id) });
  await gone.skip.onclick();
  t_.ok('先によそで片付いていたときは失敗にせず、畳む', folded.join() === 'c3' && gone.res.getAttribute('role') !== 'alert');

  // 決着
  v.settle();
  v.update({ state: 'setup' });
  t_.ok('決着した後は触らない', lead(v) === 'MSI の Chrome で接続が断られました' && v.skip.disabled === true);

  // 決着の 1 行
  const line = a => chromeSettledLine(t, { host: 'MSI', ...a });
  t_.ok('決着の 1 行: つながった / 操作が済んだ / Chrome を使わずに続けた / 断った / 子がやめた',
    line({ by: 'host', allow: true, reason: 'connect' }) === 'MSI の Chrome につながりました' && line({ by: 'host', allow: true, reason: 'login' }) === 'MSI での操作が済みました'
    && line({ by: 'device', allow: false }) === 'Chrome を使わずに続けてもらいました' && line({ by: 'host', allow: false }) === 'MSI で断りました' && line({ by: 'abort', allow: false }) === '子が待つのをやめました');

  // 枠の配線: 決着したら本文を外して ◇ の 1 行だけに縮む（本文が残ると、つながった後も古い案内が読める）
  const client = readFileSync(new URL('../../web/client.mjs', import.meta.url), 'utf8');
  const card = client.slice(client.indexOf('function chromeWaitCard('), client.indexOf('function permissionCard('));
  t_.ok('決着で本文（view.body）を外す', /registerRelayCard\(ev, \{[^}]*removeOnFold: \[view\.body\]/.test(card));
}
