import { writeFile, readFile, unlink } from 'node:fs/promises';
import { freshDatabase } from '../../../packages/db/test/harness.ts';
import { createApp } from '../src/app.ts';
import { AuthService } from '../src/auth/service.ts';
import { OrganisationService } from '../src/organisations/service.ts';
import { CommitmentsService } from '../src/commitments/service.ts';
import { NotesService } from '../src/notes/service.ts';
import { serve } from '@hono/node-server';
// Manual browser fixture only: never imported by the application or started against hosted data.
const directory = process.env.WORKSPACE_PROBE_DIR;
if (!directory) throw new Error('Set WORKSPACE_PROBE_DIR to a private temporary directory.');
const db = await freshDatabase();
try {
const google = { next: {subject:'workspace-owner',email:'olive@example.test',name:'Olive Owner'}, authorizationUrl:({state})=>`https://google.test/?state=${state}`, async exchange(){return this.next} };
const app = createApp({db:db.app,auth:new AuthService(db.app,google,{appUrl:'http://127.0.0.1:3034',sessionTtlDays:1}),organisations:new OrganisationService(db.app),commitments:new CommitmentsService(db.app),notes:new NotesService(db.app)});
async function request(method,path,token,body) {const res=await app.request(path,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});const data=await res.json();if(!res.ok)throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(data)}`);return data;}
async function login(){const a=await app.request('/auth/google/start');const state=new URL(a.headers.get('location')).searchParams.get('state');const b=await app.request(`/auth/google/callback?code=test&state=${state}`);const code=new URL(b.headers.get('location')).searchParams.get('code');return request('POST','/auth/session/exchange',null,{code});}
const owner=await login(); const org=await request('POST','/v1/organisations',owner.token,{name:'Workspace test bakery'}); const base=`/v1/organisations/${org.id}`;
const invitation=await request('POST',`${base}/invitations`,owner.token,{email:'pat@example.test',role:'member'});
google.next={subject:'workspace-pat',email:'pat@example.test',name:'Pat Baker'}; const pat=await login();await request('POST','/v1/invitations/accept',pat.token,{token:invitation.token});
const project=await request('POST',`${base}/projects`,owner.token,{name:'Autumn launch'});
const production=await request('POST',`${base}/tags`,owner.token,{name:'Production'});const sales=await request('POST',`${base}/tags`,owner.token,{name:'Sales'});
const tasks={};for(const [title,status,who,tag] of [['Confirm packaging slot','open',owner.user.id,production.id],['Call the stockist','open',pat.user.id,sales.id],['Completed launch task','done',owner.user.id,null],['Cancelled launch task','cancelled',owner.user.id,null],['Unassigned launch task','open',null,null]]) {const task=await request('POST',`${base}/tasks`,owner.token,{title,status,ownerId:who,projectId:project.id});tasks[title]=task.id;if(tag)await request('PUT',`${base}/tasks/${task.id}/tags/${tag}`,owner.token);}
for (let i = 0; i < 50; i++) await request('POST', `${base}/tasks`, owner.token, { title: `Team follow-up ${i + 1}`, projectId: project.id, ownerId: pat.user.id });
await writeFile(`${directory}/data.json`,JSON.stringify({fixture:'captain-workspace-local',token:owner.token,userId:owner.user.id,orgId:org.id,base,projectId:project.id,productionId:production.id,salesId:sales.id,tasks}),{mode:0o600,flag:'wx'});
const server=serve({hostname:'127.0.0.1',port:8084,fetch:async(req)=>{const mode=await readFile(`${directory}/mode`,'utf8').catch(()=> '');const url=new URL(req.url);if(req.method==='GET'&&url.pathname.endsWith('/tasks')) {if(mode==='failed')return Response.json({error:'Fixture task query unavailable'},{status:503});if(mode==='slow')await new Promise(r=>setTimeout(r,1800));}return app.fetch(req);}});
console.log('Workspace fixture ready on 8084');
async function close(){server.close();await db.close();await unlink(`${directory}/data.json`);process.exit(0)}process.on('SIGTERM',close);process.on('SIGINT',close);
} catch(error) { await db.close(); throw error; }
