import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLabel } from '../../core/remote/pairing.mjs';

export const name = 'remote-pairing-vectors';
export const title = 'リモート: 端末・ホストの名前の整え方（cleanLabel）を 3 版で共有するベクトル';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'remote', 'vectors.json'), 'utf8'));

export default async function (t) {
  const cases = VECTORS.pleiad.pairing.cleanLabels;
  t.ok('cleanLabel が vectors.json の全事例（制御文字・全角の空白・U+00A0・長さの上限）と一致する',
    cases.length > 0 && cases.every(({ input, output }) => cleanLabel(input) === output));
}
