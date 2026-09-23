import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from './local-files.mjs';
import { visualizeReferences } from '../web/visualize-reference.mjs';
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
