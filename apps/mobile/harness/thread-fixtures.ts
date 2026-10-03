/** Contract-shaped synthetic threads. Never imported by production; no inference or server writes. */
import type { ApiClient } from '../src/auth/contracts.ts';
import type { MemberScope } from '../src/account/members.ts';
import { createWebCalls } from '../src/account/web-calls.ts';
import { historyClient } from './history-fixtures.ts';
export const tid='00000000-0000-4000-8000-000000000011',tagId='00000000-0000-4000-8000-000000000012';
const author='00000000-0000-4000-8000-000000000099';
export function threadFixture(){
 const messages=Array.from({length:65},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+100).padStart(12,'0')}`,threadId:tid,kind:'message',seq:i+1,changeSeq:i+1,authorId:author,authorName:'Pat Crew',body:`Message ${i+1}: check the packaging plan.`,createdAt:'2026-10-01T02:00:00.000Z',editedAt:null,deletedAt:null,deletedBy:null,revision:1}));
 const tags=[{id:tagId,name:'Summer lager'}];
 const detail={thread:{id:tid,kind:'topic',title:'Packaging plan',revision:1,lastSeq:65,lastChange:65,readPosition:3,unread:51,starred:false,createdAt:'2026-10-01T01:00:00.000Z'},card:{record:null,title:'Packaging plan',status:null,facts:['Pat Crew',''],fold:{createdBy:author,open:null}},tags,pin:null};
 const row={id:tid,kind:'topic',title:'Packaging plan',record:null,facts:['Pat Crew',''],status:null,lastMessageAt:'2026-10-01T02:00:00.000Z',lastMessage:{authorName:'Pat Crew',excerpt:'Check the packaging plan.'},unread:51,needsYou:true,starred:false,tags};
 return {messages,detail,list:{filter:'all',available:true,threads:[row],nextCursor:null,groups:[{key:tagId,label:'Summer lager',threads:1,needsYou:1}]}};
}
/** R3 V-D record threads (design boards 1, 2 and 4): a task with change lines and steps, a booking, a stock item. */
const maya='00000000-0000-4000-8000-000000000041',tom='00000000-0000-4000-8000-000000000042',taskId='00000000-0000-4000-8000-000000000043',stepId='00000000-0000-4000-8000-000000000044',bookingId='00000000-0000-4000-8000-000000000045',tankId='00000000-0000-4000-8000-000000000046',itemId='00000000-0000-4000-8000-000000000047',productionTag='00000000-0000-4000-8000-000000000048';
const at='2026-10-01T06:40:00.000Z';
const line=(n:number,actor:string,name:string,changes:unknown[],createdAt=at)=>({id:`00000000-0000-4000-8000-${String(500+n).padStart(12,'0')}`,threadId:tid,kind:'change',seq:n,changeSeq:n,authorId:actor,authorName:name,body:null,createdAt,editedAt:null,deletedAt:null,deletedBy:null,revision:1,changeSetId:`00000000-0000-4000-8000-${String(600+n).padStart(12,'0')}`,change:{actorKind:'person',actorId:actor,actorName:name,causeKind:'request',createdAt,changes,truncated:false}});
const said=(n:number,actor:string,name:string,body:string,createdAt:string)=>({id:`00000000-0000-4000-8000-${String(500+n).padStart(12,'0')}`,threadId:tid,kind:'message',seq:n,changeSeq:n,authorId:actor,authorName:name,body,createdAt,editedAt:null,deletedAt:null,deletedBy:null,revision:1});
const change=(n:number,c:Record<string,unknown>)=>({id:`00000000-0000-4000-8000-${String(700+n).padStart(12,'0')}`,recordKind:'task',recordId:taskId,operation:'update',field:null,itemKind:null,itemId:null,before:null,after:null,...c});
const taskRow=(extra:Record<string,unknown>={})=>({id:taskId,parentId:null,title:'Package summer lager',body:'',status:'in_progress',ownerId:tom,ownerName:'Tom Reilly',due:'2026-10-08',sourceKind:'person',sourceId:maya,seriesId:null,periodStart:null,periodEnd:null,evidenceRequired:false,completedBy:null,completedAt:null,revision:4,createdAt:at,updatedAt:at,evidenceCount:0,evidence:[],...extra});
export function recordFixture(kind:'task'|'booking'|'stock',variant=''){
 const tags=[{id:tagId,name:'Summer lager'},{id:productionTag,name:'Production'}];
 const thread={id:tid,kind:'record',title:'Package summer lager',revision:2,lastSeq:6,lastChange:6,readPosition:3,unread:3,starred:false,createdAt:at};
 const messages=[said(1,tom,'Tom Reilly','Labels are delayed. The printer says Wednesday now, not Monday.','2026-10-01T03:58:00.000Z'),
  line(2,maya,'Maya Chen',[change(1,{field:'due',before:'2026-10-06',after:'2026-10-08'}),change(2,{operation:'attach',itemKind:'tag',itemId:productionTag,after:{threadId:tid,tagId:productionTag}})]),
  said(3,maya,'Maya Chen','Moved it to Thursday so the labels are here first.','2026-10-01T06:41:00.000Z'),
  line(4,tom,'Tom Reilly',[change(3,{field:'ownerId',before:maya,after:tom})],'2026-10-01T23:12:00.000Z'),
  said(5,tom,'Tom Reilly','I’ll take this one from here. Maya has the launch to run.','2026-10-01T23:13:00.000Z'),
  line(6,tom,'Tom Reilly',[change(4,{itemKind:'step',itemId:stepId,field:'status',before:'open',after:'done'})],'2026-10-01T23:20:00.000Z')];
 if(kind==='booking'){
  const cancelled=variant==='cancelled';
  return {messages:[said(1,tom,'Tom Reilly','Thursday morning works for the crew.','2026-10-01T04:14:00.000Z')],tags:[tags[0]!],
   detail:{thread:{...thread,title:'Summer lager canning run',lastSeq:1,lastChange:1,readPosition:1,unread:0},card:{record:{kind:'booking',id:bookingId},title:'Summer lager canning run',status:cancelled?'cancelled':'confirmed',facts:['Canning line','2026-10-07T21:00:00Z'],fold:{equipmentId:tankId,equipmentName:'Canning line',kind:'booking',status:cancelled?'cancelled':'confirmed',startsAt:'2026-10-07T21:00:00.000Z',endsAt:'2026-10-08T01:00:00.000Z',setupMinutes:30,cleanupMinutes:30,taskId:null,ownerId:null,ownerName:null,open:{kind:'equipment',equipmentId:tankId}}},tags:[tags[0]!],pin:null},
   booking:{id:bookingId,equipmentId:tankId,title:'Summer lager canning run',kind:'booking',status:cancelled?'cancelled':'confirmed',startsAt:'2026-10-07T21:00:00.000Z',endsAt:'2026-10-08T01:00:00.000Z',setupMinutes:30,cleanupMinutes:30,occupiedStartsAt:'2026-10-07T20:30:00.000Z',occupiedEndsAt:'2026-10-08T01:30:00.000Z',taskId:null,ownerId:null,createdBy:maya,revision:2,createdAt:at,updatedAt:at,tagIds:[tagId]}};
 }
 if(kind==='stock'){
  const archived=variant==='archived';
  return {messages:[said(1,tom,'Tom Reilly','Counted the back shelf too.','2026-10-01T04:14:00.000Z')],tags:[tags[0]!],
   detail:{thread:{...thread,title:'Cascade hops',lastSeq:1,lastChange:1,readPosition:1,unread:0},card:{record:{kind:'stock',id:itemId},title:'Cascade hops',status:archived?'archived':'counted',facts:['4.5 kg','2026-10-01T04:10:00Z'],fold:{location:'Cold store',unitLabel:'kg',currentCount:'4.5',countedAt:'2026-10-01T04:10:00.000Z',reorderPoint:'2',notes:'',archivedAt:archived?at:null,open:null}},tags:[tags[0]!],pin:null}};
 }
 // Runs of change lines (owner decision, 3 October 2026): a run of three across two days by Maya and Tom, a message, a
 // run of two, a message. `runs` has read everything; `unread` has read only the run's first line, so the first unread
 // is inside the run. `created` is the system's creation of a series occurrence (quiet), then Tom's message.
 if(variant==='runs'||variant==='unread'){
  const run=[said(1,tom,'Tom Reilly','Labels are delayed. The printer says Wednesday now, not Monday.','2026-10-01T03:58:00.000Z'),
   line(2,maya,'Maya Chen',[change(11,{field:'due',before:'2026-10-06',after:'2026-10-08'})],'2026-10-01T06:40:00.000Z'),
   line(3,tom,'Tom Reilly',[change(12,{field:'ownerId',before:maya,after:tom})],'2026-10-01T23:12:00.000Z'),
   line(4,maya,'Maya Chen',[change(13,{itemKind:'step',itemId:stepId,field:'status',before:'open',after:'done'})],'2026-10-01T23:20:00.000Z'),
   said(5,maya,'Maya Chen','Thursday it is.','2026-10-01T23:30:00.000Z'),
   line(6,tom,'Tom Reilly',[change(14,{field:'title',before:'Pack summer lager',after:'Package summer lager'})],'2026-10-01T23:40:00.000Z'),
   line(7,tom,'Tom Reilly',[change(15,{field:'status',before:'open',after:'in_progress'})],'2026-10-01T23:41:00.000Z'),
   said(8,tom,'Tom Reilly','Starting now.','2026-10-01T23:45:00.000Z')];
  const readPosition=variant==='unread'?2:8;
  return {messages:run,tags,detail:{thread:{...thread,lastSeq:8,lastChange:8,readPosition,unread:variant==='unread'?4:0},card:{record:{kind:'task',id:taskId},title:'Package summer lager',status:'in_progress',facts:['Tom Reilly','2026-10-08'],fold:{body:'',status:'in_progress',ownerId:tom,ownerName:'Tom Reilly',due:'2026-10-08',evidenceRequired:false,seriesId:null,open:null}},tags,pin:null},
   task:{task:taskRow(),parent:null,series:null,checklist:{tasks:[taskRow({id:stepId,parentId:taskId,title:'Book the canning line',status:'done',ownerId:null,ownerName:null,due:null,revision:2})],nextOffset:null},evidenceNextOffset:null,tags:{items:[],nextOffset:null},today:'2026-10-02',timezone:'Australia/Sydney'}};
 }
 if(variant==='created'){
  const made=line(1,maya,'',[change(16,{operation:'create',after:{id:taskId,title:'Excise return October',status:'open'}}),change(17,{operation:'attach',itemKind:'tag',itemId:productionTag,after:{threadId:tid,tagId:productionTag}})],'2026-10-01T00:00:00.000Z');
  const created={...made,authorId:null,authorName:null,change:{...made.change,actorKind:'system',actorId:null,actorName:null,causeKind:'routine'}};
  const messages=[created,said(2,tom,'Tom Reilly','I’ll file this one.','2026-10-01T04:00:00.000Z')];
  return {messages,tags,detail:{thread:{...thread,title:'Excise return October',lastSeq:2,lastChange:2,readPosition:0,unread:1},card:{record:{kind:'task',id:taskId},title:'Excise return October',status:'open',facts:['No owner','2026-10-21'],fold:{body:'',status:'open',ownerId:null,ownerName:null,due:'2026-10-21',evidenceRequired:false,seriesId:null,open:null}},tags,pin:null},
   task:{task:taskRow({title:'Excise return October',status:'open',ownerId:null,ownerName:null,due:'2026-10-21',revision:1}),parent:null,series:null,checklist:{tasks:[],nextOffset:null},evidenceNextOffset:null,tags:{items:[],nextOffset:null},today:'2026-10-02',timezone:'Australia/Sydney'}};
 }
 return {messages,tags,detail:{thread,card:{record:{kind:'task',id:taskId},title:'Package summer lager',status:'in_progress',facts:['Tom Reilly','2026-10-08'],fold:{body:'',status:'in_progress',ownerId:tom,ownerName:'Tom Reilly',due:'2026-10-08',evidenceRequired:false,seriesId:null,open:null}},tags,pin:null},
  task:{task:taskRow(),parent:null,series:null,checklist:{tasks:[taskRow({id:stepId,parentId:taskId,title:'Book the canning line',status:'done',ownerId:null,ownerName:null,due:null,revision:2}),taskRow({id:'00000000-0000-4000-8000-000000000049',parentId:taskId,title:'Order pallet wrap',status:'open',ownerId:null,ownerName:null,due:null,revision:1}),taskRow({id:'00000000-0000-4000-8000-000000000050',parentId:taskId,title:'Check label stock',status:'open',ownerId:null,ownerName:null,due:null,revision:1})],nextOffset:null},evidenceNextOffset:null,tags:{items:[],nextOffset:null},today:'2026-10-02',timezone:'Australia/Sydney'}};
}
export const recordMembers=[{userId:maya,name:'Maya Chen',email:'maya@example.test',role:'member',status:'active',since:at},{userId:tom,name:'Tom Reilly',email:'tom@example.test',role:'member',status:'active',since:at},{userId:'00000000-0000-4000-8000-000000000051',name:'Jess Park',email:'jess@example.test',role:'member',status:'active',since:at}];
export function threadHarness(scenario:string,scope:()=>MemberScope|null){
 if(scenario.startsWith('threads-history'))return createWebCalls(historyClient(scenario,scope),'https://harness.invalid',{memberScope:scope,accountEpoch:()=>scope()?.epoch??null,accepted(){},sessionEnded(){}});
 const f=threadFixture();
 const kind=scenario.startsWith('threads-card-booking')?'booking':scenario.startsWith('threads-card-stock')?'stock':scenario.startsWith('threads-card-task')||scenario==='threads-lines'||scenario.startsWith('threads-runs')||scenario==='threads-system-created'?'task':null;
 const r=kind?recordFixture(kind,scenario.split('-').at(-1)):null;
 const client:ApiClient={
  async get(path,_token,parse){
   if(r){
    const u=new URL(path,'https://harness.invalid');let value:unknown;
    if(scenario==='threads-card-task-failed'&&u.pathname.includes('/tasks/'))return {ok:false,kind:'unavailable',status:503};
    if(u.pathname.endsWith('/members'))value={members:recordMembers};
    else if(u.pathname.endsWith('/tags'))value={tags:r.tags.map(t=>({...t,createdAt:at,updatedAt:at,ownerId:null,startsOn:null,endsOn:null,createdBy:null,revision:1,archivedAt:null})),nextOffset:null};
    else if(u.pathname.includes('/tasks/'))value=(r as {task:unknown}).task;
    else if(u.pathname.endsWith('/reservations'))value={reservations:[],nextOffset:null,coverage:'complete',from:u.searchParams.get('from'),to:u.searchParams.get('to'),timezone:'Australia/Sydney'};
    else if(u.pathname.includes('/reservations/'))value=(r as {booking:unknown}).booking;
    else if(/\/organisations\/[^/]+$/.test(u.pathname))value={id:scope()?.organisationId,name:'Harbour Brewing',timezone:'Australia/Sydney',locale:'en-AU',createdAt:at,role:'owner'};
    else if(u.pathname.endsWith('/messages'))value={thread:{id:tid,revision:2,lastSeq:r.detail.thread.lastSeq,lastChange:r.detail.thread.lastChange},messages:r.messages,hasMore:false};
    else if(u.pathname.endsWith('/changes'))value={thread:{id:tid,revision:2,lastSeq:r.detail.thread.lastSeq,highWater:r.detail.thread.lastChange},changes:[],next:r.detail.thread.lastChange,complete:true};
    else value=r.detail;
    return {ok:true,value:parse(value)};
   }
   if(scenario==='threads-failed'||scenario==='threads-new-failed')return {ok:false,kind:'unavailable',status:503};
   if(scenario==='threads-lost')return {ok:false,kind:'refused',status:404,code:'not_found'};
   if(scenario==='threads-wait'||scenario==='threads-new-wait')return {ok:false,kind:'unavailable',status:429,retryAfter:30};
   const u=new URL(path,'https://harness.invalid');let value:unknown;
   if(u.pathname.endsWith('/members'))value={members:scenario==='threads-new-empty'?[]:[{userId:author,name:'Pat Crew',email:'pat@example.test',role:'member',status:'active',since:'2026-10-01T00:00:00.000Z'}]};
   else if(u.pathname.endsWith('/tags'))value={tags:[{id:tagId,name:'Summer lager',createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',ownerId:null,startsOn:null,endsOn:null,createdBy:null,revision:1,archivedAt:null}],nextOffset:null};
   else if(u.pathname.endsWith('/messages')){const before=Number(u.searchParams.get('before')??Infinity),after=Number(u.searchParams.get('after')??0),latest=u.searchParams.has('latest'),rows=latest?f.messages.slice(-50):f.messages.filter(m=>m.seq>after&&m.seq<before).slice(0,50);value={thread:{id:tid,revision:1,lastSeq:65,lastChange:65},messages:rows,hasMore:true};}
   else if(u.pathname.endsWith('/changes'))value={thread:{id:tid,revision:1,lastSeq:65,highWater:65},changes:[],next:65,complete:true};
   else if(u.pathname.endsWith('/'+tid))value=f.detail;
   else value={...f.list,filter:u.searchParams.get('filter')??'all',...(scenario==='threads-empty'?{threads:[],groups:[]}:{}),available:scenario!=='threads-unavailable'};
   return {ok:true,value:parse(value)};
  },
  async post(path,_token,body,parse){if(scenario==='threads-new-pending')return new Promise(()=>{});if(scenario==='threads-new-refused')return {ok:false,kind:'refused',status:409,code:'thread_id_unavailable'};if(path.endsWith('/read'))return {ok:true,value:parse({readPosition:(body as {seq:number}).seq,unread:0})};return {ok:false,kind:'unavailable',status:503};},
  async patch(){return {ok:false,kind:'unavailable',status:503};},async delete(){return {ok:false,kind:'unavailable',status:503};}
 };
 return createWebCalls(client,'https://harness.invalid',{memberScope:scope,accountEpoch:()=>scope()?.epoch??null,accepted(){},sessionEnded(){}});
}
