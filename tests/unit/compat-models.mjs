// 互換の接続先のモデルの表示と検索（web/compat-models.mjs・web/search-terms.mjs・web/combo.mjs）と、
// 一覧取得のときの display_name・コンテキスト長の保存（core/compat-endpoints.mjs）。LLM は呼ばない。
// 見張ること:
//   1. 表示名は `anthropic/` の名前空間（残りに `/` があるときだけ）と末尾の [1m] を隠す。送る ID は変えない
//   2. 検索は大文字小文字を区別しない部分一致、空白区切りは AND。描くのは先頭の数十件だけ。一覧に無い字はそのまま使える
//   3. display_name・コンテキスト長を保存し、旧形式（models が文字列の配列）も読める
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { compatModelLabel, compatModelText, contextLabel, modelCandidates, searchModels, resolveTyped, comboModelOptions, SHOW_LIMIT } from '../../web/compat-models.mjs';
import { searchTerms, matchesTerms, filterLimited, moreText } from '../../web/search-terms.mjs';
import { createCombo } from '../../web/combo.mjs';
import { endpointChipLabel } from '../../web/composer-labels.mjs';
import { createCompatEndpoints, normalizeModels } from '../../core/compat-endpoints.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startFakeCompatApi } from '../lib/fake-compat-api.mjs';

export const name = 'compat-models';
export const title = '互換の接続先のモデル: 表示名（anthropic/ と [1m]）・検索（AND・件数の上限・自由入力）・display_name の保存と旧形式';

// OpenRouter の Anthropic 形式の /v1/models が返す実データの形
const OPENROUTER = [
  { id: 'anthropic/deepseek/deepseek-v4.1-flash[1m]', display_name: 'DeepSeek: DeepSeek V4.1 Flash', max_input_tokens: 1000000 },
  { id: 'anthropic/openai/gpt-6-luna-pro:batch[1m]', display_name: 'OpenAI: GPT-6 Luna Pro (batch)', max_input_tokens: 1048576 },
  { id: 'anthropic/claude-opus-5.5[1m]', display_name: 'Anthropic: Claude Opus 5.5', max_input_tokens: 1000000 },
  { id: 'anthropic/cohere/command-a-plus', display_name: 'Cohere: Command A+', max_input_tokens: 256000 },
  { id: 'anthropic/~openai/gpt-sol-latest[1m]', display_name: 'OpenAI: GPT Sol (latest)', max_input_tokens: 1000000 },
];
/** 数百件の一覧（OpenRouter 風） */
const MANY = [...OPENROUTER, ...Array.from({ length: 400 }, (_, i) => ({ id: `anthropic/vendor${i % 20}/model-${i}`, display_name: `Vendor ${i % 20}: Model ${i}`, max_input_tokens: 131072 }))];

function key(target, k) {
  let prevented = false;
  target.dispatchEvent({ type: 'keydown', key: k, preventDefault() { prevented = true; } });
  return prevented;
}

