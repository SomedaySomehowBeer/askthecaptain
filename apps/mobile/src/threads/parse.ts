import { isCanonicalInstant, isCanonicalUuid } from '../api/paths.ts';
import { filters, type Card, type ChangeLine, type Changes, type Detail, type Group, type LineChange, type Message, type MessagePage, type Pin, type Row, type Tag, type ThreadList } from './contracts.ts';
const bad = (): never => { throw new TypeError('threads: unexpected response'); };
export const object = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : bad();
export const keys = (x: Record<string, unknown>, required: string[], optional: string[] = []) => { if (!required.every(k => Object.hasOwn(x,k)) || Object.keys(x).some(k => !required.includes(k) && !optional.includes(k))) bad(); };
export const text = (x: unknown, max = 4000): string => typeof x === 'string' && [...x].length <= max ? x : bad();
export const integer = (x: unknown, min = 0, max = 2_147_483_647): number => typeof x === 'number' && Number.isInteger(x) && x >= min && x <= max ? x : bad();
const bool = (x: unknown): boolean => typeof x === 'boolean' ? x : bad();
export const uuid = (x: unknown): string => isCanonicalUuid(x) ? x : bad();
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();
const nullable = <T>(x: unknown, parse: (x: unknown) => T): T | null => x === null ? null : parse(x);
const oneOf = <T extends string>(x: unknown, choices: readonly T[]): T => typeof x === 'string' && choices.includes(x as T) ? x as T : bad();
export const array = <T>(x: unknown, parse: (x: unknown) => T, max: number): T[] => Array.isArray(x) && x.length <= max ? x.map(parse) : bad();
const unique = <T>(rows: T[], id: (x: T) => string) => { if (new Set(rows.map(id)).size !== rows.length) bad(); return rows; };
const kind = (x: unknown) => oneOf(x, ['record','topic','private'] as const);
const recordKind = (x: unknown) => oneOf(x, ['task','booking','stock'] as const);
const facts = (x: unknown): [string,string] => { const rows = array(x, v => text(v,500),2); return rows.length === 2 ? [rows[0]!,rows[1]!] : bad(); };
const date = (x: unknown): string => { const s=text(x,10); return /^\d{4}-\d{2}-\d{2}$/.test(s) && isCanonicalInstant(s+'T00:00:00.000Z') ? s : bad(); };
export function parseTag(raw: unknown): Tag { const x=object(raw);keys(x,['id','name']);return {id:uuid(x.id),name:text(x.name,200)}; }
const tags = (x: unknown) => unique(array(x,parseTag,100),t=>t.id);
export function parseRow(raw: unknown): Row {
 const x=object(raw);keys(x,['id','kind','title','record','facts','status','lastMessageAt','lastMessage','unread','needsYou','starred','tags']);
 const record=nullable(x.record,v=>{const r=object(v);keys(r,['kind','id']);return {kind:recordKind(r.kind),id:uuid(r.id)};});
 const rowKind=kind(x.kind);if ((rowKind==='record') !== (record!==null)) bad();
 return {id:uuid(x.id),kind:rowKind,title:text(x.title,500),record,facts:facts(x.facts),status:nullable(x.status,v=>text(v,80)),lastMessageAt:nullable(x.lastMessageAt,instant),lastMessage:nullable(x.lastMessage,v=>{const m=object(v);keys(m,['authorName','excerpt']);return {authorName:nullable(m.authorName,v=>text(v,500)),excerpt:text(m.excerpt,120)};}),unread:integer(x.unread,0,51),needsYou:bool(x.needsYou),starred:bool(x.starred),tags:tags(x.tags)};
}
export function parseGroup(raw: unknown): Group {
 const x=object(raw);keys(x,['key','label','threads','needsYou'],['owner','startsOn','endsOn']);
 return {key:x.key==='none'?'none':uuid(x.key),label:text(x.label,200),threads:integer(x.threads),needsYou:integer(x.needsYou,0,integer(x.threads)),...(x.owner===undefined?{}:{owner:nullable(x.owner,v=>{const o=object(v);keys(o,['id','name']);return {id:uuid(o.id),name:nullable(o.name,v=>text(v,500))};})}),...(x.startsOn===undefined?{}:{startsOn:nullable(x.startsOn,date)}),...(x.endsOn===undefined?{}:{endsOn:nullable(x.endsOn,date)})};
}
export function parseList(raw: unknown): ThreadList { const x=object(raw);keys(x,['filter','available','threads','nextCursor','groups']);return {filter:oneOf(x.filter,filters),available:bool(x.available),threads:unique(array(x.threads,parseRow,50),r=>r.id),nextCursor:nullable(x.nextCursor,v=>{const s=text(v,2000);return s.length?s:bad();}),groups:unique(array(x.groups,parseGroup,100),g=>g.key)}; }
const messageKeys=['id','threadId','kind','seq','changeSeq','authorId','authorName','body','createdAt','editedAt','deletedAt','deletedBy','revision'];
const journalKinds=['task','reservation','stock_item','series','equipment','tag','thread'] as const;
const operations=['create','update','remove','attach','detach'] as const;
/** A journalled value: JSON only, bounded so a hostile payload cannot grow the page without limit. */
const json=(x:unknown):unknown=>{if(x===undefined||JSON.stringify(x).length>20000)bad();return x;};
const isRow=(x:unknown)=>x!==null&&typeof x==='object'&&!Array.isArray(x);
/** One change of a change line (R3 §3), with the database's shape rules: an update names a field and has both values; a
 *  create or attach has only `after`, a full row; a remove or detach only `before`; attach and detach are tag items. */
