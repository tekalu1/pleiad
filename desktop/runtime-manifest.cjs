// resources/app の manifest（ファイルごとの SHA-256・大きさ）。ビルド時に作り（scripts/pack-runtime.cjs）、
// 実行場所を組むとき（desktop/runtime.cjs）に、写した木と突き合わせる（docs/zero-downtime-update/design.md §3.3、ADR 0137）。
// Node の組み込みだけ。ビルドと main の両方が読む。
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const MANIFEST_FILE = 'manifest.json';
const MANIFEST_SCHEMA = 1;
/** 実行場所の版の名前に付けるビルドの短いハッシュの長さ */
const BUILD_HASH_LENGTH = 12;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');

/** dir の下の通常ファイルを、dir からの相対パス（/ 区切り・並べ替え済み）で返す。manifest.json 自身は含めない */
async function listFiles(dir) {
  const found = [];
  const walk = async (current, prefix) => {
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else if (entry.isFile() && !(prefix === '' && entry.name === MANIFEST_FILE)) found.push(rel);
    }
  };
  await walk(dir, '');
  return found.sort();
}

/** files（{ [相対パス]: { size, sha256 } }）から、ビルドを表すハッシュを作る。並べ替えた「パス・大きさ・SHA-256」の行を、そのまま SHA-256 にかける */
function computeBuildHash(files) {
  return sha256(Object.keys(files).sort().map(rel => `${rel}\0${files[rel].size}\0${files[rel].sha256}\n`).join(''));
}

/** 版ごとの置き場の名前に使う短いハッシュ */
const shortBuildHash = buildHash => String(buildHash).slice(0, BUILD_HASH_LENGTH);

/** dir（resources/app）の manifest を作る。concurrency 本ずつ読む */
async function buildManifest(dir, { appVersion, concurrency = 16 } = {}) {
  const list = await listFiles(dir);
  const files = {};
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= list.length) return;
      const rel = list[index];
      const data = await fsp.readFile(path.join(dir, ...rel.split('/')));
      files[rel] = { size: data.length, sha256: sha256(data) };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const sorted = Object.fromEntries(Object.keys(files).sort().map(rel => [rel, files[rel]]));
  return { schema: MANIFEST_SCHEMA, appVersion: String(appVersion ?? ''), buildHash: computeBuildHash(sorted), files: sorted };
}

/** 読んだ manifest の形と buildHash を確かめて返す。壊れていれば Error（code: 'manifest-invalid'） */
function parseManifest(text) {
  const invalid = detail => Object.assign(new Error(`manifest.json is invalid: ${detail}`), { code: 'manifest-invalid' });
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) { throw invalid(error.message); }
  if (manifest?.schema !== MANIFEST_SCHEMA) throw invalid(`schema ${manifest?.schema}`);
  if (typeof manifest.appVersion !== 'string' || !manifest.appVersion) throw invalid('appVersion');
  if (!manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) throw invalid('files');
  for (const [rel, entry] of Object.entries(manifest.files)) {
    // 相対パスだけ（実行場所の外へ出る・絶対パス・\ 区切りは受けない）
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(rel)) throw invalid(`path ${rel}`);
    if (!Number.isInteger(entry?.size) || entry.size < 0 || !/^[0-9a-f]{64}$/.test(entry?.sha256 ?? '')) throw invalid(`entry ${rel}`);
  }
  if (manifest.buildHash !== computeBuildHash(manifest.files)) throw invalid('buildHash');
  return manifest;
}

async function readManifest(dir) {
  let text;
  try { text = await fsp.readFile(path.join(dir, MANIFEST_FILE), 'utf8'); }
  catch (error) { throw Object.assign(new Error(`manifest.json is missing: ${error.message}`), { code: 'manifest-missing' }); }
  return parseManifest(text);
}

module.exports = { MANIFEST_FILE, MANIFEST_SCHEMA, BUILD_HASH_LENGTH, sha256, listFiles, computeBuildHash, shortBuildHash, buildManifest, parseManifest, readManifest };
