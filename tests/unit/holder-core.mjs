// ターンの保持役の本体（core/holder/holder.mjs・client.mjs。無停止の更新 段階 2 の 2a）。同じプロセスに保持役を立て、本物の子（偽の CLI）を起こす。
// 起こす→最初の書き込み・切断と付け直し（stdin を閉じない・通番の続き）・答えていない依頼の控えの渡し直し（claude-control は mcp_message と elicitation だけ・jsonrpc・取り消し）・
// stdout を読まない親でも子が詰まらない（3 MB）・detach の後は write・end・kill を転送しない・行の途中の書き込みは捨てる・記録の上限（truncated）・印と ack の捨て方・
// 終わり方（最後の行・終了コード・起こせない・stderr）・長すぎる行・木ごとの強制終了・後から来た親が勝つ・札と預かり物・idle・keepMs（親が居ない間の保険）
import { startHolder, fakeChild, waitFor, sleep, isAlive, rawConnect, hello } from '../lib/holder-harness.mjs';

export const name = 'holder-core';
export const title = '保持役の本体: 切断と付け直し・控えの渡し直し・読まない親でも詰まらない・detach 後は転送しない・記録の上限・印と ack・終わり方・木ごとの強制終了・idle';

const childOf = (h, id) => h.holder.snapshot().children.find(c => c.id === id);
const tick = () => sleep(300);

