// ターンの札（無停止の更新 2b-2。docs/zero-downtime-update/stage2-server-state.md の §3 の 3・表の札の行・T1・§4.3・§6 の 2b-2、design.md §4）。
// 純関数 cardOf(ctx) と restoreFields(card) の検証:
//   - ctx → 札 → 戻した値が一致する（往復）
//   - 秘密（account.token・endpoint.key 等）が札の本体に入らず、secrets に隔離される
//   - 大きさの上限（CARD_MAX_BYTES = 64 KB）を超えたら失敗する
//   - 本文（発言・途中送信・中断の文・`!` の行）は札に入らない（ハッシュと文字数だけ。長い貼り付けでも札が作れる）
//   - 知らない版（v !== 1）は null で断る
//   - 途中送信の控え（steers）の形（5 か所の waiters）と正規化
//   - 会話の口のトークン（connectionTokens）の形
//   - ターンの前の切り口（baseline: count と lastUuid）
import assert from 'node:assert/strict';
import {
  CARD_VERSION,
  CARD_MAX_BYTES,
  STEER_WAITERS,
  cardOf,
  restoreFields,
  promptHash,
  normalizeSteers,
  normalizeConnectionTokens,
} from '../../core/turn-card.mjs';

export const name = 'turn-card';
export const title = 'ターンの札: ctx → 札 → 復元の往復・秘密の隔離・上限の超過・知らない版の拒否・途中送信の形';

