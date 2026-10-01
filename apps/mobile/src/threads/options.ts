import type { ReadScope } from '../account/contracts.ts';
import { parseMembers, type Member } from '../account/members.ts';
import { organisationPath, isCanonicalInstant } from '../api/paths.ts';
import type { ThreadCalls } from './api.ts';
import { queryPath } from './api.ts';
import { array, integer, keys, object, text, uuid } from './parse.ts';
import type { Tag } from './contracts.ts';
export type TagPage={tags:Tag[];nextOffset:number|null};
export function parseTagPage(raw:unknown):TagPage{
 const x=object(raw);keys(x,['tags','nextOffset']);
 const tags=array(x.tags,raw=>{const t=object(raw);keys(t,['id','name','createdAt','updatedAt'],['ownerId','startsOn','endsOn','createdBy','revision','archivedAt']);
  for(const k of ['createdAt','updatedAt','archivedAt'])if(t[k]!==undefined&&t[k]!==null&&!isCanonicalInstant(t[k]))throw new TypeError('invalid tag time');
  for(const k of ['ownerId','createdBy'])if(t[k]!==undefined&&t[k]!==null)uuid(t[k]);
  for(const k of ['startsOn','endsOn'])if(t[k]!==undefined&&t[k]!==null&&(typeof t[k]!=='string'||!isCanonicalInstant(`${t[k]}T00:00:00.000Z`)))throw new TypeError('invalid tag date');
  if(t.revision!==undefined)integer(t.revision,1);
  return {id:uuid(t.id),name:text(t.name,200),archived:t.archivedAt!==undefined&&t.archivedAt!==null};
 },100);if(new Set(tags.map(t=>t.id)).size!==tags.length)throw new TypeError('duplicate tags');
 return {tags:tags.filter(t=>!t.archived).map(({id,name})=>({id,name})),nextOffset:x.nextOffset===null?null:integer(x.nextOffset,0,1_000_000)};
}
export type OptionsState<T>={rows:readonly T[];busy:boolean;loaded:boolean;message:string;waitUntil:number;nextOffset:number|null};
export function createOptions<K extends 'members'|'tags'>(calls:ThreadCalls,scope:ReadScope,kind:K,now:()=>number){
 type Row=K extends 'members'?Member:Tag;
 let live=true;let state:OptionsState<Row>={rows:[],busy:false,loaded:false,message:'',waitUntil:0,nextOffset:null};const listeners=new Set<()=>void>();
 const active=()=>live&&calls.current(scope),set=(s:typeof state)=>{if(active()){state=s;listeners.forEach(f=>f());}};
 return {snapshot:()=>state,subscribe(f:()=>void){listeners.add(f);return()=>{listeners.delete(f);};},dispose(){live=false;listeners.clear();},
  async load(more=false){if(!active()||state.busy||now()<state.waitUntil||(more&&state.nextOffset===null))return;const offset=more?state.nextOffset!:0;set({...state,busy:true,message:''});
   const result=kind==='members'?await calls.request(scope,'GET',organisationPath(scope.organisationId,'members'),undefined,v=>({rows:parseMembers(v).filter(m=>m.userId!==scope.userId),nextOffset:null})):await calls.request(scope,'GET',queryPath(organisationPath(scope.organisationId,'tags'),{offset,limit:50}),undefined,v=>{const p=parseTagPage(v);if(p.nextOffset!==null&&p.nextOffset<=offset)throw new TypeError('tag cursor did not advance');return {rows:p.tags,nextOffset:p.nextOffset};});
   if(!active()||result.kind==='stale')return;
   if(result.kind==='error'){set({...state,busy:false,loaded:false,rows:[],nextOffset:null,waitUntil:now()+Math.max(15,result.retryAfter)*1000,message:result.status===404?'These choices are no longer available.':`Could not load ${kind}. Wait, then try again.`});return;}
   const rows=result.value.rows as unknown as readonly Row[];const old=more?state.rows:[],ids=new Set(old.map(r=>'userId'in r?r.userId:r.id));set({rows:[...old,...rows.filter(r=>!ids.has('userId'in r?r.userId:r.id))],busy:false,loaded:true,message:'',waitUntil:0,nextOffset:result.value.nextOffset});
  }
 };
}
