'use client';
import Link from 'next/link';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Equipment, ReservationRange } from './types.ts';
import { interval, scales, zoomScroll, type Scale } from './geometry.ts';
import { displayTime, shiftDate, zonedDay } from './time.ts';
export type Lane = { equipment: Equipment; result: { ok: true; value: ReservationRange } | { ok: false; message: string } };
type Props = { lanes: Lane[]; date: string; span: number; from: string; to: string; zone: string; initialScale: Scale; offset: number; nextOffset: number | null };
const headerHeight = 52;
const labels: Record<Scale, string> = { hours: 'Hours', days: 'Days', weeks: 'Weeks' };
export function Timeline({ lanes, date, span, from, to, zone, initialScale, offset, nextOffset }: Props) {
 const [scale, setScale] = useState<Scale>(initialScale), [selected, setSelected] = useState(lanes[0]?.equipment.id ?? '');
 const [edges, setEdges] = useState({ left: true, right: false });
 const viewport = useRef<HTMLDivElement>(null), anchor = useRef<{ top: number; left: number } | null>(null);
 const pointers = useRef(new Map<number, { x: number; y: number }>()), pinch = useRef(0), dragged = useRef(false);
 const height = (Date.parse(to) - Date.parse(from)) / 86_400_000 * scales[scale];
 function href(values: { date?: string; offset?: number; span?: number; scale?: Scale } = {}) {
  return '/resources/equipment?' + new URLSearchParams({ date: values.date ?? date, span: String(values.span ?? span), offset: String(values.offset ?? offset), scale: values.scale ?? scale });
 }
 const detail = (equipmentId: string, reservationId: string) => `/resources/equipment/${equipmentId}/reservations/${reservationId}`;
 const reserve = selected ? '/resources/equipment/new?' + new URLSearchParams({ equipmentId: selected, date }) : '/resources/equipment/manage';
 function updateEdges() { const view = viewport.current; if (view) setEdges({ left: view.scrollLeft < 1, right: view.scrollLeft >= view.scrollWidth - view.clientWidth - 1 }); }
 useLayoutEffect(() => {
  const view = viewport.current; if (!view) return;
  if (anchor.current) { view.scrollTop = anchor.current.top; view.scrollLeft = anchor.current.left; anchor.current = null; }
  updateEdges(); const observer = new ResizeObserver(updateEdges); observer.observe(view); return () => observer.disconnect();
 }, [scale, lanes.length]);
 function zoom(next: Scale, at?: number) {
  const view = viewport.current; if (!view || next === scale) return;
  anchor.current = { top: zoomScroll(view.scrollTop, at ?? view.clientHeight / 2, scales[scale], scales[next], headerHeight), left: view.scrollLeft };
  setScale(next);
  // Keep browser/tab history meaningful without refetching the same occupancy on every pinch.
  window.history.replaceState(null, '', href({ scale: next }));
 }
 const ticks = useMemo(() => {
  const result: { at: number; label: string }[] = [], start = Date.parse(from), finish = Date.parse(to);
  if (scale === 'hours') {
   const formatter = new Intl.DateTimeFormat('en-AU', { timeZone: zone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
   for (let at = start; at < finish; at += 3_600_000) result.push({ at, label: formatter.format(at) });
  } else for (let d = 0; d < span; d += scale === 'weeks' ? 7 : 1) {
   try { const at = Date.parse(zonedDay(shiftDate(date, d), zone)); result.push({ at, label: new Intl.DateTimeFormat('en-AU', { timeZone: zone, day: 'numeric', month: 'short' }).format(at) }); }
   catch { /* A skipped civil date occupies no elapsed time and has no midnight tick. */ }
  }
  return result;
 }, [from, to, date, span, zone, scale]);
 const selection = lanes.find(lane => lane.equipment.id === selected)?.equipment;
 const adjacent = (days: number) => { try { return shiftDate(date, days); } catch { return null; } };
 const previousDate = adjacent(-span), nextDate = adjacent(span);
 return <>
  <div className="equipment-toolbar"><Link className="button button--secondary" href="/resources/equipment/manage">Manage equipment</Link><a className="button button--secondary" href={href()}>Refresh availability</a></div>
  <details className="equipment-dates"><summary>Change dates or window</summary><form className="equipment-window" method="get" action="/resources/equipment">
   <input name="offset" type="hidden" value={offset} /><input name="scale" type="hidden" value={scale} />
   <div className="field"><label htmlFor="equipment-date">Starting date</label><input id="equipment-date" name="date" type="date" required defaultValue={date} /></div>
   <div className="field"><label htmlFor="equipment-span">Window</label><select id="equipment-span" name="span" defaultValue={span}><option value="1">1 day</option><option value="7">7 days</option><option value="14">14 days</option><option value="28">28 days</option></select></div>
   <button className="button button--secondary" type="submit">Show dates</button>
  </form></details>
  <div className="equipment-toolbar equipment-scale" role="group" aria-label="Time scale">{(Object.keys(scales) as Scale[]).map(value => <button key={value} className="button button--secondary" aria-pressed={scale === value} onClick={() => zoom(value)}>{labels[value]}</button>)}</div>
  <nav className="equipment-toolbar equipment-date-nav" aria-label="Schedule dates">{previousDate ? <Link href={href({ date: previousDate })} aria-label="Previous dates">‹</Link> : <span>Start of supported dates</span>}<strong>{date} – {shiftDate(date, span - 1)}</strong>{nextDate ? <Link href={href({ date: nextDate })} aria-label="Next dates">›</Link> : <span>End of supported dates</span>}</nav>
  {!lanes.length ? <div className="card notice"><h2>{offset ? 'No equipment on this page.' : 'Add your first equipment'}</h2><p>{offset ? 'Return to the first equipment page or manage the catalogue.' : 'Add a machine, room or vehicle, then reserve its time here.'}</p><Link className="button button--primary" href={offset ? href({ offset: 0 }) : '/resources/equipment/manage'}>{offset ? 'First equipment page' : 'Add equipment'}</Link></div> : <>
   <div className="equipment-navigation"><button className="button button--secondary" aria-label="Previous equipment" disabled={edges.left} onClick={() => viewport.current?.scrollBy({ left: -168, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>‹</button><span>Equipment <small>Scroll sideways · Pinch to zoom time</small></span><button className="button button--secondary" aria-label="Next equipment" disabled={edges.right} onClick={() => viewport.current?.scrollBy({ left: 168, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}>›</button></div>
   <p className="muted">Selected: {selection?.name}. Tap a column to select; + reserves it.</p>
   <div className="equipment-viewport" ref={viewport} role="region" tabIndex={0} aria-label="Equipment timeline; scroll sideways for equipment and vertically for time" data-scale={scale} onScroll={updateEdges}
    onClickCapture={event => { if (dragged.current) { event.preventDefault(); event.stopPropagation(); dragged.current = false; } }}
    onPointerDown={event => { if (event.pointerType !== 'touch') return; if (!pointers.current.size) dragged.current = false; pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (pointers.current.size === 2) { const [a, b] = [...pointers.current.values()]; pinch.current = Math.hypot(a!.x - b!.x, a!.y - b!.y); } }}
    onPointerMove={event => {
     const previous = pointers.current.get(event.pointerId), view = viewport.current; if (!previous || !view) return;
     const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
     pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
     if (Math.abs(dx) + Math.abs(dy) > 2) { dragged.current = true; view.setPointerCapture(event.pointerId); }
     if (pointers.current.size === 1) { view.scrollLeft -= dx; view.scrollTop -= dy; return; }
     const [a, b] = [...pointers.current.values()], distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
     const order: Scale[] = ['weeks', 'days', 'hours'], i = order.indexOf(scale), ratio = distance / pinch.current;
     if (pinch.current && (ratio > 1.25 || ratio < 0.8)) { const next = order[Math.max(0, Math.min(2, i + (ratio > 1 ? 1 : -1)))]!; zoom(next, (a!.y + b!.y) / 2 - view.getBoundingClientRect().top); pinch.current = distance; }
    }}
    onPointerUp={event => { pointers.current.delete(event.pointerId); pinch.current = 0; }} onPointerCancel={event => { pointers.current.delete(event.pointerId); pinch.current = 0; }}>
    <div className="equipment-canvas" style={{ width: 100 + lanes.length * 168 }}>
     <div className="equipment-head"><span>Time</span>{lanes.map(({ equipment }) => <button key={equipment.id} aria-pressed={selected === equipment.id} onClick={() => setSelected(equipment.id)}>{equipment.name}</button>)}</div>
     <div className="equipment-body" style={{ height }}>
      <div className="equipment-axis">{ticks.map(t => <span key={t.at} style={{ top: (t.at - Date.parse(from)) / 86_400_000 * scales[scale] }}>{t.label}</span>)}</div>
      {lanes.map(({ equipment, result }) => {
       const partial = result.ok && result.value.coverage !== 'complete';
       return <div key={equipment.id} className={`equipment-lane${!result.ok || partial ? ' equipment-lane--unknown' : ''}`} data-equipment={equipment.id} data-coverage={result.ok ? result.value.coverage : 'failed'}>
        {ticks.map(t => <span key={t.at} className="equipment-gridline" style={{ top: (t.at - Date.parse(from)) / 86_400_000 * scales[scale] }} />)}
        {!result.ok || partial ? <span className="equipment-unknown">{result.ok ? 'Partial · narrow dates' : 'Not loaded'}</span> : null}
        {result.ok ? result.value.reservations.map(booking => {
         const occupied = interval(booking.occupiedStartsAt, booking.occupiedEndsAt, from, to, scales[scale]); if (!occupied) return null;
         const actual = interval(booking.startsAt, booking.endsAt, from, to, scales[scale]);
         const text = `${equipment.name} · ${booking.title} · ${displayTime(booking.startsAt, zone)} to ${displayTime(booking.endsAt, zone)} · setup ${booking.setupMinutes} min, cleanup ${booking.cleanupMinutes} min`;
         return <Link key={booking.id} href={detail(equipment.id, booking.id)} className={`equipment-booking${booking.kind === 'maintenance' ? ' equipment-booking--maintenance' : ''}${occupied.height < 24 ? ' equipment-booking--short' : ''}`} style={{ top: occupied.top, height: occupied.height }} aria-label={text} title={text}>
          {actual ? <span className="equipment-booking__actual" style={{ top: actual.top - occupied.top, height: actual.height }} /> : null}
          {occupied.height >= 24 ? <strong>{booking.title}</strong> : null}{occupied.height >= 65 ? <small>{booking.kind === 'maintenance' ? 'Maintenance' : 'Confirmed'}{booking.setupMinutes || booking.cleanupMinutes ? ' · includes buffers' : ''}</small> : null}
         </Link>;
        }) : null}
       </div>;
      })}
     </div>
    </div>
   </div>
   <p className="muted">Only the displayed date window is loaded. Other dates are unknown. Bands include setup and cleanup; zoom in or use the list below for short reservations. Availability can change before you save.</p>
   <div className="equipment-reservations"><h2>Reservations in this window</h2>{lanes.map(({ equipment, result }) => <section className="card" key={equipment.id} aria-label={`${equipment.name} reservations`}>
    <h3>{equipment.name}</h3>
    {!result.ok ? <p className="form__error" role="alert">Reservations could not be read: {result.message} Availability is unknown; refresh to retry.</p> : <>
     {result.value.coverage !== 'complete' ? <p className="form__error">Not every reservation was loaded. Narrow the date window and refresh; gaps are not confirmed free.</p> : !result.value.reservations.length ? <p className="muted">No confirmed reservations in this loaded window.</p> : null}
     <ul className="equipment-booking-list">{result.value.reservations.map(booking => <li key={booking.id}><Link href={detail(equipment.id, booking.id)}>{booking.title}</Link><span>{booking.kind === 'maintenance' ? 'Maintenance' : 'Confirmed'} · {displayTime(booking.startsAt, zone)} – {displayTime(booking.endsAt, zone)}</span><small>Setup {booking.setupMinutes} min · cleanup {booking.cleanupMinutes} min</small></li>)}</ul>
    </>}
   </section>)}</div>
  </>}
  <nav className="equipment-toolbar" aria-label="Equipment pages">{offset > 0 ? <Link href={href({ offset: Math.max(0, offset - 8) })}>Previous equipment page</Link> : null}{nextOffset !== null ? <Link href={href({ offset: nextOffset })}>More equipment</Link> : null}</nav>
  <Link className="equipment-plus" href={reserve} aria-label={selected ? `Reserve equipment: ${selection?.name}` : 'Add equipment'}><span aria-hidden="true">+</span></Link>
 </>;
}
