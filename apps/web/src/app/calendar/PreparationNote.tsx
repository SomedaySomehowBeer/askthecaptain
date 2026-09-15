import type { Event } from './calendar.ts';
export function PreparationNote({ event, timezone }: { event: Event; timezone: string }) {
 return <div className="preparation-note stack">
  {event.preparationNote && event.preparedAt ? <>
   <p>{event.preparationNote}</p>
   <p className="muted">Prepared at <time dateTime={event.preparedAt}>{new Intl.DateTimeFormat('en-AU', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.preparedAt))}</time> · {timezone}. Based on contacts and recent mail snippets available then.</p>
  </> : <p className="muted">No preparation note for this event. When enabled, Prepare for tomorrow runs at 18:00 for the following day. Check its run in Settings → Workflows.</p>}
 </div>;
}