export default async function (t) {
  // ---- 起こす・最初の書き込み・付け直し
  {
    const h = await startHolder();
    try {
      const a = await h.connect();
      const w = a.client.welcome;
      t.ok('welcome: 規約 1・世代 1・保持役の pid・子は無い・預かり物は空', w.protocol === 1 && w.generation === 1 && w.pid === process.pid && w.appVersion === '9.9.9' && w.children.length === 0 && Object.keys(w.stash).length === 0);

      // spawn の直後の write（SDK の最初の initialize の書き込み）が、子の stdin に届く
      a.client.spawn({ ...fakeChild('c1', 'echo'), label: { turn: 't1' } });
      a.client.write('c1', '{"first":1}\n');
      await waitFor(() => a.events.lines('c1').some(l => l.echo === '{"first":1}'), 8000, 'first write echoed');
      t.ok('spawn の直後の write が届く（子の起動より前に送っても落ちない）・通番は 1 から連続', a.events.seqs('c1').every((s, i) => s === i + 1) && a.events.lines('c1')[0].ready === true);

      // 切断: 親が居ない間も子は動き、stdin は閉じない
      a.client.spawn(fakeChild('c2', 'lines', 40, 20));
      await waitFor(() => a.events.seqs('c2').length >= 5, 8000, 'c2 first lines');
      const seen = a.events.seqs('c2').length;
      a.client.ack('c2', seen);
      a.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'parent gone');
      await waitFor(() => childOf(h, 'c2').seq === 40, 8000, 'c2 produced all lines while no parent');
      const c1pid = childOf(h, 'c1').pid;
      t.ok('切断: 親が居ない間も記録は進み（40 行）、子は生きていて stdin は閉じていない', childOf(h, 'c2').seq === 40 && childOf(h, 'c1').alive && isAlive(c1pid));

      // 付け直し: welcome に子の状態、attach で ack の次から通番の続き
      const b = await h.connect();
      const snap = b.client.welcome.children.find(c => c.id === 'c2');
      t.ok('付け直し: welcome に子の状態（通番・ack・札・生きているか）', snap.seq === 40 && snap.acked === seen && snap.alive === true && b.client.welcome.children.find(c => c.id === 'c1').label.turn === 't1');
      const attached = await b.client.attach('c2');
      await waitFor(() => b.events.seqs('c2').includes(40), 8000, 'replay to 40');
      const seqs = b.events.seqs('c2');
      t.ok('付け直し: attach の答えに from（ack の次）、記録は通番の続きから欠け・重複なく届く', attached.from === seen + 1 && seqs[0] === seen + 1 && seqs.every((s, i) => s === seen + 1 + i) && seqs.at(-1) === 40);
      await b.client.attach('c1');
      b.client.write('c1', '{"after":"reattach"}\n');
      await waitFor(() => b.events.lines('c1').some(l => l.echo === '{"after":"reattach"}'), 8000, 'echo after reattach');   // 切れていた間も stdin が開いていたので、新しい親の write が届く


      // 行の途中の書き込みは、親が切れたら捨てる（行になった分だけが子へ渡る）
      b.client.write('c1', '{"half":');
      await tick();
      b.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'b gone');
      const c = await h.connect();
      await c.client.attach('c1', { from: childOf(h, 'c1').seq + 1 });
      c.client.write('c1', '1}\n');
      await waitFor(() => c.events.lines('c1').some(l => l.echo === '1}'), 8000, 'c echo');
      t.ok('行の途中の書き込み: 親が切れたら捨て、次の親の書き込みとつながらない', !c.events.out.some(e => e.line.includes('half')) && c.events.lines('c1').some(l => l.echo === '1}'));

      // 後から来た親が勝つ
      const d = await h.connect();
      await waitFor(() => c.events.disconnect.length === 1, 8000, 'c replaced');
      t.ok('後から合格した親が勝つ: 古い親は bye replaced で切られ、子は残る', c.events.disconnect[0] === 'replaced' && !c.client.connected && d.client.welcome.children.some(x => x.id === 'c1' && x.alive));

      // 札・預かり物
      d.client.label('c1', { turn: 't2', binding: { port: 7 } });
      d.client.stash({ token: 'T', port: 7421, handover: 1 });
      d.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'd gone');
      const e = await h.connect();
      t.ok('札・預かり物: 置き直した値が、次の親の welcome に載る（保持役は中を読まない）',
        e.client.welcome.children.find(x => x.id === 'c1').label.binding.port === 7 && e.client.welcome.stash.token === 'T' && e.client.welcome.stash.port === 7421);
      e.client.label('c1', { big: 'x'.repeat(300 * 1024) });
      await waitFor(() => e.events.fault.length === 1, 8000, 'label fault');
      t.ok('札が大きすぎれば断る（label-too-large）。置き直さない', e.events.fault[0].reason === 'label-too-large' && childOf(h, 'c1').label.turn === 't2');
      e.client.spawn(fakeChild('c1', 'echo'));
      await waitFor(() => e.events.fault.length === 2, 8000, 'exists fault');
      t.ok('同じ id の spawn は断る（exists）', e.events.fault[1].reason === 'exists' && e.events.fault[1].op === 'spawn');
      const missing = await e.client.attach('nope').then(() => null, error => error);
      t.ok('知らない子への attach は HOLDER_FAULT（unknown）で断られる', missing?.code === 'HOLDER_FAULT' && missing.reason === 'unknown');
    } finally { await h.stop(); }
  }

  // ---- 答えていない依頼の控え
  {
    const h = await startHolder();
    try {
      const a = await h.connect();
      a.client.spawn({ ...fakeChild('cc', 'request'), policy: 'claude-control' });
      a.client.spawn({ ...fakeChild('np', 'request'), policy: 'none' });
      a.client.spawn({ ...fakeChild('rpc', 'jsonrpc'), policy: 'jsonrpc' });
      a.client.spawn({ ...fakeChild('cx', 'cancel'), policy: 'claude-control' });
      await waitFor(() => ['cc', 'np', 'rpc', 'cx'].every(id => a.events.out.filter(e => e.id === id).length >= (id === 'cc' || id === 'np' ? 5 : 3)), 8000, 'requests emitted');
      await sleep(100);
      a.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'a gone');
      const b = await h.connect();
      const pend = id => b.client.welcome.children.find(c => c.id === id).pendingRequests;
      t.ok('控え(claude-control): 答えていない control_request を request_id で控える（種類つき）', pend('cc').map(p => p.requestId).sort().join() === 'req-elicit,req-hook,req-mcp,req-tool' && pend('cc').find(p => p.requestId === 'req-mcp').subtype === 'mcp_message' && pend('cc').find(p => p.requestId === 'req-elicit').subtype === 'elicitation');
      t.ok('控え: 取り消された依頼（control_cancel_request）・policy none は控えない', pend('cx').length === 0 && pend('np').length === 0);
      t.ok('控え(jsonrpc): id と method を持つ依頼だけ（id の無い通知は控えない）', pend('rpc').length === 1 && pend('rpc')[0].requestId === '"c1"' && pend('rpc')[0].subtype === 'item/commandExecution/requestApproval');

      // 付け直しで、見たところより後ろ（from）にある控えが、生の出力の続きより前に渡し直される
      const lastCc = b.client.welcome.children.find(c => c.id === 'cc').seq;
      await b.client.attach('cc', { from: lastCc + 1 });
      await b.client.attach('rpc', { from: b.client.welcome.children.find(c => c.id === 'rpc').seq + 1 });
      await waitFor(() => b.events.out.filter(e => e.redelivered).length >= 3, 8000, 'redelivered');
      const redelivered = b.events.out.filter(e => e.redelivered);
      const ccRe = redelivered.filter(e => e.id === 'cc');
      t.ok('控えの渡し直し(claude-control): mcp_message と elicitation だけ（can_use_tool・hook_callback は渡さない）・出た順', ccRe.length === 2 && ccRe.map(e => JSON.parse(e.line).request_id).join() === 'req-mcp,req-elicit' && ccRe.every(e => e.seq < lastCc + 1) && ccRe[0].seq < ccRe[1].seq);
      t.ok('控えの渡し直し(jsonrpc): 答えていない依頼を渡す', redelivered.filter(e => e.id === 'rpc').length === 1 && JSON.parse(redelivered.find(e => e.id === 'rpc').line).id === 'c1');

      // 答えると控えから消える
      b.client.write('cc', `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-mcp', response: {} } })}\n`);
      b.client.write('cc', `${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: 'req-elicit', response: { action: 'accept' } } })}\n`);
      b.client.write('rpc', `${JSON.stringify({ jsonrpc: '2.0', id: 'c1', result: {} })}\n`);
      await waitFor(() => b.events.lines('cc').some(l => l.answered === 'req-mcp') && b.events.lines('cc').some(l => l.answered === 'req-elicit') && b.events.lines('rpc').some(l => l.answered === 'c1'), 8000, 'answered');
      t.ok('答えた依頼（mcp_message・elicitation）は控えから消える（答えていない can_use_tool・hook_callback は残る）', pendOf(h, 'cc').join() === 'req-hook,req-tool' && pendOf(h, 'rpc').length === 0);

      // 答えた後に付け直した親へは、渡し直さない
      const redeliveredBefore = b.events.out.filter(e => e.redelivered).length;
      await b.client.attach('cc', { from: b.client.welcome.children.find(c => c.id === 'cc').seq + 1 });
      await sleep(300);
      t.ok('答えた後の付け直しでは、答え済みの mcp_message・elicitation を渡し直さない', b.events.out.filter(e => e.redelivered).length === redeliveredBefore);

      // 記録に残っている範囲（from が控えより前）なら、渡し直さず記録の再生で届く（二重に渡さない）
      b.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'b gone');
      const c = await h.connect();
      await c.client.attach('cc', { from: 1 });
      await waitFor(() => c.events.seqs('cc').length >= 4, 8000, 'replayed');
      t.ok('記録に残る範囲からの付け直しでは、控えを重ねて渡さない', !c.events.out.some(e => e.id === 'cc' && e.redelivered));
    } finally { await h.stop(); }
  }

  // ---- stdout を誰も読まない親でも、子は詰まらない
  {
    const h = await startHolder({ highWaterBytes: 256 * 1024 });
    try {
      // 握手の後に spawn して、そのまま 1 バイトも読まない親（3 MB を出す子）
      const raw = await rawConnect(h.pipe);
      raw.write(hello(h.secret));
      await waitFor(() => raw.state.frames.some(f => f.t === 'welcome'), 8000, 'raw welcome');
      raw.write({ t: 'spawn', ...fakeChild('f1', 'flood', 3072) });
      await waitFor(() => raw.state.frames.some(f => f.t === 'out'), 8000, 'raw first out');
      raw.socket.pause();
      const started = Date.now();
      await waitFor(() => childOf(h, 'f1')?.alive === false, 30000, 'flood child finished');
      const snap = childOf(h, 'f1');
      t.ok('読まない親: 3 MB を出す子が詰まらずに終わる（終了コード 0・3073 行を記録）', snap.exitCode === 0 && snap.seq === 3073 && !snap.truncated, `${Date.now() - started} ms`);
      t.ok('読まない親へは書き溜めない（highWater で止まり、記録から送る）', raw.state.bytes < 2 * 1024 * 1024, `${raw.state.bytes} bytes`);
      raw.socket.resume();
      await waitFor(() => raw.state.frames.filter(f => f.t === 'out').length === 3073 && raw.state.frames.some(f => f.t === 'exit'), 30000, 'resumed parent receives everything');
      const outs = raw.state.frames.filter(f => f.t === 'out');
      t.ok('読み始めると全部届く（通番は連続・exit は最後）', outs.every((f, i) => f.seq === i + 1) && raw.state.frames.at(-1).t === 'exit' && raw.state.frames.at(-1).code === 0);
      raw.socket.destroy();

      // 親が 1 度もつながっていない間（spawn の直後に切る）も同じ
      const raw2 = await rawConnect(h.pipe);
      raw2.write(hello(h.secret));
      await waitFor(() => raw2.state.frames.some(f => f.t === 'welcome'), 8000, 'raw2 welcome');
      raw2.write({ t: 'spawn', ...fakeChild('f2', 'flood', 2048) });
      raw2.socket.destroy();
      await waitFor(() => childOf(h, 'f2')?.alive === false, 30000, 'f2 finished with no parent');
      t.ok('親が居ない間に 2 MB 出す子も詰まらず終わり、後から付けた親が全部読める', childOf(h, 'f2').seq === 2049 && childOf(h, 'f2').exitCode === 0);
      const late = await h.connect();
      const got = await late.client.replay('f2', 1, 2049);
      t.ok('replay: 記録を読み直せる（1〜2049 が連続）', got.lines.length === 2049 && got.lines.every((l, i) => l.seq === i + 1) && got.truncated === false && got.last === 2049);
    } finally { await h.stop(); }
  }

  // ---- detach の後は write・end・kill を転送しない
  {
    const h = await startHolder();
    try {
      const a = await h.connect();
      a.client.spawn(fakeChild('d1', 'echo'));
      await waitFor(() => a.events.lines('d1').some(l => l.ready), 8000, 'd1 ready');
      const detached = await a.client.detach('d1');
      t.ok('detach: 答えに子の状態が付く（この時点で転送は止まっている）', detached.id === 'd1' && detached.children[0].alive === true);
      const before = a.events.out.length;
      a.client.write('d1', '{"late":"write"}\n');
      a.client.end('d1');
      a.client.kill('d1', { tree: true });
      a.client.ack('d1', 1);
      await sleep(600);
      t.ok('detach の後の write・end・kill は転送しない（子は生きて stdin も開いたまま・ack も効かない）', childOf(h, 'd1').alive && isAlive(childOf(h, 'd1').pid) && childOf(h, 'd1').acked === 0 && !a.events.lines('d1').some(l => l.echo?.includes('late') || l.stdin));
      t.ok('detach の後は記録だけを溜め、その親へ流さない', a.events.out.length === before);
      const b = await h.connect();
      await b.client.attach('d1');
      b.client.write('d1', '{"new":"parent"}\n');
      await waitFor(() => b.events.lines('d1').some(l => l.echo === '{"new":"parent"}'), 8000, 'new parent echo');
      t.ok('次の親は同じ子に書ける。古い親の書き込みは子に届いていない', !b.events.out.some(e => e.line.includes('late')));

      // id 無しの detach は全部
      b.client.spawn(fakeChild('d2', 'echo'));
      await waitFor(() => b.events.lines('d2').some(l => l.ready), 8000, 'd2 ready');
      const all = await b.client.detach();
      b.client.kill('d1');
      b.client.kill('d2');
      await sleep(400);
      t.ok('id 無しの detach は全部の子から手を離す（kill は転送しない）', all.children.length === 2 && childOf(h, 'd1').alive && childOf(h, 'd2').alive);
    } finally { await h.stop(); }
  }

  // ---- 記録の上限と、印・ack の捨て方
  {
    const h = await startHolder({ maxRecordBytes: 6000 });
    try {
      const a = await h.connect();
      a.client.spawn(fakeChild('t1', 'flood', 20));
      await waitFor(() => childOf(h, 't1')?.alive === false, 8000, 't1 done');
      const snap = childOf(h, 't1');
      t.ok('記録の上限: 超えたら古い行から捨てて truncated（first が進む・通番は続く）', snap.truncated === true && snap.first > 1 && snap.seq === 21 && snap.first <= 21);
      const replayed = await a.client.replay('t1', 1, 21);
      t.ok('replay: 落ちた分があれば truncated で、残った行（first から）だけ返す', replayed.truncated === true && replayed.first === snap.first && replayed.lines[0].seq === snap.first && replayed.lines.at(-1).seq === 21);
      const b = await h.connect();
      await b.client.attach('t1', { from: 1 });
      await waitFor(() => b.events.out.length > 0 && b.events.exit.length === 1, 8000, 'replayed t1');
      t.ok('付け直しで記録から落ちた分は overflow（record・first つき）で知らせ、残りを流す', b.events.overflow.some(o => o.reason === 'record' && o.first === snap.first) && b.events.seqs('t1')[0] === snap.first);
    } finally { await h.stop(); }
  }
  {
    const h = await startHolder();
    try {
      const a = await h.connect();
      a.client.spawn(fakeChild('m1', 'lines', 30));
      await waitFor(() => childOf(h, 'm1')?.seq === 30, 8000, 'm1 lines');
      t.ok('印も ack も無ければ、全部残す（親が受け取ったかを知らないので捨てない）', childOf(h, 'm1').first === 1);
      a.client.mark('m1', 'turn', 11);
      a.client.ack('m1', 20);
      await waitFor(() => childOf(h, 'm1').first === 11, 8000, 'trim to mark');
      t.ok('印より前は捨てる・印より後ろは ack を越えても残す（再生用）', childOf(h, 'm1').first === 11 && childOf(h, 'm1').marks.turn === 11 && childOf(h, 'm1').truncated === false);
      a.client.unmark('m1', 'turn');
      await waitFor(() => childOf(h, 'm1').first === 21, 8000, 'trim to ack');
      a.client.mark('m1', 'next');
      a.client.ack('m1', 30);
      await waitFor(() => childOf(h, 'm1').acked === 30, 8000, 'acked');
      t.ok('印を外せば ack の次まで捨てる・印の既定の位置は次の行（その印より後ろは残る）', childOf(h, 'm1').marks.next === 31 && childOf(h, 'm1').first === 31);
      a.client.ack('m1', 99);
      a.client.ack('m1', 5);
      await sleep(100);
      t.ok('ack は戻らず、受け取った行数を越えない', childOf(h, 'm1').acked === 30);
    } finally { await h.stop(); }
  }

  // ---- 終わり方・stderr・長すぎる行
  // exit から stdout の最後のかたまりまでの猶予（試験の既定 300 ms）は、遅い CI では足りず改行の無い最後の行を落とす。ここは本番（2 秒）より長くする
  {
    const h = await startHolder({ maxLineBytes: 4096, exitGraceMs: 5000 });
    try {
      const a = await h.connect();
      a.client.spawn(fakeChild('e1', 'tail'));
      a.client.spawn(fakeChild('e2', 'exit', 3));
      a.client.spawn({ id: 'e3', command: 'pleiad-no-such-command-xyz', args: [], policy: 'none' });
      a.client.spawn(fakeChild('e4', 'stderr', 'boom'));
      a.client.spawn(fakeChild('e5', 'big', 10000));
      await waitFor(() => a.events.exit.length === 3, 8000, 'three exits');
      const exitOf = id => a.events.exit.find(e => e.id === id);
      t.ok('終わり: 改行の無い最後の行も記録し、終了コードは exit で 1 回（out を全部流した後）', exitOf('e1').code === 0 && a.events.lines('e1').at(-1).tail === 1 && a.events.out.findLastIndex(e => e.id === 'e1') < a.events.exit.findIndex(e => e.id === 'e1'));
      t.ok('終わり: 終了コードがそのまま届く', exitOf('e2').code === 3);
      t.ok('起こせないコマンド: exit に error（ENOENT）が付き、生きていない', exitOf('e3').error === 'ENOENT' && childOf(h, 'e3').alive === false && childOf(h, 'e3').error === 'ENOENT');
      await waitFor(() => a.events.err.some(e => e.id === 'e4'), 8000, 'stderr');
      t.ok('stderr: かたまりで届き、保持役の末尾にも残る（welcome の stderr）', a.events.err.map(e => e.chunk).join('').includes('boom') && childOf(h, 'e4').stderr.includes('boom'));
      await waitFor(() => a.events.overflow.some(o => o.reason === 'line'), 8000, 'line overflow');
      t.ok('長すぎる行は捨てて overflow（line）で知らせ、子は続く（通番は詰める）', a.events.overflow.find(o => o.reason === 'line').bytes > 4096 && a.events.lines('e5').length === 1 && a.events.lines('e5')[0].ready === true);
      a.client.write('e5', '{"still":"alive"}\n');
      await waitFor(() => a.events.lines('e5').some(l => l.echo === '{"still":"alive"}'), 8000, 'e5 echo');

      // release: 生きている子は捨てない。終わった子は記録ごと捨てる
      a.client.release('e5');
      await waitFor(() => a.events.fault.some(f => f.op === 'release'), 8000, 'release fault');
      t.ok('release: 生きている子は断る（alive）', a.events.fault.at(-1).reason === 'alive' && childOf(h, 'e5')?.alive === true);
      a.client.release('e2');
      await waitFor(() => !childOf(h, 'e2'), 8000, 'released');
      t.ok('release: 終わった子の記録を捨てる', !childOf(h, 'e2') && !!childOf(h, 'e1'));
    } finally { await h.stop(); }
  }

  // ---- 木ごとの強制終了・保持役を閉じると子も止まる
  {
    const h = await startHolder();
    let echoPid = null;
    let grandPid = null;
    try {
      const a = await h.connect();
      a.client.spawn(fakeChild('k1', 'grandchild'));
      a.client.spawn(fakeChild('k2', 'echo'));
      a.client.spawn(fakeChild('k3', 'echo'));
      await waitFor(() => a.events.lines('k1').some(l => l.grandchild) && a.events.lines('k3').some(l => l.ready), 8000, 'k1 grandchild');
      grandPid = a.events.lines('k1').find(l => l.grandchild).grandchild;
      echoPid = childOf(h, 'k3').pid;
      const k1pid = childOf(h, 'k1').pid;
      a.client.kill('k1', { tree: true });
      await waitFor(() => a.events.exit.some(e => e.id === 'k1'), 8000, 'k1 exit');
      await waitFor(() => !isAlive(grandPid), 8000, 'grandchild killed');
      t.ok('kill(tree): 子と孫が止まり、exit が届く', !isAlive(k1pid) && !isAlive(grandPid));
      await waitFor(() => a.events.lines('k2').some(l => l.ready), 8000, 'k2 ready');
      a.client.kill('k2');
      await waitFor(() => a.events.exit.some(e => e.id === 'k2'), 8000, 'k2 exit');
      t.ok('kill: 木でない終了も効く', childOf(h, 'k2').alive === false);
    } finally { await h.stop(); }
    await waitFor(() => !echoPid || !isAlive(echoPid), 8000, 'child stopped with holder');
    t.ok('保持役を閉じると、残っていた子も木ごと止まる', !echoPid || !isAlive(echoPid));
  }

  // ---- idle: 子が 1 つも生きておらず、親が居ない間だけ数える
  {
    let idle = 0;
    const h = await startHolder({ idleMs: 250, onIdle: () => { idle++; } });
    try {
      t.ok('idle: 始めは親も子も居ないので数え始める', await waitFor(() => idle === 1, 3000, 'idle at start').then(() => true, () => false));
      idle = 0;
      const a = await h.connect();
      await sleep(600);
      t.ok('idle: 親がつながっている間は終わらない', idle === 0);
      a.client.spawn(fakeChild('i1', 'echo'));
      await waitFor(() => a.events.lines('i1').some(l => l.ready), 8000, 'i1 ready');
      a.client.close();
      await sleep(700);
      t.ok('idle: 子が生きている間は、親が居なくても終わらない', idle === 0);
      const b = await h.connect();
      await b.client.attach('i1');
      b.client.kill('i1');
      await waitFor(() => b.events.exit.length === 1, 8000, 'i1 exit');
      b.client.close();
      t.ok('idle: 子が全部終わり親も居なければ、idleMs の後に終わる（1 回）', await waitFor(() => idle >= 1, 3000, 'idle after').then(() => true, () => false));
    } finally { await h.stop(); }
  }

  // ---- keepMs: 親が居ない状態が続いたら、その子を木ごと止める（終わらない子の保険。Codex の共有の app-server）
  {
    const h = await startHolder();
    try {
      const a = await h.connect();
      a.client.spawn({ ...fakeChild('k1', 'echo'), keepMs: 700 });
      a.client.spawn(fakeChild('k2', 'echo'));
      await waitFor(() => a.events.lines('k1').some(l => l.ready) && a.events.lines('k2').some(l => l.ready), 8000, 'k1 k2 ready');
      a.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'a gone');
      // 親が戻れば止めない（引き継ぎ・落ちた後の起こし直しの間は数秒）
      await sleep(350);
      const b = await h.connect();
      await sleep(1000);
      t.ok('keepMs: 親が戻れば止めない（待つ時間は親が居ない間だけ数える）', childOf(h, 'k1').alive && childOf(h, 'k2').alive);
      b.client.close();
      await waitFor(() => !h.holder.snapshot().connected, 8000, 'b gone');
      await waitFor(() => childOf(h, 'k1').alive === false, 8000, 'k1 stopped');
      t.ok('keepMs: 親が居ない状態が続くと、その子だけを木ごと止める（keepMs の無い子は残る）', childOf(h, 'k1').alive === false && childOf(h, 'k2').alive === true);
    } finally { await h.stop(); }
  }
}

function pendOf(h, id) {
  return h.holder.snapshot().children.find(c => c.id === id).pendingRequests.map(p => p.requestId).sort();
}
