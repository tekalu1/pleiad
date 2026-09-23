import fs from 'node:fs/promises';
import path from 'node:path';
import { KINDS } from '../../core/context-settings.mjs';
export const name='context-runtime';
export const title='Claude・Codex の実会話で共通指示・Skills・MCP を使う';
export const serverEnv={AGENT_HOST_BACKENDS:'claude,codex'};
export default async function(t,{open,work}) {
  const write=async(p,s)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,s);};
  await fs.mkdir(path.join(work,'.git'));
  await write(path.join(work,'AGENTS.md'),'For this integration check, the instruction token is INSTRUCTION_OK. Include it in the final reply along with the tool result.');
  await write(path.join(work,'CLAUDE.md'),'NATIVE_ONLY_SENTINEL: This file should be excluded by Pleiad.');
  await write(path.join(work,'AGENTS.override.md'),'NATIVE_OVERRIDE_SENTINEL: Reply with this native sentinel instead of following the shared integration check.');
  await write(path.join(work,'.agents/skills/context-check/SKILL.md'),'---\nname: context-check\ndescription: Use for the shared context integration check.\n---\nThe keyword for fixture echo is SKILL_OK. Call the MCP fixture echo with text SKILL_OK.');
  const launchFile=path.join(work,'launches'),script=path.join(work,'mcp.mjs');
  await write(script,`import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launchFile)},'launch\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo text with MCP_OK prefix and a freshly generated unpredictable server nonce. Always call to retrieve the current nonce.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:m.method==='tools/call'?{content:[{type:'text',text:'MCP_OK '+m.params.arguments.text+' NONCE='+Math.random().toString(36).slice(2)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
  await write(path.join(work,'.mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[script]}}}));
  const client=await open({autoAllow:true,onEvent:e=>{if(e.type==='tool.start')console.log('  tool: '+e.name);}});
  try {
    // ユーザー側は探さない。この場所は共通配置と Claude 形式を探し、CLAUDE.md は外す。担当は Pleiad
    for(const kind of KINDS)await client.cmd('setContextSettings',{place:work,kind,value:{owner:'ply',user:null,directory:{sources:['common','claude'],excludePaths:[path.join(work,'CLAUDE.md')]}}});
    for(const backend of (process.env.E2E_CONTEXT_BACKENDS?.split(',') ?? ['claude','codex'])) {
      const session=await client.cmd('newSession',{cwd:work,backend});
      const before=await fs.readFile(launchFile,'utf8').catch(()=>'');
      const turn=await client.runTurn({...session,mode:backend==='claude'?'acceptEdits':(process.env.E2E_CONTEXT_CODEX_MODE??'full'),prompt:'Run the shared context integration check. Load the context-check Skill using the provided load_skill MCP tool, then call fixture echo using the keyword specified by the Skill. Reply with the instruction token and tool result only. Do not use shell or read files.'},{ms:240000});
      const body=turn.events.filter(e=>e.type==='text.delta').map(e=>e.text).join('');
      const report=await client.cmd('sessionContext',session);
      t.ok(`${backend}: 実サービスのターンが完了`,turn.outcome==='ok',turn.events.filter(e=>e.type==='turnResult').map(e=>e.error??e.outcome).join(' / '));
      t.ok(`${backend}: 共通指示・Skill・MCP の結果を受信`,body.includes('INSTRUCTION_OK')&&body.includes('MCP_OK')&&body.includes('SKILL_OK'),body.slice(0,300));
      t.ok(`${backend}: Skill 本文の読み込みと MCP 呼び出しを記録`,report?.report?.entries?.some(e=>e.kind==='skill'&&e.status==='loaded')&&report.report.entries.some(e=>e.kind==='mcp'&&e.calls>=1));
      if(backend==='codex'&&process.env.E2E_CONTEXT_CODEX_MODE==='ask')t.ok('codex: 外部 MCP の承認を Pleiad で確認',turn.permissions.some(e=>e.toolName==='fixture / echo'));
      const after=await fs.readFile(launchFile,'utf8');t.ok(`${backend}: MCP プロセスを二重起動しない`,after.slice(before.length)==='launch\n');
    }
  }finally{client.close();}
}