export default async function (t) {
  const TOKEN_64 = 'a'.repeat(64);
  const TOKEN_CTX = 'c'.repeat(64);

  // 1. ctx → 札 → 復元の往復（代表的な ctx で一致すること）
  {
    const sampleUuid = 'uuid-last-msg-1234';
    const ctx = {
      key: 'session-test-key-1',
      sessionId: 'session-test-key-1',
      backend: { id: 'claude' },
      agentLocale: 'ja',
      startedAtMs: 1728250000000,
      userSentAt: 1728249999000,
      presentKey: 'present-key-xyz',
      browserRelayId: 'relay-id-1',
      baselineLength: 5,
      baselineLastUuid: sampleUuid,
      prompt: 'テストプロンプト',
      args: {
        messageId: 'msg-item-1',
        prompt: 'テストプロンプト',
        scheduledFor: '2026-10-07T00:00:00Z',
        sentBy: { id: 'human-user' },
      },
      hooks: {
        compact: 'idle',
        internal: false,
        taskId: 'parent-task-77',
      },
      cwd: 'D:/dev/test-workspace',
      permissionMode: 'ask',
      model: 'claude-3-7-sonnet',
      effort: 'medium',
      accountId: 'account-id-primary',
      endpointId: 'endpoint-id-default',
      attachments: [{ path: 'foo.txt', size: 100 }],
      pastSubagents: new Set(['subagent-1', 'subagent-2']),
      initialDelivered: true,
      interruptionTaken: false,
      shellHanded: true,
      interruption: {
        keys: ['stop-key-1'],
        dropped: [],
        text: '中断注記テキスト',
        body: '中断注記本文',
      },
      shellHandoff: {
        ids: ['shell-1'],
        skipped: [],
        lines: ['! echo hello'],
      },
      turn: {
        gitSetup: { branch: 'main' },
        git: { snapshot: 'refs/pleiad/1' },
        gitLate: false,
        steeredAttachments: [{ key: 'steer-msg-1', prompt: '途中送信の本文' }],
        abortReason: null,
        info: { stopping: false },
      },
      connectionTokens: {
        agents: TOKEN_64,
        computer: null,
        browser: TOKEN_64,
        control: TOKEN_64,
        context: TOKEN_CTX,
      },
      steers: {
        'steer-item-1': { waiters: ['liveNotices', 'pendingSteers'], note: 'wait test' },
      },
      hooksTurn: {
        record: { hooks: ['pre-tool'] },
        input: { env: 'test' },
      },
      backendCard: { testSpecial: 42 },
    };

    const { card, secrets } = cardOf(ctx);

    assert.equal(card.v, CARD_VERSION, '版は CARD_VERSION (1)');
    assert.equal(card.key, 'session-test-key-1');
    assert.equal(card.sessionId, 'session-test-key-1');
    assert.equal(card.backend, 'claude');
    assert.equal(card.baseline.count, 5);
    assert.equal(card.baseline.lastUuid, sampleUuid);
    assert.equal(card.input.promptHash, promptHash('テストプロンプト'));
    assert.equal(card.input.promptChars, 'テストプロンプト'.length);
    assert.equal(JSON.stringify(card).includes('テストプロンプト'), false, '本文は札に入らない');
    assert.equal(card.input.messageId, 'msg-item-1');
    assert.equal(card.input.taskId, 'parent-task-77');
    assert.equal(card.settings.cwd, 'D:/dev/test-workspace');
    assert.equal(card.settings.model, 'claude-3-7-sonnet');
    assert.equal(card.connectionTokens.agents, TOKEN_64);
    assert.equal(card.connectionTokens.context, TOKEN_CTX);
    assert.deepEqual(card.steers['steer-item-1'].waiters, ['liveNotices', 'pendingSteers']);

    // 復元して突き合わせ
    const restored = restoreFields(card);
    assert.ok(restored !== null, 'restoreFields は成功してオブジェクトを返す');
    assert.equal(restored.v, CARD_VERSION);
    assert.equal(restored.key, ctx.key);
    assert.equal(restored.sessionId, ctx.sessionId);
    assert.equal(restored.backendId, 'claude');
    assert.equal(restored.agentLocale, ctx.agentLocale);
    assert.equal(restored.startedAtMs, ctx.startedAtMs);
    assert.equal(restored.userSentAt, ctx.userSentAt);
    assert.equal(restored.presentKey, ctx.presentKey);
    assert.equal(restored.browserRelayId, ctx.browserRelayId);

    // T1 の切り口
    assert.equal(restored.baseline.count, 5);
    assert.equal(restored.baseline.lastUuid, sampleUuid);

    // 入力
    assert.equal(restored.promptHash, promptHash(ctx.prompt));
    assert.equal(restored.promptChars, ctx.prompt.length);
    assert.equal(restored.messageId, ctx.args.messageId);
    assert.equal(restored.scheduledFor, ctx.args.scheduledFor);
    assert.deepEqual(restored.sentBy, ctx.args.sentBy);
    assert.equal(restored.compactTrigger, 'idle');
    assert.equal(restored.internal, false);
    assert.equal(restored.taskId, 'parent-task-77');

    // 設定
    assert.equal(restored.cwd, ctx.cwd);
    assert.equal(restored.permissionMode, ctx.permissionMode);
    assert.equal(restored.model, ctx.model);
    assert.equal(restored.effort, ctx.effort);
    assert.equal(restored.accountId, 'account-id-primary');
    assert.equal(restored.endpointId, 'endpoint-id-default');
    assert.deepEqual(restored.attachments, ctx.attachments);
    assert.deepEqual(restored.steeredAttachments, [{ key: 'steer-msg-1', promptHash: promptHash('途中送信の本文') }]);
    assert.deepEqual(Array.from(restored.pastSubagents), ['subagent-1', 'subagent-2']);

    // 進行・合図
    assert.equal(restored.delivery.initialDelivered, true);
    assert.equal(restored.delivery.interruptionTaken, false);
    assert.equal(restored.delivery.shellHanded, true);
    // 文と `!` の行は入らない（渡った合図の処理に使う id だけ）
    assert.deepEqual(restored.interruption, { keys: ['stop-key-1'], dropped: [] });
    assert.deepEqual(restored.shellHandoff, { ids: ['shell-1'], skipped: [] });
    for (const body of ['中断注記テキスト', '中断注記本文', '! echo hello', '途中送信の本文'])
      assert.equal(JSON.stringify(card).includes(body), false, `${body} は札に入らない`);

    // git
    assert.equal(restored.git.setup, true);
    assert.equal(restored.git.activity.snapshot, 'refs/pleiad/1');
    assert.equal(restored.git.late, false);

    // トークン
    assert.equal(restored.connectionTokens.agents, TOKEN_64);
    assert.equal(restored.connectionTokens.context, TOKEN_CTX);
    assert.equal(restored.connectionTokens.computer, null);

    // 途中送信
    assert.deepEqual(restored.steers['steer-item-1'].waiters, ['liveNotices', 'pendingSteers']);

    // hooks
    assert.deepEqual(restored.hooks.record, { hooks: ['pre-tool'] });
    assert.deepEqual(restored.hooks.input, { env: 'test' });

    // バックエンド固有
    assert.deepEqual(restored.backendCard, { testSpecial: 42 });

    t.ok('ctx → 札 → 戻した値が一致する（往復）', true);
  }

  // 2. 秘密が札の本体に入らない（secrets として別に返される）
  {
    const SECRET_TOKEN = 'sk-ant-api03-SECRET_OAUTH_TOKEN_VALUE_XYZ';
    const SECRET_KEY = 'super-secret-endpoint-api-key-999';

    const ctx = {
      sessionId: 'session-secret-test',
      backend: 'claude',
      accountId: 'acc-1',
      endpointId: 'ep-1',
      account: {
        id: 'acc-1',
        token: SECRET_TOKEN,
        extra: 'not-in-card',
      },
      endpoint: {
        id: 'ep-1',
        key: SECRET_KEY,
        headers: { Authorization: `Bearer ${SECRET_KEY}` },
      },
      prompt: '秘密を含まない本文',
    };

    const { card, secrets } = cardOf(ctx);

    const serializedCard = JSON.stringify(card);
    assert.equal(serializedCard.includes(SECRET_TOKEN), false, '札の JSON に account.token が含まれない');
    assert.equal(serializedCard.includes(SECRET_KEY), false, '札の JSON に endpoint.key が含まれない');

    // card には ID だけが入る
    assert.equal(card.settings.accountId, 'acc-1');
    assert.equal(card.settings.endpointId, 'ep-1');

    // secrets 側に正しく分離されている
    assert.equal(secrets.account.id, 'acc-1');
    assert.equal(secrets.account.token, SECRET_TOKEN);
    assert.equal(secrets.endpoint.id, 'ep-1');
    assert.equal(secrets.endpoint.key, SECRET_KEY);
    assert.deepEqual(secrets.endpoint.headers, { Authorization: `Bearer ${SECRET_KEY}` });

    t.ok('秘密が札の本体に入らず、secrets に隔離される', true);
  }

  // 3. 上限を超えたら失敗する。長い本文は上限に数えない
  {
    const hugePrompt = 'x'.repeat(CARD_MAX_BYTES * 4);
    const long = cardOf({ sessionId: 'session-long-prompt', backend: 'fake', prompt: hugePrompt });
    assert.ok(Buffer.byteLength(JSON.stringify(long.card)) < 4096, '長い貼り付けの発言でも札は小さい');
    assert.equal(long.card.input.promptChars, hugePrompt.length);

    // 本文以外で大きくなるもの（前のターンまでのサブエージェントの一覧）が上限を超えたら例外
    const ctx = {
      sessionId: 'session-large',
      backend: 'fake',
      pastSubagents: new Set(Array.from({ length: 2000 }, (_, i) => `agent-${String(i).padStart(4, '0')}-${'x'.repeat(30)}`)),
    };

    assert.throws(
      () => cardOf(ctx),
      /exceeds limit/,
      '既定の上限 (64 KB) を超えたら例外'
    );

    // options.maxBytes で上限を変更した場合も機能すること
    assert.throws(
      () => cardOf({ sessionId: 'session-small', prompt: 'abc' }, { maxBytes: 10 }),
      /exceeds limit/,
      '指定した小さな上限を超えたら例外'
    );

    // 上限以内なら通ること
    const ok = cardOf({ sessionId: 'session-small', prompt: 'abc' }, { maxBytes: 2000 });
    assert.ok(ok.card);

    t.ok('大きさの上限（CARD_MAX_BYTES）を超えたら失敗する。長い本文は札に入らない', true);
  }

  // 4. 知らない版は断る（restoreFields が null を返す）
  {
    assert.equal(restoreFields({ v: 2, sessionId: 's1' }), null, '未来の版 v: 2 は null');
    assert.equal(restoreFields({ v: 0, sessionId: 's1' }), null, '過去の版 v: 0 は null');
    assert.equal(restoreFields({ v: '1', sessionId: 's1' }), null, '文字列の版は null');
    assert.equal(restoreFields(null), null, 'null は null');
    assert.equal(restoreFields(undefined), null, 'undefined は null');
    assert.equal(restoreFields([]), null, '配列は null');
    assert.equal(restoreFields({}), null, 'v が無いオブジェクトは null');

    t.ok('知らない版（v !== 1）は null で断る', true);
  }

  // 5. 途中送信の控え（steers）の形
  {
    assert.deepEqual(
      STEER_WAITERS,
      ['pendingSteers', 'liveNotices', 'liveInstructions', 'agentTasks', 'botLiveSteers'],
      '5 つの waiter 名が正しく定義されている'
    );

    // normalizeSteers による無効 waiter の除外
    const raw = {
      'msg-1': {
        waiters: ['pendingSteers', 'invalidWaiter', 'liveNotices'],
        cliUuid: 'u-1',
      },
      'msg-2': {
        waiters: ['agentTasks', 'botLiveSteers', 'liveInstructions'],
      },
      'bad-entry': 'not-an-object',
    };
    const normalized = normalizeSteers(raw);

    assert.deepEqual(normalized['msg-1'].waiters, ['pendingSteers', 'liveNotices']);
    assert.equal(normalized['msg-1'].cliUuid, 'u-1');
    assert.deepEqual(normalized['msg-2'].waiters, ['agentTasks', 'botLiveSteers', 'liveInstructions']);
    assert.equal(normalized['bad-entry'], undefined);

    // cardOf 経由でも正規化される
    const { card } = cardOf({
      sessionId: 's-steers',
      backend: 'claude',
      steers: raw,
    });
    assert.deepEqual(card.steers['msg-1'].waiters, ['pendingSteers', 'liveNotices']);
    assert.deepEqual(card.steers['msg-2'].waiters, ['agentTasks', 'botLiveSteers', 'liveInstructions']);

    t.ok('途中送信の控え（steers）の形（5 か所の waiters）と正規化が正しい', true);

    // 2b-7: 渡った合図を待つ控えの中身（完了通知・追加指示）は、札の往復で欠けない。委譲の子の実行の控え（delegation）は上限で切り、往復する
    const steers = {
      'task-notice-1': { waiters: ['liveNotices'], notice: { prompt: 'p', promptHash: 'h', promptChars: 1, items: [{ taskId: 't1', revision: 2 }] } },
      'task-send-1': { waiters: ['liveInstructions', 'agentTasks'], taskId: 't2', instructionIds: ['i1', 'i2'] },
    };
    const execution = { reply: 'r'.repeat(20000), stopped: [{ id: 'bg1', kind: 'shell', label: 'sleep' }], rejections: [{ text: '再生で作り直る' }] };
    const { card: full } = cardOf({ sessionId: 's-2b7', backend: 'fake', steers, execution });
    const back = restoreFields(JSON.parse(JSON.stringify(full)));
    assert.deepEqual(back.steers, normalizeSteers(steers));
    assert.deepEqual(back.steers['task-send-1'].instructionIds, ['i1', 'i2']);
    assert.equal(back.delegation.reply.length, 16000, '止める前の返答は上限で切る');
    assert.deepEqual(back.delegation.stopped, [{ id: 'bg1', kind: 'shell', label: 'sleep' }]);
    assert.equal('rejections' in back.delegation, false, '拒否されたコマンドは札に入れない（再生の出来事から作り直る）');
    assert.equal(restoreFields(cardOf({ sessionId: 's-2b7', backend: 'fake' }).card).delegation, null, '委譲の子でなければ delegation は null');
    t.ok('2b-7: 完了通知・追加指示の控えと、委譲の子の実行の控え（reply・stopped）が札の往復で保たれる', true);
  }

  // 6. 会話の口のトークン（connectionTokens）の正規化
  {
    const badTokens = {
      agents: 'short',
      computer: TOKEN_64.toUpperCase(), // 大文字は不正
      browser: TOKEN_64,
      control: null,
      context: 'invalid',
    };
    const normalized = normalizeConnectionTokens(badTokens);
    assert.equal(normalized.agents, null, '短すぎるトークンは null');
    assert.equal(normalized.computer, null, '大文字を含むトークンは null');
    assert.equal(normalized.browser, TOKEN_64, '64 桁小文字 16 進は保持');
    assert.equal(normalized.control, null);
    assert.equal(normalized.context, null);

    t.ok('会話の口のトークン（connectionTokens）の形式検査が正しい', true);
  }

  // 7. ターンの前の切り口（T1: baseline の発言数と最後の uuid）
  {
    // messages 配列から自動抽出されるケース
    const ctx = {
      sessionId: 'session-baseline-auto',
      backend: 'fake',
      turn: {
        stream: {
          messages: [
            { role: 'user', uuid: 'msg-u-1' },
            { role: 'assistant', uuid: 'msg-u-2' },
          ],
        },
      },
    };
    const { card } = cardOf(ctx);
    assert.equal(card.baseline.count, 2);
    assert.equal(card.baseline.lastUuid, 'msg-u-2');

    const restored = restoreFields(card);
    assert.equal(restored.baseline.count, 2);
    assert.equal(restored.baseline.lastUuid, 'msg-u-2');

    t.ok('ターンの前の切り口（baseline: count と lastUuid）が正しく機能する', true);
  }

  // 8. 出している承認のカードの id（waits。2b-6）: 往復する・文字列以外と空は落とす・上限を超えたら先頭の 64 件
  {
    const { card } = cardOf({ sessionId: 's-waits', backend: 'fake', waits: ['perm-aaa', '', 7, null, 'perm-bbb'] });
    assert.deepEqual(card.waits, ['perm-aaa', 'perm-bbb']);
    assert.deepEqual(restoreFields(card).waits, ['perm-aaa', 'perm-bbb']);
    assert.deepEqual(cardOf({ sessionId: 's-waits', backend: 'fake' }).card.waits, [], '無ければ空');
    assert.deepEqual(restoreFields({ v: CARD_VERSION, waits: 'x' }).waits, [], '配列でなければ空');
    assert.equal(cardOf({ sessionId: 's-waits', backend: 'fake', waits: Array.from({ length: 100 }, (_, i) => `perm-${i}`) }).card.waits.length, 64);
    t.ok('承認のカードの id（waits）が札に載って往復する', true);
  }
}
