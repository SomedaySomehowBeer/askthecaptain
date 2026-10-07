/** The booking and task cards against the real API on loopback (owner's hosted findings, 7 October): starts
 *  apps/api/test/real-api-server.ts (a fresh Postgres database, the API serving apps/mobile/dist/web, seeded through its
 *  own routes), signs in with the session cookie and drives the production export at phone width. Checks that
 *  "Cancel this booking" is offered on an untouched card, is the only control there that says Cancel, and cancels;
 *  that Save is off whenever a warning above it says the save will be refused (an invalid time, an overlap) and on
 *  under a caution; that a booking spanning days opens whole; and that the task card's Save is off under its stale
 *  warning. Needs DATABASE_URL (a disposable test cluster) and the web export. Not hosted, not native.
 *  Usage: DATABASE_URL=… node apps/e2e/scripts/real-api-cards-check.mjs [screenshot-dir] */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test'); const { expect } = require('@playwright/test');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shots = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required (a disposable test cluster)'); process.exit(2); }

const server = spawn(process.execPath, ['--import', 'tsx', 'test/real-api-server.ts'], { cwd: path.join(root, 'apps/api'), env: { ...process.env, PORT: process.env.PORT ?? '8091' }, stdio: ['ignore', 'pipe', 'inherit'] });
const info = await new Promise((resolve, reject) => {
 let out = ''; const timer = setTimeout(() => reject(new Error('the real API did not start in 120 seconds')), 120_000);
 server.stdout.on('data', chunk => { out += chunk; const line = out.split('\n').find(l => l.startsWith('{"ready"')); if (line) { clearTimeout(timer); resolve(JSON.parse(line)); } });
 server.once('exit', code => { clearTimeout(timer); reject(new Error(`the real API exited (${code})`)); });
});
const api = async (method, p, token, body) => {
 const r = await fetch(`${info.url}/v1/organisations/${info.org}${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
 if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${await r.text()}`); return r.json();
};
let browser, failed = false;
try {
 browser = await chromium.launch();
 const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
 await context.addCookies([{ name: 'captain_session', value: info.token, url: info.url }]);
 const page = await context.newPage(); page.setDefaultTimeout(15000);
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 const id = n => page.getByTestId(n).filter({ visible: true });
 const shot = async name => { if (shots) await page.screenshot({ path: path.join(shots, `real-${name}.png`) }); };
 const open = async thread => { await page.goto(`${info.url}/threads/${thread}`); await id('thread-card-fold').click(); };
 const off = async t => expect(id(t)).toHaveAttribute('aria-disabled', 'true');
 const on = async t => { await expect(id(t)).not.toHaveAttribute('aria-disabled', 'true'); await expect(id(t)).toBeEnabled(); };
 const cancelControls = () => page.locator('[data-testid="booking-editor"] [role="button"]').evaluateAll(b => b.filter(e => /cancel/i.test(e.textContent)).map(e => e.textContent));

 // An untouched booking: cancel offered and the only Cancel; nothing to save or discard.
 await open(info.runThread); await expect(id('booking-start')).toHaveValue('08:00');
 await expect(id('booking-occupancy')).toContainText('Holds the Canning line from 7:30 am to 12:30 pm, with setup and cleanup. That time is free.');
 await on('booking-cancel'); await off('booking-save'); await off('booking-cancel-edit'); await expect(id('booking-cancel-edit')).toHaveText('Discard edits');
 expect(await cancelControls()).toEqual(['Cancel this booking']);
 await id('booking-cancel').scrollIntoViewIfNeeded(); await shot('booking-open');

 // An overlap with the clean that follows: the warning names it and Save is off; discarding and cancelling stay on.
 await id('booking-end').fill('13:00');
 await expect(id('booking-occupancy')).toContainText('That time overlaps Bright tank clean (1:00 pm to 3:00 pm). Choose another time to save.');
 await off('booking-save'); await on('booking-cancel-edit'); await on('booking-cancel'); await id('booking-occupancy').scrollIntoViewIfNeeded(); await shot('booking-overlap');
 // An end before the start: the invalid warning, Save off.
 await id('booking-end').fill('07:00'); await expect(id('booking-invalid')).toContainText('The end must be after the start'); await off('booking-save'); await shot('booking-invalid');
 // A free time: Save on, and it saves.
 await id('booking-end').fill('12:30'); await id('booking-cleanup').selectOption('0');
 await expect(id('booking-occupancy')).toContainText('That time is free.'); await on('booking-save');
 await id('booking-save').click(); await expect(id('booking-save-status')).toContainText('Saved');
 const saved = await api('GET', `/equipment/${info.equipment}/reservations/${info.run}`, info.maya);
 expect([saved.endsAt, saved.cleanupMinutes, saved.revision]).toEqual(['2031-03-04T01:30:00.000Z', 0, 2]);
 // "Cancel this booking": asks, then cancels; the API says so.
 await on('booking-cancel'); await id('booking-cancel').click(); await expect(id('booking-cancel-confirm')).toContainText('Cancel this booking?');
 await on('booking-cancel-yes'); await shot('booking-cancel-confirm'); await id('booking-cancel-yes').click();
 await expect(id('booking-cancelled')).toContainText('This booking is cancelled'); await shot('booking-cancelled');
 expect((await api('GET', `/equipment/${info.equipment}/reservations/${info.run}`, info.maya)).status).toBe('cancelled');

 // A booking over two days opens whole: its end date, no warning, nothing to save, cancel offered.
 await open(info.hireThread); await expect(id('booking-end-date')).toHaveValue('2031-03-12');
 await expect(id('booking-date')).toHaveValue('2031-03-10'); await expect(id('booking-end')).toHaveValue('10:00');
 await expect(id('booking-invalid')).toHaveCount(0); await expect(id('booking-occupancy')).toContainText('That time is free.');
 await off('booking-save'); await on('booking-cancel'); await shot('booking-multiday');

 // The task card's stale warning: Maya changes the task while it is open; Sam's save is refused, the newer task is
 // shown and Save stays off under the warning until the next edit.
 await open(info.taskThread); await expect(id('task-title')).toHaveValue('Package summer lager');
 await id('task-due').fill('2031-03-06');
 const current = await api('GET', `/tasks/${info.task}?limit=50`, info.maya);
 await api('PATCH', `/tasks/${info.task}`, info.maya, { expectedRevision: current.task.revision, title: 'Package the summer lager' });
 await on('task-save'); await id('task-save').click();
 await expect(id('task-save-status')).toContainText('Someone changed this since you opened it');
 await expect(id('task-title')).toHaveValue('Package the summer lager'); await off('task-save'); await expect(id('task-cancel')).toHaveText('Discard edits'); await shot('task-stale');
 await id('task-due').fill('2031-03-06'); await on('task-save'); await expect(id('task-save-status')).toHaveCount(0);

 expect(errors).toEqual([]);
 console.log('PASS real API 390px: booking cancel offered untouched and the only Cancel, cancels; Save off under the overlap and invalid warnings, on when free and saves; two-day booking opens whole; task Save off under the stale warning');
} catch (error) {
 failed = true; console.error(error);
} finally {
 await browser?.close();
 server.kill('SIGTERM');
 await new Promise(resolve => { if (server.exitCode !== null) resolve(); else server.once('exit', resolve); });
}
process.exitCode = failed ? 1 : 0;
