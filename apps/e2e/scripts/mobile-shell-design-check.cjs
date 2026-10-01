/** T-E presentation evidence: same synthetic data before/after; no business behaviour or hosted API. */
const {expect}=require('@playwright/test');const path=require('node:path');
module.exports=async({browser,production,shots,width,before=false})=>{
 const context=await browser.newContext({viewport:{width,height:900},colorScheme:'light'});
 try{
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.bringToFront();const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const user=uuid(1),org=uuid(2),thread=uuid(11),tag=uuid(12),instant='2026-10-01T02:00:00.000Z';let failed=false;
  const messages=Array.from({length:16},(_,i)=>({id:uuid(100+i),threadId:thread,kind:'message',seq:i+1,changeSeq:i+1,authorId:uuid(3),authorName:i%2?'Maya Chen':'Tom Reilly',body:i%2?'The labels are ready. We can book the canning line for Thursday.':'Labels are delayed. The printer says Wednesday now, not Monday.',createdAt:instant,editedAt:null,deletedAt:null,deletedBy:null,revision:1}));
  await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());const json=(status,value)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.origin!==production.origin)return route.abort();
   if(url.pathname==='/v1/me')return json(200,{user:{id:user,name:'Maya Chen',email:'maya@example.test'},memberships:[{organisationId:org,organisationName:'Tidewater Brewing',role:'owner',status:'active'}],passkeyVerified:true});
   if(url.pathname==='/v1/me/passkeys')return json(200,{available:false,passkeys:[]});
   if(url.pathname.startsWith('/v1/')){
    if(failed)return json(503,{});
    if(url.pathname.endsWith('/members'))return json(200,{members:[]});
    if(url.pathname.endsWith('/tags'))return json(200,{tags:[],nextOffset:null});
    if(url.pathname.endsWith('/threads'))return json(200,{filter:url.searchParams.get('filter')??'all',available:true,nextCursor:null,groups:[{key:tag,label:'Summer lager',threads:3,needsYou:2,owner:{id:user,name:'Maya'},startsOn:'2026-10-01',endsOn:'2026-10-10'}],threads:[['Package summer lager','In progress','Maya · Due Tue 6 Oct','Scheduler: The booking is ready.',3],['Plan summer lager launch','Done','Tom · 5 of 5 steps','Agreed. Launch is Fri 16 Oct.',0],['Brew sheet, Batch 214','Ready','Tom · 14 of 16 values','Saved 14 values from the photo.',1]].map(([title,status,fact,excerpt,unread],i)=>({id:i?uuid(20+i):thread,kind:'record',title,record:{kind:'task',id:uuid(40+i)},status,facts:fact.split(' · '),lastMessageAt:instant,lastMessage:{authorName:'Tom Reilly',excerpt},unread,needsYou:unread>0,starred:false,tags:[{id:tag,name:'Summer lager'}]}))});
    if(url.pathname.endsWith('/messages'))return json(200,{thread:{id:thread,revision:1,lastSeq:16,lastChange:16},messages,hasMore:false});
    if(url.pathname.endsWith('/changes'))return json(200,{thread:{id:thread,revision:1,lastSeq:16,highWater:16},changes:[],next:16,complete:true});
    if(url.pathname.endsWith('/read'))return json(200,{readPosition:req.postDataJSON().seq,unread:0});
    return json(200,{thread:{id:thread,kind:'record',title:'Package summer lager',revision:1,lastSeq:16,lastChange:16,readPosition:0,unread:16,starred:false,createdAt:instant},card:{record:{kind:'task',id:uuid(40)},title:'Package summer lager',status:'In progress',facts:['Maya Chen','Tue 6 Oct'],fold:{body:'Use the new labels.',status:'in_progress',ownerId:user,ownerName:'Maya Chen',due:'2026-10-06',evidenceRequired:false,seriesId:null,open:null}},tags:[{id:tag,name:'Summer lager'}],pin:null});
   }
   const upstream=new URL(url);upstream.hostname='127.0.0.1';return route.fulfill({response:await route.fetch({url:upstream.href})});
  });
  const id=name=>page.getByTestId(name).filter({visible:true});const shot=async name=>{if(shots)await page.screenshot({path:path.join(shots,`${width}-${before?'before':'after'}-${name}.png`)});};
  const overflow=async()=>expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(1);
  await page.goto(new URL('/',production).href);await expect(id(`thread-row-${thread}`)).toBeVisible();await overflow();await shot('list');
  if(!before){await expect(id('threads-refresh')).toHaveCount(0);await expect(page.getByText('Maya · 1–10 Oct',{exact:true})).toBeVisible();const row=id(`thread-row-${thread}`);expect(await row.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');expect(await row.evaluate(el=>el.parentElement.querySelectorAll('[data-testid^="thread-row-"]').length)).toBe(3);expect(await row.evaluate(el=>getComputedStyle(el).borderBottomWidth)).toBe('1px');}
  await id(`thread-row-${thread}`).click();await expect(id('thread-unread-line')).toBeVisible();await overflow();await shot('thread');
  if(!before){await expect(id('thread-refresh')).toHaveCount(0);const card=await id('thread-card').boundingBox(),star=await id('thread-star').boundingBox();expect(card.height).toBeLessThanOrEqual(110);expect(star.y+star.height).toBeLessThanOrEqual(card.y+2);await expect(id('thread-star')).toHaveAttribute('aria-label','Star thread');const a=await id('thread-fact-0').boundingBox(),b=await id('thread-fact-1').boundingBox();expect(a.y).toBe(b.y);expect(Math.abs(a.width-b.width)).toBeLessThanOrEqual(1);const input=await id('thread-composer').boundingBox(),send=await id('thread-send').boundingBox();expect(send.x).toBeGreaterThan(input.x+input.width-1);expect(send.y).toBeLessThan(input.y+input.height);expect(await id('thread-messages').evaluate(el=>getComputedStyle(el).scrollbarWidth)).toBe('none');expect(await id('message-'+uuid(100)).evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(255, 255, 255)');const divider=await id('message-'+uuid(100)).locator('[aria-hidden="true"]').evaluate(el=>({left:getComputedStyle(el).left,right:getComputedStyle(el).right,height:getComputedStyle(el).height}));expect(divider).toEqual({left:'12px',right:'12px',height:'1px'});}
  await page.goto(new URL('/threads/new',production).href);await expect(id('new-thread-body')).toBeFocused();await id('new-thread-body').fill('Book the canning line Thursday afternoon for the lager run');await overflow();await shot('new');
  if(!before){const input=await id('new-thread-body').boundingBox(),send=await id('new-thread-send').boundingBox();expect(send.x).toBeGreaterThan(input.x+input.width-1);expect(send.y).toBeLessThan(input.y+input.height);await id('new-thread-private').click();await expect(page.getByRole('button',{name:'Refresh members',exact:true})).toBeVisible();await shot('private');
   await id('new-thread-body').fill('One\nTwo\nThree\nFour\nFive\nSix\nSeven');await expect.poll(async()=> (await id('new-thread-body').boundingBox()).height).toBeGreaterThan(input.height);expect((await id('new-thread-body').boundingBox()).height).toBeLessThanOrEqual(120);
   failed=true;await page.goto(new URL('/',production).href);await expect(id('threads-status')).toContainText('Could not load');await expect(id('threads-refresh')).toHaveText('Try again');expect((await id('threads-refresh').boundingBox()).width).toBeLessThan(100);
   await page.goto(new URL('/threads/'+thread,production).href);await expect(id('thread-status')).toContainText('Could not load');await expect(id('thread-refresh')).toHaveText('Try again');expect((await id('thread-refresh').boundingBox()).width).toBeLessThan(100);
  }
  expect(errors).toEqual([]);
  console.log(`PASS ${width}px: ${before?'baseline screenshots':'dense grouped rows, readable dates, compact card/facts/header star, white messages, hidden scrollbar, inline composers and screenshots'}`);
 }finally{await context.close();}
};
