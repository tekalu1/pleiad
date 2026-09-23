// procway の loadSettings の身代わり。接続先は 1 つだけ（cli-agent 型にしておくと Pleiad は容量の中継を挟まない）。
export async function loadSettings() {
  const settings = {
    defaultProvider: "fake",
    // procway 自身の既定。Pleiad が選んだモードで上書きされることを台本の返答で確かめる
    approvalMode: "auto-readonly",
    providers: { fake: { type: "cli-agent", command: process.execPath, args: [], defaultModel: "script" } },
    session: { autoCompact: { enabled: false } },
    tools: { staleToolResults: { enabled: false } },
    agents: {},
  };
  return { settings, sources: [{ name: "default", path: null, loaded: true }] };
}
