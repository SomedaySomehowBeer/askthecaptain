export type DateRange = { from: string; to: string; label: string; explicit: boolean };
export const addDays = (date: string, days: number) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const monthStart = (year: number, month: number) => new Date(Date.UTC(year, month, 1, 12)).toISOString().slice(0, 10);
/** Dates are civil dates in the organisation's timezone; SQL converts boundaries to instants. */
export function dateRange(question: string, today: string): DateRange {
 const q = question.toLowerCase(), year = Number(today.slice(0, 4)), month = Number(today.slice(5, 7)) - 1;
 const range = (from: string, to: string, label: string, explicit = true) => ({ from, to, label, explicit });
 for (const [word, offset] of [['yesterday', -1], ['today', 0], ['tomorrow', 1]] as const) if (new RegExp(`\\b${word}\\b`).test(q)) return range(addDays(today, offset), addDays(today, offset + 1), word);
 for (const [word, offset] of [['last', -7], ['this', 0], ['next', 7]] as const) if (q.includes(`${word} week`)) {
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7) + offset); return range(monday, addDays(monday, 7), `${word} week`);
 }
 for (const [word, offset] of [['last', -1], ['this', 0], ['next', 1]] as const) if (q.includes(`${word} month`)) return range(monthStart(year, month + offset), monthStart(year, month + offset + 1), `${word} month`);
 const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
 for (const [m, name] of months.entries()) {
  const match = new RegExp(`\\b${name}(?:\\s+(20\\d{2}))?\\b`).exec(q); if (!match) continue;
  // "May I..." is not a date. Other named months default to the organisation's current year.
  if (name === 'may' && /\bmay i\b/.test(q) && !match[1]) continue;
  const y = match[1] ? Number(match[1]) : year; return range(monthStart(y, m), monthStart(y, m + 1), `${name} ${y}`);
 }
 return range(today, addDays(today, 7), 'next seven days (default for calendar and due-soon tasks)', false);
}
