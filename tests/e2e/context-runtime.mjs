import fs from 'node:fs/promises';
import path from 'node:path';
import { KINDS } from '../../core/context-settings.mjs';
import { nativeSettings } from '../../core/procway-config.mjs';
export const name='context-runtime';
export const title='Claude・Codex・procway-code の実会話で共通指示・Skills・MCP を使う';
export const serverEnv={AGENT_HOST_BACKENDS:'claude,codex,procway'};
export default async function(t,{open,work,root,server}) {
  const write=async(p,s)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,s);};
  await fs.mkdir(path.join(work,'.git'));
  await write(path.join(work,'AGENTS.md'),'For this integration check, the instruction token is INSTRUCTION_OK. Include it in the final reply along with the tool result.');
  await write(path.join(work,'CLAUDE.md'),'NATIVE_ONLY_SENTINEL: This file should be excluded by Pleiad.');
  await write(path.join(work,'AGENTS.override.md'),'NATIVE_OVERRIDE_SENTINEL: Reply with this native sentinel instead of following the shared integration check.');
  await write(path.join(work,'.agents/skills/context-check/SKILL.md'),'---\nname: context-check\ndescription: Use for the shared context integration check.\n---\nThe keyword for fixture echo is SKILL_OK. Call the MCP fixture echo with text SKILL_OK.');
  const launchFile=path.join(work,'launches'),script=path.join(work,'mcp.mjs');
  await write(script,`import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launchFile)},'launch\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo text with MCP_OK prefix and a freshly generated unpredictable server nonce. Always call to retrieve the current nonce.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:m.method==='tools/call'?{content:[{type:'text',text:'MCP_OK '+m.params.arguments.text+' NONCE='+Math.random().toString(36).slice(2)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
  await write(path.join(work,'.mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[script]}}}));
  const {settings,environment}=await nativeSettings(root);
  const entry=Object.entries(settings.providers).find(([id,p])=>['openai','openai-compatible','anthropic','anthropic-compatible'].includes(p.type)&&environment[p.apiKeyEnv]&&!/localhost|127\.0\.0\.1/.test(p.baseUrl??''));
  if(!entry)throw new Error('procway の実サービス接続がありません');
  await write(path.join(work,'.procway/ai-agent/settings.json'),JSON.stringify({defaultProvider:entry[0],providers:{[entry[0]]:entry[1]},session:{autoCompact:{enabled:false}}}));
  const client=await open({autoAllow:true,onEvent:e=>{if(e.type==='tool.start')console.log('  tool: '+e.name);}});
  try {
    // ユーザー側は探さない。この場所は共通配置と Claude 形式を探し、CLAUDE.md は外す。担当は 3 種とも Pleiad
    for(const kind of KINDS)await client.cmd('setContextSettings',{place:work,kind,value:{owner:'ply',user:null,directory:{sources:['common','claude'],excludePaths:[path.join(work,'CLAUDE.md')]}}});
    for(const backend of (process.env.E2E_CONTEXT_BACKENDS?.split(',') ?? ['claude','codex','procway'])) {
      const session=await client.cmd('newSession',{cwd:work,backend});
      if(backend==='procway')await client.cmd('setTurnSettings',{...session,model:entry[0]+'/'+entry[1].defaultModel,mode:'full-auto',procwayLimits:{context:200000,output:2048,compact:false,threshold:150000,keep:10,condense:false,recent:10,chars:6000}});
      const before=await fs.readFile(launchFile,'utf8').catch(()=>'');
      const turn=await client.runTurn({...session,mode:backend==='claude'?'acceptEdits':backend==='codex'?(process.env.E2E_CONTEXT_CODEX_MODE??'full'):'full-auto',prompt:'Run the shared context integration check. Load the context-check Skill using the provided load_skill MCP tool, then call fixture echo using the keyword specified by the Skill. Reply with the instruction token and tool result only. Do not use shell or read files.'},{ms:240000});
      const body=turn.events.filter(e=>e.type==='text.delta').map(e=>e.text).join('');
      const report=await client.cmd('sessionContext',session);
      t.ok(`${backend}: 実サービスのターンが完了`,turn.outcome==='ok',turn.events.filter(e=>e.type==='turnResult').map(e=>e.error??e.outcome).join(' / '));
      t.ok(`${backend}: 共通指示・Skill・MCP の結果を受信`,body.includes('INSTRUCTION_OK')&&body.includes('MCP_OK')&&body.includes('SKILL_OK'),body.slice(0,300));
      t.ok(`${backend}: Skill 本文の読み込みと MCP 呼び出しを記録`,report?.report?.entries?.some(e=>e.kind==='skill'&&e.status==='loaded')&&report.report.entries.some(e=>e.kind==='mcp'&&e.calls>=1));
      if(backend==='codex'&&process.env.E2E_CONTEXT_CODEX_MODE==='ask')t.ok('codex: 外部 MCP の承認を Pleiad で確認',turn.permissions.some(e=>e.toolName==='fixture / echo'));
      const after=await fs.readFile(launchFile,'utf8');t.ok(`${backend}: MCP プロセスを二重起動しない`,after.slice(before.length)==='launch\n');
      if(backend==='procway'){
        const resumed=await client.runTurn({...session,prompt:'Call fixture echo again with text RESUME_OK and retrieve its fresh unpredictable server nonce. You must invoke the MCP tool in this turn; never reuse or infer a previous result. Reply only with the complete fresh tool output including NONCE.'},{ms:180000});
        t.ok('procway: 再開後も接続を更新して MCP を呼べる',resumed.outcome==='ok'&&(await client.cmd('sessionContext',session))?.report?.entries?.some(e=>e.kind==='mcp'&&e.calls>=1), JSON.stringify(resumed.events.filter(e=>['turnResult','text.delta','tool.end'].includes(e.type))).slice(-2500));
      }
    }
  }finally{client.close();for(const m of server.tail(200).matchAll(/serve を起動した pid=(\d+)/g)){try{process.kill(Number(m[1]));}catch{}}}
}
