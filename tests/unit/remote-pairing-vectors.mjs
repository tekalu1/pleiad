import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanLabel } from '../../core/remote/pairing.mjs';

export const name = 'remote-pairing-vectors';
export const title = 'Pairing label vectors shared across implementations';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'remote', 'vectors.json'), 'utf8'));

export default async function (t) {
  const cases = VECTORS.pleiad.pairing.cleanLabels;
  t.ok('cleanLabel follows the shared Unicode whitespace vectors',
    cases.length > 0 && cases.every(({ input, output }) => cleanLabel(input) === output));
}
