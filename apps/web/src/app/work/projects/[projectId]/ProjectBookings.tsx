import Link from 'next/link';
import { Notice } from '../../../../components/Notice.tsx';
import type { Loaded } from '../../../../lib/api.ts';
import { shortDate } from '../../../../lib/dates.ts';
import { displayTime, shiftDate } from '../../../resources/equipment/time.ts';
import type { Reservation } from '../../../resources/equipment/types.ts';

export type ProjectReservationPage = { reservations: (Reservation & { equipmentName: string; equipmentArchivedAt: string | null })[]; nextOffset: number | null; from: string; to: string; timezone: string };
export type ProjectWindow = { date: string; span: number; from: string; to: string; zone: string };

export function ProjectBookings({ result, window, problem, invalidWindow, href, overview, start }: {
 result: Loaded<ProjectReservationPage> | null; window: ProjectWindow | null; problem: string | null; invalidWindow: boolean;
 href: string; overview: boolean; start: number;
}) {
 const scheduleHref = `${href}?view=schedule`;
 const currentHref = window ? `${scheduleHref}&date=${window.date}&span=${window.span}` : scheduleHref;
 const adjacent = (direction: number) => { try { const date = shiftDate(window!.date, direction * window!.span); shiftDate(date, window!.span); return `${scheduleHref}&date=${date}&span=${window!.span}`; } catch { return null; } };
 const previous = window ? adjacent(-1) : null, next = window ? adjacent(1) : null;
 return <section className="project-section" aria-label="Equipment bookings">
  <div className="project-section__heading"><h2>Equipment bookings</h2>{overview ? <Link href={currentHref}>Schedule <span aria-hidden="true">›</span></Link> : null}</div>
  {!overview && window ? <form className="project-window" method="get" action={href}>
   <input type="hidden" name="view" value="schedule"/>
   <label className="field">Starting date<input name="date" type="date" defaultValue={window.date} required min="1900-01-01" max="2199-12-30"/></label>
   <label className="field">Window<select name="span" defaultValue={window.span}>{[1,7,14,28].map(span => <option key={span} value={span}>{span} {span === 1 ? 'day' : 'days'}</option>)}</select></label>
   <button className="button button--ghost" type="submit">Show bookings</button>
  </form> : null}
  {problem || !window ? <Notice title="Schedule could not be read" tone="failed" action={{ href: invalidWindow ? scheduleHref : overview ? href : scheduleHref, label: invalidWindow ? 'Open today’s project schedule' : 'Try again' }}>{problem ?? 'The business time zone is unavailable.'}</Notice> : <>
   <p className="project-note">{shortDate(window.date)} – {shortDate(shiftDate(window.date, window.span - 1))} · {window.zone}</p>
   {!result?.ok ? <Notice title="Bookings could not be read" tone="failed" action={{ href: `${currentHref}&offset=${start}`, label: 'Try again' }}>{result && !result.ok ? result.error.message : 'Refresh to try again.'}</Notice> : <>
    {result.value.reservations.length ? <ul className="bare project-bookings">
     {result.value.reservations.map(r => <li key={r.id}><Link href={`/resources/equipment/${r.equipmentId}/reservations/${r.id}`} className="project-booking">
      <span className="project-booking__heading"><strong>{r.equipmentName} · {r.title}</strong><span className="chip">Confirmed</span></span>
      <span>{displayTime(r.startsAt, result.value.timezone)} – {displayTime(r.endsAt, result.value.timezone)}</span>
      {r.setupMinutes || r.cleanupMinutes ? <span>Setup {r.setupMinutes} min · Cleanup {r.cleanupMinutes} min</span> : null}
      {r.equipmentArchivedAt ? <span>Archived equipment</span> : null}
     </Link></li>)}
    </ul> : <p className="project-empty">No confirmed bookings overlap this window.</p>}
    {overview && result.value.nextOffset !== null ? <p className="project-note">Showing the first three bookings. <Link href={currentHref}>View all bookings in this window</Link>.</p> : null}
    {!overview ? <nav className="row" aria-label="Booking pages">{start > 0 ? <Link href={`${currentHref}&offset=${Math.max(0, start - 50)}`}>Previous bookings</Link> : null}{result.value.nextOffset !== null ? <Link href={`${currentHref}&offset=${result.value.nextOffset}`}>Next bookings</Link> : null}</nav> : null}
   </>}
   {!overview ? <nav className="project-window-nav" aria-label="Schedule windows">{previous ? <Link href={previous}>Earlier</Link> : null}{next ? <Link href={next}>Later</Link> : null}</nav> : null}
   <p className="project-note">This project’s confirmed bookings only. Check shared equipment availability before booking.</p>
   <Link className="project-schedule-link" href={`/resources/equipment?date=${window.date}&span=${window.span}`}>View shared equipment schedule <span aria-hidden="true">›</span></Link>
  </>}
 </section>;
}
