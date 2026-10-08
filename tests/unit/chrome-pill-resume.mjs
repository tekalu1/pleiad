import { resumeFromPill } from '../../core/chrome/pill-resume.mjs';

export const name = 'chrome-pill-resume';
export const title = 'デスクトップのピルの「戻す」をサーバーで受ける: 戻せないときは必ず失敗を返す・押した引き継ぎが今のものか確かめる';

// control の代役。states は会話の id -> 今の状態
function rig({ resume } = {}) {
  const states = new Map();
  const replies = [];
  const resumed = [];
  const control = {
    state: id => states.get(id) ?? { sessionId: id, state: 'idle', since: null, error: null, by: null },
    resume: async id => { resumed.push(id); if (resume) return resume(id, states); states.set(id, { sessionId: id, state: 'idle', since: null, error: null, by: null }); },
  };
  const run = data => resumeFromPill({ control, reply: message => replies.push(message), log: () => {} }, data);
  const pause = (id, { by = 'pc', since = 100 } = {}) => states.set(id, { sessionId: id, state: 'paused', since, error: null, by });
  return { run, pause, replies, resumed, states };
}

export default async function (t) {
  {
    const r = rig();
    r.pause('s');
    const ok = await r.run({ sessionId: 's', since: 100 });
    t.ok('PC への引き継ぎ中で since が合えば戻し、失敗は返さない', ok === true && r.resumed.join() === 's' && r.replies.length === 0, JSON.stringify(r.replies));
  }
  {
    const r = rig();
    await r.run({ sessionId: 'nobody', since: 1 });
    t.ok('引き継いでいない会話への「戻す」は、黙って捨てず失敗を返す', r.resumed.length === 0 && r.replies.length === 1 && r.replies[0].type === 'chrome-pill-resume-failed' && r.replies[0].sessionId === 'nobody', JSON.stringify(r.replies));
  }
  {
    const r = rig();
    r.pause('s', { by: 'device' });
    await r.run({ sessionId: 's', since: 100 });
    t.ok('端末への引き継ぎ（by が pc でない）への「戻す」も失敗を返す', r.resumed.length === 0 && r.replies.length === 1);
  }
  {
    const r = rig();
    r.pause('s', { since: 200 });
    await r.run({ sessionId: 's', since: 100 });
    t.ok('押したときの引き継ぎ（since）と今の引き継ぎが違えば、戻さず失敗を返す（前に押したピルで次の引き継ぎを戻さない）', r.resumed.length === 0 && r.replies.length === 1 && r.states.get('s').state === 'paused', JSON.stringify(r.replies));
  }
  {
    const r = rig();
    r.pause('s', { since: 200 });
    await r.run({ sessionId: 's' });
    t.ok('since を持たない古い送り手の「戻す」は、今の引き継ぎとして扱う', r.resumed.length === 1 && r.replies.length === 0);
  }
  {
    // 窓を隠せず paused のまま。同じ失敗の繰り返しは状態の便りが出ないので、返事で知らせる
    const r = rig({ resume: async (id, states) => { states.set(id, { ...states.get(id), error: 'conceal-failed' }); } });
    r.pause('s');
    await r.run({ sessionId: 's', since: 100 });
    const first = r.replies.length;
    await r.run({ sessionId: 's', since: 100 });
    t.ok('戻したあとも paused のままなら、毎回失敗を返す（2 回続けても）', first === 1 && r.replies.length === 2, JSON.stringify(r.replies));
  }
  {
    const r = rig({ resume: async () => { throw new Error('boom'); } });
    r.pause('s');
    await r.run({ sessionId: 's', since: 100 });
    t.ok('戻す処理が例外で落ちたときも失敗を返す', r.replies.length === 1 && r.replies[0].type === 'chrome-pill-resume-failed');
  }
}
