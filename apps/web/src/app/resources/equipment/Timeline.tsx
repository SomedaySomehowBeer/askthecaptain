'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Equipment } from './types.ts';
import { interval, scales, zoomScroll, type Scale } from './geometry.ts';
import { displayTime, shiftDate, todayInZone } from './time.ts';
import { DAY, chunkDays, chunksBetween, dateAt, dayStart, renderWindow, ticks as axisTicks, type ScheduleRange, type TimeWindow } from './range.ts';
import { cellOf, combined, finish, plan, reservationsBetween, retry, seed, start, stateOf, type CellState, type Cells, type LaneRead } from './loads.ts';
import { readOccupancy } from './occupancy.ts';
type Props = { equipment: Equipment[]; range: ScheduleRange; initial: Record<string, LaneRead>; zone: string; initialScale: Scale; offset: number; nextOffset: number | null };
const headerHeight = 52;
const labels: Record<Scale, string> = { hours: 'Hours', days: 'Days', weeks: 'Weeks' };
/** Days moved by the previous/next date arrows at each scale. */
const steps: Record<Scale, number> = { hours: 1, days: 7, weeks: 28 };
const unknownWords: Record<Exclude<CellState, 'complete'>, string> = { unloaded: 'Not loaded yet', loading: 'Loading…', failed: 'Could not load', partial: 'Partial · not every reservation shown' };
const shifted = (date: string, days: number) => { try { return shiftDate(date, days); } catch { return null; } };
/** A typed date's first instant, or null when it is invalid or skipped (the server then refuses it). */
const startOf = (date: string, zone: string) => { try { return dayStart(date, zone); } catch { return null; } };
const motion =(): ScrollBehavior => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
const dayFormats = new Map<string, Intl.DateTimeFormat>();
function dayLabel(date: string, zone: string) {
 const at = dayStart(date, zone); if (!at) return date;
 let format = dayFormats.get(zone);
 if (!format) { format = new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }); dayFormats.set(zone, format); }
 return format.format(Date.parse(at));
}

