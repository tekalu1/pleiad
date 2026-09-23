import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DEFAULT_SCAN, KINDS, containsPath, createContextSettings, defaultKind, matchesGlobs } from '../../core/context-settings.mjs';
import { resolveRuntime, contextTools, mcpTransportConfig } from '../../core/context-runtime.mjs';
import { createContextBridge } from '../../core/context-bridge.mjs';
import { claudeContextOptions, unexpectedNativeMcp } from '../../core/backends/context-options.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name='context-runtime';
export const title='共通読み込み・遅延 Skills・MCP 接続と分離・セッション固定';
export default async function(t) {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'ply-runtime-')), cwd=path.join(tmp,'repo'), home=path.join(tmp,'home');
  const write=async(p,s)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,s);};
  const rejects=async(label,fn)=>{try{await fn();t.ok(label,false);}catch{t.ok(label,true);}};
  const policy={version:1,cwd,owners:{instruction:'ply',skill:'ply',mcp:'ply'},user:{...DEFAULT_SCAN,sources:[]},directory:{...DEFAULT_SCAN,sources:['common','claude']}};
  let host,client,server,connection;
  try {
    await fs.mkdir(path.join(cwd,'.git'),{recursive:true});
    await write(path.join(cwd,'AGENTS.md'),'ROOT_SENTINEL');
    await write(path.join(cwd,'CLAUDE.md'),'@AGENTS.md\nCLAUDE_SENTINEL');
    await write(path.join(cwd,'sub/AGENTS.md'),'SCOPED_SENTINEL');
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: example description\n---\nSKILL_BODY_SENTINEL');
    await write(path.join(cwd,'.agents/skills/manual/SKILL.md'),'---\nname: manual\ndescription: manual only\ndisable-model-invocation: true\n---\nMANUAL_BODY');
    let runtime=await resolveRuntime(policy,{home});
    let helpers=contextTools(runtime);
    t.ok('AGENTS の直接探索と CLAUDE import は一度だけ',helpers.prompt.split('ROOT_SENTINEL').length===2);
    t.ok('初期プロンプトには Skill 本文・子階層の指示を混ぜない',!helpers.prompt.includes('SKILL_BODY_SENTINEL')&&!helpers.prompt.includes('SCOPED_SENTINEL'));
    const skill=runtime.skills.find(s=>s.name==='example');
    t.ok('必要時だけ Skill を読み込み記録する',(await helpers.call('load_skill',{id:skill.id})).content[0].text.includes('SKILL_BODY_SENTINEL')&&runtime.report.entries.find(e=>e.id===skill.id).status==='loaded');
    // 同じ会話で渡し済みの本文は繰り返さない（短い一行）。full: true と、本文が変わったときは渡し直す
    const skillAgain=(await helpers.call('load_skill',{id:skill.id})).content[0].text;
    t.ok('渡し済みの Skill は本文を繰り返さず短い一行で返す',!skillAgain.includes('SKILL_BODY_SENTINEL')&&skillAgain.startsWith('Already provided in this conversation: Skill example')&&skillAgain.includes('full: true'),skillAgain);
    t.ok('Skill も full: true なら本文を返す',(await helpers.call('load_skill',{id:skill.id,full:true})).content[0].text.includes('SKILL_BODY_SENTINEL'));
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: example description\n---\nSKILL_BODY_V2');
    const skillChanged=(await helpers.call('load_skill',{id:skill.id})).content[0].text;
    t.ok('Skill の本文が変わっていれば渡し直し、変わったと添える',skillChanged.includes('SKILL_BODY_V2')&&/changed since it was last provided/.test(skillChanged),skillChanged);
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: example description\n---\nSKILL_BODY_SENTINEL');
    t.ok('何度読んでも記録の行は loaded のまま（頼まれた回数を数える）',runtime.report.entries.find(e=>e.id===skill.id).status==='loaded'&&runtime.report.entries.find(e=>e.id===skill.id).calls===4);
    t.ok('どちらのツールも full を受け取り、説明に書く',helpers.tools.length===2&&helpers.tools.every(tool=>tool.inputSchema.properties.full?.type==='boolean'&&tool.description.includes('full: true')));
    await rejects('自動呼出し不可の Skill は明示依頼なしでは公開しない',()=>helpers.call('load_skill',{id:runtime.skills.find(s=>s.name==='manual').id}));
    t.ok('明示依頼の Skill は公開',contextTools(runtime,'$manual を使う').prompt.includes('- manual:'));
    const manual = runtime.skills.find(s => s.name === 'manual');
    const multiple = { ...runtime, skills: [manual, { ...manual, id: 'second', name: 'second' }] };
    t.ok('文中の複数スラッシュ指定で手動専用スキルを公開', ['まず/manual と /second を使う', '/manual /second'].every(prompt => {
      const text = contextTools(multiple, prompt).prompt;
      return text.includes('- manual:') && text.includes('- second:');
    }));
    t.ok('URL・パスをスキルの明示指定と誤認しない', ['https://manual', 'C:/manual', './manual', '/manual/file', 'a/manual'].every(prompt => !contextTools(runtime, prompt).prompt.includes('- manual:')));
    t.ok('子階層の指示を範囲付きで必要時に読み込む',(await helpers.call('instructions_for_path',{id:path.join(cwd,'sub')})).content[0].text.includes('SCOPED_SENTINEL'));
    await rejects('範囲外の指示を要求できない',()=>helpers.call('instructions_for_path',{id:tmp}));
    const ctx={owners:policy.owners,prompt:'MANAGED_PROMPT',url:'http://localhost/context',headers:{Authorization:'test'}};
    const cl=claudeContextOptions(ctx);
    t.ok('Claude の種類別抑止と明示プロンプト',cl.strictMcpConfig&&cl.skills.length===0&&cl.extraArgs['disable-slash-commands']===null&&cl.settings.claudeMdExcludes.length&&cl.systemPrompt.append==='MANAGED_PROMPT');
    // MCP を Pleiad が担当する Claude の会話: Pleiad 自身が渡した MCP（委譲の ply_agents を含む）はネイティブ扱いしない
    const passed=['host','ply_agents','ply_context'];
    t.ok('Pleiad が渡した ply_agents・ply_context はネイティブ MCP と見なさない',unexpectedNativeMcp([{name:'host'},{name:'ply_agents'},{name:'ply_context'}],passed).length===0);
    t.ok('止められなかったネイティブ MCP は名前で見つける',JSON.stringify(unexpectedNativeMcp([{name:'host'},{name:'ply_agents'},{name:'github'}],passed))==='["github"]');
    t.ok('渡していない名前はネイティブとして見つける（ply_agents を渡さないターン）',JSON.stringify(unexpectedNativeMcp([{name:'host'},{name:'ply_agents'}],['host']))==='["ply_agents"]');
    // claude.mjs が渡す MCP と確認に使う名前が同じもの（plyServers）であること
    const claudeSource=await fs.readFile(new URL('../../core/backends/claude.mjs',import.meta.url),'utf8');
    t.ok('Claude は渡した mcpServers の名前で確認する',/mcpServers: plyServers/.test(claudeSource)&&/unexpectedNativeMcp\(native, Object\.keys\(plyServers\)\)/.test(claudeSource));
    const settings=createContextSettings(path.join(tmp,'prefs'),home);
    for(const kind of KINDS)await settings.set({place:null,kind,value:{...defaultKind(),owner:'ply'}});
    t.ok('担当のユーザー既定を子ディレクトリへ継承',(await settings.get(path.join(cwd,'sub'))).owners.skill==='ply');
    for(const kind of KINDS)await settings.set({place:cwd,kind,value:defaultKind()});
    t.ok('この場所の担当をユーザー既定と独立して保存',(await settings.get(cwd)).owners.skill==='native'&&(await settings.get(path.join(cwd,'sub'))).owners.skill==='native');
    // A real SDK MCP client connects to this fixture. The marker file proves one launch.
    const mcpScript=path.join(tmp,'fixture.mjs'),launches=path.join(tmp,'launches');
    await write(mcpScript,`import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(${JSON.stringify(launches)},'launch\\n');for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:m.method==='tools/call'?{content:[{type:'text',text:m.params.arguments.text}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    await write(path.join(cwd,'.mcp.json'),JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[mcpScript],env:{TOKEN:'SECRET_VALUE'}}}}));
    runtime=await resolveRuntime(policy,{home});
    t.ok('MCP の生の定義は会話の記録に含めない',!JSON.stringify(runtime.report).includes('SECRET_VALUE'));
    t.ok('既存登録を転送用に変換',mcpTransportConfig(runtime.servers[0],cwd).command===process.execPath);
    const bridge=createContextBridge();
    server=http.createServer(bridge.handle);await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${server.address().port}`;
    connection=await bridge.open({runtime,prompt:'',origin,isActive:()=>true});
    const request=async(method,params={},headers=connection.headers)=>{const r=await fetch(connection.url,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return {status:r.status,body:await r.json()};};
    const tools=(await request('tools/list')).body.result.tools;
    const tool=tools.find(t=>t.description.includes('[fixture / echo]'));
    t.ok('MCP に一度接続し実際の tool を公開',tool&&await fs.readFile(launches,'utf8')==='launch\n');
    t.ok('MCP ツールを呼び出し使用回数を記録',(await request('tools/call',{name:tool.name,arguments:{text:'ECHO_RESULT'}})).body.result.content[0].text==='ECHO_RESULT'&&runtime.report.entries.find(e=>e.name==='fixture').calls===1);
    t.ok('別セッションの資格情報では使えない',(await request('tools/list',{},{})).status===401);
    await connection.close();
    t.ok('ターン終了後は接続口を失効',(await request('tools/list')).status===401);
    connection=null;
    host=await startServer({dataDir:path.join(tmp,'data'),env:{AGENT_HOST_BACKENDS:'fake'}});client=await open(host);
    const none={sources:[],excludePaths:[]},kindAs=owner=>({owner,user:none,directory:none});
    const owners=async(value)=>{for(const kind of KINDS)await client.cmd('setContextSettings',{place:cwd,kind,value:typeof value==='function'?value(kind):value});};
    await owners(kindAs('ply'));
    const session=await client.cmd('newSession',{cwd,backend:'fake'});
    await client.runTurn({...session,prompt:'echo:first'});
    await owners(kindAs('native'));
    await client.runTurn({...session,prompt:'echo:second'});
    t.ok('設定変更後は既存セッションも次のターンから新しい担当に従う',(await client.cmd('sessionContext',session)).owners.mcp==='native');
    const next=await client.cmd('newSession',{cwd,backend:'fake'});await client.runTurn({...next,prompt:'echo:new'});
    t.ok('新しい会話から新しい担当に切り替わる',(await client.cmd('sessionContext',next)).owners.mcp==='native');
    client.close();await host.stop();client=null;host=null;
    host=await startServer({dataDir:path.join(tmp,'data'),env:{AGENT_HOST_BACKENDS:'fake'}});client=await open(host);
    t.ok('読み込み記録を再起動後に復元',(await client.cmd('sessionContext',session)).owners.mcp==='native');
    // 固定された会話と今のファイルの突き合わせ（会話の入口とコンテキスト画面の「変更あり」）
    await owners(kind=>kind==='instruction'?{owner:'ply',user:none,directory:{sources:['common'],excludePaths:[]}}:kindAs('native'));
    const pinned=await client.cmd('newSession',{cwd,backend:'fake'});await client.runTurn({...pinned,prompt:'echo:pinned'});
    t.ok('固定された会話の変更なしを見分ける',(await client.cmd('sessionContext',pinned)).changed?.differs===false);
    await write(path.join(cwd,'AGENTS.md'),'ROOT_SENTINEL_CHANGED');
    const moved=await client.cmd('sessionContext',pinned);
    // 会話の方針は実体パスで固定される（cwd が 8.3 短縮名の TEMP 配下でも同じ実体を指す）
    t.ok('固定後に変わったファイルを名指しする',moved.changed?.differs===true&&moved.changed.paths.includes(path.join(await fs.realpath(cwd),'AGENTS.md')),JSON.stringify(moved.changed));
    t.ok('ネイティブ読み込みの会話では突き合わせない',(await client.cmd('sessionContext',next)).changed===null);
    // Skill は本文ではなくカタログ（名前・説明）で固定する（本文は load_skill がそのつど今の内容を返す）
    await owners(kind=>kind==='skill'?{owner:'ply',user:none,directory:{sources:['common'],excludePaths:[]}}:kindAs('native'));
    const skilled=await client.cmd('newSession',{cwd,backend:'fake'});await client.runTurn({...skilled,prompt:'echo:skill'});
    t.ok('Skill を固定した会話の変更なしを見分ける',(await client.cmd('sessionContext',skilled)).changed?.differs===false);
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: example description\n---\nSKILL_BODY_EDITED');
    t.ok('Skill 本文だけの編集では変更ありにしない',(await client.cmd('sessionContext',skilled)).changed?.differs===false,JSON.stringify((await client.cmd('sessionContext',skilled)).changed));
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: example\ndescription: EDITED_DESCRIPTION\n---\nSKILL_BODY_EDITED');
    t.ok('Skill の説明が変われば変更ありにする',(await client.cmd('sessionContext',skilled)).changed?.differs===true);
    await write(path.join(cwd,'.agents/skills/example/SKILL.md'),'---\nname: RENAMED\ndescription: EDITED_DESCRIPTION\n---\nSKILL_BODY_EDITED');
    t.ok('Skill の名前が変われば変更ありにする',(await client.cmd('sessionContext',skilled)).changed?.differs===true);
    // 同じ名前の MCP が 2 つ（home の ~/.claude.json とこの場所の .mcp.json）: 止めずに 1 つを使い、どちらを使ったかを記録に残す
    const dupHome=path.join(tmp,'dup-home'),dupCwd=path.join(tmp,'dup-repo');
    await fs.mkdir(path.join(dupCwd,'.git'),{recursive:true});
    await write(path.join(dupHome,'.claude.json'),JSON.stringify({mcpServers:{dup:{command:'home-dup',args:[]}}}));
    await write(path.join(dupCwd,'.mcp.json'),JSON.stringify({mcpServers:{dup:{command:'repo-dup',args:[]}}}));
    const mcpOnly={sources:['claude'],excludePaths:[]};
    const dupPolicy=prefer=>({version:2,cwd:dupCwd,owners:{instruction:'native',skill:'native',mcp:'ply'},
      plan:{user:{roots:[],kinds:{instruction:null,skill:null,mcp:mcpOnly}},directory:{roots:[],kinds:{instruction:null,skill:null,mcp:mcpOnly}},mcp:{disabled:[],prefer}}});
    const first=await resolveRuntime(dupPolicy({}),{home:dupHome});
    const usedFirst=first.report.entries.find(e=>e.name==='dup'&&e.choice),unusedFirst=first.report.entries.find(e=>e.name==='dup'&&e.shadowedBy==='choice');
    t.ok('同じ名前の MCP は止めずに 1 つを使い、使った方に「先に見つかった方」と記録する',first.servers.filter(s=>s.name==='dup').length===1&&usedFirst?.choice.by==='first'&&usedFirst.choice.others===1&&usedFirst.choice.source==='claude',JSON.stringify(first.report.entries));
    t.ok('使わなかった定義には理由を残す',/先に見つかった方/.test(unusedFirst?.reason??'')&&unusedFirst.path!==usedFirst.path);
    const chosen=await resolveRuntime(dupPolicy({dup:unusedFirst.path}),{home:dupHome});
    const usedChosen=chosen.report.entries.find(e=>e.name==='dup'&&e.choice);
    t.ok('設定で選んだ定義を使い、「設定で選んだもの」と記録する',usedChosen?.path===unusedFirst.path&&usedChosen.choice.by==='prefer'&&/設定で選んだもの/.test(chosen.report.entries.find(e=>e.name==='dup'&&e.shadowedBy==='choice')?.reason??''));
    // 作業場所が home そのもの: ~/.claude/skills は user と directory の両方で見つかるが、同じ実体なので 1 つとして渡す
    const selfHome=path.join(tmp,'self-home');
    await write(path.join(selfHome,'.claude/skills/twice/SKILL.md'),'---\nname: twice\ndescription: found twice\n---\nTWICE_BODY');
    const skillOnly={sources:['claude'],excludePaths:[]};
    const homeRuntime=await resolveRuntime({version:2,cwd:selfHome,owners:{instruction:'native',skill:'ply',mcp:'native'},
      plan:{user:{roots:[],kinds:{instruction:null,skill:skillOnly,mcp:null}},directory:{roots:[],kinds:{instruction:null,skill:skillOnly,mcp:null}}}},{home:selfHome});
    t.ok('作業場所が home でも同じ Skill を同名の重複として止めない',homeRuntime.skills.filter(s=>s.name==='twice').length===1&&homeRuntime.report.entries.filter(e=>e.name==='twice').some(e=>e.status==='duplicate'),JSON.stringify(homeRuntime.report.entries));
    // Claude の .claude/rules。paths の無いものは開始時に渡し、paths 付きは当たるファイルを instructions_for_path で求めたときだけ返す
    t.ok('rules の glob（**・*・?・{a,b}）',[['src/**/*.{ts,tsx}','src/a/b/c.tsx',true],['src/**/*.ts','src/c.ts',true],['src/*.ts','src/a/c.ts',false],['**/*.md','a.md',true],['a?.js','ab.js',true],['apps/main/**','apps/main',true],['docs/**','src/x.ts',false]]
      .every(([g,p,want])=>matchesGlobs([g],tmp,path.join(tmp,p))===want));
    const realTmp=await fs.realpath(tmp),rulesCwd=path.join(realTmp,'rules-repo'),rulesHome=path.join(realTmp,'rules-home');
    await fs.mkdir(path.join(rulesCwd,'.git'),{recursive:true});
    await write(path.join(rulesCwd,'CLAUDE.md'),'RULES_ROOT');
    await write(path.join(rulesCwd,'.claude/rules/always.md'),'---\ndescription: no paths\n---\nALWAYS_RULE');
    await write(path.join(rulesCwd,'.claude/rules/backend/server.md'),'---\npaths:\n  - "apps/*/src/server/**/*.ts"\n---\nSERVER_RULE');
    await write(path.join(rulesCwd,'.claude/rules/docs.md'),'---\npaths: "docs/**/*.md, *.{md,txt}"\n---\nDOCS_RULE');
    await write(path.join(rulesHome,'.claude/rules/personal.md'),'PERSONAL_RULE');
    await write(path.join(rulesHome,'.claude/rules/web.md'),'---\npaths: ["**/*.css"]\n---\nUSER_CSS_RULE');
    await write(path.join(rulesCwd,'apps/main/src/server/x.ts'),'');
    await write(path.join(rulesCwd,'apps/main/src/client/y.ts'),'');
    await write(path.join(rulesCwd,'web/site.css'),'');
    const claudeOnly={sources:['claude'],excludePaths:[]};
    const rulesPolicy={version:2,cwd:rulesCwd,owners:{instruction:'ply',skill:'ply',mcp:'native'},
      plan:{user:{roots:[],kinds:{instruction:claudeOnly,skill:null,mcp:null}},directory:{roots:[],kinds:{instruction:claudeOnly,skill:null,mcp:null}},mcp:{disabled:[],prefer:{}}}};
    const ruled=await resolveRuntime(rulesPolicy,{home:rulesHome});
    const ruleTools=contextTools(ruled);
    t.ok('rules があっても診断で止めず、paths の無い rules（下位フォルダー・ユーザーを含む）を開始時に渡す',['RULES_ROOT','ALWAYS_RULE','PERSONAL_RULE'].every(s=>ruleTools.prompt.includes(s))&&!ruleTools.prompt.includes('description: no paths'));
    t.ok('paths 付きの rules は開始時に本文を渡さず、glob だけを案内する',!['SERVER_RULE','DOCS_RULE','USER_CSS_RULE'].some(s=>ruleTools.prompt.includes(s))&&ruleTools.prompt.includes('apps/*/src/server/**/*.ts')
      &&ruled.report.entries.filter(e=>e.status==='conditional').length===3,ruleTools.prompt);
    const serverText=(await ruleTools.call('instructions_for_path',{id:path.join(rulesCwd,'apps/main/src/server/x.ts')})).content[0].text;
    t.ok('下位フォルダーの paths 付き rule を当たるファイルで範囲付きで返す',serverText.includes('SERVER_RULE')&&serverText.includes('Scope: files matching apps/*/src/server/**/*.ts')&&!serverText.includes('paths:')&&!serverText.includes('DOCS_RULE'),serverText);
    t.ok('これから作るファイルでも paths 付き rule を返す',(await ruleTools.call('instructions_for_path',{id:path.join(rulesCwd,'apps/other/src/server/new/y.ts'),full:true})).content[0].text.includes('SERVER_RULE'));
    t.ok('読み足した rule は記録で loaded になる',ruled.report.entries.find(e=>e.path.endsWith('server.md'))?.status==='loaded');
    const clientText=(await ruleTools.call('instructions_for_path',{id:path.join(rulesCwd,'apps/main/src/client/y.ts')})).content[0].text;
    t.ok('当たらないファイルでは paths 付き rule を返さない',!clientText.includes('SERVER_RULE')&&!clientText.includes('USER_CSS_RULE'),clientText);
    t.ok('ユーザーの paths 付き rule は会話の作業場所から glob を見る',(await ruleTools.call('instructions_for_path',{id:path.join(rulesCwd,'web/site.css')})).content[0].text.includes('USER_CSS_RULE'));
    t.ok('文字列の paths（, 区切り・{a,b}）',(await ruleTools.call('instructions_for_path',{id:path.join(rulesCwd,'CLAUDE.md')})).content[0].text.includes('DOCS_RULE'));
    // 渡し済みの rule は繰り返さない。控えは指示欄のプロンプトに影響させない（prompt caching を外さない）
    const serverPath=path.join(rulesCwd,'apps/main/src/server/x.ts');
    const again=(await ruleTools.call('instructions_for_path',{id:serverPath})).content[0].text;
    t.ok('渡し済みの rule は本文を繰り返さず、範囲付きの短い一行で返す',!again.includes('SERVER_RULE')&&again.startsWith('Already provided in this conversation: ')&&again.includes('server.md')&&again.includes('scope: files matching apps/*/src/server/**/*.ts')&&again.includes('call again with full: true'),again);
    t.ok('rule も full: true なら本文を返す',(await ruleTools.call('instructions_for_path',{id:serverPath,full:true})).content[0].text.includes('SERVER_RULE'));
    const subAgain=(await helpers.call('instructions_for_path',{id:path.join(cwd,'sub')})).content[0].text;
    t.ok('子階層の指示も渡し済みなら短い一行',!subAgain.includes('SCOPED_SENTINEL')&&subAgain.startsWith('Already provided in this conversation: '),subAgain);
    const carried=await resolveRuntime(rulesPolicy,{home:rulesHome}),fresh=await resolveRuntime(rulesPolicy,{home:rulesHome});
    carried.delivered={...ruled.delivered};
    t.ok('渡し済みの控えがあっても指示欄のプロンプトは同じ（ツールの返りだけが変わる）',Object.keys(carried.delivered).length>0&&contextTools(carried).prompt===contextTools(fresh).prompt&&contextTools(ruled).prompt===ruleTools.prompt);
    t.ok('持ち越した控えで、次のターンの最初の呼び出しから短い一行',(await contextTools(carried).call('instructions_for_path',{id:serverPath})).content[0].text.startsWith('Already provided'));
    await write(path.join(rulesCwd,'.claude/rules/backend/server.md'),'---\npaths:\n  - "apps/*/src/server/**/*.ts"\n---\nSERVER_RULE_V2');
    const changedRule=(await ruleTools.call('instructions_for_path',{id:serverPath})).content[0].text;
    t.ok('渡した後に変わった rule は本文を渡し直し、変わったと添える',changedRule.includes('SERVER_RULE_V2')&&/changed since it was last provided/.test(changedRule),changedRule);
    t.ok('渡し直した後はまた短い一行',!(await ruleTools.call('instructions_for_path',{id:serverPath})).content[0].text.includes('SERVER_RULE_V2'));
    t.ok('渡し済みの rule を頼み直しても記録は loaded のまま',ruled.report.entries.find(e=>e.path.endsWith('server.md'))?.status==='loaded');
    await write(path.join(rulesCwd,'.claude/rules/broken.md'),'---\npaths: 3\n---\nBROKEN');
    await rejects('解釈できない paths は診断にする',()=>resolveRuntime(rulesPolicy,{home:rulesHome}));
  }finally{client?.close();await host?.stop();await connection?.close();if(server)await new Promise(r=>server.close(r));if(!containsPath(os.tmpdir(),tmp))throw new Error('bad test path');await fs.rm(tmp,{recursive:true,maxRetries:5,retryDelay:100});}
}
