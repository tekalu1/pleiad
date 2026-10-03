// 操作の権限。主体 × 危険度 × 呼び出しが束縛された会話の承認モード → allow | ask | deny | hidden。
// 純関数だけ（server・store には依存しない）。表は tests/unit/ops-policy.mjs が全組み合わせで固定する（ADR 0081）。
//
// 主体は 2 つ。
//   human   画面（PC・リモートの端末・モバイル）。全部通す。
//   agent   Pleiad の中の AI の MCP・CLI・`pleiad mcp` をまとめたもの。どこから来たかは via（記録のため）、
//           どの会話に束縛されているかは sessionId。権限は記録の by や via ではなく、この判定で決める（design.md §5）。
//
// 危険度は 4 段。
//   read        読むだけ
//   write       Pleiad の状態を変える（題・状態・圧縮の閾値など）
//   guarded     関所を緩める・権限を広げる・取り返しがつかない（MCP の登録・Hooks・computer use の許可・接続先の削除など）
//   human-only  下の HUMAN_ONLY の 5 つだけ（承認モード・秘密の値・アカウント・接続先の既定・リモートのペアリング）。agent には出さない
//               Pleiad の機能はほかは全部 agent も使える。5 つに当たらない操作を human-only にしない（ADR 0094。tests/lint-ops.mjs が落とす）
//
// agent の guarded は、束縛された会話の承認モード（core/modes.mjs の軸）で決める。
//   scope が none / readonly                  → deny（READ_ONLY_MODE。write も同じ）
//   scope が full かつ autonomy が never      → allow（その会話はデータ置き場を直接書き換えられるので、ここで止めても防壁にならない。記録は残す）
//   それ以外（ask・judge、sandbox で閉じた never） → ask（会話の承認カード。段階 2）
//   会話に束縛されていない（外のターミナルの CLI・外の AI の MCP） → deny（NEEDS_UI。画面へ誘導）
import { modePosition, scopeRank } from '../modes.mjs';

export const RISKS = ['read', 'write', 'guarded', 'human-only'];
export const PRINCIPALS = ['human', 'agent'];
export const VIAS = ['mcp', 'cli', 'mcp-stdio'];
export const DECISIONS = ['allow', 'ask', 'deny', 'hidden'];

/**
 * human-only にしてよいものの全部（ADR 0094）。WS のコマンド（commands）と設定の一覧のキー（settings）と、WS のコマンドを持たない操作の id（ops）。
 * ここに無いものは human-only にしない（操作の risk・tests/ops-baseline.json の human-only・設定の risk を tests/lint-ops.mjs が突き合わせる）。
 * 足すのは ADR の範囲。
 */
export const HUMAN_ONLY = Object.freeze({
  // 承認モード。AI が自分の関所を緩められると承認フローが意味を失う（design.md §8.5）。承認カードへの応答も同じ。bot の承認モード（bots.setMode。ADR 0108）も
  mode: { commands: ['setMode', 'resolvePermission'], settings: ['mode'], ops: ['bots.setMode'] },
  // 秘密の値を入れる・消す・認可する（委譲の判定器のキー・互換の接続先のキー・MCP の OAuth）
  secrets: { commands: ['setDelegationRoutingKey', 'deleteDelegationRoutingKey', 'compatEndpointCheck', 'compatEndpointSave', 'mcpAuthStart', 'mcpAuthLogout'], settings: [] },
  // アカウント（契約・課金の主体）。一覧も含む
  accounts: { commands: ['saveClaudeAccount', 'deleteClaudeAccount', 'claudeLoginStart', 'claudeLoginCode', 'claudeLoginCancel', 'authLogin', 'authLogout', 'authSubmit', 'claudeAccounts'], settings: ['claudeAccount'] },
  // 新しい会話の接続先の既定（会話の送り先を、人が確かめていない先へ黙って替えない）
  endpointDefault: { commands: ['compatEndpointDefault'], settings: [] },
  // リモートのペアリングと外に開く設定（端末の一覧を含む）
  remotePairing: { commands: ['remotePairingStart', 'remotePairingCancel', 'remotePairingApprove', 'remotePairingDeny', 'remoteRevoke', 'remoteDevices', 'setRemoteSettings'], settings: [] },
});
export const HUMAN_ONLY_COMMANDS = new Set(Object.values(HUMAN_ONLY).flatMap((x) => x.commands));
export const HUMAN_ONLY_SETTINGS = new Set(Object.values(HUMAN_ONLY).flatMap((x) => x.settings));
export const HUMAN_ONLY_OPS = new Set(Object.values(HUMAN_ONLY).flatMap((x) => x.ops ?? []));

export const riskRank = (risk) => RISKS.indexOf(risk);

/** 値に依って危険度が上がる操作（riskOf）の結果は、定義の risk より下げない。 */
export const maxRisk = (a, b) => (riskRank(b) > riskRank(a) ? b : a);

// 返す形: { decision, code?, reason }。code は deny のときの失敗の種類（画面と CLI がコードで見分ける）。
const allow = (reason) => ({ decision: 'allow', reason });
const ask = (reason) => ({ decision: 'ask', reason });
const deny = (code, reason) => ({ decision: 'deny', code, reason });
const hidden = (reason) => ({ decision: 'hidden', reason });

/**
 * @param principal { by: 'human' } | { by: 'agent', sessionId?: string|null, mode?: modes() の 1 エントリ }
 *                  mode は束縛された会話の承認モード。会話が分からない（束縛されているのに引けない）ときは弱い側（workspace・ask）に倒す
 * @param risk      'read' | 'write' | 'guarded' | 'human-only'
 * @param opts      { modeGate?: false }  write 以上を読み取り・計画モードの会話から断る規則を外す（既定は掛ける）
 */
export function decide(principal, risk, opts = {}) {
  if (!RISKS.includes(risk)) return deny('INVALID_RISK', `unknown risk: ${risk}`);
  if (principal?.by === 'human') return allow('human');
  if (principal?.by !== 'agent') return deny('INVALID_PRINCIPAL', `unknown principal: ${principal?.by}`);

  if (risk === 'human-only') return hidden('human-only');
  if (risk === 'read') return allow('read');

  const bound = typeof principal.sessionId === 'string' && principal.sessionId !== '';
  const position = bound ? modePosition(principal.mode) : null;

  if (bound && opts.modeGate !== false && scopeRank(position.scope) <= scopeRank('readonly'))
    return deny('READ_ONLY_MODE', `scope=${position.scope}`);

  if (risk === 'write') return allow('write');

  // guarded
  if (!bound) return deny('NEEDS_UI', 'unbound');
  // modeGate: false の操作でも、権限を広げる変更は自分で読み取りの会話から通さない
  if (scopeRank(position.scope) <= scopeRank('readonly')) return deny('READ_ONLY_MODE', `scope=${position.scope}`);
  if (position.scope === 'full' && position.autonomy === 'never') return allow('mode-never-full');
  return ask('mode-needs-approval');
}

/** 一覧に出すか。human-only は agent の一覧・list_ops のどこにも出さない（呼ばれても NOT_FOUND と同じに見せる）。 */
export const visibleTo = (principal, risk) => decide(principal, risk).decision !== 'hidden';
