import assert from 'node:assert/strict';
import vm from 'node:vm';
import { LINK_BRIDGE, visualizationDocument } from '../../web/visualize-document.mjs';
import { handlePreviewLinkMessage, openExternalLink, configureLinkOpen } from '../../web/link-open.mjs';

export const name = 'preview-links';
export const title = '隔離したプレビューのリンクを親で確認して開く';

export default function(t) {
  const sent=[]; const handlers={};
  const location={hash:''};
  const child={
    URL, location, window:{}, parent:{postMessage:data=>sent.push(data)},
    document:{addEventListener:(name,fn)=>{handlers[name]=fn;}},
  };
  vm.runInNewContext(LINK_BRIDGE.replace(/^<script>|<\/script>$/g,''),child);
  const anchor=(href,target='')=>({getAttribute:()=>href,target});
  const dispatch=(href,target='',{ctrlKey=false,type='click',button=0}={})=>{
    let stopped=false;
    handlers[type]({target:{closest:()=>anchor(href,target)},ctrlKey,metaKey:false,button,preventDefault(){stopped=true;}});
    return stopped;
  };
  assert(dispatch('https://example.com/page','_blank'));
  assert.equal(sent.length,1);
  assert.equal(sent[0].url,'https://example.com/page');
  assert.equal(sent[0].newWindow,true);
  assert(dispatch('https://example.com/self','_self'));
  assert.equal(sent[1].newWindow,false);
  assert(dispatch('#section','_blank'));
  assert.equal(location.hash,'#section');
  assert.equal(sent.length,2);
  assert(dispatch('javascript:alert(1)'));
  assert.equal(sent.length,2);
  child.window.open('http://example.com/','_blank');
  assert.equal(sent[2].url,'http://example.com/');
  assert.equal(sent[2].external,false);
  assert.equal(sent[0].external,false,'ふつうのクリックは開き先の設定に従う');
  assert(dispatch('https://example.com/ctrl','',{ctrlKey:true}));
  assert.equal(sent[3].external,true,'Ctrl/⌘+クリックは既定のブラウザー');
  assert(dispatch('https://example.com/middle','',{type:'auxclick',button:1}));
  assert.equal(sent[4].external,true,'中クリックは既定のブラウザー');
  assert(!dispatch('https://example.com/right','',{type:'auxclick',button:2}));
  assert.equal(sent.length,5,'右クリックは拾わない');
  assert(!visualizationDocument('x',{resize:false}).includes('ply-preview-open-link'));
  t.ok('リンクと window.open を通知し、同一ページのアンカーは枠内で動かす',true);

  const originalDocument=globalThis.document;
  const trusted={}, forged={}, opened=[];
  const frame={contentWindow:trusted};
  globalThis.document={
    querySelectorAll:()=>[frame],
    createElement:()=>({click(){opened.push({href:this.href,target:this.target,rel:this.rel});},remove(){}}),
    body:{append(){}},
  };
  try {
    const message=(source,url)=>({source,data:{type:'ply-preview-open-link',url,newWindow:true}});
    assert.equal(handlePreviewLinkMessage(message(forged,'https://example.com/')),false);
    assert.equal(handlePreviewLinkMessage(message(trusted,'javascript:alert(1)')),false);
    assert.equal(handlePreviewLinkMessage(message(trusted,'https://user:pass@example.com/')),false);
    assert.equal(opened.length,0);
    assert.equal(handlePreviewLinkMessage(message(trusted,'https://example.com/')),true);
    assert.deepEqual(opened,[{href:'https://example.com/',target:'_blank',rel:'noopener noreferrer nofollow'}]);
    assert.equal(handlePreviewLinkMessage(message(trusted,'http://example.com/')),true);
    assert.equal(opened.length,2);
  } finally { globalThis.document=originalDocument; }
  t.ok('親は現在の枠の WindowProxy と URL を確認し、偽の送り元を無視する',true);

  // デスクトップのホストの画面: 既定のブラウザーへは殻の口で渡す（窓の setWindowOpenHandler は https しか通さない）
  const originalWindow=globalThis.window;
  const commands=[];
  globalThis.window={plyDesktop:{browser:{command:(action,args)=>{commands.push([action,args]);return Promise.resolve({ok:true});}}}};
  try {
    configureLinkOpen({getPrefs:()=>({linkOpen:'external'})});
    assert.equal(openExternalLink('http://localhost:5173/x'),true);
    assert.equal(openExternalLink('https://example.com/',{external:true}),true);
    assert.deepEqual(commands,[['openExternal',{url:'http://localhost:5173/x'}],['openExternal',{url:'https://example.com/'}]]);
    assert.equal(openExternalLink('file:///C:/a.html'),false);
    assert.equal(commands.length,2);
  } finally { globalThis.window=originalWindow; configureLinkOpen({getPrefs:()=>({})}); }
  t.ok('デスクトップでは既定のブラウザーを殻の口で開き、http の localhost も渡せる',true);
}
