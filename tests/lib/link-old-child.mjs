// 古い版の接続の子の身代わり（版の不一致の試験）。挨拶に v: 0 の welcome（預かり物つき）を返し、quit を受けたら終わる。引数: パイプ名・秘密
import net from 'node:net';
const [pipe, secret] = process.argv.slice(2);
net.createServer(socket => {
  let buf = '';
  socket.on('error', () => {});
  socket.on('data', chunk => {
    buf += chunk.toString('utf8');
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith('!hello') && JSON.parse(line.slice(7)).secret === secret) socket.write(`!welcome ${JSON.stringify({ v: 0, phase: 'idle', gen: 0, firstId: 1000, sessions: [], carry: { v: 1, port: 7777, entries: [{ id: 'old-conv', key: 'ef'.repeat(24), stopped: true, paused: null }], windows: [] } })}\n`);
      if (line === '!quit') process.exit(0);
    }
  });
}).listen(pipe);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
