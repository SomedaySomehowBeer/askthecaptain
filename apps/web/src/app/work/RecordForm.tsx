'use client';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode, type FormEvent } from 'react';
import { saveRecord, type Result } from './record-actions.ts';
export function RecordForm({kind,id,revision,operation,children,label='Save changes'}:{kind:'tasks'|'projects'|'series';id?:string;revision?:number;operation?:string;children:ReactNode;label?:string}) {
 const router=useRouter();const [result,setResult]=useState<Result|null>(null);const [pending,start]=useTransition();const locked=pending||(result!==null&&!result.ok&&!!result.locked);
 function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(locked)return;const data=new FormData(e.currentTarget);start(async()=>{let r:Result;try{r=await saveRecord(data);}catch{r={ok:false,error:'The save could not be confirmed. Check the record before trying again.',locked:true};}setResult(r);if(r.ok){router.push(r.href);router.refresh();}});}
 return <form className="form" method="post" onSubmit={submit} aria-busy={pending||undefined}>
 <input type="hidden" name="kind" value={kind}/><input type="hidden" name="id" value={id??''}/><input type="hidden" name="expectedRevision" value={revision??''}/><input type="hidden" name="operation" value={operation??''}/>
 <fieldset disabled={locked} className="work-new__fields">{children}<button className="button button--primary" disabled={locked}>{pending?'Saving…':label}</button></fieldset>
 {result&&!result.ok?<div role="alert"><p className="form__error">{result.error}</p>{result.locked?<a href={id?`/work/${kind}/${id}`:`/work/${kind==='tasks'?'':kind}`}>Reload saved work</a>:null}</div>:null}
 </form>;
}
