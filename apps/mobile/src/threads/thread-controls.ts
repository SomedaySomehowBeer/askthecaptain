import type { ReadScope } from '../account/contracts.ts';
import type { Mutation, ThreadCalls } from './api.ts';
import type { Detail, Message } from './contracts.ts';
import { copy } from './copy.ts';
import { firstUnread, hasGap, initialMessages, mergeMessages } from './derive.ts';
export type ThreadState={phase:'idle'|'loading'|'ready'|'failed'|'lost';detail:Detail|null;messages:Message[];busy:boolean;message:string;waitUntil:number;cursor:number;complete:boolean;firstUnreadSeq:number|null;jumpSeq:number|null;readPosition:number;needsRefresh:boolean};
export function createThreadControls(calls:ThreadCalls,scope:ReadScope,id:string,now:()=>number,onMessages:(m:Message[])=>void,onLost:()=>void){
 let live=true,failures=0,lastReadAttempt=-Infinity,attemptedRead=0,readWait=0,reading=false,pinSearch=0,pinTarget:string|null=null;
 let state:ThreadState={phase:'idle',detail:null,messages:[],busy:false,message:'',waitUntil:0,cursor:0,complete:true,firstUnreadSeq:null,jumpSeq:null,readPosition:0,needsRefresh:false};
 const listeners=new Set<()=>void>();const active=()=>live&&calls.current(scope);const set=(s:ThreadState)=>{if(active()){state=s;listeners.forEach(fn=>fn());}};
 const allowed=()=>active()&&!state.busy&&state.phase!=='lost'&&now()>=state.waitUntil;
 const fail=(result:{status:number;retryAfter:number},operation=false)=>{if(result.status===404){onLost();set({...state,phase:'lost',detail:null,messages:[],busy:false,message:copy.lost});return;}failures++;set({...state,phase:state.detail?'ready':'failed',busy:false,message:result.status===429?copy.wait:operation?copy.mutationUnknown:copy.threadFailed,needsRefresh:operation||state.needsRefresh,waitUntil:now()+Math.max(result.retryAfter,operation?0:Math.min(60,failures*15))*1000});};
 const load=async()=>{
  if(!allowed())return;set({...state,phase:'loading',busy:true,message:''});
  const detail=await calls.detail(scope,id);if(!active()||detail.kind==='stale')return;if(detail.kind==='error'){fail(detail);return;}
  const page=await calls.messages(scope,id,initialMessages(detail.value));if(!active()||page.kind==='stale')return;if(page.kind==='error'){fail(page);return;}
  failures=0;const d=detail.value,messages=page.value.messages;onMessages(messages);
  const first=firstUnread(messages,d.thread.readPosition,scope.userId);
  set({...state,phase:'ready',busy:false,detail:d,messages,cursor:Math.min(d.thread.lastChange,page.value.thread.lastChange),complete:true,firstUnreadSeq:first?.seq??null,jumpSeq:first?.seq??messages.at(-1)?.seq??null,readPosition:d.thread.readPosition,message:hasGap(messages)?copy.gap:'',waitUntil:0,needsRefresh:false});
 };
 const page=async(direction:'earlier'|'newer')=>{
  if(!allowed()||!state.detail)return;const edge=direction==='earlier'?state.messages[0]?.seq:(state.messages.findIndex((m,i)=>i>0&&m.seq!==state.messages[i-1]!.seq+1)>0?state.messages[state.messages.findIndex((m,i)=>i>0&&m.seq!==state.messages[i-1]!.seq+1)-1]?.seq:state.messages.at(-1)?.seq);
  if(edge===undefined)return;set({...state,busy:true});const result=await calls.messages(scope,id,direction==='earlier'?{before:edge,limit:50}:{after:edge,limit:50});
  if(!active()||result.kind==='stale')return;if(result.kind==='error'){fail(result);return;}
  const messages=mergeMessages(state.messages,result.value.messages);onMessages(result.value.messages);
  set({...state,busy:false,messages,cursor:Math.min(state.cursor,result.value.thread.lastChange),detail:{...state.detail!,thread:{...state.detail!.thread,lastSeq:Math.max(state.detail!.thread.lastSeq,result.value.thread.lastSeq)}},jumpSeq:direction==='earlier'?edge:result.value.messages[0]?.seq??edge,message:hasGap(messages)?copy.gap:''});
 };
 return {snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},dispose(){live=false;listeners.clear();state={...state,messages:[],detail:null};},load,page,lost(){fail({status:404,retryAfter:0});},
  sent(m:Message){if(!active())return;const messages=mergeMessages(state.messages,[m]);set({...state,messages,jumpSeq:m.seq,detail:state.detail?{...state.detail,thread:{...state.detail.thread,lastSeq:Math.max(state.detail.thread.lastSeq,m.seq)}}:null});},
  async poll(){
   if(!allowed()||!state.detail)return;set({...state,busy:true});const result=await calls.changes(scope,id,state.cursor);
   if(!active()||result.kind==='stale')return;if(result.kind==='error'){fail(result);return;}
   const changes=result.value;let detail=state.detail;
   if(changes.thread.revision!==detail.thread.revision||changes.changes.some(c=>c.kind==='pin')){const d=await calls.detail(scope,id);if(!active()||d.kind==='stale')return;if(d.kind==='error'){fail(d);return;}detail=d.value;}
   const incoming=changes.changes.filter(c=>c.kind==='message').map(c=>c.message);onMessages(incoming);
   // Changes below the display window are reconciled, but cannot punch holes in its visible sequence.
   const start=state.messages[0]?.seq??1,messages=mergeMessages(state.messages,incoming.filter(m=>m.seq>=start));
   const pin=detail.pin; if(pin&&incoming.some(m=>m.id===pin.messageId&&m.deletedAt!==null))detail={...detail,pin:null};
   failures=0;set({...state,detail:{...detail,thread:{...detail.thread,lastSeq:Math.max(detail.thread.lastSeq,changes.thread.lastSeq)}},messages,busy:false,cursor:changes.next,complete:changes.complete,message:hasGap(messages)?copy.gap:changes.complete?'':copy.catching,waitUntil:0});
  },
  async mutate(action:Mutation){
   if(!allowed()||!state.detail||state.needsRefresh)return;set({...state,busy:true,message:''});const result=await calls.mutate(scope,id,action);
   if(!active()||result.kind==='stale')return;
   if(result.kind==='error'&&result.status===404){fail(result,true);return;}
   if(result.kind==='error'&&(result.status===429||result.retryAfter>0)){fail(result,true);return;}
   // Read the actual state after every write, including an uncertain write. No mutation is replayed.
   const d=await calls.detail(scope,id);if(!active()||d.kind==='stale')return;if(d.kind==='error'){fail(d,true);return;}
   let messages=state.messages;
   if(action.kind==='edit'||action.kind==='delete'){const p=await calls.messages(scope,id,{after:action.message.seq-1,limit:1});if(!active()||p.kind==='stale')return;if(p.kind==='error'){fail(p,true);return;}messages=mergeMessages(messages,p.value.messages);onMessages(p.value.messages);}
   const target=('message'in action)?messages.find(m=>m.id===action.message.id):null;
   const holds=action.kind==='star'?d.value.thread.starred===action.value:action.kind==='pin'?d.value.pin?.messageId===action.message.id:action.kind==='unpin'?d.value.pin===null:action.kind==='delete'?target?.deletedAt!==null&&target!==undefined:target?.body===action.body.trim();
   set({...state,busy:false,detail:d.value,messages,needsRefresh:false,message:holds?'Change confirmed.':result.kind==='error'&&result.status===409?copy.conflict:'Current state loaded. The requested change was not confirmed; choose again.'});
  },
  async displayed(seq:number){
   if(!active()||state.busy||reading||!state.detail||seq<=state.readPosition||seq<=attemptedRead||!state.messages.some(m=>m.seq===seq)||now()<readWait||now()-lastReadAttempt<15000)return;
   const gap=state.messages.findIndex((m,i)=>i>0&&m.seq!==state.messages[i-1]!.seq+1);if(gap>0&&seq>state.messages[gap-1]!.seq)return;
   lastReadAttempt=now();attemptedRead=seq;reading=true;const result=await calls.read(scope,id,seq);reading=false;
   if(!active()||result.kind==='stale')return;
   if(result.kind==='ok')set({...state,readPosition:Math.max(state.readPosition,result.value.readPosition)});
   else if(result.status===404)fail(result);else{readWait=now()+result.retryAfter*1000;set({...state,message:'Your read position was not confirmed. New displayed messages can advance it later.'});}
  },
  async jumpPin(){
   if(!allowed()||!state.detail?.pin)return;const target=state.detail.pin.messageId;if(pinTarget!==target){pinTarget=target;pinSearch=0;}const known=state.messages.find(m=>m.id===target&&m.deletedAt===null);
   if(known){set({...state,jumpSeq:known.seq});return;}
   // The contract's pin has an ID but no message sequence. Resolve it through bounded change pages.
   set({...state,busy:true,message:'Finding the pinned message…'});const changes=await calls.changes(scope,id,pinSearch);
   if(!active()||changes.kind==='stale')return;if(changes.kind==='error'){fail(changes);return;}
   pinSearch=changes.value.next;const message=changes.value.changes.find(c=>c.kind==='message'&&c.message.id===target);
   if(message?.kind==='message'&&message.message.deletedAt===null){const p=await calls.messages(scope,id,{after:message.message.seq-1,limit:50});if(!active()||p.kind==='stale')return;if(p.kind==='error'){fail(p);return;}set({...state,busy:false,messages:p.value.messages,jumpSeq:message.message.seq,message:''});onMessages(p.value.messages);}
   else set({...state,busy:false,message:changes.value.complete?'Pinned message could not be loaded. Refresh the thread.':'Pinned message is further back. Tap the pin again to continue finding it.'});
  }
 };
}
