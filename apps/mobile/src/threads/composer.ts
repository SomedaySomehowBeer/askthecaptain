import type { ReadScope } from '../account/contracts.ts';
import type { ThreadCalls } from './api.ts';
import type { Message } from './contracts.ts';
import { copy } from './copy.ts';
import { validBody } from './derive.ts';
import type { DraftStorage, Pending } from './storage.ts';
export type ComposerState={body:string;pending:Pending|null;busy:boolean;message:string;waitUntil:number;refused:boolean};
export function createComposer(calls:ThreadCalls,scope:ReadScope,threadId:string,storage:DraftStorage,now:()=>number,randomId:()=>string,onSent:(m:Message)=>void,onLost:()=>void=()=>{}){
 let live=true;const saved=storage.load(scope,threadId);
 let state:ComposerState={body:saved?.body??'',pending:saved,busy:false,message:saved?.locked?copy.unknown:'',waitUntil:0,refused:false};const listeners=new Set<()=>void>();
 const active=()=>live&&calls.current(scope);const set=(s:ComposerState)=>{if(active()){state=s;listeners.forEach(fn=>fn());}};
 const reconcile=(messages:readonly Message[])=>{if(!active()||!state.pending)return;const matched=messages.find(m=>m.id===state.pending!.id&&m.threadId===threadId&&m.authorId===scope.userId);if(matched){storage.clear(scope,threadId);set({body:'',pending:null,busy:false,message:'Message confirmed.',waitUntil:0,refused:false});}};
 return {snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},dispose(){live=false;listeners.clear();},reconcile,
  edit(body:string){if(!active()||state.busy||state.pending?.locked)return;if(state.pending){const p={...state.pending,body};if(validBody(body))storage.save(scope,p);}set({...state,body});},
  discard(){if(!active()||state.busy)return;storage.clear(scope,threadId);set({body:'',pending:null,busy:false,message:'Draft discarded. Any message already sent remains in the thread.',waitUntil:state.waitUntil,refused:false});},
  newId(){if(!active()||state.busy||!state.refused)return;storage.clear(scope,threadId);set({...state,pending:null,refused:false,message:'Review your text, then send with a new ID.'});},
  async send(){
   if(!active()||state.busy||state.refused||now()<state.waitUntil||!validBody(state.body))return;
   const pending:Pending={id:state.pending?.id??randomId(),threadId,body:state.pending?.locked?state.pending.body:state.body.trim(),locked:true};
   if(!storage.save(scope,pending)){set({...state,message:copy.storage});return;}
   set({...state,body:pending.body,pending,busy:true,message:copy.pending});const result=await calls.send(scope,threadId,{id:pending.id,body:pending.body});
   if(!active()||result.kind==='stale')return;
   // A poll may already have reconciled this ID. Never replace a newer draft with an old response.
   if(state.pending?.id!==pending.id)return;
   if(result.kind==='ok'){onSent(result.value);reconcile([result.value]);return;}
   if(result.status===404){onLost();storage.clear(scope,threadId);set({...state,busy:false,pending:null,body:'',message:copy.lost,refused:true});return;}
   const next={...pending,locked:result.uncertain};storage.save(scope,next);
   set({...state,busy:false,pending:next,waitUntil:now()+result.retryAfter*1000,refused:result.status!==429&&!result.uncertain,message:result.status===429?copy.rate:result.uncertain?copy.unknown:copy.refused});
  }
 };
}
