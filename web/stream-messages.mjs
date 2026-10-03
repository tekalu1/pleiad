// 走っているターンの出来事（loadSession の live が返す stream.events）を、保存済みの履歴と同じ形の仮の発言に畳む。
// メインパネルは出来事を onEvent で 1 件ずつ再生して描くが、読むだけの筋（作業の詳細、client.mjs の readonlyThread）は
// 履歴の形しか描かない。ここで畳んで、保存済みの発言の後ろに足す（Antigravity の子は、ターンが終わるまで履歴に何も入らない）。
// 発言の区切りは onEvent に合わせる: text.end で発言を閉じ、閉じた後の本文・考えた内容・text.end は次の発言にする。
// ツールは閉じた発言にも続けて入る（履歴の 1 発言 = 本文 + ツール呼び出し）。人の発言・完了通知・提示は発言を閉じる。

const META = new Set(['type', 'sessionId', 'streamSeq']);
const strip = (ev) => Object.fromEntries(Object.entries(ev).filter(([key]) => !META.has(key)));
const isoAt = (at) => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : at ?? null;

/**
 * @param {object[]} events stream.events（streamSeq の順）
 * @param {{ backend?: string|null, model?: string|null, initialMessageId?: string|null }} [opts]
 *   backend・model は仮の AI の発言の発言者。initialMessageId はターンを始めた発言（サーバーが履歴の末尾に足し済み）
 * @returns {{ messages: object[], presents: object[] }} 保存済みの履歴（NormalizedMessage）と提示（presents）と同じ形
 */
export function streamMessages(events = [], { backend = null, model = null, initialMessageId = null } = {}) {
  const messages = [];
  const presents = [];
  const calls = new Map();
  const users = new Map();       // messageId -> 人の発言（途中送信）
  const undelivered = new Set(); // 受理しただけで、まだエージェントに渡っていない発言（渡るまでは指示の一覧に出ている）
  const deliveredEarly = new Set(); // 吹き出しより先に届いた配達の合図（onEvent の deliveredEarly と同じ）
  let turn = null, closed = false, writing = false, thinking = false;
  const closeTurn = () => { turn = null; closed = false; writing = false; thinking = false; };
  const openTurn = () => {
    if (turn && !closed) return turn;
    turn = { role: 'assistant', text: '', ...(backend ? { backend } : {}), ...(model ? { model } : {}) };
    messages.push(turn);
    closed = false; writing = false; thinking = false;
    return turn;
  };
  for (const ev of events ?? []) {
    switch (ev?.type) {
      case 'text.delta': {
        const text = String(ev.text ?? '');
        if (!text) break;
        if (!writing) { const m = openTurn(); if (m.text) m.text += '\n\n'; writing = true; }
        thinking = false;
        turn.text += text;
        break;
      }
      case 'text.end':
        openTurn();
        closed = true; writing = false; thinking = false;
        break;
      case 'thinking.start':
        writing = false;
        break;
      case 'thinking.delta': {
        if (!ev.text) break;
        if (!thinking) { const m = openTurn(); m.thinking = m.thinking ? `${m.thinking}\n\n` : ''; thinking = true; }
        turn.thinking += String(ev.text);
        break;
      }
      case 'tool.start': {
        if (ev.id && calls.has(ev.id)) break;
        writing = false;
        const m = turn ?? openTurn();
        const call = { id: ev.id ?? null, name: ev.name, input: ev.input ?? null };
        (m.toolCalls ??= []).push(call);
        if (ev.id) calls.set(ev.id, call);
        break;
      }
      case 'tool.result': {
        const call = calls.get(ev.id);
        if (call) { const { id, ...result } = strip(ev); call.result = result; }
        break;
      }
      case 'userMessage': {
        if (ev.initial || (ev.messageId && ev.messageId === initialMessageId)) break;
        closeTurn();
        const known = ev.messageId ? users.get(ev.messageId) : null;
        const m = known ?? { role: 'user', text: '', at: null };
        m.text = String(ev.text ?? '');
        m.at = isoAt(ev.at) ?? m.at;
        if (ev.sentBy) m.sentBy = ev.sentBy;
        if (!known) { messages.push(m); if (ev.messageId) users.set(ev.messageId, m); }
        if (ev.pending && ev.messageId && !deliveredEarly.has(ev.messageId)) undelivered.add(m);
        else undelivered.delete(m);
        break;
      }
      case 'userMessage.delivered': {
        const m = users.get(ev.messageId);
        if (m) undelivered.delete(m);
        else if (ev.messageId) deliveredEarly.add(ev.messageId);
        break;
      }
      case 'userMessage.dropped': {
        const m = users.get(ev.messageId);
        if (m) { messages.splice(messages.indexOf(m), 1); users.delete(ev.messageId); undelivered.delete(m); }
        break;
      }
      case 'taskNotice':
        closeTurn();
        messages.push({ role: 'user', internalTaskNotice: true, text: String(ev.text ?? ''), at: isoAt(ev.at) });
        break;
      case 'present':
        if (ev.by !== 'human') closeTurn();
        presents.push(strip(ev));
        break;
      case 'turnResult':
        if (ev.compact || ev.outcome === 'ok') break;
        closeTurn();
        if (ev.outcome === 'aborted') messages.push({ role: 'system', kind: 'interrupt', text: '', at: isoAt(ev.at) });
        break;
      default:
        break;
    }
  }
  return {
    messages: messages.filter(m => !undelivered.has(m)
      && (m.role !== 'assistant' || m.text || m.thinking || m.toolCalls?.length)),
    presents,
  };
}
