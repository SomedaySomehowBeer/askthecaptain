// Local review fixture: Perth civil dates; no booking writes or provider operations.
const equipmentFixture={
  names:['FV-02','BBT-01','Packaging','Cold room','Delivery van'],
  bookings:[
    {resource:0,title:'Summer lager',start:8/24,end:2+16/24,kind:'lager'},
    {resource:0,title:'Cleaning',start:3+8/24,end:3+9/24,kind:'blocked'},
    {resource:0,title:'Pale ale',start:3+10/24,end:3+15/24,kind:'pale'},
    {resource:1,title:'Summer lager',start:2+8/24,end:4+16/24,kind:'lager'},
    {resource:1,title:'Cleaning',start:4+16/24,end:4+17/24,kind:'blocked'},
    {resource:2,title:'Pale ale',start:3+9/24,end:3+12/24,kind:'pale'},
    {resource:2,title:'Cleaning',start:3+12/24,end:3+13/24,kind:'blocked'},
    {resource:2,title:'Maintenance',start:3+16/24,end:3+17/24,kind:'blocked'},
    {resource:3,title:'Pale ale',start:0,end:7,kind:'pale'},
    {resource:4,title:'Sample delivery',start:4+9/24,end:4+12/24,kind:'lager'}
  ]
};
function equipmentTimeline({icon,link}){
  return `<div class="title-row"><h1>Equipment</h1><button class="plus" data-sheet="reserve-equipment" aria-label="Reserve equipment">${icon('plus')}</button></div>
    <p class="subtitle">Shared availability · Perth time</p>
    <div class="time-scale" role="group" aria-label="Time scale"><button data-scale="hours">Hours</button><button data-scale="days" aria-pressed="true">Days</button><button data-scale="weeks">Weeks</button></div>
    <div class="allocation-range"><strong data-range>28 Sep–4 Oct</strong><span>Pinch to zoom time</span></div>
    <div class="equipment-navigation"><button data-equipment-shift="-1" aria-label="Previous equipment">${icon('back')}</button><span>Equipment <small>Swipe sideways for more</small></span><button data-equipment-shift="1" aria-label="Next equipment">${icon('chevron')}</button></div>
    <div class="allocation-scroll" tabindex="0" role="region" aria-label="Equipment timeline; scroll sideways for equipment and vertically for time"><div class="allocation-canvas"></div></div>
    <p class="allocation-note">Bookings span their actual time. Zoom in to inspect short reservations.</p>
    <div class="request-alert">${icon('alert')}<div><strong>Summer lager · Request unconfirmed</strong><p>1 Oct, 09:00–12:00 · Packaging overlaps Pale ale.</p><button class="timeline-detail-link" data-focus-conflict>Inspect 1 Oct by hour ${icon('arrow')}</button><a href="${link('task')}">Open linked task ${icon('arrow')}</a></div></div>`;
}
function mountEquipmentTimeline(phone,{icon}){
  const viewport=phone.querySelector('.allocation-scroll');if(!viewport)return;
  const canvas=viewport.querySelector('.allocation-canvas');
  const scaleNames=['weeks','days','hours'];const dayHeights={weeks:16,days:64,hours:576};
  let scale='days';let scheduled=false;
  const origin=Date.UTC(2026,8,28);
  const date=day=>new Date(origin+Math.floor(day)*86400000).toLocaleDateString('en-AU',{timeZone:'UTC',day:'numeric',month:'short'});
  const clock=day=>{const minutes=Math.round((day-Math.floor(day))*1440);return `${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;};
  const bookingLabel=b=>`${b.title}: ${date(b.start)} ${clock(b.start)} – ${date(b.end)} ${clock(b.end)}`;
  function updateRange(){
    const start=viewport.scrollTop/dayHeights[scale];
    let end=Math.min(27.999,start+(viewport.clientHeight-38)/dayHeights[scale]);if(scale==='weeks')end=Math.min(27.999,Math.ceil(end/7)*7-0.001);
    phone.querySelector('[data-range]').textContent=date(start)===date(end)?date(start):`${date(start)}–${date(end)}`;
    phone.querySelector('[data-equipment-shift="-1"]').disabled=viewport.scrollLeft<1;
    phone.querySelector('[data-equipment-shift="1"]').disabled=viewport.scrollLeft>=viewport.scrollWidth-viewport.clientWidth-1;
  }
  function render(){
    const h=dayHeights[scale],step=scale==='weeks'?7:1;
    const header=`<div class="allocation-head"><span>TIME</span>${equipmentFixture.names.map(n=>`<strong>${n}</strong>`).join('')}</div>`;
    const ticks=scale==='hours'?Array.from({length:28*24},(_,i)=>`<span style="top:${i*24}px">${i%24===0?date(i/24):String(i%24).padStart(2,'0')+':00'}</span>`).join(''):Array.from({length:28/step},(_,i)=>`<span style="top:${i*step*h}px">${date(i*step)}${scale==='weeks'?'<small>7 days</small>':''}</span>`).join('');
    const lanes=equipmentFixture.names.map((_,r)=>{
      const entries=equipmentFixture.bookings.map((b,i)=>({...b,id:i})).filter(b=>b.resource===r);
      const blocks=entries.map(b=>{
        const height=(b.end-b.start)*h;
        return `<button class="allocation-booking ${b.kind}${height<18?' brief':''}" data-booking="${b.id}" style="top:${b.start*h}px;height:${height}px" aria-label="${equipmentFixture.names[r]} · ${bookingLabel(b)}" title="${bookingLabel(b)}">${height>=18?`<strong>${b.title}</strong>`:''}${height>=36?`<small>${Math.floor(b.end)>Math.floor(b.start)?date(b.start)+'–'+date(b.end):clock(b.start)+'–'+clock(b.end)}</small>`:''}</button>`;
      }).join('');
      const conflict=r===2?`<button class="allocation-conflict" data-conflict-marker style="top:${(3+9/24)*h}px" aria-label="Unconfirmed Summer lager request clashes on 1 October; inspect by hour" title="Unconfirmed request · 1 Oct, 09:00–12:00">!</button>`:'';
      const available=r===2&&scale==='hours'?`<button class="allocation-booking free" data-sheet="available-slot" style="top:${(3+13/24)*h}px;height:${3/24*h}px"><strong>Available</strong><small>13:00–16:00</small></button>`:'';
      return `<div class="allocation-lane">${blocks}${available}${conflict}</div>`;
    }).join('');
    canvas.innerHTML=header+`<div class="allocation-body" style="height:${28*h}px;--tick:${scale==='hours'?24:step*h}px"><div class="allocation-axis">${ticks}</div>${lanes}</div>`;
    phone.querySelectorAll('[data-scale]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scale===scale)));
  }
  function zoom(next,anchorY=viewport.clientHeight/2){
    const anchorDay=(viewport.scrollTop+anchorY-38)/dayHeights[scale];const left=viewport.scrollLeft;
    scale=next;render();viewport.scrollTop=anchorDay*dayHeights[scale]-anchorY+38;viewport.scrollLeft=left;updateRange();
  }
  function showBooking(text){
    const overlay=phone.querySelector('.overlay');overlay.querySelector('h2').textContent='Reservation detail';
    overlay.querySelector('.sheet-body').textContent=text+' · Illustrative confirmed/unavailable period. This preview does not change reservations.';
    overlay.hidden=false;overlay.querySelector('.close').focus();
  }
  phone.querySelectorAll('[data-scale]').forEach(b=>b.addEventListener('click',()=>zoom(b.dataset.scale)));
  phone.querySelectorAll('[data-equipment-shift]').forEach(b=>b.addEventListener('click',()=>{viewport.scrollLeft+=Number(b.dataset.equipmentShift)*108;updateRange();}));
  function focusConflict(){scale='hours';render();viewport.scrollTop=(3+8/24)*dayHeights.hours;viewport.scrollLeft=216;updateRange();}
  phone.querySelector('[data-focus-conflict]').addEventListener('click',focusConflict);
  viewport.addEventListener('click',e=>{
    if(dragged){e.preventDefault();e.stopImmediatePropagation();dragged=false;return;}
    const booking=e.target.closest('[data-booking]');if(booking)showBooking(bookingLabel(equipmentFixture.bookings[Number(booking.dataset.booking)]));
    if(e.target.closest('[data-conflict-marker]'))focusConflict();
  },true);
  viewport.addEventListener('scroll',()=>{if(!scheduled){scheduled=true;requestAnimationFrame(()=>{updateRange();scheduled=false;});}});
  // Touch pan and pinch apply only inside this chart; page zoom elsewhere is unaffected.
  const pointers=new Map();let pinchDistance=0,pinchChanged=false,dragged=false;
  const separation=()=>{const [a,b]=[...pointers.values()];return Math.hypot(a.x-b.x,a.y-b.y);};
  viewport.addEventListener('pointerdown',e=>{if(e.pointerType!=='touch')return;dragged=false;pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});viewport.setPointerCapture(e.pointerId);if(pointers.size===2){pinchDistance=separation();pinchChanged=false;}});
  viewport.addEventListener('pointermove',e=>{
    if(!pointers.has(e.pointerId))return;
    const old=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===2){dragged=true;const distance=separation(),ratio=distance/pinchDistance;const direction=ratio>1.3?1:ratio<0.77?-1:0;const next=Math.max(0,Math.min(2,scaleNames.indexOf(scale)+direction));if(!pinchChanged&&direction&&scaleNames[next]!==scale){const points=[...pointers.values()];zoom(scaleNames[next],(points[0].y+points[1].y)/2-viewport.getBoundingClientRect().top);pinchDistance=distance;pinchChanged=true;}}
    else if(pointers.size===1){const dx=e.clientX-old.x,dy=e.clientY-old.y;if(Math.abs(dx)+Math.abs(dy)>2)dragged=true;viewport.scrollLeft-=dx;viewport.scrollTop-=dy;}
  });
  for(const name of ['pointerup','pointercancel','lostpointercapture'])viewport.addEventListener(name,e=>pointers.delete(e.pointerId));
  render();updateRange();
}
