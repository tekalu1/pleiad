// チャンネル・スレッドの入力欄の添付（docs/channels.md「画面」、ADR 0116）。中身は Chats の入力欄と同じ部品（web/composer/attachments.mjs）で、
// ここはチャンネルの入力欄の持ち方だけを決める: クリップのボタンと隠した file input を自分で作る・置き場の分け先はチャンネルの id
// （<データ置き場>/uploads/<チャンネル id>/）・持ち主は下書きの key・出どころは「この端末」だけ。
// 出どころを選ばせる口（ホストのファイル・フォルダー）は持たない: Chats の作業ディレクトリに結び付いているため。
import { createComposerAttachments } from '../composer/attachments.mjs';

/**
 * @param {object} o
 * @param {{ cmd: Function, whenOnline?: Function, openImage?: Function, filePreview?: object }} o.host
 * @param {() => string|null} o.bucket 置き場の分け先（チャンネルの id）
 * @param {() => string} o.owner いまの下書きの key。送っている間に別の下書きへ移っても、届いたものは持ち主の下書きへ入れる
 * @param {() => boolean} [o.accepts] 添付を受け付ける間か（書けない・アーカイブでは false）
 * @param {(text: string) => void} o.say 入力欄の下の一行（失敗など）
 * @param {() => void} o.onChange 添付が増減した・送る前の状態が変わった（下書きの保存・送信ボタンの状態）
 * @param {(owner: string, item: object) => void} o.adopt 別の下書きへ移った後に届いた添付を、その持ち主の下書きへ入れる
 */
export function createChAttachments({ host, bucket, owner, accepts = () => true, say, onChange, adopt }) {
  return createComposerAttachments({ host, bucket, owner, accepts, say, onChange, adopt, controls: true, originOf: () => 'device' });
}
