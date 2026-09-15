import type { TransactionSql } from '@captain/db';
import type { CalendarEvent, CalendarInfo, EventTime } from '@captain/connectors/calendar';
import { notFound } from '../errors.ts';
export type CalendarConnection = { id: string; accountEmail: string; status: string; error: string | null; scopes: string[] };
export async function connection(tx: TransactionSql) {
 const [row] = await tx<CalendarConnection[]>`select id, account_email, status, error, scopes from connections where provider = 'google'`; return row ?? null;
}
export async function requireMember(tx: TransactionSql, userId: string, organisationId: string) {
 const [row] = await tx`select role from memberships where organisation_id = ${organisationId} and user_id = ${userId} and status = 'active'`;
 if (!row) throw notFound(); return row.role as string;
}
export async function saveCalendar(tx: TransactionSql, organisationId: string, conn: CalendarConnection, c: CalendarInfo) {
 const [row] = await tx`insert into calendars (organisation_id, connection_id, account_email, provider_id, name, is_primary, timezone, access_role, selected)
  values (${organisationId}, ${conn.id}, ${conn.accountEmail}, ${c.providerId}, ${c.name}, ${c.primary}, ${c.timezone}, ${c.accessRole}, ${c.selected})
  on conflict (organisation_id, connection_id, provider_id) do update set name = excluded.name, is_primary = excluded.is_primary,
  timezone = excluded.timezone, access_role = excluded.access_role returning id, provider_id, timezone, is_primary, selected`;
 return row!;
}
function instant(tx: TransactionSql, value: EventTime, fallbackZone: string) {
 const raw = value.date ?? value.dateTime!;
 return !value.date && /(Z|[+-]\d{2}:\d{2})$/.test(raw) ? tx`${raw}::timestamptz` : tx`(${raw}::text::timestamp at time zone ${value.timeZone ?? fallbackZone})`;
}
export async function saveEvent(tx: TransactionSql, organisationId: string, calendarId: string, timezone: string, e: CalendarEvent) {
 if (e.status === 'cancelled') { await tx`delete from calendar_events where calendar_id = ${calendarId} and provider_id = ${e.providerId}`; return; }
 await tx`insert into calendar_events (organisation_id, calendar_id, provider_id, status, summary, description, location, starts_at, ends_at, all_day, start_date, end_date,
  timezone, organiser, attendees, attendees_omitted, recurring_event_id, html_link, updated_at)
  values (${organisationId}, ${calendarId}, ${e.providerId}, ${e.status}, ${e.summary}, ${e.description}, ${e.location}, ${instant(tx, e.start, timezone)}, ${instant(tx, e.end, timezone)},
  ${Boolean(e.start.date)}, ${e.start.date ?? null}, ${e.end.date ?? null}, ${e.start.timeZone ?? timezone}, ${tx.json(e.organiser)}, ${tx.json(e.attendees)}, ${e.attendeesOmitted}, ${e.recurringEventId}, ${e.htmlLink}, ${e.updatedAt})
  on conflict (organisation_id, calendar_id, provider_id) do update set status = excluded.status, summary = excluded.summary, description = excluded.description,
  location = excluded.location, starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day, start_date = excluded.start_date, end_date = excluded.end_date,
  timezone = excluded.timezone, organiser = excluded.organiser, attendees = excluded.attendees, attendees_omitted = excluded.attendees_omitted,
  recurring_event_id = excluded.recurring_event_id, html_link = excluded.html_link, updated_at = excluded.updated_at`;
}
