'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '../../lib/api.ts';
import { actionSession } from '../../lib/session.ts';
import type { Options } from './records.ts';
export type Result = { ok: true; href: string } | { ok: false; error: string; locked?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (f:FormData,k:string) => String(f.get(k) ?? '').trim();
export async function findWorkOptions(q:string, projectOffset=0, taskOffset=0, projectId?:string|null):Promise<Options | {error:string}> {
 const s=await actionSession();if(!s.ok)return {error:s.error};
 if(q.length>100 || ![projectOffset,taskOffset].every(n=>Number.isInteger(n)&&n>=0&&n<=1000000))return {error:'Search is not valid.'};
 if(projectId!==undefined&&projectId!==null&&!uuid.test(projectId))return {error:'Project selection is not valid.'};
 try{return await api<Options>(`/v1/organisations/${s.org}/work/options?${new URLSearchParams({q,projectOffset:String(projectOffset),taskOffset:String(taskOffset),limit:'50',...(projectId===undefined?{}:{projectId:projectId??'none'})})}`,{token:s.token});}
 catch{return {error:'Work choices could not be read. Your current selection is kept.'};}
}
export async function saveRecord(form:FormData):Promise<Result> {
 const s=await actionSession();if(!s.ok)return {ok:false,error:s.error};
 const kind=text(form,'kind'), id=text(form,'id'), operation=text(form,'operation');
 if(!['tasks','projects','series'].includes(kind)||(id&&!uuid.test(id)))return {ok:false,error:'This record is not valid.'};
 const revision=Number(text(form,'expectedRevision'));
 if(id&&(!Number.isSafeInteger(revision)||revision<1))return {ok:false,error:'Reload this record before editing.',locked:true};
 let path=`/v1/organisations/${s.org}/${kind}${id?`/${id}`:''}`;let method=id?'PATCH':'POST';
 const body:Record<string,unknown>=id?{expectedRevision:revision}:{};
 if(operation==='checklist') {path=`/v1/organisations/${s.org}/tasks`;method='POST';delete body.expectedRevision;Object.assign(body,{parentId:id,expectedParentRevision:revision,title:text(form,'title')});}
 else if(operation==='evidence') {path+= '/evidence';method='POST';Object.assign(body,{kind:'url',reference:text(form,'reference'),label:text(form,'label')});}
 else if(operation==='remove-evidence') {const evidenceId=text(form,'evidenceId');if(!uuid.test(evidenceId))return {ok:false,error:'This evidence is not valid.'};path=`/v1/organisations/${s.org}/evidence/${evidenceId}?expectedRevision=${revision}`;method='DELETE';}
 else if(operation==='status')body.status=text(form,'status');
 else if(kind==='tasks')Object.assign(body,{title:text(form,'title'),body:text(form,'body'),ownerId:text(form,'ownerId')||null,projectId:text(form,'projectId')||null,due:text(form,'due')||null});
 else if(kind==='projects')Object.assign(body,{name:text(form,'name'),description:text(form,'description'),...(id?{archived:form.get('archived')==='on',stage:text(form,'stage')}:{})});
 else Object.assign(body,{title:text(form,'title'),body:text(form,'body'),ownerId:text(form,'ownerId')||null,projectId:text(form,'projectId')||null,recurrence:text(form,'recurrence'),everyMonths:text(form,'recurrence')==='custom'?Number(text(form,'everyMonths')):null,anchor:text(form,'anchor'),dueOffsetDays:Number(text(form,'dueOffsetDays')),evidenceRequired:form.get('evidenceRequired')==='on',...(id?{paused:form.get('paused')==='on'}:{})});
 try {
  const value=await api<{id:string}>(path,{token:s.token,method,...(method==='DELETE'?{}:{body})});
  revalidatePath('/work','layout');revalidatePath('/resources/equipment','layout');
  return {ok:true,href:`/work/${kind}/${id||value.id}`};
 } catch(e) {
  if(e instanceof ApiError&&e.status>=400&&e.status<500)return {ok:false,error:e.code==='stale_revision'?'This record changed since you opened it. Your changes were not saved. Reload to review the latest version.':e.message,locked:e.code==='stale_revision'};
  return {ok:false,error:'The save could not be confirmed. Check the record or list before trying again.',locked:true};
 }
}
