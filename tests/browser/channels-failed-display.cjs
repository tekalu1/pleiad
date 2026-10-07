// playwright-cli -s=channels-failed-display run-code --filename=tests/browser/channels-failed-display.cjs
// Start an isolated fake server on port 7433 with AGENT_HOST_TOKEN=channels-test.
async page => {
  await page.goto('http://127.0.0.1:7433/?token=channels-test');
  await page.getByRole('button', { name: 'あとで', exact: true }).click().catch(() => {});
  await page.getByRole('radio', { name: 'チャンネル' }).click();
  const shown = await page.evaluate(async () => {
    const { renderPost } = await import('/channels/post.mjs');
    const host = { state: { backends: [] }, renderAssistantMarkdown: (text) => `<p>${text}</p>` };
    const ctx = { host, bots: new Map([['b_owl', { name: 'Owl', icon: '🦉' }]]),
      actions: { react() {}, quick() {}, openThread() {}, menu() {} } };
    const base = { channelId: 'c_test', threadId: 'p_root', author: { kind: 'bot', botId: 'b_owl' },
      at: Date.now(), mentions: [], reactions: {}, turn: { botId: 'b_owl', sessionId: 's_test' }, state: 'failed' };
    const fixture = document.createElement('div');
    fixture.append(renderPost({ ...base, id: 'p_with_body', text: '途中の返事です', failedWithBody: true }, ctx),
      renderPost({ ...base, id: 'p_without_body', text: '失敗しました: エラー' }, ctx));
    document.body.append(fixture);
    const result = [...fixture.querySelectorAll('.post')].map((post) => {
      const status = post.querySelector('.post-state');
      return { body: post.querySelector('.post-body')?.textContent, label: status?.textContent,
        className: status?.className, marks: status?.querySelectorAll('.post-state-mark').length,
        weight: Number(getComputedStyle(status.querySelector('.post-state-text')).fontWeight) };
    });
    fixture.remove();
    return result;
  });
  if (shown[0]?.body !== '途中の返事です' || shown[0]?.label !== '終わり方に問題がありました'
    || shown[0]?.className !== 'post-state failed-body' || shown[0]?.marks !== 0
    || shown[1]?.label !== '✕失敗' || shown[1]?.marks !== 1 || shown[0].weight >= shown[1].weight) {
    throw Error(JSON.stringify(shown));
  }
  return shown;
}
