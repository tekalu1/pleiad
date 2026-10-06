// 承認のカードの id（無停止の更新 段階 2 の 2b-6。docs/zero-downtime-update/stage2-server-state.md §3 の 5・A3）。
// ツールの id（toolUseID・CLI の requestId）と会話の id から決まる値にする。サーバーを入れ替えて承認を出し直すとき（付け直し）、
// 旧サーバーと新サーバーのカードが同じ id になり、画面のカード・スマホの通知・通知の一覧（wait:<id>）が二重にならない。
// ツールの id が無い承認（設定の変更・ply_delegate の確認など）は、これまでどおり乱数。
import crypto from 'node:crypto';

/** 覚えておく id の数。超えたら古いものから忘れる */
export const USED_MAX = 4096;

/**
 * 承認の id を振る（1 つのサーバーに 1 つ）。next(sessionId, toolUseID) は、ツールの id があり、このプロセスでまだ使っていなければ
 * 決まった値（perm-<sha256 の先頭 32 桁>）、それ以外は乱数（UUID）。同じプロセスでの 2 回目は乱数にする: 同じツールの id がもう一度承認を求めても
 * （1 回目と同時に待っていても、終わった後でも）カードが上書きされず、通知の一覧の行（dedupeKey = wait:<id>）が重複として落ちない
 */
export function createApprovalIds({ max = USED_MAX } = {}) {
  const used = new Set();
  return {
    next(sessionId, toolUseID) {
      if (typeof toolUseID !== 'string' || !toolUseID) return crypto.randomUUID();
      const id = approvalCardId(sessionId, toolUseID);
      if (used.has(id)) return crypto.randomUUID();
      used.add(id);
      if (used.size > max) used.delete(used.values().next().value);
      return id;
    },
  };
}

/** 決まった値の承認の id（純関数）。会話ごとに別の値になる（委譲の子の承認を祖先の会話へ中継する複製も、会話の id から同じ規則で決まる） */
export function approvalCardId(sessionId, toolUseID) {
  return `perm-${crypto.createHash('sha256').update(`${sessionId ?? ''}\0${toolUseID}`).digest('hex').slice(0, 32)}`;
}
