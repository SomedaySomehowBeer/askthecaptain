import type { ApiClient, ApiOutcome, Parse } from '../auth/contracts.ts';
import { organisationPath, type OrganisationPath } from '../api/paths.ts';
import type { ReadScope } from '../account/contracts.ts';
import type { Changes, Detail, Filter, Message, MessagePage, ThreadList } from './contracts.ts';
import { parseChanges, parseDetail, parseList, parseMessage, parseMessages, parseChangedPin, parseRead, parseStar, uuid } from './parse.ts';
export type Result<T> = { kind: 'ok'; value: T } | { kind: 'stale' } | { kind: 'error'; status: number; code: string; retryAfter: number; uncertain: boolean };
export type MessageQuery = { latest: number } | { after: number; limit?: number } | { before: number; limit?: number };
export type Mutation = { kind: 'edit'; message: Message; body: string } | { kind: 'delete'; message: Message } | { kind: 'pin'; message: Message } | { kind: 'unpin' } | { kind: 'star'; value: boolean };
export function threadPath(scope: ReadScope, id?: string, ...parts: string[]): OrganisationPath { return organisationPath(scope.organisationId,'threads',...(id?[uuid(id),...parts]:[])); }
export function queryPath(path: OrganisationPath, values: Record<string, string | number | undefined>): OrganisationPath {
 const query = Object.entries(values).filter(([,v])=>v!==undefined).map(([k,v])=>`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');return `${path}?${query}` as OrganisationPath;
}
export type ThreadCalls = {
 current(scope: ReadScope): boolean;
 request<T>(scope: ReadScope, method: 'GET'|'POST'|'PATCH'|'DELETE', path: OrganisationPath, body: unknown, parse: Parse<T>): Promise<Result<T>>;
 list(scope: ReadScope, filter: Filter, after?: string): Promise<Result<ThreadList>>;
 detail(scope: ReadScope, id: string): Promise<Result<Detail>>;
 messages(scope: ReadScope,id:string,query:MessageQuery):Promise<Result<MessagePage>>;
 changes(scope: ReadScope,id:string,after:number):Promise<Result<Changes>>;
 send(scope:ReadScope,id:string,message:{id:string;body:string}):Promise<Result<Message>>;
 mutate(scope:ReadScope,id:string,action:Mutation):Promise<Result<unknown>>;
 read(scope:ReadScope,id:string,seq:number):Promise<Result<{readPosition:number;unread:number}>>;
};
export function createThreadCalls(client: ApiClient, hooks: { scope(): ReadScope|null; sessionEnded():void; reconcile():void }): ThreadCalls {
 const current=(s:ReadScope)=>{const c=hooks.scope();return c!==null&&c.epoch===s.epoch&&c.userId===s.userId&&c.organisationId===s.organisationId;};
 const request=async<T>(s:ReadScope,method:'GET'|'POST'|'PATCH'|'DELETE',path:OrganisationPath,body:unknown,parse:Parse<T>):Promise<Result<T>>=>{
  if(!current(s))return {kind:'stale'};
  let a:ApiOutcome<T>;try{a=await(method==='GET'?client.get(path,null,parse):method==='POST'?client.post(path,null,body,parse):method==='PATCH'?client.patch(path,null,body,parse):client.delete(path,null,parse));}catch{a={ok:false,kind:'unavailable',status:0};}
  if(!current(s))return {kind:'stale'};
  if(a.ok)return {kind:'ok',value:a.value};
  if(a.kind==='unauthorised'){hooks.sessionEnded();return {kind:'stale'};}
  if(a.kind==='refused'&&a.status===403)hooks.reconcile();
  return {kind:'error',status:a.status,code:a.kind==='refused'?a.code:'unavailable',retryAfter:a.kind==='unavailable'?Math.min(300,a.retryAfter??0):0,uncertain:method!=='GET'&&a.kind==='unavailable'&&a.status!==429};
 };
 return {current,request,
  list:(s,filter,after)=>request(s,'GET',queryPath(threadPath(s),{filter,limit:50,after}),undefined,parseList),
  detail:(s,id)=>request(s,'GET',threadPath(s,id),undefined,v=>{const d=parseDetail(v);if(d.thread.id!==id)throw new TypeError('thread identity mismatch');return d;}),
  messages:(s,id,q)=>request(s,'GET',queryPath(threadPath(s,id,'messages'),q),undefined,v=>{const p=parseMessages(v);if(p.thread.id!==id)throw new TypeError('thread identity mismatch');return p;}),
  changes:(s,id,after)=>request(s,'GET',queryPath(threadPath(s,id,'changes'),{after,limit:100}),undefined,v=>{const p=parseChanges(v);if(p.thread.id!==id||p.next<after||p.changes.some(c=>c.changeSeq<=after))throw new TypeError('change cursor mismatch');return p;}),
  send:(s,id,message)=>request(s,'POST',threadPath(s,id,'messages'),message,v=>{const m=parseMessage(v);if(m.threadId!==id||m.id!==message.id)throw new TypeError('message identity mismatch');return m;}),
  mutate(s,id,a){
   if(a.kind==='star')return request(s,a.value?'POST':'DELETE',threadPath(s,id,'star'),{},parseStar);
   if(a.kind==='pin')return request(s,'POST',threadPath(s,id,'pin'),{messageId:a.message.id},parseChangedPin);
   if(a.kind==='unpin')return request(s,'DELETE',threadPath(s,id,'pin'),undefined,parseChangedPin);
   if(a.kind==='edit')return request(s,'PATCH',threadPath(s,id,'messages',a.message.id),{body:a.body,expectedRevision:a.message.revision},parseMessage);
   return request(s,'DELETE',queryPath(threadPath(s,id,'messages',a.message.id),{expectedRevision:a.message.revision}),undefined,parseMessage);
  },
  read:(s,id,seq)=>request(s,'POST',threadPath(s,id,'read'),{seq},parseRead)
 };
}
