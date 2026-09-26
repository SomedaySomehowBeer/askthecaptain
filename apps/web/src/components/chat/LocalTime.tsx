'use client';
import { useEffect, useState } from 'react';

/** A time shown in the reader's own timezone. The server renders the date alone (it cannot know the browser's
 *  zone, and a guessed zone would be wrong); the browser fills in the local short form after hydration. */
export function LocalTime({ iso, timezone }: { iso: string; timezone?: string }) {
	const [text, setText] = useState(() => iso.slice(0, 10));
	const [full, setFull] = useState<string | undefined>(undefined);
	useEffect(() => {
		setText(shortTime(iso, timezone));
		const when = new Date(iso);
		if (!Number.isNaN(when.getTime())) setFull(`${new Intl.DateTimeFormat('en-AU', { ...(timezone ? { timeZone: timezone } : {}), dateStyle: 'full', timeStyle: 'short' }).format(when)}${timezone ? '' : ' (your local time)'}`);
	}, [iso, timezone]);
	// Labelled: without an organisation timezone this is the reader's local time, and the title says so.
	return <time dateTime={iso} title={full}>{text}</time>;
}

/** Today: the time. This year: day and month. Otherwise: the date with its year. */
export function shortTime(iso: string, timezone?: string, now = new Date()): string {
	const when = new Date(iso);
	if (Number.isNaN(when.getTime())) return '';
	const zone = timezone ? { timeZone: timezone } : {};
	const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { ...zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
	if (day(when) === day(now)) return new Intl.DateTimeFormat('en-AU', { ...zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(when);
	const sameYear = day(when).slice(0, 4) === day(now).slice(0, 4);
	return new Intl.DateTimeFormat('en-AU', { ...zone, day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).format(when);
}
