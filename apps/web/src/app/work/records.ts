import type { Project, Task } from '../../lib/api.ts';
export type Choice = { id: string; label: string };
export type Options = { projects: { items: Choice[]; nextOffset: number | null }; tasks: { items: (Choice & {projectId: string | null})[]; nextOffset: number | null } };
export type TaskDetail = { task: Task; project: Project | null; parent: {id:string;title:string} | null; series: {id:string;title:string} | null; checklist: {tasks:Task[];nextOffset:number|null}; evidenceNextOffset:number|null; tags:{items:{id:string;name:string}[];nextOffset:number|null};today:string;timezone:string };
export const offset = (value: string | string[] | undefined) => typeof value === 'string' && /^\d+$/.test(value) ? Math.min(Number(value), 1000000) : 0;
