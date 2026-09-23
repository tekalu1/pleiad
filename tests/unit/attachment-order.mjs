import { buildItems, attachmentMessageIndex } from "../../web/timeline.mjs";

export const name = "attachment-order";
export const title = "添付画像が送信元の発言の直後に残る";
const at = "2026-09-11T12:58:51.000Z";
const path = "C:\\Temp\\uploads\\image.png";
const user = {role:"user", text:`確認してください\n\n[添付] ${path}`, at};
const image = {by:"human", path, at:"2026-09-11T12:58:51.619Z"};
const order = items => items.map(i=>i.kind === "msg" ? i.m.text : `image:${i.pi}`).join("|");

export default async function(t) {
  const messages=[user,{role:"assistant",text:"調査中",at},{role:"assistant",text:"完了",at}];
  t.ok("同じ開始時刻のCodex回答より前", order(buildItems(messages,[image])) === `${user.text}|image:0|調査中|完了`);
  messages.push({role:"user",text:"続けて",at:"2026-09-11T13:10:00Z"},{role:"assistant",text:"次の回答",at:"2026-09-11T13:10:00Z"});
  const items=buildItems(messages,[image]);
  t.ok("会話が伸びても添付は元の発言に固定", items[1].kind === "present" && items[1].anchorMi===0);
  t.ok("時刻なしの履歴でも位置を保持",buildItems(messages.map(m=>({...m,at:null})),[{...image,at:null}])[1].kind === "present");
  const more=buildItems(messages,[image,{...image,path:path.replace("image.png","second.png") }]);
  t.ok("一致しないファイルを別発言へ誤配置しない",more.find(i=>i.pi===1)?.anchorMi===-1);
  const multi={...user,text:user.text+`\n[添付] C:/Temp/uploads/second.png`};
  t.ok("複数添付の順番",order(buildItems([multi,messages[1]],[image,{...image,path:"C:/Temp/uploads/second.png"}])).endsWith("image:0|image:1|調査中"));
  t.ok("Windowsパスの区切り・大小文字を吸収",attachmentMessageIndex([user],{...image,path:"c:/temp/uploads/image.png"})===0);
  const reused=[user,{...user,at:"2026-09-11T14:00:00Z"}];
  t.ok("同じ画像を再送した時は送信時刻で区別",attachmentMessageIndex(reused,{...image,at:"2026-09-11T14:00:00.010Z"})===1);
  t.ok("ライブの時刻なしイベントは直近の送信に対応",attachmentMessageIndex(reused,{...image,at:null})===1);
  t.ok("発言IDは時刻のない同じ添付の再送を区別", attachmentMessageIndex(
    reused.map((m,i)=>({...m,uuid:`u${i}`,at:null})), {...image,at:null,messageId:"u0"})===0);
  t.ok("AIの提示順は変更しない",buildItems([user,messages[1]],[{...image,by:"ai"}]).at(-1).kind === "present");
  const mixed=buildItems(messages,[{by:"ai"},image]);
  t.ok("時刻ありなしの混在でもpresentのキーを保持",mixed[1].pi===1 && mixed.at(-1).pi===0);
  t.ok("分岐の差分描画に元メッセージの添字を渡す",items[1].anchorMi===0 && items.filter(i=>i.mi!=null).map(i=>i.mi).join() === "0,1,2,3,4");
}
