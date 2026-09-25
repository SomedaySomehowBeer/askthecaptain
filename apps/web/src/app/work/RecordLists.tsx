import Link from 'next/link';
import { TaskListFeedback } from './TaskListFeedback.tsx';
import { TaskCheckRow } from './ChecklistItem.tsx';
import type { WorkPage } from './types.ts';
import type { Loaded } from '../../lib/api.ts';
import { Notice } from '../../components/Notice.tsx';
export function TaskList({result,href,offset=0}:{result:Loaded<WorkPage>;href:string;offset?:number}){return <TaskListFeedback><section className="card stack"><h2>Tasks</h2>{!result.ok?<Notice tone="failed">{result.error.message}</Notice>:<>{result.value.tasks.length?<ul className="bare work-list">{result.value.tasks.map(t=><TaskCheckRow key={`${t.id}-${t.revision}`} task={t} parentHref={`${href}${href.includes('?')?'&':'?'}offset=${offset}`} variant="task"><span className="work-task__title">{t.title}</span><span className="work-task__meta">{t.status.replaceAll('_',' ')} · {t.due??'No date'}</span></TaskCheckRow>)}</ul>:<p>No tasks on this page.</p>}<div className="row">{offset>0?<Link href={`${href}${href.includes('?')?'&':'?'}offset=${Math.max(0,offset-50)}`}>Previous</Link>:null}{result.value.nextOffset!==null?<Link href={`${href}${href.includes('?')?'&':'?'}offset=${result.value.nextOffset}`}>Next tasks</Link>:null}</div></>}</section></TaskListFeedback>;}
