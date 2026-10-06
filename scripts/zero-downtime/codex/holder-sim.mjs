// 保持役の最小の身代わり（段階 0 の実測用）。子（codex app-server / agy）の stdio を持ち、
// 出力の行に通番を振って溜め、いまの接続（sink）へ流す。接続が無い間は溜めるだけ。
// 設計の保持役（design.md §4）の「通番の記録」と「付け直しでの再生」だけを真似る。
import { spawn } from 'node:child_process';

export class HolderSim {
  constructor(command, args, opts = {}) {
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false, ...opts });
    this.log = [];          // { seq, line }
    this.err = '';
    this.sink = null;       // (line, seq) => void
    this.buf = '';
    this.exit = null;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (d) => {
      this.buf += d; let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1);
        const e = { seq: this.log.length + 1, line, at: Date.now() };
        this.log.push(e);
        this.sink?.(e.line, e.seq);
      }
    });
    this.child.stderr.on('data', (d) => { this.err += d; if (this.err.length > 20000) this.err = this.err.slice(-20000); });
    this.exited = new Promise((r) => this.child.on('exit', (code, sig) => { this.exit = { code, sig }; r(this.exit); }));
  }
  /** 接続を付ける。from より後ろの記録を先に流してから、ライブの出力へつなぐ。 */
  attach(sink, from = 0) {
    this.sink = null;
    for (const e of this.log) if (e.seq > from) sink(e.line, e.seq);
    this.sink = sink;
  }
  detach() { this.sink = null; }
  get seq() { return this.log.length; }
  write(s) { this.child.stdin.write(s); }
  kill() { try { spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {} }
}
