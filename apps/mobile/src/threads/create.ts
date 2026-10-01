import type { ReadScope } from '../account/contracts.ts';
import type { ThreadCalls } from './api.ts';
import { threadPath } from './api.ts';
import { parseDetail, array, integer, keys, object, text, uuid } from './parse.ts';
import { validBody } from './derive.ts';
import type { WebStorage } from './storage.ts';
import { copy } from './copy.ts';
export type CreateDraft={id:string;messageId:string;body:string;private:boolean;title:string;participantIds:string[];locked:boolean;refused:boolean;waitUntil:number};
export type CreateStorage={load(s:ReadScope):CreateDraft|null;save(s:ReadScope,d:CreateDraft):boolean;clear(s:ReadScope):void};
export const validTitle=(s:string)=>s.trim().length>0&&[...s.trim()].length<=80;
export const validCreate=(d:CreateDraft)=>validBody(d.body)&&(!d.private||validTitle(d.title))&&d.participantIds.length<=49;
export function parseCreateDraft(raw:unknown):CreateDraft{
 const x=object(raw);keys(x,['id','messageId','body','private','title','participantIds','locked','refused','waitUntil']);
 if(typeof x.private!=='boolean'||typeof x.locked!=='boolean'||typeof x.refused!=='boolean')throw new TypeError('invalid create draft');
 const d={id:uuid(x.id),messageId:uuid(x.messageId),body:text(x.body,8000),private:x.private,title:text(x.title,160),participantIds:array(x.participantIds,uuid,49),locked:x.locked,refused:x.refused,waitUntil:integer(x.waitUntil,0,Number.MAX_SAFE_INTEGER)};
 if(new Set(d.participantIds).size!==d.participantIds.length||(d.locked&&!validCreate(d)))throw new TypeError('invalid create draft');return d;
}
export function createNewStorage(get:()=>WebStorage|null):CreateStorage{
 // Share the pending namespace so account sign-out/different-person cleanup covers creates too.
 const key=(s:ReadScope)=>`captain.pending-thread.${s.userId}.${s.organisationId}.new`;
 const clear=(s:ReadScope)=>{try{get()?.removeItem(key(s));}catch{/* best effort */}};
 return {clear,load(s){try{const raw=get()?.getItem(key(s));if(!raw)return null;const d=parseCreateDraft(JSON.parse(raw));if(d.participantIds.includes(s.userId))throw new TypeError('creator included');return d;}catch{clear(s);return null;}},save(s,d){try{const store=get();if(!store)return false;store.setItem(key(s),JSON.stringify(d));return true;}catch{return false;}}};
}
export const browserCreates=createNewStorage(()=>typeof window==='undefined'?null:window.sessionStorage);
export type CreateState={draft:CreateDraft;pending:boolean;busy:boolean;waitUntil:number;message:string;lost:boolean};
export function createNewThread(calls:ThreadCalls,scope:ReadScope,storage:CreateStorage,now:()=>number,random:()=>string,opened:(id:string)=>void){
 let live=true;const fresh=():CreateDraft=>({id:random(),messageId:random(),body:'',private:false,title:'',participantIds:[],locked:false,refused:false,waitUntil:0});
 const saved=storage.load(scope);let state:CreateState={draft:saved??fresh(),pending:saved!==null,busy:false,waitUntil:saved?.waitUntil??0,message:saved?.locked?copy.createUnknown:saved?.refused?copy.createRefused:'',lost:false};
 const listeners=new Set<()=>void>(),active=()=>live&&calls.current(scope),set=(s:CreateState)=>{if(active()){state=s;listeners.forEach(f=>f());}};
 return {snapshot:()=>state,subscribe(f:()=>void){listeners.add(f);return()=>{listeners.delete(f);};},dispose(){live=false;listeners.clear();},
  edit(patch:Partial<Pick<CreateDraft,'body'|'title'|'private'|'participantIds'>>){if(!active()||state.busy||state.draft.locked||state.lost)return;const draft={...state.draft,...patch};if(draft.participantIds.length>49||draft.participantIds.includes(scope.userId))return;if(state.pending&&!storage.save(scope,draft)){set({...state,message:copy.storage});return;}set({...state,draft});},
  discard(){if(!active()||state.busy)return;storage.clear(scope);set({...state,draft:fresh(),pending:false,lost:false,message:copy.createDiscard});},
  newIds(){if(!active()||state.busy||!state.draft.refused)return;storage.clear(scope);set({...state,draft:{...state.draft,id:random(),messageId:random(),refused:false,locked:false},pending:false,message:copy.createNewIds});},
  async send(){
   if(!active()||state.busy||state.lost||state.draft.refused||now()<state.waitUntil||!validCreate(state.draft))return;
   const d={...state.draft,body:state.draft.body.trim(),title:state.draft.title.trim(),participantIds:[...state.draft.participantIds].sort(),locked:true};
   if(!storage.save(scope,d)){set({...state,message:copy.storage});return;}
   set({...state,draft:d,pending:true,busy:true,message:copy.creating});
   const input={id:d.id,kind:d.private?'private':'topic',...(d.private?{title:d.title,participantIds:d.participantIds}:{}),message:{id:d.messageId,body:d.body}};
   const result=await calls.request(scope,'POST',threadPath(scope),input,v=>{const detail=parseDetail(v);if(detail.thread.id!==d.id||detail.thread.kind!==input.kind)throw new TypeError('created thread mismatch');return detail;});
   if(!active()||result.kind==='stale')return;
   if(result.kind==='ok'){storage.clear(scope);set({...state,pending:false,busy:false,message:copy.created});opened(d.id);return;}
   if(result.status===404){storage.clear(scope);set({...state,draft:fresh(),pending:false,busy:false,lost:true,message:copy.lost});return;}
   const draft={...d,locked:result.uncertain,refused:result.status!==429&&!result.uncertain,waitUntil:now()+result.retryAfter*1000};storage.save(scope,draft);
   set({...state,draft,busy:false,waitUntil:now()+result.retryAfter*1000,message:result.status===429?copy.rate:result.uncertain?copy.createUnknown:result.code==='thread_id_unavailable'?copy.createIdUnavailable:copy.createRefused});
  }
 };
}
