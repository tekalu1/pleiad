// バックエンドがプロンプトを相手（CLI・app-server）へ渡す前に失敗した、という印を付ける。
// server はこの印を見て、送信待ちの項目を「送信済み」から「失敗」へ戻す（利用者が再送・取り消しを選べる）。
// 渡したかもしれないとき（書き込んだ後・応答が不明）は付けない。二重送信になるより、結果不明のほうがよい
export function undelivered(err) {
  const error = err instanceof Error ? err : new Error(String(err));
  error.undelivered = true;
  return error;
}
