import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readLocalFile } from './local-files.mjs';
import { visualizeReferences } from '../web/visualize-reference.mjs';
import { visualizationDocument, VISUALIZE_CSP } from '../web/visualize-document.mjs';
import { t } from './i18n.mjs';

// Visualize の案内（エージェントに渡す）。会話の言語ごとの本文: en は skills/visualize/SKILL.md、ja は SKILL.ja.md。
// 1 つの文書として長く、表示の約束（参照の形式・特殊な印）をそのまま保つ必要があるので、辞書ではなく Skill の形のファイルで持つ
const readSkill = async name => (await fs.readFile(new URL(`../skills/visualize/${name}`, import.meta.url), 'utf8')).replace(/^---[\s\S]*?---\s*/, '');
const SKILLS = { en: await readSkill('SKILL.md'), ja: await readSkill('SKILL.ja.md') };
/** 会話の言語（ja|en）の案内。言語を持たなければ英語 */
export const visualizeInstructions = locale => SKILLS[locale] ?? SKILLS.en;
export const MAX_VISUALIZE_BYTES = 1024 * 1024;

export async function prepareVisualization(ref, roots) {
  if (ref.error) throw new Error(ref.error);
  const { path: file, title, mode } = ref.value;
  if (!['.html', '.htm'].includes(path.extname(file).toLowerCase())) throw new Error(t('filePreview.visualize.htmlRequired'));
  const { body } = await readLocalFile(file, roots, { maxBytes: MAX_VISUALIZE_BYTES });
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(body); }
  catch { throw new Error(t('filePreview.visualize.notUtf8')); }
  return { kind: 'visualization', path: file, caption: title ?? path.basename(file), mode, content };
}

// Serialize snapshots in response order, and drain before turnEnd. A missing or
// rejected file gets a durable error card, rather than a disappearing reference.
export function createVisualizationCollector({ roots, publish }) {
  let text = '', chain = Promise.resolve(), count = 0;
  function end() {
    const refs = visualizeReferences(text); text = '';
    for (const ref of refs) {
      if (++count > 33) continue;
      const overLimit = count > 32;
      chain = chain.then(async () => {
        let payload;
        try {
          if (overLimit) throw new Error(t('filePreview.visualize.tooMany', { max: 32 }));
          payload = await prepareVisualization(ref, roots);
        }
        catch (e) { payload = { kind: 'visualization', caption: ref.value?.title ?? t('filePreview.visualize.caption'), error: String(e.message) }; }
        await publish({ ...payload, reference: ref.raw });
      });
      // Keep the rejection for close(), without an unhandled rejection while
      // the backend is still streaming other messages.
      chain.catch(() => {});
    }
  }
  return {
    accept(event) {
      if (event.type === 'text.delta') text += String(event.text ?? '');
      if (event.type === 'text.end') end();
    },
    async close() { end(); await chain; },
  };
}

// ---- 会話に保存された写しを単体で開く（右パネルの「ブラウザーで開く」。docs/visualize.md）
// 写しはモデルが書いた HTML で、スクリプトも動く。Pleiad と同じオリジンで開くと保存領域やトークンに届くので、
// 応答ヘッダーの sandbox（allow-same-origin を付けない）で不透明なオリジンに閉じ込める。
// 読み込める先は会話の中の枠と同じ（VISUALIZE_CSP）。frame-ancestors で他の画面への埋め込みも断る
export const SNAPSHOT_CSP = `sandbox allow-scripts; ${VISUALIZE_CSP}; frame-ancestors 'none'`;

/** 別タブへ返す応答。record は history.findVisualization の結果 */
export function snapshotResponse(record) {
  return {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SNAPSHOT_CSP,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()',
    },
    body: visualizationDocument(record.content, { resize: false, title: record.caption ?? '' }),
  };
}

/**
 * 殻（デスクトップ版）は新しい窓を開かないので、サーバーのある PC の既定のブラウザーへ写しをファイルで渡す。
 * 置き場は dir（データ置き場の下）。1 日より古い写しは書くたびに消す。返すのは書いたファイルの絶対パス
 */
export async function writeSnapshotFile(record, dir, { now = Date.now() } = {}) {
  await fs.mkdir(dir, { recursive: true });
  for (const name of await fs.readdir(dir).catch(() => [])) {
    const old = path.join(dir, name);
    const stat = await fs.stat(old).catch(() => null);
    if (stat && now - stat.mtimeMs > 24 * 60 * 60 * 1000) await fs.rm(old, { force: true }).catch(() => {});
  }
  const key = crypto.createHash('sha256').update(`${record.id ?? ''}\n${record.at ?? ''}\n${record.content}`).digest('hex').slice(0, 24);
  const file = path.join(dir, `${key}.html`);
  await fs.writeFile(file, visualizationDocument(record.content, { resize: false, title: record.caption ?? '' }), 'utf8');
  return file;
}
