import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMarkdown, renderToolCall, applyToolResult, applyToolHints } from "../../web/render.mjs";
import { backend, threadToMessages } from "../../core/backends/codex.mjs";
import { rpc } from "../../core/backends/codex-rpc.mjs";
import { startServer } from "../lib/server.mjs";

export const name = "timeline-images";
export const title = "ツール折りたたみ・生成画像・ローカルファイルの回帰";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";

export default async function(t) {
  const md = renderMarkdown("[生成プロンプト](D:/work/my-app/prompts.md)\n\n![Harmonic](D:/work/my-app/logo.png)");
  t.ok("Windows パスのリンクを無効化しない", md.includes('href="/local-file?path=D%3A') && !md.includes("md-link-blocked"));
  t.ok("Windows パスを画像として描く", md.includes('<img class="md-img" src="/local-file?path=D%3A'));
  t.ok("空白と括弧を含むパス", renderMarkdown("[logo](<D:/My Project/logo (1).png>)").includes("My%20Project%2Flogo%20(1).png"));
  t.ok("バックスラッシュのパス", renderMarkdown(String.raw`![logo](C:\Temp\images\logo.png)`).includes("C%3A%5CTemp%5Cimages%5Clogo.png"));
  t.ok("外部画像を自動取得しない", !renderMarkdown("![x](//evil.example/x.png)").includes("<img"));
  t.ok("危険なリンクは無効のまま", renderMarkdown("[x](javascript:evil)").includes("md-link-blocked"));

  applyToolHints(backend.toolHints);
  const card = renderToolCall("commandExecution", {command:"echo private-command"});
  applyToolResult(card, {text:"short output"});
  t.ok("閉じた見出しは実行だけ", card.querySelector("summary").textContent === "実行" && card.querySelector("details").getAttribute("open") === undefined);
  t.ok("短い入力・出力も折りたたみの中に保存", card.querySelector("details").outerHTML.includes("private-command") && card.querySelector("details").outerHTML.includes("short output"));
  const item = {type:"imageGeneration", id:"image-1",status:"completed",revisedPrompt:"organic",result:png};
  const messages = threadToMessages({turns:[{id:"t", items:[item,item,{type:"agentMessage",id:"a",text:"done"}]}]});
  const call = messages[0].toolCalls[0];
  t.ok("同じ画像IDを履歴で重複させない", messages[0].toolCalls.length === 1);
  t.ok("base64を入力に混ぜず画像として保持", !JSON.stringify(call.input).includes(png) && call.result.images[0].dataUri.endsWith(png));
  const pic = renderToolCall(call.name,call.input);
  applyToolResult(pic,call.result); applyToolResult(pic,call.result);
  t.ok("生成画像はトグルの外・結果の再送でも1枚", pic.querySelectorAll(".tc-preview").length === 1 && !pic.querySelector("details").outerHTML.includes("<img"));

  const originals = {request:rpc.request,attach:rpc.attach,claimOrphan:rpc.claimOrphan};
  let handlers;
  rpc.attach = (_id,h) => {handlers=h;return ()=>{};};
  rpc.claimOrphan = h => {handlers=h;return ()=>{};};
  rpc.request = async method => {
    if (method === "thread/start") return {thread:{id:"image-test"}};
    if (method !== "turn/start") throw new Error(method);
    queueMicrotask(()=>{
      handlers.onNotification("item/completed",{item});
      handlers.onNotification("turn/completed",{turn:{id:"t",status:"completed"}});
    });
    return {turn:{id:"t"}};
  };
  try {
    const events=[];
    await backend.runTurn({prompt:"fixture",cwd:process.cwd(),emit:e=>events.push(e)});
    t.ok("完了だけ届く画像もカードを作る", events.find(e=>e.type==="tool.start")?.id === item.id);
    t.ok("ライブ結果も画像を保持", events.find(e=>e.type==="tool.result")?.images[0].dataUri.endsWith(png));
  } finally {Object.assign(rpc,originals);}

  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),"timeline-images-"));
  const workspace=path.join(scratch,"workspace");
  const data=path.join(scratch,"data");
  await fs.mkdir(workspace); await fs.mkdir(data);
  const local=path.join(workspace,"logo.png");
  await fs.writeFile(local,Buffer.from(png,"base64"));
  await fs.writeFile(path.join(workspace,"unsafe.html"),"<script>alert(1)</script>");
  await fs.writeFile(path.join(scratch,"secret.txt"),"outside");
  await fs.writeFile(path.join(data,"sessions.json"),JSON.stringify({fixture:{cwd:workspace,backend:"fake"}}));
  const server=await startServer({dataDir:data,env:{AGENT_HOST_BACKENDS:"fake"}});
  const url=p=>`http://127.0.0.1:${server.port}/local-file?path=${encodeURIComponent(p)}`;
  const auth={headers:{cookie:`agent_host_token=${server.token}`}};
  try {
    t.ok("画像にも認証が必要", (await fetch(url(local))).status === 401);
    const image=await fetch(url(local),auth);
    t.ok("実ファイルをPNGとして返す", image.status===200 && image.headers.get("content-type")==="image/png" && Buffer.from(await image.arrayBuffer()).equals(Buffer.from(png,"base64")));
    t.ok("ワークスペース外を拒否", (await fetch(url(path.join(scratch,"secret.txt")),auth)).status===404);
    t.ok("親ディレクトリへの脱出を拒否", (await fetch(url(path.join(workspace,"../secret.txt")),auth)).status===404);
    const html=await fetch(url(path.join(workspace,"unsafe.html")),auth);
    t.ok("HTMLは実行せず添付として返す", html.headers.get("content-type")==="application/octet-stream" && html.headers.get("content-disposition").startsWith("attachment"));
    await fs.symlink(scratch,path.join(workspace,"escape"),process.platform==="win32"?"junction":"dir");
    t.ok("シンボリックリンクでの脱出も拒否",(await fetch(url(path.join(workspace,"escape/secret.txt")),auth)).status===404);
  } finally {await server.stop(); await fs.rm(scratch,{recursive:true,force:true});}
}
