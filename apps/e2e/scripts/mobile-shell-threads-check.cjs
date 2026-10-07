/** R2 T-B against contract-shaped synthetic API responses. No hosted thread or inference call. */
const { expect } = require('@playwright/test'); const path = require('node:path');
module.exports = async ({ browser, production, base, shots, width }) => {
 const context = await browser.newContext({viewport:{width,height:900}});
 try {
  const page=await context.newPage();page.setDefaultTimeout(15000);await page.clock.install();await page.bringToFront();
  const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const user=uuid(1),org=uuid(2),thread=uuid(11),tag=uuid(12),otherTag=uuid(13),author=uuid(99);
  const instant='2026-10-01T02:00:00.000Z';let readPosition=3,revision=1,starred=false,pin=null,mode='ok',listMode='ok',release;
  let messages=Array.from({length:65},(_,i)=>({id:uuid(i+100),threadId:thread,kind:'message',seq:i+1,changeSeq:i+1,authorId:author,authorName:'Pat Crew',body:`Message ${i+1}: check the packaging plan.`,createdAt:instant,editedAt:null,deletedAt:null,deletedBy:null,revision:1}));
  let lastChange=65,recordMode=false;
  const calls=[],writes=[],reads=[],errors=[],outside=[];
  const topicDetail=()=>({thread:{id:thread,kind:'topic',title:'Packaging plan',revision,lastSeq:messages.length,lastChange,readPosition,unread:Math.min(51,messages.filter(m=>m.seq>readPosition&&m.authorId!==user&&!m.deletedAt).length),starred,createdAt:instant},card:{record:null,title:'Packaging plan',status:null,facts:['Pat Crew',''],fold:{createdBy:author,open:null}},tags:[{id:tag,name:'Summer lager'}],pin:pin});
  const detail=()=>{const d=topicDetail();if(recordMode){d.thread.kind='record';d.card.record={kind:'task',id:user};d.card.fold={body:'Pack the cans carefully.',status:'open',ownerId:user,ownerName:'Sam Skipper',due:'2026-10-10',evidenceRequired:true,seriesId:null,open:null};}return d;};
  const row=id=>({id,kind:'topic',title:id===thread?'Packaging plan':'Other topic',record:null,status:null,facts:['Pat Crew',''],lastMessageAt:instant,lastMessage:{authorName:'Pat Crew',excerpt:'Check the packaging plan.'},unread:51,needsYou:true,starred:false,tags:[{id:tag,name:'Summer lager'},{id:otherTag,name:'Production'}]});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());if(![production.origin,base.origin].includes(url.origin)){outside.push(url.origin);return route.abort();}
   const json=(status,value,headers={})=>route.fulfill({status,contentType:'application/json',headers,body:JSON.stringify(value)});
   if(url.pathname.startsWith('/v1/')){
    calls.push(url.pathname+url.search);expect(req.headers()['x-captain-client']).toBe('web');expect(req.headers().authorization).toBeUndefined();
    if(url.pathname==='/v1/me')return json(200,{user:{id:user,name:'Sam Skipper',email:'sam@example.test'},memberships:[{organisationId:org,organisationName:'Harbour Brewing',role:'owner',status:'active'}],passkeyVerified:true});
    if(url.pathname==='/v1/me/passkeys')return json(200,{available:false,passkeys:[]});
    if(mode==='lost')return json(404,{code:'not_found'});
    if(url.pathname.endsWith('/threads')){
     if(listMode==='failed')return json(503,{}, {'retry-after':'5'});
     if(listMode==='hold')return new Promise(resolve=>{release=async()=>{listMode='ok';await json(200,{filter:'all',available:true,threads:[],nextCursor:null,groups:[]});resolve();};});
     const filter=url.searchParams.get('filter');expect(url.searchParams.get('limit')).toBe('50');
     return json(200,{filter,available:true,threads:filter==='tasks'?[]:url.searchParams.has('after')?[row(uuid(14))]:[row(thread)],nextCursor:filter==='tasks'||url.searchParams.has('after')?null:'second-page',groups:filter==='tasks'?[]:[{key:tag,label:'Summer lager',threads:2,needsYou:2,owner:{id:user,name:'Sam Skipper'},startsOn:'2026-10-01',endsOn:'2026-10-10'},{key:otherTag,label:'Production',threads:2,needsYou:2}]});
    }
    if(url.pathname.endsWith('/'+thread))return json(200,detail());
    if(url.pathname.endsWith('/changes')){const after=Number(url.searchParams.get('after'));const changes=messages.filter(m=>m.changeSeq>after).sort((a,b)=>a.changeSeq-b.changeSeq).map(message=>({changeSeq:message.changeSeq,kind:'message',message}));return json(200,{thread:{id:thread,revision,lastSeq:messages.length,highWater:lastChange},changes:changes.slice(0,100),next:changes.length>100?changes[99].changeSeq:lastChange,complete:changes.length<=100});}
    if(url.pathname.endsWith('/read')){const {seq}=req.postDataJSON();reads.push(seq);readPosition=Math.max(readPosition,seq);return json(200,{readPosition:readPosition,unread:0});}
    if(req.method()==='GET'&&url.pathname.endsWith('/messages')){
     const after=Number(url.searchParams.get('after')??0),before=Number(url.searchParams.get('before')??Infinity),limit=Number(url.searchParams.get('limit')??50),rows=messages.filter(m=>m.seq>after&&m.seq<before);
     const selected=url.searchParams.has('latest')?rows.slice(-50):url.searchParams.has('before')?rows.slice(-limit):rows.slice(0,limit);
     return json(200,{thread:{id:thread,revision,lastSeq:messages.length,lastChange},messages:selected,hasMore:rows.length>selected.length});
    }
    if(req.method()!=='GET'){
     const body=req.postData()?req.postDataJSON():{};writes.push({method:req.method(),path:url.pathname,body});
     if(mode==='unknown')return json(503,{}, {'retry-after':'5'});
     if(mode==='rate')return json(429,{}, {'retry-after':'5'});
     if(url.pathname.endsWith('/star')){starred=req.method()==='POST';return json(200,{starred});}
     if(url.pathname.endsWith('/pin')){pin=req.method()==='DELETE'?null:{id:uuid(900),messageId:body.messageId,pinnedBy:user,pinnedAt:instant};return json(200,{...(pin??{id:uuid(900),messageId:body.messageId??messages.at(-1).id,pinnedBy:user,pinnedAt:instant}),threadId:thread,changeSeq:++lastChange,unpinnedBy:req.method()==='DELETE'?user:null,unpinnedAt:req.method()==='DELETE'?instant:null});}
     if(url.pathname.endsWith('/messages')){const old=messages.find(m=>m.id===body.id);if(old)return json(200,old);const message={...messages[0],id:body.id,body:body.body,authorId:user,authorName:'Sam Skipper',seq:messages.length+1,changeSeq:++lastChange};messages.push(message);return json(201,message);}
     const target=messages.find(m=>url.pathname.endsWith('/'+m.id));if(target){expect(req.method()==='DELETE'?Number(url.searchParams.get('expectedRevision')):body.expectedRevision).toBe(target.revision);target.revision++;target.changeSeq=++lastChange;if(req.method()==='PATCH'){target.body=body.body;target.editedAt=instant;}else{target.body=null;target.deletedAt=instant;target.deletedBy=user;if(pin?.messageId===target.id)pin=null;}return json(200,target);}
    }
    return json(503,{});
   }
   const upstream=new URL(url);if(upstream.hostname==='localhost')upstream.hostname='127.0.0.1';return route.fetch({url:upstream.href,maxRedirects:0}).then(response => route.fulfill({ response })).catch(() => { /* the page closed with the file in flight (a font swapping in) */ });
  });
  page.on('pageerror',e=>errors.push(e.message));const id=n=>page.getByTestId(n).filter({visible:true});const go=p=>page.goto(new URL(p,production).href);
  const shot=async name=>{if(shots)await page.screenshot({path:path.join(shots,`${width}-threads-${name}.png`),fullPage:true});};
  const overflow=async()=>expect(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-innerWidth)).toBeLessThanOrEqual(1);
  await go('/');await expect(id(`thread-row-${thread}`)).toHaveCount(2);await expect(id(`thread-group-${tag}`)).toContainText('2 threads');await overflow();await shot('list');
  await id(`thread-group-${tag}`).click();await expect(id(`thread-row-${thread}`)).toHaveCount(1);await page.reload();await expect(id(`thread-group-${tag}`)).toHaveAttribute('aria-expanded','false');await id(`thread-group-${tag}`).click();
  await id('threads-more').click();await expect(id(`thread-row-${uuid(14)}`)).toHaveCount(2);await id('threads-filter-2').click();await expect(id('threads-empty')).toBeVisible();await id('threads-filter-0').click();
  await id(`thread-row-${thread}`).first().click();await expect(id('thread-unread-line')).toBeVisible();expect(calls.some(p=>p.includes('/messages?after=2&limit=50'))).toBe(true);
  const line=await id('thread-unread-line').boundingBox(),area=await id('thread-messages').boundingBox();expect(line.y).toBeGreaterThanOrEqual(area.y-2);expect(line.y).toBeLessThan(area.y+area.height);
  await overflow();await shot('unread');
  await id('thread-card-fold').click();await expect(id('thread-details')).toContainText('Make this a task');await id('thread-card-fold').click();
  await id(`message-menu-${uuid(103)}`).click();await expect(page.getByRole('button',{name:'Edit message',exact:true})).toHaveCount(0);await id(`message-menu-${uuid(103)}`).click();
  const beforeCard=await id('thread-card').boundingBox();await id('thread-messages').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.clock.fastForward(16000);await expect.poll(()=>reads.some(seq=>seq>4)).toBe(true);const afterCard=await id('thread-card').boundingBox();expect(afterCard.y).toBe(beforeCard.y);
  await id('thread-newer').click();await expect(id(`message-${uuid(164)}`)).toBeVisible();await page.clock.fastForward(16000);await id('thread-messages').evaluate(el=>{el.scrollTop=el.scrollHeight;});await page.clock.fastForward(16000);await expect.poll(async()=>{if(!reads.includes(65))await page.clock.fastForward(16000);return reads.includes(65);}).toBe(true);
  mode='rate';await id('thread-composer').fill('Rate limited draft');await id('thread-send').click();await expect(id('composer-status')).toContainText('still editable');await id('thread-composer').fill('Ready for packaging');await expect(id('thread-send')).toBeDisabled();mode='ok';await page.clock.fastForward(5100);
  await id('thread-composer').fill('Ready for packaging');await id('thread-send').click();await expect(id('thread-composer')).toHaveValue('');const own=messages.at(-1);await expect(id(`message-${own.id}`)).toBeVisible();
  await id(`message-menu-${own.id}`).click();await page.getByRole('button',{name:'Edit message',exact:true}).click();await id('message-edit').fill('Packaging is ready');await page.getByRole('button',{name:'Save edited message',exact:true}).click();await expect(id('thread-status')).toContainText('confirmed');await page.getByRole('button',{name:'Close editor',exact:true}).click();await expect(id(`message-${own.id}`)).toContainText('Packaging is ready');
  await id('thread-star').click();await expect(id('thread-star')).toHaveAttribute('aria-label','Unstar thread');
  await page.getByRole('button',{name:'Pin message',exact:true}).click();await expect(id('thread-pin')).toContainText('Packaging is ready');await id('thread-pin').click();
  await id(`message-menu-${own.id}`).click();await page.getByRole('button',{name:'Delete message',exact:true}).click();await expect(id(`message-${own.id}`)).toContainText('Message deleted');await expect(id('thread-pin')).toHaveCount(0);
  recordMode=true;await page.reload();await id('thread-card-fold').click();await expect(id('thread-details')).toContainText('Pack the cans carefully.');await expect(id('thread-details')).toContainText('Evidence required');await id('thread-card-fold').click();recordMode=false;await page.reload();
  mode='unknown';await id('thread-composer').fill('Keep this exact message');await id('thread-send').click();await expect(id('composer-status')).toContainText('may have been sent');await expect(id('thread-composer')).toHaveAttribute('readonly','');const pending=writes.at(-1).body;await page.clock.fastForward(5100);
  mode='ok';await page.reload();await expect(id('thread-send')).toHaveAttribute('aria-label','Retry same message');await id('thread-send').click();await expect(id('thread-composer')).toHaveValue('');expect(writes.filter(w=>w.path.endsWith('/messages')).at(-1).body).toEqual(pending);
  const stored=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));expect(JSON.stringify(stored)).not.toContain('Keep this exact');expect(JSON.stringify(stored)).not.toContain(thread);expect(JSON.stringify(stored)).not.toContain('Packaging plan');
  mode='lost';await page.clock.fastForward(16000);await expect(id('thread-status')).toContainText('no longer available');await expect(id('thread-composer')).toHaveCount(0);mode='ok';
  await go('/');await expect(id(`thread-row-${thread}`)).toHaveCount(2);listMode='failed';await page.reload();await expect(id('threads-status')).toContainText('Could not load');await expect(id(`thread-row-${thread}`)).toHaveCount(0);listMode='ok';await page.clock.fastForward(16000);await expect(id(`thread-row-${thread}`)).toHaveCount(2);
  for(const [scenario,target]of[['threads-loaded','threads-list'],['threads-empty','threads-empty'],['threads-failed','threads-status'],['threads-wait','threads-status'],['threads-unavailable','threads-status']]){await page.goto(new URL(`/?scenario=${scenario}`,base).href);await expect(id(target)).toBeVisible();await overflow();}
  await page.goto(new URL(`/threads/${thread}?scenario=threads-lost`,base).href);await expect(id('thread-status')).toContainText('no longer available');
  expect(errors).toEqual([]);expect(outside).toEqual([]);console.log(`PASS ${width}px: grouped/folded/paged threads, filters, first unread, visible reads, fixed card, send/edit/delete/pin/star, persisted uncertain send, lost access and harness states`);
 }finally{await context.close();}
};
