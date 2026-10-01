/** Contract-shaped synthetic threads. Never imported by production; no inference or server writes. */
import type { ApiClient } from '../src/auth/contracts.ts';
import type { MemberScope } from '../src/account/members.ts';
import { createWebCalls } from '../src/account/web-calls.ts';
export const tid='00000000-0000-4000-8000-000000000011',tagId='00000000-0000-4000-8000-000000000012';
const author='00000000-0000-4000-8000-000000000099';
export function threadFixture(){
 const messages=Array.from({length:65},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+100).padStart(12,'0')}`,threadId:tid,kind:'message',seq:i+1,changeSeq:i+1,authorId:author,authorName:'Pat Crew',body:`Message ${i+1}: check the packaging plan.`,createdAt:'2026-10-01T02:00:00.000Z',editedAt:null,deletedAt:null,deletedBy:null,revision:1}));
 const tags=[{id:tagId,name:'Summer lager'}];
 const detail={thread:{id:tid,kind:'topic',title:'Packaging plan',revision:1,lastSeq:65,lastChange:65,readPosition:3,unread:51,starred:false,createdAt:'2026-10-01T01:00:00.000Z'},card:{record:null,title:'Packaging plan',status:null,facts:['Pat Crew',''],fold:{createdBy:author,open:null}},tags,pin:null};
 const row={id:tid,kind:'topic',title:'Packaging plan',record:null,facts:['Pat Crew',''],status:null,lastMessageAt:'2026-10-01T02:00:00.000Z',lastMessage:{authorName:'Pat Crew',excerpt:'Check the packaging plan.'},unread:51,needsYou:true,starred:false,tags};
 return {messages,detail,list:{filter:'all',available:true,threads:[row],nextCursor:null,groups:[{key:tagId,label:'Summer lager',threads:1,needsYou:1}]}};
}
export function threadHarness(scenario:string,scope:()=>MemberScope|null){
 const f=threadFixture();const client:ApiClient={
  async get(path,_token,parse){
   if(scenario==='threads-failed')return {ok:false,kind:'unavailable',status:503};
   if(scenario==='threads-lost')return {ok:false,kind:'refused',status:404,code:'not_found'};
   if(scenario==='threads-wait')return {ok:false,kind:'unavailable',status:429,retryAfter:30};
   const u=new URL(path,'https://harness.invalid');let value:unknown;
   if(u.pathname.endsWith('/messages')){const before=Number(u.searchParams.get('before')??Infinity),after=Number(u.searchParams.get('after')??0),latest=u.searchParams.has('latest'),rows=latest?f.messages.slice(-50):f.messages.filter(m=>m.seq>after&&m.seq<before).slice(0,50);value={thread:{id:tid,revision:1,lastSeq:65,lastChange:65},messages:rows,hasMore:true};}
   else if(u.pathname.endsWith('/changes'))value={thread:{id:tid,revision:1,lastSeq:65,highWater:65},changes:[],next:65,complete:true};
   else if(u.pathname.endsWith('/'+tid))value=f.detail;
   else value={...f.list,filter:u.searchParams.get('filter')??'all',...(scenario==='threads-empty'?{threads:[],groups:[]}:{}),available:scenario!=='threads-unavailable'};
   return {ok:true,value:parse(value)};
  },
  async post(path,_token,body,parse){if(path.endsWith('/read'))return {ok:true,value:parse({readPosition:(body as {seq:number}).seq,unread:0})};return {ok:false,kind:'unavailable',status:503};},
  async patch(){return {ok:false,kind:'unavailable',status:503};},async delete(){return {ok:false,kind:'unavailable',status:503};}
 };
 return createWebCalls(client,'https://harness.invalid',{memberScope:scope,accountEpoch:()=>scope()?.epoch??null,accepted(){},sessionEnded(){}});
}
