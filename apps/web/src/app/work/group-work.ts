import { daysBetween } from '../../lib/dates.ts';

/** Groups only the loaded page. The organisation's date must be known for relative headings. */
export function groupWork<T extends { due: string | null; status: string }>(tasks: T[], today: string | null): { label: string; tasks: T[] }[] {
 const order = ['Overdue', 'Due today', 'Tomorrow', 'Next 7 days', 'Later', 'No date', 'Scheduled', 'Completed', 'Cancelled'];
 const groups = new Map<string, T[]>();
 for (const task of tasks) {
  const delta = today && task.due ? daysBetween(today, task.due) : null;
  const label = task.status === 'done' ? 'Completed' : task.status === 'cancelled' ? 'Cancelled' : !task.due ? 'No date' : delta === null ? 'Scheduled' : delta < 0 ? 'Overdue' : delta === 0 ? 'Due today' : delta === 1 ? 'Tomorrow' : delta <= 7 ? 'Next 7 days' : 'Later';
  const group = groups.get(label) ?? []; group.push(task); groups.set(label, group);
 }
 return order.filter(label => groups.has(label)).map(label => ({ label, tasks: groups.get(label)! }));
}
