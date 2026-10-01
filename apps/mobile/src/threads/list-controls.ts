import type { ReadScope } from '../account/contracts.ts';
import type { ThreadCalls } from './api.ts';
import type { Filter, ThreadList } from './contracts.ts';
import { copy } from './copy.ts';
export type ListState={phase:'idle'|'loading'|'ready'|'failed'|'lost';filter:Filter;data:ThreadList|null;message:string;waitUntil:number};
export function createListControls(calls:ThreadCalls,scope:ReadScope,now:()=>number){
 let live=true,generation=0,busy=false,failures=0;
 let state:ListState={phase:'idle',filter:'all',data:null,message:'',waitUntil:0};const listeners=new Set<()=>void>();
 const active=()=>live&&calls.current(scope);const set=(s:ListState)=>{if(active()){state=s;listeners.forEach(fn=>fn());}};
 const load=async(more=false)=>{
  if(!active()||busy||state.phase==='lost'||now()<state.waitUntil||(more&&!state.data?.nextCursor))return;
  busy=true;const version=generation,filter=state.filter,cursor=more?state.data?.nextCursor??undefined:undefined;
  set({...state,phase:'loading',message:''});const result=await calls.list(scope,filter,cursor);busy=false;
  if(!active()||version!==generation||result.kind==='stale')return;
  if(result.kind==='ok'&&result.value.filter===filter){failures=0;const data=result.value;
   if(more&&state.data){const ids=new Set(state.data.threads.map(r=>r.id));data.threads=[...state.data.threads,...data.threads.filter(r=>!ids.has(r.id))];}
   set({...state,phase:'ready',data,message:data.available?'':copy.unavailable,waitUntil:0});
  }else{failures++;const error=result.kind==='error'?result:null;set({...state,phase:error?.status===404?'lost':'failed',data:null,message:error?.status===404?copy.lost:error?.status===429?copy.wait:copy.failed,waitUntil:now()+Math.max(error?.retryAfter??0,Math.min(60,failures*15))*1000});}
 };
 return {snapshot:()=>state,subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},dispose(){live=false;listeners.clear();state={...state,data:null};},load,
  async filter(filter:Filter){if(busy||filter===state.filter||filter==='files'||filter==='people')return;generation++;set({...state,filter,data:null,phase:'idle'});await load();}
 };
}
