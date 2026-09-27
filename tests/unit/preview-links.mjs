import assert from 'node:assert/strict';
import vm from 'node:vm';
import { LINK_BRIDGE, visualizationDocument } from '../../web/visualize-document.mjs';
import { handlePreviewLinkMessage } from '../../web/link-open.mjs';

export const name = 'preview-links';
export const title = '隔離したプレビューのリンクを親で確認して開く';

export default function(t) {
  const sent=[]; let click;
  const location={hash:''};
  const child={
    URL, location, window:{}, parent:{postMessage:data=>sent.push(data)},
    document:{addEventListener:(_name,fn)=>{click=fn;}},
  };
  vm.runInNewContext(LINK_BRIDGE.replace(/^<script>|<\/script>$/g,''),child);
  const anchor=(href,target='')=>({getAttribute:()=>href,target});
  const dispatch=(href,target='')=>{
    let stopped=false;
    click({target:{closest:()=>anchor(href,target)},ctrlKey:false,metaKey:false,preventDefault(){stopped=true;}});
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
}
