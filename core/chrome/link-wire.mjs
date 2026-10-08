// 接続の子（core/chrome/link-child.mjs）とサーバー側の口（core/chrome/link.mjs）が共有する、パイプの上の約束（ADR 0167 の決定 2）。Node の組み込みだけ。
//
// 名前付きパイプ（Windows は \\.\pipe\pleiad-chrome-link-<乱数>、それ以外は一時フォルダーの unix ソケット）。1 行 1 メッセージ。
//   CDP のメッセージはそのまま 1 行（JSON は改行を含まない）。制御は `!` で始まる行（`!<名前> <JSON>`）:
//     サーバー -> 子   !hello {secret, v}   !open {url, gen}   !close（答えなし）   !carry {carry}   !quit
//     子 -> サーバー   !welcome {v, phase, gen, port, path, upgradeAt, firstId, sessions, carry}   !opened {gen}   !fail {status, code, gen}   !closed {code, gen}
//   gen はサーバーが !open ごとに増やす接続の世代。opened・fail・closed はそれが指す接続の世代を載せて戻り、サーバーは今の接続のものだけを受ける。
//   fail・closed は子の側で終わったとき（Chrome が断った・切った）だけ。サーバーが !close で閉じた接続には答えない
//   つなぎ手は 1 つ。新しいつなぎ手が古いほうを切る。始めの挨拶（!hello）の secret が違えば切る。
import os from 'node:os';
import path from 'node:path';

/** 接続の子の版。パイプの約束・札の形を変えた版だけ上げる（合わない接続の子は、新しいサーバーが quit して起こし直す） */
export const LINK_VERSION = 1;
/** 保持役の子の label（札）の kind */
export const LINK_CARD_KIND = 'chrome-link';
/** この大きさ以上の行は JSON を解かない（映像のフレーム・撮影の答え。先頭の数百バイトで id と method を読むだけで流す） */
export const BIG_LINE_BYTES = 64 * 1024;
/** 1 行の上限（超えた行は捨てる） */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;
/** 中継の状態の預かり物の上限（保持役の label の上限 256 KB より小さく。越えたら預けない） */
export const CARRY_MAX_BYTES = 256 * 1024;
/** つなぎ手の挨拶を待つ上限 */
export const HELLO_TIMEOUT_MS = 5000;
/** 新しいつなぎ手に渡す CDP の番号の始まりは、前のつなぎ手が振った最大の番号にこれを足したもの */
export const ID_GAP = 1000;

export const NEWLINE = Buffer.from('\n');

/** パイプの名前（札に載せる。乱数は呼び出し側が決める） */
export function linkPipeName(random, { platform = process.platform, tmpdir = os.tmpdir() } = {}) {
  return platform === 'win32' ? `\\\\.\\pipe\\pleiad-chrome-link-${random}` : path.join(tmpdir, `pleiad-chrome-link-${random}.sock`);
}

/** 制御の行（`!名前 JSON\n`）。CDP の行と区別するのは先頭の `!` */
export const controlLine = (name, value) => `!${name}${value === undefined ? '' : ` ${JSON.stringify(value)}`}\n`;

/** 行 buf（改行を除く）が制御なら { name, value }、そうでなければ null。値の JSON が壊れていれば value は undefined */
export function parseControl(buf) {
  if (buf[0] !== 0x21) return null;
  const text = buf.toString('utf8');
  const space = text.indexOf(' ');
  const name = space < 0 ? text.slice(1) : text.slice(1, space);
  let value;
  if (space >= 0) { try { value = JSON.parse(text.slice(space + 1)); } catch { value = undefined; } }
  return { name, value };
}

/**
 * 大きい行を読み解かずに種類を知る。Chrome の答えは `{"id":N,…`、イベントは `{"method":"…",…`（実機の並び）、サーバーの要求は `{"id":N,"method":…`（createCdp の並び）。
 * 先頭の 256 バイトだけを見る。どちらでもなければ kind 'other'
 */
export function peekLine(buf) {
  const head = buf.toString('latin1', 0, Math.min(buf.length, 256));
  const id = /^\{"id":(\d+)/.exec(head);
  if (id) return { kind: 'id', id: Number(id[1]) };
  const method = /^\{"method":"([^"]+)"/.exec(head);
  if (method) return { kind: 'event', method: method[1] };
  return { kind: 'other' };
}

/**
 * ソケットのかたまりを行に分ける。行は Buffer のまま渡す（大きい行を文字列にしない）。かたまりは Buffer のリストで持ち、行の終わりで 1 回だけ連結する。
 * maxBytes を超えた行は、改行まで捨てて onOverflow を呼ぶ
 */
export class LineReader {
  constructor({ onLine, onOverflow = () => {}, maxBytes = MAX_LINE_BYTES }) {
    this.onLine = onLine; this.onOverflow = onOverflow; this.maxBytes = maxBytes;
    this.parts = []; this.size = 0; this.skipping = false;
  }

  push(chunk) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.skipping) {
        const piece = chunk.subarray(start, end);
        this.parts.push(piece); this.size += piece.length;
        if (this.size > this.maxBytes) { this.parts = []; this.size = 0; this.skipping = true; this.onOverflow(); }
      }
      if (newline < 0) break;
      if (this.skipping) this.skipping = false;
      else {
        const line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
        this.parts = []; this.size = 0;
        if (line.length) this.onLine(line);
      }
      start = newline + 1;
    }
  }
}
