import type { Detail, Group, Message, Row, ThreadList } from './contracts.ts';
export function groupedRows(list:ThreadList): {group:Group;rows:Row[]}[] {return list.groups.map(group=>({group,rows:list.threads.filter(row=>group.key==='none'?row.tags.length===0:row.tags.some(tag=>tag.id===group.key))}));}
export const firstName=(name:string|null)=>name?.trim().split(/\s+/)[0]||'Former member';
export const unreadLabel=(count:number)=>count>50?'50+':String(count);
/** A quiet line (owner decision, 3 October 2026; threads contract §6): the system's creation of the thread's record, with
 *  only what was created or attached with it (a series occurrence's tags). It shows, but is never unread. The API counts
 *  it the same way. */
export function quietLine(m:Message):boolean {const c=m.change;return m.kind==='change'&&c!==undefined&&c.actorKind==='system'&&c.changes.some(x=>x.operation==='create'&&x.itemKind===null)&&c.changes.every(x=>x.operation==='create'||x.operation==='attach');}
export function firstUnread(messages:readonly Message[],position:number,userId:string):Message|null {return messages.find(m=>m.seq>position&&m.authorId!==userId&&m.deletedAt===null&&!quietLine(m))??null;}
export const initialMessages=(detail:Detail)=>detail.thread.unread>50?{after:Math.max(0,detail.thread.readPosition-1),limit:50}:{latest:50};
export function mergeMessages(old:readonly Message[],next:readonly Message[]):Message[]{const map=new Map(old.map(m=>[m.id,m]));for(const m of next){const old=map.get(m.id);if(!old||m.changeSeq>old.changeSeq)map.set(m.id,m);}return [...map.values()].sort((a,b)=>a.seq-b.seq);}
export function hasGap(messages:readonly Message[]):boolean {return messages.some((m,i)=>i>0&&m.seq!==messages[i-1]!.seq+1);}
/** A change line records what changed: it has no menu (no edit, delete or pin; the API refuses each with 409). */
export function messagePowers(message:Message,userId:string,role:string){const live=message.deletedAt===null&&message.kind==='message';return {edit:live&&message.authorId===userId,delete:live&&(message.authorId===userId||role==='owner'||role==='admin'),pin:live&&(role==='owner'||role==='admin')};}
export function recordRoute(detail:Detail):'/equipment'|null{return detail.card.record?.kind==='booking'?'/equipment':null;}
export const validBody=(value:string)=>{const body=value.trim();return body.length>0&&[...body].length<=4000&&new TextEncoder().encode(body).length<=16000;};

export function cardDetails(card:Detail['card']):string[]{const f=card.fold,lines:string[]=[];for(const k of ['body','notes'])if(typeof f[k]==='string'&&f[k])lines.push(f[k]);for(const [key,label]of [['location','Location'],['unitLabel','Unit'],['currentCount','Count'],['countedAt','Counted'],['reorderPoint','Reorder point'],['startsAt','Starts'],['endsAt','Ends'],['setupMinutes','Setup minutes'],['cleanupMinutes','Cleanup minutes'],['ownerName','Owner']] as const){const value=f[key];if(typeof value==='string'||typeof value==='number')lines.push(`${label}: ${value}`);}if(f.evidenceRequired===true)lines.push('Evidence required');return lines;}
