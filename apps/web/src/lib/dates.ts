/** Calendar dates as `YYYY-MM-DD`, said in words relative to the organisation's today. */
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
export const daysBetween = (from: string, to: string): number => Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000);
export function shortDate(date: string): string {
	const value = utc(date);
	return `${days[value.getUTCDay()]} ${value.getUTCDate()} ${months[value.getUTCMonth()]}${value.getUTCFullYear() === new Date().getUTCFullYear() ? '' : ` ${value.getUTCFullYear()}`}`;
}
export type Urgency = 'overdue' | 'today' | 'soon' | 'later';
export function describeDue(due: string | null, today: string): { text: string; urgency: Urgency | null } {
	if (!due) return { text: 'no date', urgency: null };
	const delta = daysBetween(today, due);
	if (delta < 0) return { text: delta === -1 ? 'overdue by a day' : `overdue by ${-delta} days`, urgency: 'overdue' };
	if (delta === 0) return { text: 'due today', urgency: 'today' };
	if (delta === 1) return { text: 'due tomorrow', urgency: 'soon' };
	if (delta < 7) return { text: `due ${shortDate(due)}`, urgency: 'soon' };
	return { text: `due ${shortDate(due)}`, urgency: 'later' };
}
export const recurrenceWords = (recurrence: string, everyMonths: number | null): string =>
	recurrence === 'custom' ? (everyMonths === 1 ? 'every month' : `every ${everyMonths} months`) : recurrence === 'weekdays' ? 'every weekday' : recurrence;
