// チャンネル・スレッドの入力欄を Chats の入力欄に揃えた部分（ADR 0116）の、画面を持たない判定:
// 送る本文（文中の添付の印・文末に付く添付・順番）・書きかけの保存の形と上限・添付つきの投稿の本文の描き方・配線。
// 画面の打鍵（貼り付け・ドロップ・一覧・下書きの復元・スレッド）は tests/browser/channels-composer.cjs（実ブラウザー）。
import { readFileSync } from 'node:fs';
import { attachedKey, orderAttachments, composeBody, parseDrafts, pruneDrafts, serializeDrafts, DRAFT_LIMIT, feedDraftKey, threadDraftKey } from '../../web/channels/ch-attach-model.mjs';
import { attachedBodyHtml } from '../../web/channels/post.mjs';

export const name = 'channels-composer-ui';
export const title = 'チャンネルの入力欄（Chats に揃えた分）: 送る本文と添付の印・書きかけの保存・添付つきの投稿の描き方・配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- 送る本文（web/client.mjs の submit と同じ決まり）
  const a = { path: 'C:\\up\\a.png', name: 'a.png', mime: 'image/png' }, b = { path: '/up/b.txt', name: 'b.txt' }, c = { path: '/up/c.pdf', name: 'c.pdf', mime: 'application/pdf' };
  t.ok('文中の印はそのまま。文中に無い添付だけ、末尾に印の行を足す（日本語の印）', (() => {
    const r = composeBody('見て\n[添付] C:\\up\\a.png\n以上', [a, b], [attachedKey(a.path)], 'ja');
    return r.text === '見て\n[添付] C:\\up\\a.png\n以上\n\n[添付] /up/b.txt' && r.attachments.map((x) => x.name).join() === 'a.png,b.txt';
  })());
  t.ok('印の言語は画面の言語（英語は [Attachment]）。mime が無ければ空', composeBody('x', [b], [], 'en').text === 'x\n\n[Attachment] /up/b.txt' && composeBody('x', [b], [], 'en').attachments[0].mime === '');
  t.ok('本文が空でも添付があれば印だけの本文になる。どちらも無ければ空', composeBody('  ', [b], [], 'ja').text === '[添付] /up/b.txt' && composeBody('  ', [], [], 'ja').text === '' && composeBody('  ', [], [], 'ja').attachments.length === 0);
  t.ok('添付は字の欄の中の並び順（位置の順）。文中に無いものは後ろ（もとの順）', orderAttachments([a, b, c], [attachedKey(c.path), attachedKey(a.path)]).map((x) => x.name).join() === 'c.pdf,a.png,b.txt');
  t.ok('同じパスは大小・区切りの違いを吸収して同じキー（Windows のドライブの大小）', attachedKey('C:\\Up\\a.png') === attachedKey('c:/Up/a.png') && attachedKey('/x/y') === 'p:/x/y');

  // ---- 書きかけ
  const drafts = new Map([
    ['ch:c_a', { text: '下書き', attached: [], at: 3 }],
    ['th:c_a:p_1', { text: '', attached: [{ path: '/up/a.png', name: 'a.png' }], at: 2 }],
    ['ch:c_empty', { text: '  ', attached: [], at: 9 }],
  ]);
  pruneDrafts(drafts);
  t.ok('空の書きかけは持たない（字も添付も無いもの）', [...drafts.keys()].join() === 'ch:c_a,th:c_a:p_1');
  const round = parseDrafts(serializeDrafts(drafts));
  t.ok('保存の形を往復できる（字・添付・時刻）', round.get('ch:c_a').text === '下書き' && round.get('th:c_a:p_1').attached[0].path === '/up/a.png' && round.get('ch:c_a').at === 3);
  t.ok('壊れた保存・形の違うものは空・不正な行だけ捨てる', parseDrafts('{') .size === 0 && parseDrafts(null).size === 0 && parseDrafts('{"a":1}').size === 0
    && parseDrafts(JSON.stringify([['k', { text: 'ok' }], [1, {}], ['z', null], ['p', { text: 1, attached: [{ path: 2 }, { path: '/x' }] }]])).get('p').attached.length === 1);
  const many = new Map(Array.from({ length: DRAFT_LIMIT + 5 }, (_, i) => [`ch:c_${i}`, { text: `t${i}`, attached: [], at: i }]));
  pruneDrafts(many);
  t.ok(`上限（${DRAFT_LIMIT} 件）を超えたら古い方から捨てる`, many.size === DRAFT_LIMIT && !many.has('ch:c_0') && many.has(`ch:c_${DRAFT_LIMIT + 4}`));
  t.ok('持ち主の key: 流れはチャンネルごと・スレッドはスレッドごと', feedDraftKey('c_a') === 'ch:c_a' && threadDraftKey('c_a', 'p_1') === 'th:c_a:p_1');

  // ---- 添付つきの投稿の描き方（本文の印の位置に、画像は縮小・ほかは札。Chats の自分の発言と同じ部品）
  const md = (s) => `<p>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`;
  const img = { path: 'C:\\up\\a.png', name: 'a.png', kind: 'image', mime: 'image/png', size: 4, origin: 'device' };
  const file = { path: '/up/b.txt', name: 'b.txt', kind: 'file', mime: 'text/plain', size: 3, origin: 'host' };
  const html = attachedBodyHtml('見て\n[添付] C:\\up\\a.png\n続き\n[添付] /up/b.txt', [img, file], md);
  t.ok('印の位置に添付が入る（本文 → 画像 → 本文 → 札の順）', html.indexOf('見て') < html.indexOf('msg-att-img') && html.indexOf('msg-att-img') < html.indexOf('続き') && html.indexOf('続き') < html.indexOf('msg-att-file'), html);
  t.ok('画像はホストが配る /local-file で（パスは URL に入れ、本文の字としては出さない）。札は押すと右パネル（data-file-path）', html.includes('/local-file?path=C%3A%5Cup%5Ca.png') && html.includes('data-file-path="/up/b.txt"') && !html.includes('[添付]'));
  const trailing = attachedBodyHtml('印の無い本文', [file], md);
  t.ok('印の無い添付は本文の後ろに並ぶ', trailing.indexOf('印の無い本文') < trailing.indexOf('msg-att-file'));
  const fenced = attachedBodyHtml('```\n[添付] /up/b.txt\n```', [file], md);
  t.ok('コードブロックの中の印は置き換えない（添付は後ろに並ぶ）', fenced.indexOf('[添付] /up/b.txt') >= 0 && fenced.indexOf('[添付] /up/b.txt') < fenced.indexOf('msg-att-file'));
  t.ok('一致しない印は本文のまま残す（消さない）', attachedBodyHtml('[添付] /elsewhere.txt', [file], md).includes('[添付] /elsewhere.txt'));

  // ---- 配線（文字列で）
  const composer = read('web/channels/ch-composer.mjs'), feed = read('web/channels/feed.mjs'), thread = read('web/channels/thread.mjs'), client = read('web/client.mjs'), att = read('web/channels/ch-attachments.mjs');
  t.ok('字の欄は Chats と同じ編集欄。送信は Ctrl/⌘+Enter（Enter は改行）。伸びる上限は composer-layout の promptMaxHeight', /createMarkdownEditor\(input/.test(composer) && /e\.key === 'Enter' && \(e\.ctrlKey \|\| e\.metaKey\)/.test(composer) && /promptMaxHeight\(/.test(composer));
  t.ok('チップ（モデル・エフォート・承認モード）は持ち込まない', !/composer-controls|renderModel|renderMode|effortChip|modelChip|class="chip"|'chip'/.test(composer + att));
  t.ok('添付は断片の送り手（attach-upload）・一覧の面・札の描き方を Chats と共有する', /from '\.\.\/attach-upload\.mjs'/.test(att) && /from '\.\.\/attachment-list\.mjs'/.test(att) && /createMarkdownEditor/.test(composer) && /placeAttachments, attachmentHtml/.test(read('web/channels/post.mjs')));
  t.ok('流れもスレッドも、投稿は channels.post の attachments で送る（新しい WS コマンドは足さない）', /'channels\.post', \{ channelId: S\.id, text, \.\.\.\(attachments\?\.length \? \{ attachments \} : \{\}\) \}/.test(feed)
    && /text, \.\.\.\(attachments\?\.length \? \{ attachments \} : \{\}\) \}/.test(thread) && !/attach(Start|Chunk|Finish)/.test(feed + thread));
  t.ok('書きかけは持ち主（チャンネル・スレッド）ごと。開くと切り替わり、閉じると残して空に戻す', /setDraftKey\(feedDraftKey\(view\.id\)\)/.test(feed) && /setDraftKey\(threadDraftKey\(channelId, threadId\)\)/.test(thread) && /composer\.setDraftKey\(null\)/.test(thread));
  t.ok('流れもスレッドも、板にファイルを落とせる（落とした先がその入力欄）', /composer\.bindDropZone\(root\)/.test(feed) && /composer\.bindDropZone\(root\)/.test(thread));
  t.ok('client.mjs: host に whenOnline・openImage を渡す。Chats の受け口は Channels の画面に落としたファイルを取らない', /whenOnline,/.test(client) && /openImage: \(src, caption, path, origin\) => openLightbox/.test(client) && /closest\?\.\("#channelsView"\)/.test(client));
  t.ok('置き場の分け先はチャンネル（uploads/<チャンネルの id>/）。会話の id は使わない', /sessionId: u\.bucket/.test(att) && /bucket: \(\) => S\.id/.test(feed) && /bucket: \(\) => S\.channelId/.test(thread));
}
