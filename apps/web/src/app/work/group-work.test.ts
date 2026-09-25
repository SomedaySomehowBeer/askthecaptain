import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateIn } from '../../lib/dates.ts';
import { groupWork } from './group-work.ts';

test('business-local midnight groups today correctly, leaving completed work out of overdue', () => {
 const today = dateIn('2026-09-25T17:00:00Z', 'Australia/Perth');
 const rows = [{due:'2026-09-25',status:'open'}, {due:'2026-09-26',status:'open'}, {due:'2026-09-27',status:'open'}, {due:'2026-09-01',status:'done'}, {due:null,status:'open'}];
 assert.deepEqual(groupWork(rows,today).map(g=>[g.label,g.tasks.length]), [['Overdue',1],['Due today',1],['Tomorrow',1],['No date',1],['Completed',1]]);
});
test('unknown business date never fabricates relative urgency, and every row appears once', () => {
 const rows=[{due:'2026-09-25',status:'open'},{due:null,status:'open'},{due:'2026-09-01',status:'cancelled'}];
 const groups=groupWork(rows,null);
 assert.deepEqual(groups.map(g=>g.label),['No date','Scheduled','Cancelled']);
 assert.equal(groups.flatMap(g=>g.tasks).length,rows.length);
});
