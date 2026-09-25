import { api, load, type ApiError, type Member } from '../../../../lib/api.ts';
import type { Options } from '../../../work/records.ts';
import type { ReservationOptions } from '../ReservationForm.tsx';
export async function reservationLookups(token: string, org: string) {
 const [organisation,members,work]=await Promise.all([
 load(()=>api<{timezone:string}>(`/v1/organisations/${org}`,{token})),
 load(()=>api<{members:Member[]}>(`/v1/organisations/${org}/members`,{token})),
 load(()=>api<Options>(`/v1/organisations/${org}/work/options?limit=50`,{token}))]);
 const labels:Record<string,string>={};
 if(members.ok)for(const m of members.value.members)labels[m.userId]=m.name||m.email;
 if(work.ok)for(const c of [...work.value.projects.items,...work.value.tasks.items])labels[c.id]=c.label;
 const options:ReservationOptions={people:members.ok?members.value.members.filter(m=>m.status==='active').map(m=>({id:m.userId,label:m.name||m.email})):null,projects:work.ok?work.value.projects.items:null,tasks:work.ok?work.value.tasks.items:null};
 const problems=[members,work].filter((r):r is {ok:false;error:ApiError}=>!r.ok).map(r=>r.error.message);
 return {timeZone:organisation.ok?organisation.value.timezone:null,timeZoneError:organisation.ok?null:organisation.error,options,labels,problems};
}
