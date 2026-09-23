// Claude のアカウント切り替え（core/claude-accounts.mjs）。LLM も Claude Code も呼ばない。
// env の組み立て（トークンが env にだけ入る・process.env は変わらない・未選択なら今と同じ）と、
// トークンの置き場（返さない・一覧に書かない・使えないときは止める）、使用量の並べ方を確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeEnv, redactToken, normalizeToken, createClaudeAccounts, AccountError, TOKEN_ENV,
  fetchTokenOrg, tokenChecks, readOauthAccount, cliConfigFile } from '../../core/claude-accounts.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { createStderrLog } from '../../core/backends/claude-background.mjs';

export const name = 'claude-accounts';
export const title = 'Claude のアカウント: env の組み立て・トークンの置き場・使えないアカウントで止める・トークンの持ち主の照合';

const TOKEN_A = 'sk-ant-oat01-' + 'A'.repeat(40);
const TOKEN_B = 'sk-ant-oat01-' + 'B'.repeat(40);

export default async function (t) {
  // ---- env の組み立て
  const before = JSON.stringify(process.env);
  const hadToken = Object.hasOwn(process.env, TOKEN_ENV);
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-api', HOME: '/home/x' };
  const baseCopy = JSON.stringify(base);
  const extra = { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' };

  const plain = claudeEnv(base, { extra });
  t.ok('未選択なら base + extra と同じ env（トークンを足さない）', JSON.stringify(plain) === JSON.stringify({ ...base, ...extra }));
  t.ok('未選択なら CLAUDE_CODE_OAUTH_TOKEN を持たない', !Object.hasOwn(plain, TOKEN_ENV));
  const withToken = claudeEnv(base, { token: TOKEN_A, extra });
  t.ok('選んだトークンは env にだけ入る', withToken[TOKEN_ENV] === TOKEN_A && withToken.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS === '0');
  t.ok('base は書き換えない', JSON.stringify(base) === baseCopy && !Object.hasOwn(base, TOKEN_ENV));
  t.ok('ANTHROPIC_API_KEY はそのまま残す（CLI の優先順位を変えない）', withToken.ANTHROPIC_API_KEY === 'sk-api');
  const inherited = claudeEnv({ ...base, [TOKEN_ENV]: 'from-shell' }, {});
  t.ok('未選択なら親の CLAUDE_CODE_OAUTH_TOKEN も消さない（今と同じ）', inherited[TOKEN_ENV] === 'from-shell');

  const fromProcess = claudeEnv(process.env, { token: TOKEN_B, extra });
  // Windows の Actions では PATH が Path という名前で入る。process.env は大小を区別せずに引けるが、広げた先は区別する
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH');
  t.ok('process.env を広げた env にトークンが入る', fromProcess[TOKEN_ENV] === TOKEN_B && fromProcess[pathKey] === process.env[pathKey]);
  const unset = claudeEnv(process.env, { extra: { CLAUDECODE: undefined } });
  t.ok('process.env から作っても、未選択なら process.env と同じ中身', Object.keys(process.env).every(k => k === 'CLAUDECODE' || unset[k] === process.env[k]) && unset[TOKEN_ENV] === process.env[TOKEN_ENV]);
  t.ok('process.env は変わらない', JSON.stringify(process.env) === before && Object.hasOwn(process.env, TOKEN_ENV) === hadToken);

  // ---- 伏せる
  t.ok('エラーメッセージからトークンを伏せる', redactToken(`bad ${TOKEN_A} x ${TOKEN_A}`, TOKEN_A) === 'bad [トークン] x [トークン]');
  t.ok('トークンが無ければそのまま', redactToken('as is', undefined) === 'as is');
  const logged = [];
  const log = createStderrLog({ log: s => logged.push(s), secrets: [TOKEN_A] });
  log(`auth header ${TOKEN_A}\nnext line\n`);
  t.ok('stderr の記録にトークンを残さない', logged.length === 2 && !logged.join('\n').includes(TOKEN_A) && logged[0].includes('[トークン]'));

  // ---- 形式
  t.ok('前後の空白は落とす', normalizeToken(`  ${TOKEN_A}\n`) === TOKEN_A);
  let bad = null;
  try { normalizeToken('sk-ant-oat01-abc def ghi jkl mno'); } catch (e) { bad = e; }
  t.ok('空白が混じるトークンは断る', bad && bad.message.includes('setup-token') && !bad.message.includes('abc'));

  // ---- 置き場
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-accounts-'));
  try {
    const secrets = createSecretStore({ file: path.join(dir, 'claude-account-secrets.json'), cipher: plainCipher });
    const accounts = createClaudeAccounts({ dataDir: dir, secrets, cliConfig: path.join(dir, 'no-cli.json') });
    t.ok('何も登録していなければ空', (await accounts.list()).accounts.length === 0);
    t.ok('未選択（空）は null＝ログイン中のアカウント', await accounts.resolve('') === null && await accounts.resolve(undefined) === null);

    let missing = null;
    try { await accounts.save({ name: '仕事用' }); } catch (e) { missing = e; }
    t.ok('追加にはトークンが要る', missing?.message.includes('トークン'));
    const { id: work } = await accounts.save({ name: ' 仕事用 ', token: TOKEN_A });
    const { id: home } = await accounts.save({ name: '個人用', token: TOKEN_B });
    const listed = await accounts.list();
    t.ok('一覧は id・表示名・登録済みかどうか・使用量の認可の有無・持ち主の照合だけ', listed.accounts.length === 2 && listed.accounts[0].name === '仕事用'
      && listed.accounts.every(a => a.hasToken === true && a.usageLogin === false && Object.keys(a).sort().join() === 'hasToken,id,name,tokenCheck,usageLogin'));
    t.ok('確かめない設定では照合は unknown', listed.accounts.every(a => a.tokenCheck.status === 'unknown'));
    t.ok('一覧にトークンを載せない', !JSON.stringify(listed).includes(TOKEN_A) && !JSON.stringify(listed).includes(TOKEN_B));
    t.ok('保存先の状態を返す（暗号化できない起動では encrypted: false）', listed.storage?.encrypted === false);
    const registry = await fs.readFile(path.join(dir, 'claude-accounts.json'), 'utf8');
    t.ok('一覧のファイルにはトークンを書かない', !registry.includes(TOKEN_A) && !registry.includes(TOKEN_B));
    t.ok('トークンは選んだアカウントのものが引ける', (await accounts.resolve(work)).token === TOKEN_A && (await accounts.resolve(home)).token === TOKEN_B);

    await accounts.save({ id: work, name: '仕事' });
    t.ok('名前だけ変えるとトークンは残る', (await accounts.resolve(work)).token === TOKEN_A && (await accounts.list()).accounts[0].name === '仕事');
    await accounts.save({ id: work, name: '仕事', token: TOKEN_B });
    t.ok('トークンを貼り直せる', (await accounts.resolve(work)).token === TOKEN_B);
    await accounts.save({ id: work, name: '仕事', token: TOKEN_A });

    // 暗号化して保存したものを、この起動では復号できない（npm start で開いた）
    const raw = JSON.parse(await fs.readFile(secrets.file, 'utf8'));
    raw.entries[`claude-account:${home}`] = { enc: 'safeStorage', data: 'xxxx', at: new Date().toISOString() };
    await fs.writeFile(secrets.file, JSON.stringify(raw));
    let locked = null;
    try { await accounts.resolve(home); } catch (e) { locked = e; }
    t.ok('トークンを読めないアカウントは止める（黙ってログイン中へ落とさない）', locked instanceof AccountError && locked.code === 'unreadable' && locked.message.includes('個人用'));

    await secrets.delete(`claude-account:${home}`);
    let none = null;
    try { await accounts.resolve(home); } catch (e) { none = e; }
    t.ok('トークンが無いアカウントは止める', none instanceof AccountError && none.code === 'missing-token');
    t.ok('トークンが無いことは一覧で分かる', (await accounts.list()).accounts.find(a => a.id === home).hasToken === false);

    // 使用量の認可（アカウントごとの設定フォルダ）
    const usageDir = accounts.usageDir(work);
    t.ok('使用量の設定フォルダはデータ置き場の claude-usage/<id>', path.resolve(usageDir) === path.resolve(dir, 'claude-usage', work));
    let badId = null; try { accounts.usageDir('../x'); } catch (e) { badId = e; }
    t.ok('id でないものからフォルダを作らない', Boolean(badId));
    await accounts.markUsageLogin(work);
    await fs.writeFile(path.join(usageDir, '.credentials.json'), '{}');
    t.ok('認可が済んだことが一覧で分かる', (await accounts.list()).accounts.find(a => a.id === work).usageLogin === true);
    const targets = await accounts.usageTargets();
    t.ok('使用量の対象は設定フォルダと認可の有無（トークンは含めない）', targets.length === 2 && targets.find(a => a.id === work).usageLogin === true
      && targets.find(a => a.id === home).usageLogin === false && !JSON.stringify(targets).includes('sk-ant-'));
    let unknown = null; try { await accounts.markUsageLogin('acct-none'); } catch (e) { unknown = e; }
    t.ok('登録していないアカウントには印を付けない', Boolean(unknown));

    await accounts.remove(work);
    t.ok('削除すると使用量の設定フォルダ（CLI の資格情報）も消える', await fs.access(usageDir).then(() => false, () => true));
    let gone = null;
    try { await accounts.resolve(work); } catch (e) { gone = e; }
    t.ok('削除したアカウントは止める', gone instanceof AccountError && gone.code === 'deleted');
    t.ok('削除するとトークンも消える', !(await secrets.keys('claude-account:')).includes(`claude-account:${work}`));
    let twice = null;
    try { await accounts.remove(work); } catch (e) { twice = e; }
    t.ok('無いものは消せない', Boolean(twice));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }

  // 使用量の並べ方（アカウントごとの設定フォルダで読む）は tests/unit/claude-login.mjs で確かめる

  await ownerChecks(t);
}

// ---- トークンの持ち主の照合（ネットワークは使わない。fetch と組織の引き方は偽物）
const ORG_WORK = '11111111-0000-4000-8000-000000000001';
const ORG_PERSONAL = '22222222-0000-4000-8000-000000000002';
const ORG_OTHER = 'aaaaaaaa-0000-4000-8000-000000000003';
const TOKEN_C = 'sk-ant-oat01-' + 'C'.repeat(40);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const until = async (pred, ms = 2000) => { for (const end = Date.now() + ms; !pred() && Date.now() < end;) await new Promise(done => setTimeout(done, 5)); return pred(); };

async function ownerChecks(t) {
  // ---- GET /v1/models?limit=1 の応答ヘッダー
  const seen = [];
  const fakeFetch = (reply) => async (url, init) => { seen.push({ url, headers: init.headers, method: init.method ?? 'GET', signal: init.signal }); return reply(); };
  const res = (status, org) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(org ? { 'anthropic-organization-id': org } : {}), body: null });
  const org = await fetchTokenOrg(TOKEN_A, { fetch: fakeFetch(() => res(200, ORG_WORK)), baseUrl: 'http://stub.invalid/' });
  t.ok('組織は応答ヘッダー anthropic-organization-id から読む', org === ORG_WORK);
  t.ok('送るのは GET /v1/models?limit=1（推論を消費しない）', seen[0].url === 'http://stub.invalid/v1/models?limit=1' && seen[0].method === 'GET');
  t.ok('OAuth のトークンとして送る（Bearer・oauth の beta・版）', seen[0].headers.authorization === `Bearer ${TOKEN_A}`
    && seen[0].headers['anthropic-beta'] === 'oauth-2025-04-20' && seen[0].headers['anthropic-version'] === '2023-06-01');
  t.ok('時間切れを付ける', seen[0].signal instanceof AbortSignal);
  const failed = async (opts) => { try { await fetchTokenOrg(TOKEN_A, opts); return null; } catch (e) { return e; } };
  const e401 = await failed({ fetch: fakeFetch(() => res(401, ORG_WORK)) });
  t.ok('200 でなければ失敗（組織が付いていても採らない）', e401?.message.includes('HTTP 401'));
  const eNet = await failed({ fetch: async () => { throw new Error(`connect failed for ${TOKEN_A}`); } });
  t.ok('つながらないときの文面にトークンを出さない', eNet && !eNet.message.includes(TOKEN_A) && eNet.message.includes('[トークン]'));
  const eNone = await failed({ fetch: fakeFetch(() => res(200, null)) });
  t.ok('応答に組織が無ければ失敗', eNone?.message.includes('組織'));

  // ---- 設定の .claude.json
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-claude-owner-'));
  const writeAccount = async (file, orgId, email) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, String.fromCharCode(0xfeff) + JSON.stringify({ numStartups: 3, oauthAccount: { organizationUuid: orgId, emailAddress: email, accountUuid: 'x' } }));
  };
  try {
    const cliFile = path.join(dir, 'home', '.claude.json');
    await writeAccount(cliFile, ORG_PERSONAL, 'personal@example.com');
    t.ok('.claude.json のログイン中のアカウント（BOM 付きでも読む）', JSON.stringify(await readOauthAccount(cliFile)) === JSON.stringify({ org: ORG_PERSONAL, email: 'personal@example.com' }));
    t.ok('無い・壊れた .claude.json は null', await readOauthAccount(path.join(dir, 'none.json')) === null);
    t.ok('CLI の .claude.json は CLAUDE_CONFIG_DIR の中、無ければホームの直下',
      cliConfigFile({ CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') }, '/h') === path.join(dir, 'cfg', '.claude.json') && cliConfigFile({}, path.join(dir, 'h')) === path.join(dir, 'h', '.claude.json'));

    // ---- 照合（純粋関数）
    const row = (id, name, tokenOrg, usage, hasToken = true) => ({ id, name, hasToken, tokenOrg, usage });
    const work = { org: ORG_WORK, email: 'work@example.com' }, personal = { org: ORG_PERSONAL, email: 'personal@example.com' };
    let r = tokenChecks([row('a', '仕事用', ORG_WORK, work), row('b', '個人用', ORG_PERSONAL, personal)]);
    t.ok('トークンの組織 = 使用量の認可の組織なら ok', r.get('a').status === 'ok' && r.get('b').status === 'ok' && !r.get('a').sameTokenAs);
    r = tokenChecks([row('a', '仕事用', ORG_PERSONAL, work), row('b', '個人用', ORG_PERSONAL, personal)]);
    t.ok('食い違えば mismatch、持ち主は別の登録アカウントの名前（2026-09-23 の事故の形）', r.get('a').status === 'mismatch' && r.get('a').ownerName === '個人用'
      && r.get('a').ownerEmail === 'personal@example.com' && r.get('a').expectedEmail === 'work@example.com');
    t.ok('正しい側には何も付けない（間違っているのは相手）', r.get('b').status === 'ok' && !r.get('b').sameTokenAs);
    r = tokenChecks([row('a', '仕事用', ORG_PERSONAL, work)], personal);
    t.ok('登録アカウントに持ち主が無ければ、ログイン中のアカウントかを見る', r.get('a').status === 'mismatch' && r.get('a').ownerLoggedIn === true
      && r.get('a').ownerEmail === 'personal@example.com' && !r.get('a').ownerName);
    r = tokenChecks([row('a', '仕事用', ORG_OTHER, work)], personal);
    t.ok('持ち主が分からなくても mismatch（名前は付けない）', r.get('a').status === 'mismatch' && !r.get('a').ownerName && !r.get('a').ownerLoggedIn && r.get('a').expectedEmail === work.email);
    r = tokenChecks([row('a', '仕事用', ORG_PERSONAL, null), row('b', '個人用', ORG_PERSONAL, personal)]);
    t.ok('使用量の認可が無くても、別の登録アカウントの組織なら mismatch', r.get('a').status === 'mismatch' && r.get('a').ownerName === '個人用' && !r.get('a').expectedEmail);
    r = tokenChecks([row('a', '仕事用', ORG_WORK, null)], { org: ORG_WORK, email: 'x' });
    t.ok('使用量の認可が無く比べる相手が無ければ unknown（ログイン中と同じでも決めつけない）', r.get('a').status === 'unknown' && !r.get('a').ownerLoggedIn);
    r = tokenChecks([row('a', '仕事用', null, work), row('b', 'none', ORG_WORK, work, false)]);
    t.ok('未確認・トークン無しは unknown', r.get('a').status === 'unknown' && r.get('b').status === 'unknown');
    r = tokenChecks([row('a', '仕事用', ORG_WORK, null), row('b', '仕事用2', ORG_WORK, null)]);
    t.ok('2 つの登録のトークンが同じ組織なら sameTokenAs', r.get('a').sameTokenAs?.join() === '仕事用2' && r.get('b').sameTokenAs?.join() === '仕事用');
    r = tokenChecks([row('a', '仕事用', ORG_WORK, work), row('b', '仕事用2', ORG_WORK, work)]);
    t.ok('どちらも照合が合う同じアカウントの 2 重登録も sameTokenAs', r.get('a').status === 'ok' && r.get('a').sameTokenAs?.join() === '仕事用2' && r.get('b').sameTokenAs?.join() === '仕事用');

    // ---- 保存・裏での確認
    const data = path.join(dir, 'data');
    const secrets = createSecretStore({ file: path.join(data, 'claude-account-secrets.json'), cipher: plainCipher });
    const orgOf = { [TOKEN_A]: ORG_WORK, [TOKEN_B]: ORG_PERSONAL, [TOKEN_C]: ORG_OTHER };
    let calls = [], fail = false, clock = 1_000_000, gate = null;
    const checkOrg = async token => { calls.push(token); if (gate) await gate.promise; if (fail) throw new Error('offline'); return orgOf[token]; };
    let changed = 0;
    const make = (opts = {}) => createClaudeAccounts({ dataDir: data, secrets, checkOrg, onChecked: () => { changed++; }, cliConfig: cliFile, now: () => clock, ...opts });
    const registry = async () => JSON.parse(await fs.readFile(path.join(data, 'claude-accounts.json'), 'utf8')).accounts;
    const accounts = make();

    const { id: workId } = await accounts.save({ name: '仕事用', token: TOKEN_B });
    t.ok('保存したら組織を確かめて記録してから返す', calls.length === 1 && (await registry())[0].tokenOrg === ORG_PERSONAL && typeof (await registry())[0].tokenCheckedAt === 'string');
    t.ok('一覧のファイルにトークンは書かない', !JSON.stringify(await registry()).includes('sk-ant-'));
    let list = await accounts.list();
    t.ok('使用量の認可が無く比べられなければ unknown', list.accounts[0].tokenCheck.status === 'unknown');
    await writeAccount(path.join(accounts.usageDir(workId), '.claude.json'), ORG_WORK, 'work@example.com');
    await accounts.markUsageLogin(workId);
    list = await accounts.list();
    t.ok('使用量の認可が済むと照合できる（ログイン中のアカウントのトークン）', list.accounts[0].tokenCheck.status === 'mismatch' && list.accounts[0].tokenCheck.ownerLoggedIn === true
      && list.accounts[0].tokenCheck.expectedEmail === 'work@example.com');
    t.ok('記録済みなら一覧で確かめ直さない', calls.length === 1);

    const { id: personalId } = await accounts.save({ name: '個人用', token: TOKEN_C });
    await writeAccount(path.join(accounts.usageDir(personalId), '.claude.json'), ORG_PERSONAL, 'personal@example.com');
    await accounts.markUsageLogin(personalId);
    list = await accounts.list();
    const byId = id => list.accounts.find(a => a.id === id).tokenCheck;
    t.ok('持ち主は別の登録アカウントの名前で知らせる', byId(workId).status === 'mismatch' && byId(workId).ownerName === '個人用' && !byId(workId).ownerLoggedIn);

    // 貼り直し: 正しいトークン。確かめ直して ok に
    await accounts.save({ id: workId, name: '仕事用', token: TOKEN_A });
    list = await accounts.list();
    t.ok('トークンを差し替えたら確かめ直す', calls.at(-1) === TOKEN_A && byId(workId).status === 'ok' && (await registry()).find(a => a.id === workId).tokenOrg === ORG_WORK);
    const before = calls.length;
    await accounts.save({ id: workId, name: '仕事用（改名）' });
    t.ok('名前だけの変更では確かめない・記録も残す', calls.length === before && (await registry()).find(a => a.id === workId).tokenOrg === ORG_WORK);

    // 確かめられなくても保存は止めない
    fail = true;
    await accounts.save({ id: workId, name: '仕事用', token: TOKEN_B });
    const entry = (await registry()).find(a => a.id === workId);
    t.ok('確認に失敗しても保存する（トークンは差し替わる）', (await accounts.resolve(workId)).token === TOKEN_B);
    t.ok('差し替えたら前の記録は消す（未確認のまま）', !('tokenOrg' in entry) && !('tokenCheckedAt' in entry));
    t.ok('未確認は unknown', (await accounts.list()).accounts.find(a => a.id === workId).tokenCheck.status === 'unknown');
    const afterFail = calls.length;
    await accounts.list(); await accounts.list();
    t.ok('失敗した直後は一覧を引いても叩き続けない', calls.length === afterFail);
    fail = false; clock += 6 * 60_000; changed = 0;
    await Promise.all([accounts.list(), accounts.list(), accounts.list()]);
    await until(() => changed > 0);
    t.ok('数分おけば一覧を引いたときに確かめ直す（同時に引いても 1 回）', calls.length === afterFail + 1 && changed === 1);
    t.ok('確かめ直した結果が一覧に出る', (await accounts.list()).accounts.find(a => a.id === workId).tokenCheck.ownerName === '個人用' && calls.length === afterFail + 1);

    // この確認より前に保存したトークン（記録が無い）
    const legacyData = path.join(dir, 'legacy');
    const legacySecrets = createSecretStore({ file: path.join(legacyData, 'claude-account-secrets.json'), cipher: plainCipher });
    const old = createClaudeAccounts({ dataDir: legacyData, secrets: legacySecrets, cliConfig: cliFile });
    const { id: legacyId } = await old.save({ name: '前から', token: TOKEN_A });
    calls = []; changed = 0; gate = deferred();
    const fresh = createClaudeAccounts({ dataDir: legacyData, secrets: legacySecrets, checkOrg, onChecked: () => { changed++; }, cliConfig: cliFile, now: () => clock });
    const first = await fresh.list();
    t.ok('記録の無いトークンは一覧を待たせずに裏で確かめる', first.accounts[0].tokenCheck.status === 'unknown' && await until(() => calls.length === 1) && changed === 0);
    await fresh.list(); const again = fresh.checkToken(legacyId);
    await new Promise(done => setTimeout(done, 20));
    t.ok('確かめている間に一覧を引いても重ねない', calls.length === 1);
    gate.resolve(); gate = null;
    await again; await until(() => changed > 0);
    const legacyEntry = JSON.parse(await fs.readFile(path.join(legacyData, 'claude-accounts.json'), 'utf8')).accounts[0];
    t.ok('裏で確かめた結果を記録し、一覧が変わったことを知らせる', changed === 1 && legacyEntry.tokenOrg === ORG_WORK);
    await fresh.list();
    t.ok('記録したら 2 度目は確かめない', calls.length === 1 && changed === 1);

    // 確かめている途中でトークンを差し替えた: 古いトークンの結果は記録しない
    gate = deferred(); calls = [];
    const racing = fresh.checkToken(legacyId);
    await until(() => calls.length === 1);
    const replacing = fresh.save({ id: legacyId, name: '前から', token: TOKEN_C });
    await until(() => calls.length === 2);
    gate.resolve(); gate = null;
    const [oldResult] = await Promise.all([racing, replacing]);
    const racedEntry = JSON.parse(await fs.readFile(path.join(legacyData, 'claude-accounts.json'), 'utf8')).accounts[0];
    t.ok('確かめている途中で差し替えたら、古いトークンの結果は記録しない', oldResult.changed === false && racedEntry.tokenOrg === ORG_OTHER && calls.join() === [TOKEN_A, TOKEN_C].join());
    t.ok('照合の結果にトークンを載せない', !JSON.stringify(await fresh.list()).includes('sk-ant-'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
