'use client';
import { useId, useState, useTransition } from 'react';
import { findWorkOptions } from './record-actions.ts';
import type { Choice, Options } from './records.ts';
/** Search and paging leave selected IDs in place, including choices outside the current page. */
export function WorkPicker({kind='projects',name='projectId',initial,initialLabel,choices,empty='No project',disabled=false,onChange,projectId}:{kind?:'projects'|'tasks';name?:string;initial?:string|null;initialLabel?:string;choices?:Choice[]|null;empty?:string;disabled?:boolean;onChange?:(id:string)=>void;projectId?:string|null}) {
 const id=useId();const [selected,setSelected]=useState(initial??'');const [selectedLabel,setLabel]=useState(initialLabel??'Current selection');const [q,setQ]=useState('');const [page,setPage]=useState<Options|null>(null);const [error,setError]=useState('');const [pending,start]=useTransition();
 const items=page? page[kind].items : choices??[];
 function search(offset=0){start(async()=>{try{const r=await findWorkOptions(q,kind==='projects'?offset:0,kind==='tasks'?offset:0,kind==='tasks'?projectId:undefined);if('error'in r)setError(r.error);else{setPage(r);setError('');}}catch{setError('Choices could not be read. Your selection is kept.');}});}
 return <div className="field"><label htmlFor={id}>{kind==='projects'?'Project':'Task'}</label>
 <select id={id} name={name} value={selected} disabled={disabled} onChange={e=>{setSelected(e.target.value);setLabel(items.find(v=>v.id===e.target.value)?.label??'Current selection');onChange?.(e.target.value);}}><option value="">{empty}</option>{selected&&!items.some(v=>v.id===selected)?<option value={selected}>{selectedLabel}</option>:null}{items.map(v=><option key={v.id} value={v.id}>{v.label}</option>)}</select>
 <details><summary>Find more {kind==='projects'?'projects':'tasks'}</summary><label htmlFor={`${id}-q`}>Search by name</label><div className="row"><input id={`${id}-q`} value={q} maxLength={100} disabled={disabled||pending} onChange={e=>setQ(e.target.value)}/><button type="button" className="button button--secondary" disabled={disabled||pending} onClick={()=>search()}>Search</button></div>{page&&page[kind].items.length===0?<p>No matches.</p>:null}{page&&page[kind].nextOffset!==null?<button type="button" className="button button--ghost" disabled={disabled||pending} onClick={()=>search(page[kind].nextOffset!)}>Next choices</button>:null}<p className="muted">Results are paged. Search again to return to the first page; your selection stays selected.</p></details>
 {pending?<p role="status">Reading choices…</p>:null}{error?<p role="alert">{error}</p>:null}</div>;
}
