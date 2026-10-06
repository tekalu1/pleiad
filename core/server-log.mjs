// main の子でない形で起こされたサーバー（desktop/server-boot.cjs。stdio を持たない）の標準出力・標準エラーを、ファイルへ書く
// （無停止の更新 段階 1 の 1-4。docs/zero-downtime-update/design.md §3.2）。
// 起動の失敗の理由（import の失敗・データ置き場のロックなど）を、main が末尾から読んでエラーに出す。
//   - 画面へ出る URL の行（?token=…）などの token=… は伏せて書く
//   - 1 MB を超えたら .old へ回して新しく始める（1 世代。2 つで約 2 MB まで）
//   - 同期で書く（起動の失敗・process.exit の直前の行を落とさない）。書けなくてもサーバーは止めない
// main が AGENT_HOST_SERVER_LOG に書き先を渡したときだけ使う（core/server-log-boot.mjs）。単独の起動（npm start・テスト）の出力は今のまま。
import fs from 'node:fs';
import path from 'node:path';

export const SERVER_LOG_MAX_BYTES = 1024 * 1024;

export const redactLine = text => String(text).replace(/token=\S+/g, 'token=[redacted]');

/** file へ追記する書き手。write(text) は投げない。close() で閉じる */
export function createLogSink({ file, maxBytes = SERVER_LOG_MAX_BYTES, fsImpl = fs } = {}) {
  let fd = null;
  let size = 0;
  let broken = false;

  function open() {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fd = fsImpl.openSync(file, 'a');
    size = fsImpl.fstatSync(fd).size;
  }
  function rotate() {
    fsImpl.closeSync(fd);
    fd = null;
    try { fsImpl.renameSync(file, `${file}.old`); } catch { /* 回せなければ、そのまま追記を続ける */ }
    open();
  }
  return {
    write(text) {
      if (broken) return;
      try {
        const data = Buffer.from(redactLine(text), 'utf8');
        if (fd === null) open();
        if (size > 0 && size + data.length > maxBytes) rotate();
        fsImpl.writeSync(fd, data);
        size += data.length;
      } catch { broken = true; }   // 書き先が使えない（権限・ディスク）。以後は黙って捨てる
    },
    close() {
      try { if (fd !== null) fsImpl.closeSync(fd); } catch { /* 閉じるだけ */ }
      fd = null;
    },
  };
}

/**
 * process の stdout・stderr を file へ向ける。console.log・console.error もここを通る。
 * 捕まらなかった例外・拒否の理由を書いてから、今と同じく異常終了する（起動の途中の失敗が、stdio の無い起動で消えないように）。戻り値は書き手
 */
export function redirectOutput({ file, proc = process, maxBytes = SERVER_LOG_MAX_BYTES, now = () => new Date() } = {}) {
  const sink = createLogSink({ file, maxBytes });
  const route = stream => {
    stream.write = (chunk, encoding, callback) => {
      sink.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      (typeof encoding === 'function' ? encoding : callback)?.();
      return true;
    };
  };
  route(proc.stdout);
  route(proc.stderr);
  proc.on('uncaughtException', error => {
    sink.write(`uncaughtException: ${error?.stack ?? error}\n`);
    proc.exit(1);
  });
  sink.write(`--- server start ${now().toISOString()} pid ${proc.pid}\n`);
  return sink;
}