export function Timeline({ equipment, range, initial, zone, initialScale, offset, nextOffset }: Props) {
 const router = useRouter();
 const startMs = Date.parse(range.start), endMs = Date.parse(range.end), anchorMs = Date.parse(range.anchorAt);
 const ids = useMemo(() => equipment.map(e => e.id), [equipment]);
 const [scale, setScale] = useState<Scale>(initialScale), [selected, setSelected] = useState(equipment[0]?.id ?? '');
 const [edges, setEdges] = useState({ left: true, right: false, top: false, bottom: false });
 // Before the first measurement, assume the designed viewport height opened at the anchor date.
 const [rendered, setRendered] = useState<TimeWindow>(() => renderWindow(null, anchorMs, anchorMs + (560 - headerHeight) / scales[initialScale] * DAY, startMs, endMs));
 const [visible, setVisible] = useState({ top: range.anchor, bottom: range.anchor });
 const [cells, setCells] = useState<Cells>(() => seed(range.anchorChunk, initial));
 const [settled, setSettled] = useState(0), [zoneChanged, setZoneChanged] = useState<string | null>(null);
 const viewport = useRef<HTMLDivElement>(null), anchor = useRef<{ top: number; left: number } | null>({ top: (anchorMs - startMs) / DAY * scales[initialScale], left: 0 });
 const scaleNow = useRef(scale), frame = useRef(0), busy = useRef(false), requests = useRef(0), alive = useRef(true);
 const pointers = useRef(new Map<number, { x: number; y: number }>()), pinch = useRef(0), dragged = useRef(false);
 const px = scales[scale] / DAY, y = (at: number) => (at - startMs) * px;

 function href(values: { date?: string; offset?: number; scale?: Scale } = {}) {
  return '/resources/equipment?' + new URLSearchParams({ date: values.date ?? visible.top, offset: String(values.offset ?? offset), scale: values.scale ?? scale });
 }
 const detail = (equipmentId: string, reservationId: string) => `/resources/equipment/${equipmentId}/reservations/${reservationId}`;
 const reserve = selected ? '/resources/equipment/new?' + new URLSearchParams({ equipmentId: selected, date: visible.top }) : '/resources/equipment/manage';

 /** Read the scroll position into the few values rendering depends on. Each setter bails out
  *  when nothing changed, so ordinary scrolling does not re-render the timeline. */
 function measure(reset = false) {
  frame.current = 0;
  const view = viewport.current; if (!view) return;
  const perMs = scales[scaleNow.current] / DAY, low = Math.min(endMs - 1, startMs + view.scrollTop / perMs);
  const high = Math.min(endMs, Math.max(low + 1, low + (view.clientHeight - headerHeight) / perMs));
  setRendered(current => renderWindow(reset ? null : current, low, high, startMs, endMs));
  const top = dateAt(low, zone), bottom = dateAt(high - 1, zone);
  setVisible(current => current.top === top && current.bottom === bottom ? current : { top, bottom });
  const next = { left: view.scrollLeft < 1, right: view.scrollLeft >= view.scrollWidth - view.clientWidth - 1, top: view.scrollTop < 1, bottom: view.scrollTop >= view.scrollHeight - view.clientHeight - 1 };
  setEdges(current => current.left === next.left && current.right === next.right && current.top === next.top && current.bottom === next.bottom ? current : next);
 }
 const onScroll = () => { if (!frame.current) frame.current = requestAnimationFrame(() => measure()); };
 useLayoutEffect(() => {
  const view = viewport.current; scaleNow.current = scale; if (!view) return;
  if (anchor.current) { view.scrollTop = anchor.current.top; view.scrollLeft = anchor.current.left; anchor.current = null; }
  measure(true); const observer = new ResizeObserver(() => measure(true)); observer.observe(view);
  return () => { observer.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; };
 }, [scale, equipment.length]);

 // Keep the route's anchor stable while scrolling. Next server actions can refresh the
 // server tree at the current URL; replacing its date here would re-anchor the range
 // whenever an occupancy read finishes. Explicit refresh/equipment links use visible.top.

 // Lazy occupancy reads: one bounded chunk at a time, nearest to the view first. Loading, failed
 // and never-read cells stay unknown; failed cells wait for an explicit retry.
 const wanted = useMemo(() => chunksBetween(range.chunks, rendered.low, rendered.high), [range.chunks, rendered]);
 useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
 useEffect(() => {
  const next = plan(cells, wanted, ids, busy.current); if (!next) return;
  const request = ++requests.current, chunk = range.chunks[next.chunk]!;
  busy.current = true;
  setCells(current => start(current, next.chunk, next.equipmentIds, request));
  const done = (reads: Record<string, LaneRead> | { error: string }) => {
   busy.current = false; if (!alive.current) return;
   setCells(current => finish(current, next.chunk, next.equipmentIds, request, reads)); setSettled(n => n + 1);
  };
  readOccupancy(next.equipmentIds, chunk.from, chunk.to).then(read => {
   if (!read.ok) return done({ error: read.error });
   if (read.timezone && read.timezone !== zone && alive.current) setZoneChanged(read.timezone);
   done(read.lanes);
  }, () => done({ error: 'Captain could not be reached just now.' }));
 }, [cells, wanted, ids, range.chunks, zone, settled]);

 function zoom(next: Scale, at?: number) {
  const view = viewport.current; if (!view || next === scale) return;
  anchor.current = { top: zoomScroll(view.scrollTop, at ?? view.clientHeight / 2, scales[scale], scales[next], headerHeight), left: view.scrollLeft };
  setScale(next);
 }
 /** Scroll to a date inside this range, or open the schedule anchored on it. */
 function goTo(date: string) {
  const at = startOf(date, zone), view = viewport.current;
  if (at && view && Date.parse(at) >= startMs && Date.parse(at) < endMs) view.scrollTo({ top: y(Date.parse(at)), behavior: motion() });
  else router.push(href({ date }));
 }
 const move = (direction: 1 | -1) => { const date = shifted(visible.top, direction * steps[scale]); if (date) goTo(date); };
 const earlier = range.startDate > '1900-01-02' ? shifted(range.startDate, -1) : null, later = range.endDate < '2199-12-31' ? visible.top : null;

 const tickList = useMemo(() => axisTicks(scale, range, zone, rendered.low, rendered.high), [scale, range, zone, rendered]);
 const allChunks = useMemo(() => range.chunks.map((_, i) => i), [range.chunks]);
 const selection = equipment.find(e => e.id === selected);
 // The list below follows the whole civil days in view.
 const listLow = Math.max(startMs, Date.parse(dayStart(visible.top, zone) ?? range.start));
 const afterBottom = shifted(visible.bottom, 1), listHigh = Math.min(endMs, Date.parse((afterBottom && dayStart(afterBottom, zone)) ?? range.end));
 const listChunks = chunksBetween(range.chunks, listLow, listHigh);
 const rangeLabel = visible.top === visible.bottom ? dayLabel(visible.top, zone) : `${dayLabel(visible.top, zone)} – ${dayLabel(visible.bottom, zone)}`;

 return <>
  <div className="equipment-toolbar"><Link className="button button--secondary" href="/resources/equipment/manage">Manage equipment</Link><a className="button button--secondary" href={href()}>Refresh availability</a></div>
  <details className="equipment-dates"><summary>Go to a date</summary><form className="equipment-window" method="get" action="/resources/equipment" onSubmit={event => {
   const date = new FormData(event.currentTarget).get('date'), at = typeof date === 'string' ? startOf(date, zone) : null;
   if (typeof date === 'string' && at && Date.parse(at) >= startMs && Date.parse(at) < endMs) { event.preventDefault(); goTo(date); event.currentTarget.closest('details')?.removeAttribute('open'); }
  }}>
   <input name="offset" type="hidden" value={offset} /><input name="scale" type="hidden" value={scale} />
   <div className="field"><label htmlFor="equipment-date">Date</label><input id="equipment-date" name="date" type="date" required min="1900-01-02" max="2199-12-30" defaultValue={range.anchor} /></div>
   <button className="button button--secondary" type="submit">Show date</button>
  </form></details>
  <div className="equipment-toolbar equipment-scale" role="group" aria-label="Time scale">{(Object.keys(scales) as Scale[]).map(value => <button key={value} className="button button--secondary" aria-pressed={scale === value} onClick={() => zoom(value)}>{labels[value]}</button>)}<button className="button button--secondary equipment-today" onClick={() => goTo(todayInZone(zone))}>Today</button></div>
  <nav className="equipment-toolbar equipment-date-nav" aria-label="Schedule dates">
   {!edges.top ? <button className="equipment-date-step" aria-label="Previous dates" onClick={() => move(-1)}>‹</button> : earlier ? <Link href={href({ date: earlier })} aria-label="Earlier dates">‹</Link> : <span>Start of supported dates</span>}
   <strong>{rangeLabel}</strong>
   {!edges.bottom ? <button className="equipment-date-step" aria-label="Next dates" onClick={() => move(1)}>›</button> : later ? <Link href={href({ date: later })} aria-label="Later dates">›</Link> : <span>End of supported dates</span>}
  </nav>
  {zoneChanged ? <p className="form__error" role="alert">The business time zone is now {zoneChanged}. <a href={href()}>Refresh</a> to show dates in it.</p> : null}
  {!equipment.length ? <div className="card notice"><h2>{offset ? 'No equipment on this page.' : 'Add your first equipment'}</h2><p>{offset ? 'Return to the first equipment page or manage the catalogue.' : 'Add a machine, room or vehicle, then reserve its time here.'}</p><Link className="button button--primary" href={offset ? href({ offset: 0 }) : '/resources/equipment/manage'}>{offset ? 'First equipment page' : 'Add equipment'}</Link></div> : <>
   <div className="equipment-navigation"><button className="button button--secondary" aria-label="Previous equipment" disabled={edges.left} onClick={() => viewport.current?.scrollBy({ left: -168, behavior: motion() })}>‹</button><span>Equipment <small>Scroll sideways · Pinch to zoom time</small></span><button className="button button--secondary" aria-label="Next equipment" disabled={edges.right} onClick={() => viewport.current?.scrollBy({ left: 168, behavior: motion() })}>›</button></div>
   <p className="muted">Selected: {selection?.name}. Tap a column to select; + reserves it.</p>
   <div className="equipment-viewport" ref={viewport} role="region" tabIndex={0} aria-label="Equipment timeline; scroll sideways for equipment and vertically for time" data-scale={scale} onScroll={onScroll}
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
    <div className="equipment-canvas" style={{ width: 100 + equipment.length * 168 }}>
     <div className="equipment-head"><span>Time</span>{equipment.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{item.name}</button>)}</div>
     <div className="equipment-body" style={{ height: y(endMs) }}>
      <div className="equipment-axis">{tickList.map(t => <span key={t.at} style={{ top: y(t.at) }}>{t.label}</span>)}</div>
      {equipment.map(item => <div key={item.id} className="equipment-lane" data-equipment={item.id}>
       {range.chunks.map((chunk, i) => {
        const cell = cellOf(cells, i, item.id), state = stateOf(cell), top = y(Date.parse(chunk.from));
        return <div key={chunk.from} className="equipment-segment" data-coverage={state} data-from={chunk.fromDate} style={{ top, height: y(Date.parse(chunk.to)) - top }}>
         {state === 'complete' ? null : <span className="equipment-unknown">{unknownWords[state]}{state === 'failed' ? <button type="button" aria-label={`Retry ${item.name} from ${chunk.fromDate}`} onClick={() => setCells(current => retry(current, i, item.id))}>Retry</button> : null}</span>}
        </div>;
       })}
       {reservationsBetween(cells, allChunks, item.id, rendered.low, rendered.high).map(booking => {
        const occupied = interval(booking.occupiedStartsAt, booking.occupiedEndsAt, range.start, range.end, scales[scale]); if (!occupied) return null;
        const actual = interval(booking.startsAt, booking.endsAt, range.start, range.end, scales[scale]);
        const text = `${item.name} · ${booking.title} · ${displayTime(booking.startsAt, zone)} to ${displayTime(booking.endsAt, zone)} · setup ${booking.setupMinutes} min, cleanup ${booking.cleanupMinutes} min`;
        return <Link key={booking.id} href={detail(item.id, booking.id)} className={`equipment-booking${booking.kind === 'maintenance' ? ' equipment-booking--maintenance' : ''}${occupied.height < 24 ? ' equipment-booking--short' : ''}`} style={{ top: occupied.top, height: occupied.height }} aria-label={text} title={text}>
         {actual ? <span className="equipment-booking__actual" style={{ top: actual.top - occupied.top, height: actual.height }} /> : null}
         {occupied.height >= 24 ? <strong>{booking.title}</strong> : null}{occupied.height >= 65 ? <small>{booking.kind === 'maintenance' ? 'Maintenance' : 'Confirmed'}{booking.setupMinutes || booking.cleanupMinutes ? ' · includes buffers' : ''}</small> : null}
        </Link>;
       })}
      </div>)}
      <div className="equipment-grid" aria-hidden="true">{tickList.map(t => <span key={t.at} style={{ top: y(t.at) }} />)}</div>
     </div>
     <div className="equipment-edge">{later ? <>This schedule ends on {dayLabel(shifted(range.endDate, -1) ?? range.endDate, zone)}. <Link href={href({ date: later })}>Show later dates</Link></> : 'End of supported dates.'}</div>
    </div>
   </div>
   <p className="muted">Dates load in {chunkDays}-day parts as you scroll; striped time has not been read and is unknown. Bands include setup and cleanup; zoom in or use the list below for short reservations. Availability can change before you save.</p>
   <div className="equipment-reservations"><h2>Reservations {visible.top === visible.bottom ? `on ${dayLabel(visible.top, zone)}` : `from ${dayLabel(visible.top, zone)} to ${dayLabel(visible.bottom, zone)}`}</h2>{equipment.map(item => {
    const states = listChunks.map(i => stateOf(cellOf(cells, i, item.id))), state = combined(states), bookings = reservationsBetween(cells, allChunks, item.id, listLow, listHigh);
    const failures = listChunks.filter(i => cellOf(cells, i, item.id).status === 'failed');
    const message = failures.map(i => { const cell = cellOf(cells, i, item.id); return cell.status === 'failed' ? cell.message : ''; })[0];
    return <section className="card" key={item.id} aria-label={`${item.name} reservations`} data-coverage={state}>
     <h3>{item.name}</h3>
     {state === 'failed' ? <p className="form__error" role="alert">Reservations could not be read for some of these dates: {message} Availability is unknown. {failures.map(i => <button key={i} type="button" className="button button--secondary" onClick={() => setCells(current => retry(current, i, item.id))}>Retry from {range.chunks[i]!.fromDate}</button>)}</p>
      : state === 'unloaded' || state === 'loading' ? <p className="muted" role="status">Loading these dates. Availability is unknown until they are read.</p>
      : state === 'partial' ? <p className="form__error">Not every reservation was loaded: there are more than 200 in {chunkDays} days. Gaps are not confirmed free.</p>
      : !bookings.length ? <p className="muted">No confirmed reservations on these dates.</p> : null}
     <ul className="equipment-booking-list">{bookings.map(booking => <li key={booking.id}><Link href={detail(item.id, booking.id)}>{booking.title}</Link><span>{booking.kind === 'maintenance' ? 'Maintenance' : 'Confirmed'} · {displayTime(booking.startsAt, zone)} – {displayTime(booking.endsAt, zone)}</span><small>Setup {booking.setupMinutes} min · cleanup {booking.cleanupMinutes} min</small></li>)}</ul>
    </section>;
   })}</div>
  </>}
  <nav className="equipment-toolbar" aria-label="Equipment pages">{offset > 0 ? <Link href={href({ offset: Math.max(0, offset - 8) })}>Previous equipment page</Link> : null}{nextOffset !== null ? <Link href={href({ offset: nextOffset })}>More equipment</Link> : null}</nav>
  <Link className="equipment-plus" href={reserve} aria-label={selected ? `Reserve equipment: ${selection?.name}` : 'Add equipment'}><span aria-hidden="true">+</span></Link>
 </>;
}
