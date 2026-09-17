import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GmailError } from '@captain/connectors/gmail';
import { describeFailure, explainFailure } from './sync-failure.ts';
test('failures are described by stage and kind only; database errors keep their SQLSTATE and drop the message', () => {
	const pg = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00 in "Dear customer"'), { name: 'PostgresError', code: '22021' });
	assert.deepEqual(describeFailure(pg, 'save'), { stage: 'save', kind: 'database', code: '22021' });
	assert.deepEqual(describeFailure(new GmailError(403, 'domainPolicy'), 'fetch'), { stage: 'fetch', kind: 'google', status: 403, reason: 'domainPolicy' });
	assert.deepEqual(describeFailure(new GmailError(500), 'fetch'), { stage: 'fetch', kind: 'google', status: 500 });
	assert.deepEqual(describeFailure(new RangeError('Invalid time value'), 'save'), { stage: 'save', kind: 'other', name: 'RangeError' });
	const explained = explainFailure('Gmail', describeFailure(pg, 'save'));
	assert.match(explained, /could not be saved.*Reference: save · database · 22021\./); assert.ok(!explained.includes('customer'));
	assert.match(explainFailure('Gmail', { stage: 'fetch', kind: 'google', status: 429 }), /rate limiting/);
	assert.match(explainFailure('Google Calendar', { stage: 'access', kind: 'google', status: 401 }), /Reconnect Google/);
	assert.match(explainFailure('Gmail', { stage: 'fetch', kind: 'google', status: 403, reason: 'domainPolicy' }), /Workspace administrator/);
	assert.match(explainFailure('Gmail', { stage: 'fetch', kind: 'google', status: 0, reason: 'account_changed' }), /account changed/);
	assert.match(explainFailure('Google Calendar', { stage: 'calendars', kind: 'google', status: 502, reason: 'too_many_pages' }), /more pages/);
	assert.match(explainFailure('Google Calendar', { stage: 'start', kind: 'google', status: 502, reason: 'not_connected' }), /not connected/);
});
