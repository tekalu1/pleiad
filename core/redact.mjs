// 別のエージェント（別の提供元のモデルのこともある）へ渡す文から、秘密になりやすい形を伏せて長さを切る。
// 特定の値を伏せる redactSecret（compat-endpoints.mjs）とは別で、値を知らなくても形で伏せる汎用のもの。
// 伏せ漏れはありうる（形を知らない秘密は残る）。だから長さも切り、渡すのは要約に留める。
// 使う所: Codex の実行前の拒否を依頼元へ返すとき（core/server.mjs の execute、docs/agent-delegation.md）。
const MASK = '***';

// URL（scheme://…）。userinfo とクエリの値を伏せる
const URL_RX = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>`]+/gi;

// 既知のトークンの形。前の部分（種類が分かる接頭辞）は残し、値だけを伏せる
const TOKEN_RULES = [
  // Authorization ヘッダーの値（Bearer / Basic）。伏せすぎ（Basic の後の普通の語）は害が無いので許す
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, (_, kind, sp) => `${kind}${sp}${MASK}`],
  // OpenAI・Anthropic などの sk-…（sk-proj-…・sk-ant-… を含む）
  [/\bsk-[A-Za-z0-9_-]{10,}/g, () => `sk-${MASK}`],
  // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{10,}/g, () => `github_pat_${MASK}`],
  [/\b(gh[pousr])_[A-Za-z0-9]{10,}/g, (_, kind) => `${kind}_${MASK}`],
  // GitLab・Slack・AWS のアクセスキー ID・Google の API キー
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, () => `glpat-${MASK}`],
  [/\b(xox[abprs])-[A-Za-z0-9-]{10,}/g, (_, kind) => `${kind}-${MASK}`],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, (_, kind) => `${kind}${MASK}`],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, () => `AIza${MASK}`],
  // JWT（ヘッダー.本体.署名）
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, () => MASK],
  // password=… / --token … / "api_key": "…" のような名前付きの値
  [/((?:^|[^A-Za-z0-9])-{0,2}(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)["']?\s*[=:]\s*["']?)[^\s"'&,;]+/gi, (_, head) => `${head}${MASK}`],
];

/** URL 1 本の userinfo とクエリの値を伏せる */
function maskUrl(url) {
  let out = url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, `$1${MASK}@`);
  const q = out.indexOf('?');
  if (q >= 0) {
    const hash = out.indexOf('#', q);
    const end = hash >= 0 ? hash : out.length;
    const query = out.slice(q + 1, end).replace(/(^|&)([^=&]*)=[^&]*/g, (_, amp, key) => `${amp}${key}=${MASK}`);
    out = out.slice(0, q + 1) + query + out.slice(end);
  }
  return out;
}

/** 形で秘密を伏せる。文字列でなければ null */
export function redactSecrets(text) {
  if (typeof text !== 'string') return null;
  let out = text.replace(URL_RX, maskUrl);
  for (const [rx, fn] of TOKEN_RULES) out = out.replace(rx, fn);
  return out;
}

/** 伏せてから長さを切る（切った印に … を付ける）。伏せる前に切ると、途中で切れたトークンが伏せられずに残る */
export function redactForPeer(text, max = 300) {
  const out = redactSecrets(text);
  if (out === null) return null;
  return out.length > max ? `${out.slice(0, max)}…` : out;
}
