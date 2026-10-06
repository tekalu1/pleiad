// 1-0 a: .node / .exe の PE ヘッダーを読み、対象のアーキテクチャー（Machine）と N-API の入口（輸出名）を調べる。
// arm64 の prebuild は x64 の PC では読み込めないので、読み込めないものは形で確かめる。
//   node scripts/zero-downtime/stage1-0/pe-check.mjs <file>...
import fs from 'node:fs';

const MACHINES = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' };

export function peInfo(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt16LE(0) !== 0x5a4d) return { file, error: 'not PE' };
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') return { file, error: 'bad PE signature' };
  const machine = b.readUInt16LE(pe + 4);
  const nSections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const dirBase = opt + (magic === 0x20b ? 112 : 96);
  const exportRva = b.readUInt32LE(dirBase);
  const sections = [];
  for (let i = 0; i < nSections; i++) {
    const s = opt + optSize + i * 40;
    sections.push({ va: b.readUInt32LE(s + 12), vsize: b.readUInt32LE(s + 8), raw: b.readUInt32LE(s + 20) });
  }
  const rva2off = rva => { const s = sections.find(x => rva >= x.va && rva < x.va + Math.max(x.vsize, 1)); return s ? rva - s.va + s.raw : null; };
  const exports = [];
  if (exportRva) {
    const e = rva2off(exportRva);
    const nNames = b.readUInt32LE(e + 24);
    const names = rva2off(b.readUInt32LE(e + 32));
    for (let i = 0; i < nNames; i++) {
      const o = rva2off(b.readUInt32LE(names + 4 * i));
      exports.push(b.toString('latin1', o, b.indexOf(0, o)));
    }
  }
  return { file, machine: MACHINES[machine] ?? '0x' + machine.toString(16), size: b.length, exports };
}

if (import.meta.url === new URL(process.argv[1], 'file:///').href || process.argv[1]?.endsWith('pe-check.mjs')) {
  for (const f of process.argv.slice(2)) {
    const r = peInfo(f);
    const napi = r.exports?.some(n => /^napi_register_module_v\d+$/.test(n));
    const legacy = r.exports?.some(n => /^node_register_module_v\d+$/.test(n));
    console.log(JSON.stringify({ file: f, machine: r.machine, size: r.size, napi: !!napi, abiSpecific: !!legacy, exports: r.exports?.slice(0, 6), error: r.error }));
  }
}
