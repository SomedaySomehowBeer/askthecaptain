import { PreparationNote } from './PreparationNote.tsx';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { Notice } from '../../components/Notice.tsx';
import { withReference } from '../../components/Reference.tsx';
import { Page, requireCurrent } from '../../components/Page.tsx';
import { api, load } from '../../lib/api.ts';
import { addDays, dayLabel, eventTime, onDay, weekStart, type CalendarWeek, type CalendarList } from './calendar.ts';
import { SyncButton } from './SyncButton.tsx';
export const metadata: Metadata = { title: 'Calendar' };
export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
 const me = await requireCurrent('/calendar'); const { week } = await searchParams;
 return <Page title="Calendar" lede="Your week, from the calendars connected to Captain.">
  <Suspense fallback={<div role="status"><Notice>Reading your synced calendars…</Notice></div>}><Week me={me} week={week} /></Suspense>
 </Page>;
}
async function Week({ me, week }: { me: Awaited<ReturnType<typeof requireCurrent>>; week?: string }) {
 const prefix = `/v1/organisations/${me.organisation.organisationId}/calendar`;
 const calendars = await load(() => api<CalendarList>(`${prefix}/calendars`, { token: me.token }));
 if (!calendars.ok) return <Notice tone="failed" action={{ href: '/calendar', label: 'Try again' }}>{calendars.error.message} Try again to read your calendar.</Notice>;
 if (!calendars.value.connection || calendars.value.connection.status === 'disconnected') return <Notice title="Connect Google to see your calendar" action={{ href: '/settings/connections', label: 'Go to Connections' }}>An owner or admin can connect Google in Settings.</Notice>;
 const start = weekStart(week, calendars.value.timezone); const end = addDays(start, 7);
 const result = await load(() => api<CalendarWeek>(`${prefix}/events?from=${start}&to=${end}`, { token: me.token }));
 if (!result.ok) return <Notice tone="failed" action={{ href: `/calendar?week=${start}`, label: 'Try again' }}>{result.error.message} Try again to read your calendar.</Notice>;
 const { connection, lastSync, events, timezone, covered, automaticSyncEnabled, preparationNotice } = result.value;
 const needsAccess = !connection?.scopes.some((s) => ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(s));
 const available = connection?.status === 'connected' && !needsAccess; const canSync = me.organisation.role !== 'member';
 const clean = covered && lastSync?.detail.success && available;
 return <>
  <section className="card stack calendar-status">
   <h2>{connection?.accountEmail}</h2>
   <p className="muted">{lastSync ? `Last sync attempt: ${new Intl.DateTimeFormat('en-AU', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(lastSync.at))}.` : 'Calendars have not been synced yet.'}</p>
   {needsAccess && connection?.status === 'connected' ? <Notice tone="attention" action={{ href: '/settings/connections', label: 'Reconnect Google' }}>Calendar list access is needed. An owner or admin must reconnect Google and allow the calendar permissions.</Notice> : null}
   {connection?.status !== 'connected' ? <Notice tone="attention" action={{ href: '/settings/connections', label: 'Reconnect Google' }}>{connection?.status === 'revoked' ? 'Google access was revoked.' : 'Google access could not be refreshed.'} Reconnect in Settings to resume calendar sync. Any events below are the last saved copy.</Notice> : null}
   {lastSync && !lastSync.detail.success ? <Notice tone="failed">{lastSync.detail.error ? withReference(lastSync.detail.error) : 'The last calendar sync failed. Try Sync now again.'}</Notice> : null}
   <SyncButton disabled={!canSync || !available} />
   {!canSync ? <p className="muted">Only an owner or admin can sync now.</p> : null}
   <p className="muted">{automaticSyncEnabled ? 'Connected calendars are checked automatically every five minutes.' : 'Automatic calendar checks are paused.'}</p>
  </section>
  <nav aria-label="Calendar weeks" className="row calendar-weeks"><Link className="button button--secondary" href={`/calendar?week=${addDays(start, -7)}`}>Previous week</Link><Link className="button button--ghost" href="/calendar">This week</Link><Link className="button button--secondary" href={`/calendar?week=${end}`}>Next week</Link></nav>
  <h2>{dayLabel(start)} – {dayLabel(addDays(start, 6))}</h2><p className="muted">Times shown in {timezone}. All-day dates stay as marked on the calendar.</p>
  {!covered ? <Notice title="This week is not fully synced">Captain collects 30 days back and 90 days ahead. Use Sync now to collect the current window. Events outside it may be missing.</Notice> : null}
  {events.length === 0 ? <Notice title={clean ? 'No events this week' : 'No synced events to show'}>{clean ? 'The selected calendars have no events in this synced week.' : 'This does not confirm the week is empty. Check the connection and sync status above.'}</Notice> : null}
  {preparationNotice ? <Notice action={{ href: '/settings/workflows', label: 'Workflows' }}>{preparationNotice}</Notice> : null}
  <div className="calendar-days">{Array.from({ length: 7 }, (_, n) => addDays(start, n)).map((day) => {
   const items = events.filter((e) => onDay(e, day, timezone));
   return <section className="card calendar-day" key={day} aria-label={dayLabel(day)}><h3>{dayLabel(day)}</h3>
    {items.length ? <ul className="bare">{items.map((e) => <li className="calendar-event stack" key={e.id}>
     <p className="muted">{eventTime(e, timezone)}{e.status === 'tentative' ? ' · Tentative' : ''}</p>
     <h4>{e.summary || '(No title)'}</h4>{e.location ? <p>{e.location}</p> : null}
     <p className="muted">{e.calendarName} · {e.attendeesOmitted ? 'Attendee count unavailable' : `${e.attendeeCount} ${e.attendeeCount === 1 ? 'attendee' : 'attendees'}`}</p>
     <PreparationNote event={e} timezone={timezone} />
    </li>)}</ul> : <p className="muted">{clean ? 'No events.' : 'No synced events.'}</p>}
   </section>;
  })}</div>
 </>;
}