export default async function (t) {
  // ---- 1. 表示名
  const L = compatModelLabel;
  t.ok('anthropic/ の後にさらに / があれば名前空間を隠し、[1m] は札に', JSON.stringify(L('anthropic/deepseek/deepseek-v4.1-flash[1m]')) === JSON.stringify({ id: 'anthropic/deepseek/deepseek-v4.1-flash[1m]', text: 'deepseek/deepseek-v4.1-flash', oneM: true }));
  t.ok(':batch 付きもそのまま残す', L('anthropic/openai/gpt-6-luna-pro:batch[1m]').text === 'openai/gpt-6-luna-pro:batch' && L('anthropic/openai/gpt-6-luna-pro:batch[1m]').oneM);
  t.ok('OpenRouter の Claude（anthropic/claude-…）は二重ではないので隠さない', L('anthropic/claude-opus-5.5[1m]').text === 'anthropic/claude-opus-5.5' && L('anthropic/claude-opus-5.5[1m]').oneM);
  t.ok('[1m] の無い ID は札なし', L('anthropic/cohere/command-a-plus').text === 'cohere/command-a-plus' && !L('anthropic/cohere/command-a-plus').oneM);
  t.ok('~ 付きの別名も名前空間だけ隠す', L('anthropic/~openai/gpt-sol-latest[1m]').text === '~openai/gpt-sol-latest');
  t.ok('公式の形の ID や名前空間の無い ID は変えない', L('claude-opus-5.5').text === 'claude-opus-5.5' && L('deepseek/deepseek-v4.1-flash').text === 'deepseek/deepseek-v4.1-flash' && L('~anthropic/claude-sonnet-latest').text === '~anthropic/claude-sonnet-latest');
  t.ok('送る ID（id）は一覧どおり', L('anthropic/deepseek/deepseek-v4.1-flash[1m]').id === 'anthropic/deepseek/deepseek-v4.1-flash[1m]');
  t.ok('[1m] は末尾だけ（途中の [1m] は印ではない）', L('x[1m]-y').text === 'x[1m]-y' && !L('x[1m]-y').oneM);
  t.ok('空の ID は空', L('').text === '' && L(undefined).text === '');
  t.ok('札を置けない字の場所では（1M）と書く', compatModelText('anthropic/deepseek/deepseek-v4.1-flash[1m]') === 'deepseek/deepseek-v4.1-flash（1M）' && compatModelText('anthropic/cohere/command-a-plus') === 'cohere/command-a-plus');
  t.ok('コンテキスト長の短い字', contextLabel(1000000) === '1M' && contextLabel(1048576) === '1M' && contextLabel(262144) === '256K' && contextLabel(200000) === '200K' && contextLabel(131072) === '128K' && contextLabel(undefined) === '');
  const chip = endpointChipLabel({ connection: 'OpenRouter', model: L('anthropic/deepseek/deepseek-v4.1-flash[1m]').text, fullModel: 'anthropic/deepseek/deepseek-v4.1-flash[1m]', effort: 'high' });
  t.ok('チップは表示名、title は送る ID', chip.head.startsWith('OpenRouter · deepseek/') && !chip.text.includes('anthropic/') && chip.text === `${chip.head} · high` && chip.full === 'OpenRouter · anthropic/deepseek/deepseek-v4.1-flash[1m] · high' && chip.tail === 'high', chip.text);

  // ---- 2. 候補と検索
  const { ids, info } = normalizeModels(MANY);
  const cands = modelCandidates(ids, info);
  t.ok('候補の 2 行目は display_name とコンテキスト長', cands[3].sub === 'Cohere: Command A+ · コンテキスト 256K', cands[3].sub);
  t.ok('display_name が無い接続先では 2 行目を出さない', modelCandidates(['a', 'b/c']).every(c => c.sub === ''));
  t.ok('役割の ID など一覧に無いものを先に足せる（重複は除く）', modelCandidates(['a', 'b'], {}, ['b', 'z', '']).map(c => c.id).join(',') === 'b,z,a');
  t.ok('検索語は空白で区切る', JSON.stringify(searchTerms('  DeepSeek   flash ')) === '["deepseek","flash"]');
  t.ok('語はどの字に当たってもよい（AND は語ごと）', matchesTerms(['cohere', 'a+'], ['cohere/command-a-plus', 'Cohere: Command A+']) && !matchesTerms(['cohere', 'flash'], ['cohere/command-a-plus', 'Cohere: Command A+']));
  const flash = searchModels(cands, 'deepseek FLASH');
  t.ok('大文字小文字を区別しない AND', flash.total === 1 && flash.shown[0].id === 'anthropic/deepseek/deepseek-v4.1-flash[1m]');
  t.ok('display_name でも当たる', searchModels(cands, 'command a+').shown[0]?.id === 'anthropic/cohere/command-a-plus');
  t.ok('送る ID（名前空間ごと）でも当たる', searchModels(cands, 'anthropic/cohere').total === 1);
  const all = searchModels(cands, '');
  t.ok(`空なら先頭の ${SHOW_LIMIT} 件だけ描き、残りの件数を返す`, all.shown.length === SHOW_LIMIT && all.more === MANY.length - SHOW_LIMIT && all.total === MANY.length);
  const vendor = searchModels(cands, 'vendor3');
  t.ok('絞っても上限は効く', vendor.total === 20 && vendor.more === 0 && filterLimited(cands, 'model', c => [c.text], 10).shown.length === 10);
  t.ok('「ほかに N 件」の文言', moreText(355) === 'ほかに 355 件。文字を入れて絞り込んでください');
  t.ok('打った字が送る ID ならその ID', resolveTyped(cands, 'anthropic/cohere/command-a-plus') === 'anthropic/cohere/command-a-plus');
  t.ok('打った字が表示名ならその ID（送るのは一覧どおり）', resolveTyped(cands, 'Cohere/Command-A-Plus') === 'anthropic/cohere/command-a-plus');
  t.ok('表示名が同じなら札の無いほうを先に', resolveTyped(modelCandidates(['x[1m]', 'x']), 'x') === 'x' && resolveTyped(modelCandidates(['x[1m]']), 'x') === 'x[1m]');
  t.ok('一覧に無い字はそのまま使う（自由入力）', resolveTyped(cands, 'my-org/private-model') === 'my-org/private-model');

  // ---- combo（設定の役割の欄）
  const commits = [];
  const c = createCombo({ ariaLabel: 'メイン', cls: 'mono', value: 'anthropic/deepseek/deepseek-v4.1-flash[1m]', limit: SHOW_LIMIT, emptyText: '一覧にありません。',
    options: () => comboModelOptions(cands), onCommit: (v) => commits.push(v) });
  const input = c.root.querySelector('input');
  const list = c.root.querySelector('.clist');
  input.blur = () => input.dispatchEvent({ type: 'blur' });
  globalThis.document.activeElement = null;
  const rows = () => list.children.filter(li => li.attrs.class !== 'more' && !String(li.attrs.class ?? '').includes('head'));
  const inputBadge = () => c.root.children.find(n => n.attrs.class === 'cbadge');
  const moreRow = () => list.children.find(li => li.attrs.class === 'more');
  t.ok('入力欄は表示名、title は送る ID、1M の札を横に出す', input.value === 'deepseek/deepseek-v4.1-flash' && input.attrs.title === 'anthropic/deepseek/deepseek-v4.1-flash[1m]'
    && inputBadge()?.textContent === '1M' && !inputBadge().hidden);
  input.dispatchEvent({ type: 'focus' });
  t.ok('開くと先頭の上限まで描き、「ほかに N 件」を出す', rows().length === SHOW_LIMIT && moreRow()?.textContent === moreText(MANY.length - SHOW_LIMIT) && !list.hidden);
  t.ok('候補は 2 行（表示名＋display_name）で、送る ID は title', rows()[0].attrs.class.includes('two') && rows()[0].shown.includes('DeepSeek: DeepSeek V4.1 Flash') && rows()[0].attrs.title === 'anthropic/deepseek/deepseek-v4.1-flash[1m]');
  input.value = 'flash';
  input.dispatchEvent({ type: 'input' });
  t.ok('打ち替えている間は確定している値の札を隠す', inputBadge().hidden === true);
  input.value = 'deepseek/deepseek-v4.1-flash';
  input.dispatchEvent({ type: 'input' });
  t.ok('表示名に戻せば札も戻る', inputBadge().hidden === false);
  input.dispatchEvent({ type: 'blur' });
  t.ok('触らずに離れたら値を変えない（表示名が同じ候補があっても）', commits.length === 0 && c.value === 'anthropic/deepseek/deepseek-v4.1-flash[1m]');
  input.dispatchEvent({ type: 'focus' });
  input.value = 'COHERE command';
  input.dispatchEvent({ type: 'input' });
  t.ok('打った字で絞る（AND・大文字小文字を区別しない）', rows().length === 1 && rows()[0].shown.includes('cohere/command-a-plus') && !moreRow());
  key(input, 'ArrowDown');
  key(input, 'Enter');
  t.ok('↓ と Enter で候補を選ぶと送る ID で確定', commits.at(-1) === 'anthropic/cohere/command-a-plus' && input.value === 'cohere/command-a-plus' && inputBadge().hidden);
  input.dispatchEvent({ type: 'focus' });
  input.value = 'my-org/private-model';
  input.dispatchEvent({ type: 'input' });
  t.ok('当たらなければ自由入力の案内を出す', rows().length === 0 && moreRow()?.textContent === '一覧にありません。' && !list.hidden);
  key(input, 'Enter');
  t.ok('Enter で一覧に無い ID をそのまま確定', commits.at(-1) === 'my-org/private-model' && input.value === 'my-org/private-model');
  input.dispatchEvent({ type: 'focus' });
  input.value = 'vendor1 model-1';
  input.dispatchEvent({ type: 'input' });
  const before = commits.length;
  key(input, 'Escape');
  t.ok('Esc は閉じて元の字に戻す', list.hidden && input.value === 'my-org/private-model' && commits.length === before);

  // ---- 3. 保存と旧形式
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-compat-models-'));
  const api = await startFakeCompatApi({ keys: ['sk-models-' + 'k'.repeat(20)], auth: 'bearer', models: MANY });
  try {
    const secrets = createSecretStore({ file: path.join(dir, 'compat-endpoint-secrets.json'), cipher: plainCipher });
    const eps = createCompatEndpoints({ dataDir: dir, secrets });
    const input2 = { agent: 'claude', name: 'OpenRouter', preset: 'openrouter', baseUrl: api.url, authMode: 'bearer', key: 'sk-models-' + 'k'.repeat(20),
      roles: { main: 'anthropic/deepseek/deepseek-v4.1-flash[1m]', opus: 'anthropic/claude-opus-5.5[1m]', sonnet: 'anthropic/claude-opus-5.5[1m]', haiku: 'anthropic/cohere/command-a-plus' } };
    const checked = await eps.check(input2);
    t.ok('確認で display_name とコンテキスト長を取る（ID は一覧どおり）', checked.models.length === MANY.length && checked.models[0] === 'anthropic/deepseek/deepseek-v4.1-flash[1m]'
      && checked.modelInfo['anthropic/cohere/command-a-plus']?.name === 'Cohere: Command A+' && checked.modelInfo['anthropic/cohere/command-a-plus']?.context === 256000);
    const { id } = await eps.save(input2, checked.receipt);
    const row = (await eps.list('claude')).endpoints.find(e => e.id === id);
    t.ok('保存して一覧に modelInfo が出る', row.modelInfo['anthropic/deepseek/deepseek-v4.1-flash[1m]']?.name === 'DeepSeek: DeepSeek V4.1 Flash' && row.models.length === MANY.length);
    t.ok('送る ID は変えずに保存する', row.roles.main === 'anthropic/deepseek/deepseek-v4.1-flash[1m]' && (await eps.resolve(id, 'claude')).roles.main === 'anthropic/deepseek/deepseek-v4.1-flash[1m]');
    // OpenAI 形式（OpenRouter の /api/v1/models）: name と context_length
    const oa = normalizeModels([{ id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek: V4.1 Flash', context_length: 163840 }, { id: 'plain' }, 'str-only', { name: 'only-name' }]);
    t.ok('OpenAI 形式の name・context_length も取る。無いものは info を作らない', oa.info['deepseek/deepseek-v4.1-flash']?.name === 'DeepSeek: V4.1 Flash' && oa.info['deepseek/deepseek-v4.1-flash']?.context === 163840
      && !oa.info.plain && !oa.info['str-only'] && oa.ids.join(',') === 'deepseek/deepseek-v4.1-flash,plain,str-only,only-name' && !oa.info['only-name']);
    t.ok('display_name の改行は落とし、長さを詰める', normalizeModels([{ id: 'a', display_name: 'x\ny' + 'z'.repeat(300) }]).info.a.name.length === 120 && !normalizeModels([{ id: 'a', display_name: 'x\ny' }]).info.a.name.includes('\n'));

    // 旧形式（models が文字列の配列、modelInfo なし）
    const file = path.join(dir, 'compat-endpoints.json');
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    data.endpoints.push({ id: 'ep-aaaaaaaaaaaa', agent: 'codex', name: '旧', preset: 'custom', baseUrl: 'http://127.0.0.1:1/v1', authMode: 'bearer', auth: 'none',
      roles: { main: 'old-model' }, options: {}, models: ['old-model', 'vendor/other', 'old-model'], lastCheck: { ok: true, at: new Date().toISOString() } });
    await fs.writeFile(file, JSON.stringify(data));
    const old = (await eps.list('codex')).endpoints.find(e => e.id === 'ep-aaaaaaaaaaaa');
    t.ok('旧形式の models（文字列の配列）はそのまま読める', old && old.models.join(',') === 'old-model,vendor/other' && JSON.stringify(old.modelInfo) === '{}');
    t.ok('旧形式の接続先も resolve できる', (await eps.resolve('ep-aaaaaaaaaaaa', 'codex')).models.join(',') === 'old-model,vendor/other');
    // 確認し直すと modelInfo が付く（旧形式から移る）
    api.set({ models: [{ id: 'old-model', name: 'Old Model', context_length: 32768 }] });
    const re = await eps.recheck(id);
    const after = (await eps.list('claude')).endpoints.find(e => e.id === id);
    t.ok('確認し直すと一覧と modelInfo を取り直す', re.ok && after.models.join(',') === 'old-model' && after.modelInfo['old-model']?.name === 'Old Model' && !after.modelInfo['anthropic/cohere/command-a-plus']);
  } finally {
    await api.close?.();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
