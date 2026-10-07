// 切り替えを待つ表示の画面の部品（web/switch-notice.mjs、docs/design-system.md「切り替えを待つ表示」）。
// main が渡す状態の読み方（版・phase・欠けた項目）・作業の行と止まるものの行・件数・止めたものの字・脇の知らせと設定のページに出す形・辞書。
// 配線（index.html・client.mjs・updates.mjs・preload・辞書の対応）は文字列で確かめる。DOM を使う描画は tests/browser/switch-notice.cjs
import { readFileSync } from 'node:fs';
import {
  SWITCH_BRIDGE_VERSIONS, readSwitchState, switchWorkRows, switchStopperRows, switchCounts, stoppedText, noticeModel, pageModel,
} from '../../web/switch-notice.mjs';

export const name = 'web-switch-notice';
export const title = '切り替えを待つ表示の画面: 状態の読み方（版・欠けた項目）・作業と止まるものの行・件数・止めたもの・知らせとページの形・辞書';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  const base = { v: 1, target: '0.8.0', current: '0.7.4' };
  const items = [{ kind: 'turn', sessionId: 'a', backend: 'claude' }, { kind: 'subagent', sessionId: 'a' }, { kind: 'turn', sessionId: 'b', backend: 'codex' }, { kind: 'permission', sessionId: 'c' }, { kind: 'turn', sessionId: 'd', backend: 'claude' }, { kind: 'task', sessionId: null }];
  const stoppers = [{ kind: 'shell', sessionId: 'e', label: 'npm run dev' }, { kind: 'background', sessionId: 'f', backend: 'codex', label: 'vite dev' }, { kind: 'background', sessionId: 'f', backend: 'codex', label: null }];

  // ---- 状態の読み方（main は 1 版新しいことがある。読めないものは出さない）
  t.ok('この画面が読める口の版は 1', SWITCH_BRIDGE_VERSIONS.join() === '1');
  t.ok('版 1 の状態を読む', readSwitchState({ ...base, phase: 'waiting', since: 5, items, stoppers })?.phase === 'waiting');
  t.ok('知らない版・形の違うもの・知らない phase は null（何も出さない）', readSwitchState({ ...base, v: 2, phase: 'waiting' }) === null && readSwitchState({ ...base, phase: 'nonsense' }) === null
    && readSwitchState({ ...base, phase: 'none' }) === null && readSwitchState(null) === null && readSwitchState('x') === null && readSwitchState({ phase: 'waiting' }) === null);
  const lenient = readSwitchState({ v: 1, phase: 'waiting', items: [null, 3, { kind: 'turn', sessionId: 7, extra: true }], stoppers: 'no', since: 'x', interrupt: 5, unknownField: 1 });
  t.ok('欠けた項目・知らない項目・形の違う項目は空として読む（後ろの版でも前の版でも落ちない）', lenient.items.length === 1 && lenient.items[0].sessionId === null && lenient.stoppers.length === 0 && lenient.since === null
    && lenient.interrupt === null && lenient.target === '' && lenient.interruptFailed === false && lenient.stopped.length === 0);
  t.ok('中断の進みは数だけ取る', readSwitchState({ ...base, phase: 'stopping', interrupt: { done: 2, total: 4, junk: 1 } }).interrupt.total === 4);

  // ---- 行
  const rows = switchWorkRows(items);
  t.ok('作業は会話ごとに 1 行（同じ会話のターンとサブエージェントは重ねない）', rows.length === 5 && rows.filter(r => r.sessionId === 'a').length === 1);
  t.ok('承認を待っている会話は waiting、それ以外は running（エージェントはターンのもの）', rows.find(r => r.sessionId === 'c').state === 'waiting' && rows.find(r => r.sessionId === 'a').state === 'running' && rows.find(r => r.sessionId === 'a').backend === 'claude');
  t.ok('会話の分からない作業（null）も 1 行', rows.some(r => r.sessionId === null));
  const stops = switchStopperRows(stoppers);
  t.ok('`!` のシェルは「! コマンド」、裏の端末は「端末 · 名前」（名前が無ければ「端末」）', stops[0].what === '! npm run dev' && stops[1].what === '端末 · vite dev' && stops[2].what === '端末' && new Set(stops.map(s => s.key)).size === 3);
  t.ok('実行中 N 件・承認待ち M 件', switchCounts(rows) === '実行中 4 件・承認待ち 1 件' && switchCounts(rows.filter(r => r.state === 'running')) === '実行中 4 件' && switchCounts([]) === '');
  t.ok('止めたものの 1 行（! のシェル・エージェントごとの端末）', stoppedText([stoppers[0], stoppers[1]], id => (id === 'codex' ? 'Codex' : id)) === '止めたもの: ! のシェル 1 件・Codex の端末 1 件'
    && stoppedText([stoppers[2]].map(s => ({ ...s, backend: null }))) === '止めたもの: 裏の端末 1 件' && stoppedText([]) === '');

  // ---- 知らせの形
  const model = phase => noticeModel(readSwitchState({ ...base, phase, since: 5, items, stoppers, interrupt: { done: 2, total: 4 }, reason: 'schema', kind: 'stoppers' }));
  const wait = model('waiting');
  t.ok('待ち: 題・件数・作業と止まるもの。待ち始めの時刻を持つ', wait.kind === 'wait' && wait.title === 'Pleiad 0.8.0 への切り替えを待っています' && wait.sub === '実行中 4 件・承認待ち 1 件' && wait.rows.length === 5 && wait.stoppers.length === 3 && wait.since === 5);
  t.ok('待ち: 中断が止まらなかったときだけ 1 行（辞書の文言）', wait.error === '' && noticeModel(readSwitchState({ ...base, phase: 'waiting', interruptFailed: true })).error.includes('止まらない作業があったため'));
  const ask = model('asking');
  t.ok('聞く: 止まるものだけを並べ、「切り替えると N 件が止まります」', ask.kind === 'ask' && ask.title === 'Pleiad 0.8.0 に切り替える準備ができました' && ask.sub === '切り替えると 3 件が止まります' && ask.rows.length === 0 && ask.stoppers.length === 3);
  const manual = model('manual');
  t.ok('合わない版: 形式番号が変わる理由と、それ以外の理由の 1 行', manual.kind === 'manual' && manual.title.includes('作業を中断します') && manual.sub === 'データの形式が変わるため、自動では切り替わりません' && manual.rows.length === 5
    && noticeModel(readSwitchState({ ...base, phase: 'manual', reason: 'ipc' })).sub.includes('作業を続けたまま渡せない'));
  t.ok('中断中・切り替え中の字', model('stopping').title === 'Pleiad 0.8.0 · 作業を中断しています… 2 / 4' && model('switching').title === 'Pleiad 0.8.0 に切り替えています…');
  t.ok('失敗: 前の版の名前。閉じた失敗は出さない', model('failed').title === '新しい版を起動できなかったため、前の版（0.7.4）で動いています' && noticeModel(readSwitchState({ ...base, phase: 'failed' }), { dismissed: true }) === null);
  t.ok('あとでの後（held）・切り替わった後（done）・状態なしは脇の知らせを出さない', model('held') === null && model('done') === null && noticeModel(null) === null);

  // ---- 設定のページ
  const pm = phase => pageModel(readSwitchState({ ...base, phase, kind: 'stoppers', interrupt: { done: 1, total: 3 } }));
  t.ok('ページ: 待ち・聞く・あとで・合わない版は「切り替えを待っている／止まるものがある／中断して切り替える」と動いている版', pm('waiting').status === '新しい版への切り替えを待っています · 0.8.0' && pm('waiting').hint === '動いているのは 0.7.4 です'
    && pm('asking').status === '切り替えると止まるものがあります · 0.8.0' && pm('held').status === '切り替えると止まるものがあります · 0.8.0'
    && pm('manual').status === '作業を中断して切り替える更新です · 0.8.0'
    && pageModel(readSwitchState({ ...base, phase: 'held', kind: 'manual' })).status === '作業を中断して切り替える更新です · 0.8.0');
  t.ok('ページ: 中断中は進み、切り替え中・失敗の字', pm('stopping').status === '作業を中断しています… 1 / 3' && pm('switching').status === '0.8.0 に切り替えています…' && pm('failed').status === '新しい版を起動できませんでした' && pm('failed').hint === '前の版（0.7.4）で動いています');
  t.ok('ページ: 切り替わった後・状態なしは何も足さない', pm('done') === null && pageModel(null) === null);

  // ---- 配線（文字列）
  const html = read('web/index.html');
  for (const id of ['switchNotice', 'switchTitle', 'switchSub', 'switchProgress', 'switchDetail', 'switchList', 'switchAfter', 'switchActs', 'switchBox', 'switchPageList', 'switchPageAfter', 'switchPageProgress', 'switchPageActs', 'updateNoticeStopped', 'updateHandoverWork', 'updateHandoverWait', 'updateHandoverBrowser']) {
    t.ok(`index.html に #${id}`, html.includes(`id="${id}"`));
  }
  t.ok('脇の知らせは更新の知らせ（#updatePrompt）の次、設定のページの箱は更新の状態の下', html.indexOf('id="switchNotice"') > html.indexOf('id="updatePrompt"') && html.indexOf('id="switchBox"') > html.indexOf('id="updateStatus"'));
  const preload = read('desktop/preload.cjs');
  t.ok('preload に版 1 の口（switch: version・hello・state・onState・act）', /switch: \{\s+version: 1,\s+hello:[^\n]*ply:switch-hello[\s\S]*state:[^\n]*ply:switch'[\s\S]*onState[\s\S]*ply:switch-state'[\s\S]*act:/.test(preload));
  const client = read('web/client.mjs');
  t.ok('client.mjs: 表示を作り、更新の部品へ渡す（会話を開く・名前・エージェント・確認の段の注意）', /switchUi = setupSwitchNotice\(\{[\s\S]*openSession: \(id\) => \{ onboarding\.close\(\); select\(id\); \}[\s\S]*updatesUi = setupUpdates\(\{[\s\S]*switchUi,[\s\S]*handoverNotes:/.test(client)
    && client.includes('switchUi?.refresh();'));
  const updates = read('web/updates.mjs');
  t.ok('updates.mjs: 待っている間の字・⚙ の点・「更新しました」を出さない・止めたもの・無停止の確認の 1 行', updates.includes('switchUi?.page()') && updates.includes('switchUi?.pending') && updates.includes('!switchUi?.holdsNotice') && updates.includes('switchUi?.stoppedText()')
    && updates.includes("t('updates.handoverWork'") && updates.includes("t('updates.handoverWait'") && updates.includes('state?.handover'));
  const css = read('web/updates.css');
  t.ok('CSS: 設定のページを開いている間は脇の知らせを出さない・一覧の動きは reduced-motion で止まる', css.includes('body.settings > #sidebar > .switch-notice { display: none; }') && /prefers-reduced-motion: reduce\) \{ \.switch-wd/.test(css));

  // ---- 辞書: ja と en が同じキー（複数形の _one は en だけ）
  const flat = (obj, prefix = '') => Object.entries(obj).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const dict = (lang) => JSON.parse(read(`web/locales/${lang}/ui.json`));
  const strip = (key) => key.replace(/_(one|other)$/, '');
  const jaKeys = new Set(flat(dict('ja').switch).map(strip)), enKeys = new Set(flat(dict('en').switch).map(strip));
  t.ok('辞書 switch.*: ja と en のキーが同じ', jaKeys.size > 30 && [...jaKeys].every((k) => enKeys.has(k)) && [...enKeys].every((k) => jaKeys.has(k)), `${[...jaKeys].filter((k) => !enKeys.has(k))} / ${[...enKeys].filter((k) => !jaKeys.has(k))}`);
  const used = new Set([...read('web/switch-notice.mjs').matchAll(/\bt\("(switch\.[A-Za-z]+)"/g)].map((m) => m[1].slice('switch.'.length)));
  t.ok('web/switch-notice.mjs が引く switch.* は辞書にある', [...used].every((k) => jaKeys.has(k)), [...used].filter((k) => !jaKeys.has(k)).join());
  const desktop = (lang) => JSON.parse(read(`web/locales/${lang}/desktop.json`)).switch;
  t.ok('main のダイアログの文言（stoppers*・stopAndSwitch）は ja と en にある', ['stoppersTitle', 'stoppersLater', 'stopAndSwitch'].every((k) => desktop('ja')[k] && desktop('en')[k]) && desktop('ja').stoppersMessage_other && desktop('en').stoppersMessage_one && desktop('en').stoppersMessage_other);
}
