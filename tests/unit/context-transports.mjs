import http from 'node:http';
import { createContextBridge } from '../../core/context-bridge.mjs';

export const name = 'context-transports';
export const title = 'HTTP・SSE の MCP 中継と resources / prompts';
export default async function(t) {
  const result = m => {
    switch (m.method) {
      case 'initialize': return { protocolVersion:'2025-06-18',capabilities:{tools:{},resources:{},prompts:{}},serverInfo:{name:'fixture',version:'1'} };
      case 'tools/list': return {tools:[{name:'echo',inputSchema:{type:'object'}}]};
      case 'tools/call': return {content:[{type:'text',text:'TOOL_OK'}]};
      case 'resources/list': return {resources:[{name:'guide',uri:'fixture://guide'}]};
      case 'resources/read': return {contents:[{uri:m.params.uri,text:'RESOURCE_OK'}]};
      case 'prompts/list': return {prompts:[{name:'review'}]};
      case 'prompts/get': return {messages:[{role:'user',content:{type:'text',text:'PROMPT_OK '+m.params.arguments.topic}}]};
      default: return {};
    }
  };
  let stream, connection;
  const upstream = http.createServer(async(req,res) => {
    if(req.headers.authorization!=='Bearer fixture'){res.writeHead(401);res.end();return;}
    if(req.method==='GET'&&req.url==='/sse'){
      stream=res;res.writeHead(200,{'content-type':'text/event-stream'});res.write('event: endpoint\ndata: /messages\n\n');return;
    }
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    let body='';for await(const c of req)body+=c;
    const m=JSON.parse(body);
    if(m.id===undefined){res.writeHead(202);res.end();return;}
    const response=JSON.stringify({jsonrpc:'2.0',id:m.id,result:result(m)});
    if(req.url==='/messages'){stream.write(`event: message\ndata: ${response}\n\n`);res.writeHead(202);res.end();}
    else {res.writeHead(200,{'content-type':'application/json'});res.end(response);}
  });
  const bridge=createContextBridge(),host=http.createServer(bridge.handle);
  try {
    await new Promise(r=>upstream.listen(0,'127.0.0.1',r));await new Promise(r=>host.listen(0,'127.0.0.1',r));
    const origin=`http://127.0.0.1:${host.address().port}`;
    for(const type of ['http','sse']){
      const item={id:'a123',name:'fixture',origins:[{source:'claude'}],definition:{type,url:`http://127.0.0.1:${upstream.address().port}/${type}`,headers:{Authorization:'Bearer fixture'}}};
      const runtime={owners:{mcp:'ply'},policy:{cwd:process.cwd()},prompt:'',skills:[],servers:[item],report:{entries:[{id:item.id}]}};
      let allowed=true;
      connection=await bridge.open({runtime,prompt:'',origin,isActive:()=>true,authorize:async()=>allowed});
      const request=async(method,params={})=>(await(await fetch(connection.url,{method:'POST',headers:{...connection.headers,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json()).result;
      const tool=(await request('tools/list')).tools.find(t=>t.name.startsWith('m_'));
      t.ok(`${type}: 認証ヘッダーを渡してツールを呼べる`,(await request('tools/call',{name:tool.name})).content[0].text==='TOOL_OK');
      const resource=(await request('resources/list')).resources[0];
      t.ok(`${type}: 名前空間付き resource を読み込める`,(await request('resources/read',{uri:resource.uri})).contents[0].text==='RESOURCE_OK');
      const prompt=(await request('prompts/list')).prompts[0];
      t.ok(`${type}: prompt に引数を渡せる`,(await request('prompts/get',{name:prompt.name,arguments:{topic:'topic'}})).messages[0].content.text==='PROMPT_OK topic');
      t.ok(`${type}: tools のみの利用者も metadata を取得できる`,(await request('tools/call',{name:'mcp_resources',arguments:{uri:resource.uri}})).content[0].text.includes('RESOURCE_OK'));
      allowed=false;
      t.ok(`${type}: 承認拒否なら外部ツールを呼ばない`,(await request('tools/call',{name:tool.name})).isError&&runtime.report.entries[0].calls===1);
      await connection.close();connection=null;
    }
  } finally {
    await connection?.close();stream?.end();host.closeAllConnections();upstream.closeAllConnections();
    await Promise.all([new Promise(r=>host.close(r)),new Promise(r=>upstream.close(r))]);
  }
}