export function parseLineChange(raw:unknown):LineChange{
 const x=object(raw);keys(x,['id','recordKind','recordId','operation','field','itemKind','itemId','before','after']);
 const operation=oneOf(x.operation,operations),field=nullable(x.field,v=>{const f=text(v,60);return /^[a-z][A-Za-z]{0,59}$/.test(f)?f:bad();});
 const itemKind=nullable(x.itemKind,v=>oneOf(v,['step','evidence','tag'] as const)),itemId=nullable(x.itemId,uuid),before=json(x.before),after=json(x.after);
 if((itemKind===null)!==(itemId===null)||(operation==='update')!==(field!==null))bad();
 if(operation==='update'&&(before===null&&after===null))bad();
 if((operation==='create'||operation==='attach')&&(before!==null||!isRow(after)))bad();
 if((operation==='remove'||operation==='detach')&&(after!==null||!isRow(before)))bad();
 if((operation==='attach'||operation==='detach')!==(itemKind==='tag'))bad();
 return {id:uuid(x.id),recordKind:oneOf(x.recordKind,journalKinds),recordId:uuid(x.recordId),operation,field,itemKind,itemId,before,after};
}
export function parseChangeLine(raw:unknown):ChangeLine{
 const x=object(raw);keys(x,['actorKind','actorId','actorName','causeKind','createdAt','changes','truncated']);
 const actorKind=oneOf(x.actorKind,['person','workflow','system'] as const),actorId=nullable(x.actorId,uuid);
 if(actorKind==='system'&&actorId!==null)bad();
 const changes=unique(array(x.changes,parseLineChange,50),c=>c.id),truncated=bool(x.truncated);if(truncated&&changes.length<50)bad();
 return {actorKind,actorId,actorName:nullable(x.actorName,v=>text(v,500)),causeKind:oneOf(x.causeKind,['request','workflow_run','routine','reversal','baseline'] as const),createdAt:instant(x.createdAt),changes,truncated};
}
/** A message, or a change line. Anything else (an approval card, R5) is refused with the page that holds it. */
export function parseMessage(raw: unknown): Message {
 const x=object(raw);const k=oneOf(x.kind,['message','change'] as const);
 if(k==='change'){
  keys(x,[...messageKeys,'changeSetId','change']);
  if(x.body!==null||x.editedAt!==null||x.deletedAt!==null||x.deletedBy!==null)bad();
  const change=parseChangeLine(x.change);if(change.actorKind==='system'?x.authorId!==null:false)bad();
  return {id:uuid(x.id),threadId:uuid(x.threadId),kind:'change',seq:integer(x.seq,1),changeSeq:integer(x.changeSeq,1),authorId:nullable(x.authorId,uuid),authorName:nullable(x.authorName,v=>text(v,500)),body:null,createdAt:instant(x.createdAt),editedAt:null,deletedAt:null,deletedBy:null,revision:integer(x.revision,1),changeSetId:uuid(x.changeSetId),change};
 }
 keys(x,messageKeys);
 const body=nullable(x.body,v=>text(v)),deletedAt=nullable(x.deletedAt,instant);if ((body===null)!==(deletedAt!==null) || body==='') bad();
 return {id:uuid(x.id),threadId:uuid(x.threadId),kind:'message',seq:integer(x.seq,1),changeSeq:integer(x.changeSeq,1),authorId:nullable(x.authorId,uuid),authorName:nullable(x.authorName,v=>text(v,500)),body,createdAt:instant(x.createdAt),editedAt:nullable(x.editedAt,instant),deletedAt,deletedBy:nullable(x.deletedBy,uuid),revision:integer(x.revision,1)};
}
export function parsePin(raw: unknown): Pin { const x=object(raw);keys(x,['id','messageId','pinnedBy','pinnedAt']);return {id:uuid(x.id),messageId:uuid(x.messageId),pinnedBy:nullable(x.pinnedBy,uuid),pinnedAt:instant(x.pinnedAt)}; }
export function parseChangedPin(raw:unknown){const p=object(raw);keys(p,['id','threadId','messageId','changeSeq','pinnedBy','pinnedAt','unpinnedBy','unpinnedAt']);return {...parsePin({id:p.id,messageId:p.messageId,pinnedBy:p.pinnedBy,pinnedAt:p.pinnedAt}),threadId:uuid(p.threadId),changeSeq:integer(p.changeSeq,1),unpinnedBy:nullable(p.unpinnedBy,uuid),unpinnedAt:nullable(p.unpinnedAt,instant)};}
export function parseCard(raw: unknown): Card {
 const x=object(raw);keys(x,['record','title','status','facts','fold']);
 const record=nullable(x.record,v=>{const r=object(v);keys(r,['kind','id']);return {kind:recordKind(r.kind),id:uuid(r.id)};});
 const f=object(x.fold),id=(v:unknown)=>nullable(v,uuid),words=(v:unknown)=>nullable(v,v=>text(v,16000));
 if(record?.kind==='task') {keys(f,['body','status','ownerId','ownerName','due','evidenceRequired','seriesId','open']);words(f.body);text(f.status,80);id(f.ownerId);words(f.ownerName);nullable(f.due,date);bool(f.evidenceRequired);id(f.seriesId);if(f.open!==null)bad();}
 else if(record?.kind==='booking') {keys(f,['equipmentId','equipmentName','kind','status','startsAt','endsAt','setupMinutes','cleanupMinutes','taskId','ownerId','ownerName','open']);uuid(f.equipmentId);text(f.equipmentName,500);text(f.kind,80);text(f.status,80);instant(f.startsAt);instant(f.endsAt);integer(f.setupMinutes,0,10080);integer(f.cleanupMinutes,0,10080);id(f.taskId);id(f.ownerId);words(f.ownerName);const o=object(f.open);keys(o,['kind','equipmentId']);if(o.kind!=='equipment'||uuid(o.equipmentId)!==f.equipmentId)bad();}
 else if(record?.kind==='stock') {keys(f,['location','unitLabel','currentCount','countedAt','reorderPoint','notes','archivedAt','open']);words(f.location);text(f.unitLabel,80);for(const k of ['currentCount','reorderPoint'])if(f[k]!==null&&!/^-?\d+(?:\.\d+)?$/.test(text(f[k],100)))bad();nullable(f.countedAt,instant);words(f.notes);nullable(f.archivedAt,instant);if(f.open!==null)bad();}
 else {keys(f,['createdBy','open']);id(f.createdBy);if(f.open!==null)bad();}
 return {record,title:text(x.title,500),status:nullable(x.status,v=>text(v,80)),facts:facts(x.facts),fold:{...f}};
}
export function parseDetail(raw: unknown): Detail {
 const x=object(raw);keys(x,['thread','card','tags','pin'],['participants']);const t=object(x.thread);keys(t,['id','kind','title','revision','lastSeq','lastChange','readPosition','unread','starred','createdAt']);
 const k=kind(t.kind);if ((k==='private')!==(x.participants!==undefined)) bad();
 return {thread:{id:uuid(t.id),kind:k,title:text(t.title,500),revision:integer(t.revision,1),lastSeq:integer(t.lastSeq),lastChange:integer(t.lastChange),readPosition:integer(t.readPosition,0,integer(t.lastSeq)),unread:integer(t.unread,0,51),starred:bool(t.starred),createdAt:instant(t.createdAt)},card:parseCard(x.card),tags:tags(x.tags),pin:nullable(x.pin,parsePin),...(x.participants===undefined?{}:{participants:unique(array(x.participants,v=>{const p=object(v);keys(p,['userId','name','addedAt']);return {userId:uuid(p.userId),name:text(p.name,500),addedAt:instant(p.addedAt)};},50),p=>p.userId)})};
}
export function parseMessages(raw: unknown): MessagePage {
 const x=object(raw);keys(x,['thread','messages','hasMore']);const t=object(x.thread);keys(t,['id','revision','lastSeq','lastChange']);
 const id=uuid(t.id),lastSeq=integer(t.lastSeq),lastChange=integer(t.lastChange),messages=unique(array(x.messages,parseMessage,100),m=>m.id);
 messages.forEach((m,i)=>{if(m.threadId!==id || m.seq>lastSeq || m.changeSeq>lastChange || (i>0&&messages[i-1]!.seq>=m.seq)) bad();});
 return {thread:{id,revision:integer(t.revision,1),lastSeq,lastChange},messages,hasMore:bool(x.hasMore)};
}
export function parseChanges(raw: unknown): Changes {
 const x=object(raw);keys(x,['thread','changes','next','complete']);const t=object(x.thread);keys(t,['id','revision','lastSeq','highWater']);
 const id=uuid(t.id),highWater=integer(t.highWater);
 const changes=array(x.changes,v=>{const c=object(v);const k=oneOf(c.kind,['message','pin']);keys(c,['changeSeq','kind',k]);const changeSeq=integer(c.changeSeq,1,highWater);
  if(k==='message'){const message=parseMessage(c.message);if(message.threadId!==id||message.changeSeq!==changeSeq)bad();return {changeSeq,kind:'message' as const,message};}
  const p=object(c.pin);keys(p,['id','threadId','messageId','changeSeq','pinnedBy','pinnedAt','unpinnedBy','unpinnedAt']);if(uuid(p.threadId)!==id||integer(p.changeSeq,1)!==changeSeq)bad();
  const pin={...parsePin({id:p.id,messageId:p.messageId,pinnedBy:p.pinnedBy,pinnedAt:p.pinnedAt}),threadId:id,changeSeq,unpinnedBy:nullable(p.unpinnedBy,uuid),unpinnedAt:nullable(p.unpinnedAt,instant)};return {changeSeq,kind:'pin' as const,pin};},100);
 changes.forEach((c,i)=>{if(i>0&&changes[i-1]!.changeSeq>=c.changeSeq)bad();});const next=integer(x.next,0,highWater),complete=bool(x.complete);if((complete&&next!==highWater)||(!complete&&(!changes.length||next!==changes.at(-1)!.changeSeq)))bad();
 return {thread:{id,revision:integer(t.revision,1),lastSeq:integer(t.lastSeq),highWater},changes,next,complete};
}
export const parseStar=(raw:unknown)=>{const x=object(raw);keys(x,['starred']);return {starred:bool(x.starred)};};
export const parseRead=(raw:unknown)=>{const x=object(raw);keys(x,['readPosition','unread']);return {readPosition:integer(x.readPosition),unread:integer(x.unread,0,51)};};
