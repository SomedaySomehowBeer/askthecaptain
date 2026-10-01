import assert from 'node:assert/strict';
import { test } from 'node:test';
import { threadFixture,tid,tagId } from '../../harness/thread-fixtures.ts';
import { parseList,parseDetail,parseMessage,parseMessages,parseChanges,parseRead,parseCard } from './parse.ts';
import { firstName,firstUnread,groupedRows,hasGap,initialMessages,mergeMessages,messagePowers,recordRoute,validBody } from './derive.ts';
import { createDraftStorage,type WebStorage } from './storage.ts';
import { createComposer } from './composer.ts';
import { createListControls } from './list-controls.ts';
import { createThreadControls } from './thread-controls.ts';
import { createThreadCalls,type ThreadCalls,type Result } from './api.ts';
import type { ApiClient,ApiOutcome,Parse } from '../auth/contracts.ts';
import type { Detail,Message } from './contracts.ts';
const user='00000000-0000-4000-8000-000000000001',org='00000000-0000-4000-8000-000000000002',sendId='00000000-0000-4000-8000-000000000088';
const scope={epoch:'one',userId:user,organisationId:org};
function storage(){const values=new Map<string,string>();const raw:WebStorage={getItem:k=>values.get(k)??null,setItem:(k,v)=>{values.set(k,v);},removeItem:k=>{values.delete(k);},key:i=>[...values.keys()][i]??null,get length(){return values.size;}};return {values,raw,store:createDraftStorage(()=>raw)};}
function fixture(){
 const data=threadFixture();let current:typeof scope|null=scope,now=0,ended=0,failure:ApiOutcome<never>|null=null,hold:(()=>Promise<void>)|null=null;
 const sent:{method:string;path:string;body:unknown;token:string|null}[]=[];
 const request=async<T>(method:string,path:string,token:string|null,body:unknown,parse:Parse<T>):Promise<ApiOutcome<T>>=>{
  sent.push({method,path,body,token});if(hold)await hold();if(failure)return failure;const u=new URL(path,'https://captain.example');let value:unknown=data.detail;
  if(u.pathname.endsWith('/threads'))value={...data.list,filter:u.searchParams.get('filter')??'all'};
  else if(u.pathname.endsWith('/messages')&&method==='GET'){const after=Number(u.searchParams.get('after')??0),before=Number(u.searchParams.get('before')??Infinity),limit=Number(u.searchParams.get('limit')??50);const rows=data.messages.filter(m=>m.seq>after&&m.seq<before);value={thread:{id:tid,revision:1,lastSeq:65,lastChange:65},messages:u.searchParams.has('latest')?rows.slice(-50):rows.slice(0,limit),hasMore:rows.length>limit};}
  else if(u.pathname.endsWith('/messages'))value={...data.messages[0],id:(body as {id:string}).id,body:(body as {body:string}).body,authorId:user,seq:66,changeSeq:66};
  else if(u.pathname.endsWith('/read'))value={readPosition:(body as {seq:number}).seq,unread:0};
  else if(u.pathname.endsWith('/changes'))value={thread:{id:tid,revision:1,lastSeq:65,highWater:65},changes:[],next:65,complete:true};
  else if(u.pathname.endsWith('/star')){data.detail.thread.starred=method==='POST';value={starred:data.detail.thread.starred};}
  return {ok:true,value:parse(value)};
 };
 const client:ApiClient={get:(p,t,parse)=>request('GET',p,t,undefined,parse),post:(p,t,b,parse)=>request('POST',p,t,b,parse),patch:(p,t,b,parse)=>request('PATCH',p,t,b,parse),delete:(p,t,parse)=>request('DELETE',p,t,undefined,parse)};
 const calls=createThreadCalls(client,{scope:()=>current,sessionEnded(){ended++;current=null;},reconcile(){}});
 return {data,calls,sent,now:()=>now,time:(v:number)=>{now=v;},scope:(v:typeof current)=>{current=v;},fail:(v:typeof failure)=>{failure=v;},hold:(v:typeof hold)=>{hold=v;},ended:()=>ended};
}
test('strict list/detail/message parsers reject extra fields, wrong identities, malformed tombstones and bounds',()=>{
 const f=threadFixture();assert.equal(parseList(f.list).threads.length,1);assert.equal(parseDetail(f.detail).thread.id,tid);
 for(const list of [{...f.list,token:'secret'},{...f.list,threads:[f.list.threads[0],f.list.threads[0]]},{...f.list,groups:[{...f.list.groups[0],needsYou:2}]},{...f.list,threads:[{...f.list.threads[0],unread:52}]}])assert.throws(()=>parseList(list));
 assert.throws(()=>parseDetail({...f.detail,participants:[]}));assert.throws(()=>parseMessage({...f.messages[0],body:null}));assert.throws(()=>parseMessage({...f.messages[0],body:'x'.repeat(4001)}));
 assert.throws(()=>parseMessages({thread:{id:user,revision:1,lastSeq:65,lastChange:65},messages:[f.messages[0]],hasMore:false}));
 assert.throws(()=>parseChanges({thread:{id:tid,revision:1,lastSeq:65,highWater:65},changes:[],next:0,complete:true}));
});
test('retired links, tag kind and read wire names are rejected',()=>{
 const f=threadFixture();assert.deepEqual(parseRead({readPosition:3,unread:1}),{readPosition:3,unread:1});assert.throws(()=>parseRead({lastReadSeq:3,unread:1}));assert.throws(()=>parseDetail({...f.detail,links:[]}));assert.throws(()=>parseList({...f.list,threads:[{...f.list.threads[0],links:[]}]}));assert.throws(()=>parseDetail({...f.detail,tags:[{...f.detail.tags[0],kind:'project'}]}));
});
test('groups preserve whole-set counts and show a multi-tag row under every heading',()=>{
 const list=parseList(threadFixture().list);const other={id:user,name:'Production'};list.threads[0]!.tags.push(other);list.groups.push({key:user,label:'Production',threads:99,needsYou:10});
 const groups=groupedRows(list);assert.equal(groups.length,2);assert.equal(groups[1]!.rows[0]?.id,tid);assert.equal(groups[1]!.group.threads,99);
});
test('row/card and first-unread derivation follows the contract rather than fabricating record screens',()=>{
 const f=threadFixture(),d=parseDetail(f.detail),m=f.messages.map(parseMessage);
 assert.deepEqual(initialMessages(d),{after:2,limit:50});assert.equal(firstUnread(m,3,user)?.seq,4);
 assert.deepEqual(initialMessages({...d,thread:{...d.thread,unread:50}}),{latest:50});assert.equal(firstUnread(m,65,user),null);
 assert.equal(firstName(' Pat  Crew '),'Pat');assert.equal(firstName(null),'Former member');assert.equal(recordRoute(d),null);assert.equal(recordRoute({...d,card:{...d.card,record:{kind:'booking',id:user}}}),'/equipment');
});
test('upserts retain higher change sequence, tombstones, and detect sequence gaps only',()=>{
 const m=parseMessage(threadFixture().messages[0]),edited={...m,body:'Edited',changeSeq:20,revision:2};assert.equal(mergeMessages([edited],[m])[0]?.body,'Edited');
 assert.equal(hasGap([m,{...m,id:user,seq:2,changeSeq:99}]),false);assert.equal(hasGap([m,{...m,id:user,seq:3}]),true);
});
test('message menu powers distinguish author editing from moderation and hide tombstone actions',()=>{
 const m=parseMessage(threadFixture().messages[0]);assert.deepEqual(messagePowers(m,user,'member'),{edit:false,delete:false,pin:false});assert.deepEqual(messagePowers(m,user,'admin'),{edit:false,delete:true,pin:true});assert.deepEqual(messagePowers(m,m.authorId!,'member'),{edit:true,delete:true,pin:false});assert.deepEqual(messagePowers({...m,deletedAt:m.createdAt,body:null},user,'owner'),{edit:false,delete:false,pin:false});
});
test('body bounds use code points and UTF-8 bytes',()=>{assert.equal(validBody('😀'.repeat(4000)),true);assert.equal(validBody('😀'.repeat(4001)),false);assert.equal(validBody('  '),false);});
test('drafts are scoped, clear on a different person/signout, and malformed records are discarded',()=>{
 const s=storage();const p={id:sendId,threadId:tid,body:'Hello',locked:true};assert.equal(s.store.save(scope,p),true);assert.deepEqual(s.store.load(scope,tid),p);assert.equal(s.store.load({...scope,organisationId:user},tid),null);
 s.store.person(user);assert.equal(s.values.size,1);s.store.person(org);assert.equal(s.values.size,0);s.store.save(scope,p);s.store.person(null);assert.equal(s.values.size,0);
 s.values.set(`captain.pending-thread.${user}.${org}.${tid}`,'{"secret":1}');assert.equal(s.store.load(scope,tid),null);assert.equal(s.values.size,0);
});
test('failed session storage prevents the first send',async()=>{
 const f=fixture(),s=createDraftStorage(()=>{throw new Error('unavailable');});const c=createComposer(f.calls,scope,tid,s,f.now,()=>sendId,()=>{});c.edit('Hello');await c.send();assert.equal(f.sent.length,0);assert.match(c.snapshot().message,/Nothing was sent/);
});
test('uncertain sends lock body and preserve ID through remount, never automatically replay',async()=>{
 const f=fixture(),s=storage();const c=createComposer(f.calls,scope,tid,s.store,f.now,()=>sendId,()=>{});c.edit('Hello');f.fail({ok:false,kind:'unavailable',status:503});await c.send();c.edit('Different');assert.equal(c.snapshot().body,'Hello');c.dispose();
 const restored=createComposer(f.calls,scope,tid,s.store,f.now,()=>user,()=>{});assert.equal(restored.snapshot().pending?.id,sendId);assert.equal(f.sent.length,1);f.fail(null);await restored.send();assert.deepEqual(f.sent[1]!.body,f.sent[0]!.body);assert.equal(s.values.size,0);
});
test('429 keeps a draft editable with its ID, paces retry, and cannot fabricate success',async()=>{
 const f=fixture(),s=storage(),c=createComposer(f.calls,scope,tid,s.store,f.now,()=>sendId,()=>{});c.edit('Hello');f.fail({ok:false,kind:'unavailable',status:429,retryAfter:20});await c.send();c.edit('Changed');assert.equal(c.snapshot().body,'Changed');assert.equal(c.snapshot().pending?.locked,false);await c.send();assert.equal(f.sent.length,1);f.time(20000);f.fail(null);await c.send();assert.deepEqual(f.sent[1]!.body,{id:sendId,body:'Changed'});
});
test('ID conflict retains text for explicit new-ID retry; a send only reconciles the same author and thread',async()=>{
 const f=fixture(),s=storage(),c=createComposer(f.calls,scope,tid,s.store,f.now,()=>sendId,()=>{});c.edit('Keep me');f.fail({ok:false,kind:'refused',status:409,code:'message_id_unavailable'});await c.send();assert.equal(c.snapshot().refused,true);await c.send();assert.equal(f.sent.length,1);c.newId();assert.equal(c.snapshot().body,'Keep me');
 f.fail({ok:false,kind:'unavailable',status:0});await c.send();const m={...parseMessage(f.data.messages[0]),id:sendId};c.reconcile([m]);assert.ok(c.snapshot().pending);c.reconcile([{...m,authorId:user}]);assert.equal(c.snapshot().pending,null);
});
test('pending sends coalesce and stale responses cannot enter a new scope',async()=>{
 const f=fixture(),s=storage(),c=createComposer(f.calls,scope,tid,s.store,f.now,()=>sendId,()=>{});c.edit('Hello');let release!:()=>void;f.hold(()=>new Promise(r=>{release=r;}));const result=c.send();await c.send();assert.equal(f.sent.length,1);f.scope({...scope,epoch:'two'});release();await result;assert.ok(s.store.load(scope,tid));
});
test('late 401 does not end a new person; current 401 does',async()=>{
 const f=fixture();let release!:()=>void;f.hold(()=>new Promise(r=>{release=r;}));const result=f.calls.detail(scope,tid);f.scope({...scope,userId:org,epoch:'two'});f.fail({ok:false,kind:'unauthorised'});release();await result;assert.equal(f.ended(),0);f.hold(null);f.scope(scope);await f.calls.detail(scope,tid);assert.equal(f.ended(),1);
});
test('list responses stay scoped, filter changes reset pages and failed reads back off',async()=>{
 const f=fixture(),c=createListControls(f.calls,scope,f.now);await c.load();assert.equal(c.snapshot().data?.filter,'all');await c.filter('tasks');assert.equal(c.snapshot().data?.filter,'tasks');await c.filter('files');assert.equal(c.snapshot().filter,'tasks');
 f.fail({ok:false,kind:'unavailable',status:429,retryAfter:30});await c.load();assert.equal(c.snapshot().data,null);const n=f.sent.length;await c.load();assert.equal(f.sent.length,n);f.time(30000);f.fail(null);await c.load();assert.ok(c.snapshot().data);
});
test('thread opening uses first-unread fetch and displayed messages alone advance reads with a throttle',async()=>{
 const f=fixture(),c=createThreadControls(f.calls,scope,tid,f.now,()=>{},()=>{});await c.load();assert.match(f.sent[1]!.path,/after=2&limit=50/);assert.equal(c.snapshot().firstUnreadSeq,4);await c.displayed(999);assert.equal(f.sent.length,2);await c.displayed(5);assert.equal(f.sent.length,3);await c.displayed(6);assert.equal(f.sent.length,3);f.time(15000);await c.displayed(6);assert.equal(f.sent.length,4);assert.equal(c.snapshot().readPosition,6);
});
test('lost access hides thread data and clears its pending draft',async()=>{
 const f=fixture();let lost=0;const c=createThreadControls(f.calls,scope,tid,f.now,()=>{},()=>{lost++;});await c.load();f.fail({ok:false,kind:'refused',status:404,code:'not_found'});await c.poll();assert.equal(c.snapshot().phase,'lost');assert.deepEqual(c.snapshot().messages,[]);assert.equal(c.snapshot().detail,null);assert.equal(lost,1);
});
test('stars reconcile through detail without reissuing the mutation',async()=>{
 const f=fixture(),c=createThreadControls(f.calls,scope,tid,f.now,()=>{},()=>{});await c.load();await c.mutate({kind:'star',value:true});assert.equal(c.snapshot().detail?.thread.starred,true);assert.equal(f.sent.filter(r=>r.method==='POST').length,1);assert.match(c.snapshot().message,/confirmed/);
});
test('poll requests coalesce; incomplete feed progress and newer versions converge',async()=>{
 const f=fixture();let release!:()=>void;const m={...parseMessage(f.data.messages[4]),body:'Edited',revision:2,changeSeq:66};
 const calls:ThreadCalls={...f.calls,async changes(){await new Promise<void>(r=>{release=r;});return {kind:'ok',value:{thread:{id:tid,revision:1,lastSeq:65,highWater:67},changes:[{changeSeq:66,kind:'message',message:m}],next:66,complete:false}};}};
 const c=createThreadControls(calls,scope,tid,f.now,()=>{},()=>{});await c.load();const one=c.poll();await c.poll();release();await one;assert.equal(c.snapshot().cursor,66);assert.equal(c.snapshot().complete,false);assert.equal(c.snapshot().messages.find(v=>v.id===m.id)?.body,'Edited');
});

test('card folds reject unknown fields and old card shapes',()=>{const d=threadFixture().detail;assert.throws(()=>parseCard({...d.card,body:'retired'}));assert.throws(()=>parseCard({...d.card,fold:{...d.card.fold,token:'secret'}}));assert.throws(()=>parseDetail({...d,pins:null}));});
