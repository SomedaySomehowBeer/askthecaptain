import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interval, zoomScroll } from './geometry.ts';
test('continuous elapsed intervals clip at loaded boundaries without enlarging short occupancy', () => {
 const from='2026-10-01T00:00:00Z',to='2026-10-08T00:00:00Z';
 assert.deepEqual(interval('2026-09-30T00:00:00Z','2026-10-03T12:00:00Z',from,to,84),{top:0,height:210});
 assert.deepEqual(interval('2026-10-02T00:00:00Z','2026-10-02T00:01:00Z',from,to,576),{top:576,height:0.4});
 assert.equal(interval('2026-10-08T00:00:00Z','2026-10-09T00:00:00Z',from,to,84),null);
});
test('zoom retains the time under the focal point and can roundtrip', () => {
 const top=500,anchor=200,zoomed=zoomScroll(top,anchor,84,576);
 assert.equal((top+anchor-52)/84,(zoomed+anchor-52)/576);
 assert.ok(Math.abs(zoomScroll(zoomed,anchor,576,84)-top)<0.00001);
});
