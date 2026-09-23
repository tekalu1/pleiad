// Native initialization only; no model turn is sent.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutable } from '../../core/cli-installation.mjs';
import { claudeContextOptions, codexContextRpc } from '../../core/backends/context-options.mjs';
import { rpc } from '../../core/backends/codex-rpc.mjs';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'ply-runtime-probe-')),cwd=path.join(tmp,'repo'),home=path.join(tmp,'home');
const write=async(p,s)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,s);};
const context={owners:{instruction:'ply',skill:'ply',mcp:'ply'},prompt:'PLY_EXPLICIT_CONTEXT',url:'http://127.0.0.1:1/unused',headers:{}};
let codex;
try{
 await fs.mkdir(path.join(cwd,'.git'),{recursive:true});await fs.mkdir(home);
 await write(path.join(cwd,'AGENTS.md'),'NATIVE_AGENTS_SENTINEL');
 await write(path.join(cwd,'CLAUDE.md'),'NATIVE_CLAUDE_SENTINEL');
 for(const dir of ['.agents','.claude'])await write(path.join(cwd,dir,'skills/probe/SKILL.md'),'---\nname: probe\ndescription: Native probe skill\n---\nNATIVE_SKILL_SENTINEL');
 await write(path.join(cwd,'.mcp.json'),JSON.stringify({mcpServers:{nativeFixture:{command:'should-never-launch'}}}));
 const ac=new AbortController();let release;
 const gate=new Promise(r=>release=r);async function* prompt(){await gate;}
 const q=query({prompt:prompt(),options:{pathToClaudeCodeExecutable:claudeExecutable(),cwd,settingSources:['user','project','local'],...claudeContextOptions(context),abortController:ac,persistSession:false,env:{...process.env,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1'}}});
 const timer=setTimeout(()=>ac.abort(),45000);
 try{await q.initializationResult();const usage=await q.getContextUsage({detail:'summary'});const commands=await q.supportedCommands();const mcp=await q.mcpServerStatus();
  const result={backend:'claude',memoryFiles:usage.memoryFiles?.length??0,probeSkill:commands.some(c=>c.name==='probe'),nativeMcp:mcp.some(s=>s.name==='nativeFixture')};
  console.log(JSON.stringify(result));if(result.memoryFiles||result.probeSkill||result.nativeMcp)throw new Error('Claude suppression failed');
 }finally{clearTimeout(timer);release();q.close();}
 process.env.CODEX_HOME=path.join(home,'.codex');await fs.mkdir(process.env.CODEX_HOME);process.chdir(cwd);
 await write(path.join(process.env.CODEX_HOME,'config.toml'),'[mcp_servers.nativeFixture]\ncommand="should-never-launch"\n[mcp_servers."with.dot"]\ncommand="should-never-launch"\n');
 codex=await codexContextRpc(context,cwd,rpc);
 const settings=await codex.request('config/read',{cwd,includeLayers:false});
 const skills=await codex.request('skills/list',{cwds:[cwd],forceReload:true});
 const found=skills.data.flatMap(d=>d.skills??[]).find(s=>s.name==='probe');
 const result={backend:'codex',projectDocMaxBytes:settings.config.project_doc_max_bytes,probeSkillEnabled:found?.enabled,nativeMcpEnabled:settings.config.mcp_servers.nativeFixture.enabled,dottedEnabled:settings.config.mcp_servers['with.dot'].enabled};
 console.log(JSON.stringify(result));if(result.projectDocMaxBytes!==0||result.probeSkillEnabled!==false||result.nativeMcpEnabled!==false||result.dottedEnabled!==false)throw new Error('Codex suppression failed');
 console.log('PASS: native suppression, no turns sent');
}finally{codex?.stop();rpc.stop();process.chdir(os.tmpdir());if(!path.basename(tmp).startsWith('ply-runtime-probe-'))throw new Error('bad probe path');await fs.rm(tmp,{recursive:true,maxRetries:5,retryDelay:200});}
