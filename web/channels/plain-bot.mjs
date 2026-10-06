// 組み込みの bot（Bot.plain。チャンネルのスレッドの「bot なし」。ADR 9101）の画面の側。
// 保存の名前は Agent だが、画面では言語の名前「エージェント」と ✦ で出す。Bots の一覧・メンバー・@ の候補には出さない（呼ぶ側で外す）。
// 宛先の面では、まだ作っていなければ 'plain'（op の to・botId の呼び名。サーバーが作る）として選ぶ。

/** op の to・botId の呼び名（サーバーが組み込みの bot の id へ解く） */
export const PLAIN = 'plain';

/** bots.list の 1 件を画面の形に（組み込みの bot は言語の名前とアイコン） */
export const shownBot = (bot, t) => (bot?.plain ? { ...bot, name: t('channels:plain.name'), icon: '✦', iconImage: '' } : bot);

/** まだ作っていない組み込みの bot の宛先の候補 */
export const plainOption = (t) => ({ id: PLAIN, plain: true, name: t('channels:plain.name'), icon: '✦' });
