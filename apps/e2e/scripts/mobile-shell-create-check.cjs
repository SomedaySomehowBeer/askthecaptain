/** T-C synthetic contract browser checks. Privacy here is client handling, not RLS proof. */
const {expect}=require('@playwright/test');const path=require('node:path');
module.exports=async({browser,production,base,shots,width})=>{
 const context=await browser.newContext({viewport:{width,height:900}});
 try{
  const page=await context.newPage();await page.clock.install();await page.bringToFront();page.setDefaultTimeout(15000);
  const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const user=uuid(1),second=uuid(4),member=uuid(3),org=uuid(2),tag=uuid(12),instant='2026-10-01T00:00:00.000Z';
  let actor=user,mode='ok',tagConflict=false;const threads=new Map(),writes=[],errors=[],outside=[];
  const details=t=>({thread:{id:t.id,kind:t.kind,title:t.title,revision:t.revision,lastSeq:1,lastChange:1,readPosition:0,unread:0,starred:false,createdAt:instant},card:{record:null,title:t.title,status:null,facts:['Sam Skipper',t.kind==='private'?`${t.people.length} people`:''],fold:{createdBy:user,open:null}},tags:t.tags,pin:null,...(t.kind==='private'?{participants:t.people.map(userId=>({userId,name:userId===user?'Sam Skipper':'Pat Crew',addedAt:instant}))}:{})});
  const msg=t=>({id:t.message.id,threadId:t.id,kind:'message',seq:1,changeSeq:1,authorId:user,authorName:'Sam Skipper',body:t.message.body,createdAt:instant,editedAt:null,deletedAt:null,deletedBy:null,revision:1});
  const visible=t=>t.kind==='topic'||t.people.includes(actor);
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(![production.origin,base.origin].includes(url.origin)){outside.push(url.origin);return route.abort();}
   const json=(status,value,headers={})=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(value)});
   if(url.pathname.startsWith('/v1/')){
    expect(req.headers()['x-captain-client']).toBe('web');expect(req.headers().authorization).toBeUndefined();
    if(url.pathname==='/v1/me')return json(200,{user:{id:actor,name:actor===user?'Sam Skipper':'Jo Crew',email:'person@example.test'},memberships:[{organisationId:org,organisationName:'Harbour Brewing',role:'member',status:'active'}],passkeyVerified:true});
    if(url.pathname==='/v1/me/passkeys')return json(200,{available:false,passkeys:[]});
    if(url.pathname.endsWith('/members'))return json(200,{members:[user,member,second].map(userId=>({userId,name:userId===member?'Pat Crew':userId===user?'Sam Skipper':'Jo Crew',email:`member${userId.slice(-1)}@example.test`,role:'member',status:'active',since:instant}))});
    if(url.pathname===`/v1/organisations/${org}/tags`)return json(200,{tags:[{id:tag,name:'Summer lager',createdAt:instant,updatedAt:instant,ownerId:null,startsOn:null,endsOn:null,archivedAt:null,revision:1,createdBy:user}],nextOffset:null});
    if(url.pathname.endsWith('/threads')){
     if(req.method()==='POST'){
      const body=req.postDataJSON();writes.push({kind:'create',body});expect(body.message.body).toBeTruthy();expect(body.links).toBeUndefined();
      if(mode==='rate')return json(429,{}, {'retry-after':'5'});
      if(mode==='refused')return json(409,{code:'thread_id_unavailable'});
      if(!threads.has(body.id))threads.set(body.id,{...body,title:body.kind==='private'?body.title:body.message.body.split('\n')[0].slice(0,80),people:[actor,...(body.participantIds??[])],revision:1,tags:[]});
      if(mode==='unknown')return json(503,{}, {'retry-after':'5'});
      return json(201,details(threads.get(body.id)));
     }
     const rows=[...threads.values()].filter(visible).map(t=>({id:t.id,kind:t.kind,title:t.title,record:null,facts:details(t).card.facts,status:null,lastMessageAt:instant,lastMessage:{authorName:'Sam Skipper',excerpt:t.message.body.slice(0,120)},unread:0,needsYou:false,starred:false,tags:t.tags}));
     return json(200,{filter:url.searchParams.get('filter')??'all',available:true,threads:rows,nextCursor:null,groups:rows.length?[{key:'none',label:'Other',threads:rows.length,needsYou:0}]:[]});
    }
    const t=[...threads.values()].find(t=>url.pathname.includes('/threads/'+t.id));if(!t||!visible(t))return json(404,{code:'not_found'});
    if(url.pathname.includes('/tags/')){const revision=req.method()==='DELETE'?Number(url.searchParams.get('expectedRevision')):req.postDataJSON().expectedRevision;writes.push({kind:'tag',method:req.method(),revision});expect(revision).toBe(t.revision);if(tagConflict){tagConflict=false;t.revision++;return json(409,{code:'stale_revision'});}t.revision++;t.tags=req.method()==='POST'?[{id:tag,name:'Summer lager'}]:[];return json(200,details(t));}
    if(url.pathname.endsWith('/messages'))return json(200,{thread:{id:t.id,revision:t.revision,lastSeq:1,lastChange:1},messages:[msg(t)],hasMore:false});
    if(url.pathname.endsWith('/changes'))return json(200,{thread:{id:t.id,revision:t.revision,lastSeq:1,highWater:1},changes:[],next:1,complete:true});
    if(url.pathname.endsWith('/read'))return json(200,{readPosition:1,unread:0});
    return json(200,details(t));
   }
   const upstream=new URL(url);if(upstream.hostname==='localhost')upstream.hostname='127.0.0.1';return route.fulfill({response:await route.fetch({url:upstream.href,maxRedirects:0})});
  });
  page.on('pageerror',e=>errors.push(e.message));const id=n=>page.getByTestId(n).filter({visible:true}),go=p=>page.goto(new URL(p,production).href);
  const overflow=async()=>expect(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth)).toBeLessThanOrEqual(1);
  const shot=async name=>{if(shots)await page.screenshot({path:path.join(shots,`${width}-create-${name}.png`),fullPage:true});};
  await go('/');await id('threads-new').click();await expect(id('new-thread-body')).toBeFocused();await expect(id('new-thread-send')).toBeDisabled();await id('new-thread-body').fill('Prepare the packaging run');await overflow();await shot('topic');await id('new-thread-send').click();await expect(id('thread-card')).toContainText('Prepare the packaging run');expect(writes[0].body.kind).toBe('topic');expect(writes[0].body.participantIds).toBeUndefined();
  await id('thread-card-fold').click();await expect(id('tag-add-'+tag)).toBeVisible();tagConflict=true;await id('tag-add-'+tag).click();await expect(id('thread-status')).toContainText('changed');expect(writes.filter(w=>w.kind==='tag')).toHaveLength(1);await id('tag-add-'+tag).click();await expect(id('tag-remove-'+tag)).toBeVisible();await id('tag-remove-'+tag).click();await expect(id('tag-add-'+tag)).toBeVisible();await overflow();
  await go('/threads/new');await id('new-thread-body').fill('Private supplier discussion');await id('new-thread-private').click();await id('new-thread-title').fill('Supplier prices');await id('new-member-'+member).click();await expect(id('new-member-'+user)).toHaveCount(0);await overflow();await shot('private');
  mode='unknown';await id('new-thread-send').click();await expect(id('new-thread-status')).toContainText('may have been created');const pending=writes.at(-1).body;await expect(id('new-thread-body')).toHaveAttribute('readonly','');await expect(id('new-thread-private')).toBeDisabled();const count=writes.length;await page.reload();await expect(id('new-thread-send')).toHaveAttribute('aria-label','Retry same thread');expect(writes.length).toBe(count);mode='ok';await page.clock.fastForward(5100);await id('new-thread-send').click();await expect(id('thread-card')).toContainText('Supplier prices');expect(writes.at(-1).body).toEqual(pending);expect(pending.participantIds).toEqual([member]);
  expect(await page.evaluate(()=>JSON.stringify({...sessionStorage}))).not.toContain('Private supplier discussion');
  await go('/');await expect(id('thread-row-'+pending.id)).toBeVisible();actor=second;await page.reload();await expect(id('thread-row-'+pending.id)).toHaveCount(0);await expect(page.getByText('Supplier prices',{exact:true})).toHaveCount(0);await go('/threads/'+pending.id);await expect(id('thread-status')).toContainText('no longer available');await expect(page.getByText('Private supplier discussion',{exact:true})).toHaveCount(0);await expect(id('thread-composer')).toHaveCount(0);actor=user;
  await go('/threads/new');await id('new-thread-body').fill('Try later');mode='rate';await id('new-thread-send').click();await expect(id('new-thread-status')).toContainText('still editable');const limited=writes.at(-1).body;await id('new-thread-body').fill('Edited after wait');await expect(id('new-thread-send')).toBeDisabled();await page.clock.fastForward(5100);mode='refused';await id('new-thread-send').click();await expect(id('new-thread-status')).toContainText('ID cannot');expect(writes.at(-1).body.id).toBe(limited.id);await id('new-thread-new-ids').click();mode='ok';await id('new-thread-send').click();await expect(id('thread-card')).toContainText('Edited after wait');expect(writes.at(-1).body.id).not.toBe(limited.id);
  for(const [scenario,target]of[['threads-new','new-thread-body'],['threads-new-empty','new-members-empty'],['threads-new-failed','new-members-status'],['threads-new-wait','new-members-status']]){await page.goto(new URL(`/threads/new?scenario=${scenario}`,base).href);if(scenario!=='threads-new')await id('new-thread-private').click();await expect(id(target)).toBeVisible();await overflow();}
  await page.goto(new URL('/threads/new?scenario=threads-new-refused',base).href);await id('new-thread-body').fill('Keep this');await id('new-thread-send').click();await expect(id('new-thread-new-ids')).toBeVisible();await id('new-thread-discard').click();
  await page.goto(new URL('/threads/new?scenario=threads-new-pending',base).href);await id('new-thread-body').fill('Pending');await id('new-thread-send').click();await expect(id('new-thread-status')).toContainText('Creating');await expect(id('new-thread-send')).toBeDisabled();
  expect(errors).toEqual([]);expect(outside).toEqual([]);console.log(`PASS ${width}px: new topic/private creation, focused composer, member choices, locked create retry, same IDs on 429, explicit conflict restart, revision-checked tags, second-person private absence and harness states`);
 }finally{await context.close();}
};
