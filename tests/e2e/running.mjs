// 「動いているもの」。サブエージェントを実際に1体起動させ、一覧に出ること・会話が読めること。
//
// README.md を読ませるので、このテストだけはセッションの cwd をリポジトリ直下にする。
// 書き込みは無い。

export const name = "running";
export const title = "実行中のターンとサブエージェントが見える";

export default async function (t, ctx) {
  const seen = { events: [], maxTurns: 0, maxSub: 0 };
  const c = await ctx.open({
    autoAllow: true,
    onEvent: (ev) => {
      if (ev.type !== "running") return;
      seen.events.push(ev);
      seen.maxTurns = Math.max(seen.maxTurns, ev.turns?.length ?? 0);
      seen.maxSub = Math.max(seen.maxSub, ev.subagents?.length ?? 0);
    },
  });

  try {
    const idle = await c.cmd("running");
    t.ok("running が返る（待機中は 0 件）", idle.count === 0, `count=${idle.count}`);

    await c.runTurn({
      prompt:
        "Task ツールでサブエージェントを1体だけ起動し、" +
        "「このリポジトリの README.md の見出しを列挙して」とだけ依頼して。" +
        "結果は3行以内でまとめて。自分では読まないこと。",
      sessionId: null, cwd: ctx.root, mode: "auto",
    });

    t.ok("実行中に running イベントが飛ぶ", seen.events.length > 0, `${seen.events.length} 回`);
    t.ok("実行中のターンが載る", seen.maxTurns > 0, `最大 ${seen.maxTurns} 本`);
    t.ok("サブエージェントが一覧に出る", seen.maxSub > 0, `最大 ${seen.maxSub} 体`);

    const last = seen.events.filter((e) => e.subagents?.length).at(-1);
    if (last) {
      const a = last.subagents[0];
      t.note(`${a.id} / ${a.messages} メッセージ / ${JSON.stringify(a.description ?? "").slice(0, 60)}`);
      const conv = await c.cmd("loadSubagent", { sessionId: a.sessionId, agentId: a.id });
      t.ok("サブエージェントの会話が読める", (conv.messages ?? []).length > 0, `${conv.messages?.length ?? 0} メッセージ`);
      t.ok("見出しが付く", Boolean(a.description), JSON.stringify(a.description ?? "").slice(0, 70));
    } else {
      t.ok("サブエージェントの会話が読める", false, "サブエージェントが出なかった");
      t.ok("見出しが付く", false, "サブエージェントが出なかった");
    }

    const after = await c.cmd("running");
    // 形の契約。ここが turn(単数) から turns(配列) に変わったとき、
    // クライアントが追従できておらず「動いているもの」の内訳が出なくなった。
    t.ok("running は turns を配列で返す", Array.isArray(after.turns), `turns=${JSON.stringify(after.turns)}`);
    t.ok("running は permissions / subagents / count を持つ",
      Array.isArray(after.permissions) && Array.isArray(after.subagents) && typeof after.count === "number");
    t.ok("count は3つの合計", after.count === after.turns.length + after.permissions.length + after.subagents.length,
      `count=${after.count}`);
    t.ok("項目には sessionId が付く",
      [...after.turns, ...after.subagents].every((x) => "sessionId" in x));

    t.ok("ターン終了後にターンは消える", after.turns.length === 0,
         `count=${after.count}, subagents=${after.subagents.length}`);
  } finally {
    c.close();
  }
}
