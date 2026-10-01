/** Only pending-send/create data can persist. No read cache, message history, titles or thread IDs elsewhere. */
import type { ReadScope } from '../account/contracts.ts';
import { isCanonicalUuid } from '../api/paths.ts';
import { validBody } from './derive.ts';
export type Pending = { id:string;threadId:string;body:string;locked:boolean };
export type DraftStorage = { load(scope:ReadScope,threadId:string):Pending|null;save(scope:ReadScope,pending:Pending):boolean;clear(scope:ReadScope,threadId:string):void;person(userId:string|null):void };
export type WebStorage = Pick<Storage,'getItem'|'setItem'|'removeItem'|'key'|'length'>;
const prefix='captain.pending-thread.';
export function createDraftStorage(get:()=>WebStorage|null):DraftStorage {
 const key=(s:ReadScope,id:string)=>`${prefix}${s.userId}.${s.organisationId}.${id}`;
 const clear=(s:ReadScope,id:string)=>{try{get()?.removeItem(key(s,id));}catch{/* no success claim */}};
 return {
  load(s,id){try{const raw=get()?.getItem(key(s,id));if(!raw)return null;const x=JSON.parse(raw);if(!x||Object.keys(x).sort().join(',')!=='body,id,locked,threadId'||!isCanonicalUuid(x.id)||x.threadId!==id||typeof x.body!=='string'||!validBody(x.body)||typeof x.locked!=='boolean'){clear(s,id);return null;}return x;}catch{clear(s,id);return null;}},
  save(s,p){try{const store=get();if(!store)return false;store.setItem(key(s,p.threadId),JSON.stringify(p));return true;}catch{return false;}},clear,
  person(userId){try{const store=get();if(!store)return;for(let i=store.length-1;i>=0;i--){const k=store.key(i);if(k?.startsWith(prefix)&&(!userId||!k.startsWith(`${prefix}${userId}.`)))store.removeItem(k);}}catch{/* best effort */}}
 };
}
export const browserDrafts=createDraftStorage(()=>typeof window==='undefined'?null:window.sessionStorage);
export function foldedGroups():Set<string>{try{const raw=JSON.parse(localStorage.getItem('captain.thread-group-folds')??'[]');return new Set(Array.isArray(raw)?raw.filter(k=>k==='none'||isCanonicalUuid(k)).slice(0,100):[]);}catch{return new Set();}}
export function saveFolds(keys:ReadonlySet<string>){try{localStorage.setItem('captain.thread-group-folds',JSON.stringify([...keys].slice(0,100)));}catch{/* best effort, current screen still folds */}}
