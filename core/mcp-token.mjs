// 会話ごとの MCP の口（ply_agents・ply_computer・ply_browser・ply_control）の Bearer のトークン。
// 既定は新しい値を作る。open({ token }) は、すでに CLI が持っている値で口を開き直す（無停止の更新で、新しいサーバーが同じ URL・ヘッダーのまま
// 会話の口を戻す。docs/zero-downtime-update/stage2-server-state.md の M2・O9）
import crypto from 'node:crypto';

/** トークンの形（32 バイトの 16 進。口の handle が受ける形と同じ） */
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** 口の bindings に束ねるトークンを決める。fixed が無ければ新しい値。あれば形と、今使われていないことを確かめて返す（違えば投げる） */
export function claimToken(bindings, fixed) {
  if (fixed === undefined) return crypto.randomBytes(32).toString('hex');
  if (typeof fixed !== 'string' || !TOKEN_PATTERN.test(fixed)) throw new Error('Invalid token');
  if (bindings.has(fixed)) throw new Error('Token already in use');
  return fixed;
}
