import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMe } from './me.ts';

const userId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const orgA = 'c0ffee00-1234-4abc-9def-0123456789ab';
const orgB = 'd00dfeed-5678-4def-8abc-ba9876543210';
const membership = (organisationId: string, role = 'owner') => ({ organisationId, organisationName: 'Brewery', role, status: 'active' });
const answer = (overrides: Record<string, unknown> = {}) => ({
	user: { id: userId, email: 'owner@example.test', name: 'Owner' }, memberships: [membership(orgA), membership(orgB, 'member')],
	passkeyVerified: true, ...overrides
});

test('the API answer is accepted exactly, frozen, with status dropped', () => {
	const me = parseMe(answer());
	assert.deepEqual(me, {
		user: { id: userId, email: 'owner@example.test', name: 'Owner' },
		memberships: [{ organisationId: orgA, organisationName: 'Brewery', role: 'owner' }, { organisationId: orgB, organisationName: 'Brewery', role: 'member' }],
		passkeyVerified: true
	});
	assert.ok(Object.isFrozen(me) && Object.isFrozen(me.user) && Object.isFrozen(me.memberships) && Object.isFrozen(me.memberships[0]));
	// users.name defaults to '' and a person may belong to no organisation.
	assert.deepEqual(parseMe(answer({ user: { id: userId, email: 'a@b.test', name: '' }, memberships: [] })).memberships, []);
});

test('anything else is refused with a fixed message that never repeats a value', () => {
	const secret = 'sess_leak-me-please';
	const refused: [string, unknown][] = [
		['not an object', null], ['array', [answer()]], ['extra top key', answer({ token: secret })], ['missing passkey flag', { user: answer().user, memberships: [] }],
		['passkey flag not boolean', answer({ passkeyVerified: 'yes' })],
		['user extra key', answer({ user: { id: userId, email: 'a@b.test', name: '', token: secret } })],
		['user id not canonical', answer({ user: { id: userId.toUpperCase(), email: 'a@b.test', name: '' } })],
		['empty email', answer({ user: { id: userId, email: '', name: '' } })],
		['long email', answer({ user: { id: userId, email: `${'a'.repeat(321)}`, name: '' } })],
		['long name', answer({ user: { id: userId, email: 'a@b.test', name: 'n'.repeat(501) } })],
		['memberships not an array', answer({ memberships: {} })],
		['membership extra key', answer({ memberships: [{ ...membership(orgA), secret }] })],
		['unknown role', answer({ memberships: [membership(orgA, 'superuser')] })],
		['removed membership', answer({ memberships: [{ ...membership(orgA), status: 'removed' }] })],
		['organisation id not canonical', answer({ memberships: [membership(`{${orgA}}`)] })],
		['empty organisation name', answer({ memberships: [{ ...membership(orgA), organisationName: '' }] })],
		['repeated organisation', answer({ memberships: [membership(orgA), membership(orgA, 'member')] })],
		['too many memberships', answer({ memberships: Array.from({ length: 501 }, (_, i) => membership(`c0ffee00-1234-4abc-9def-${String(i).padStart(12, '0')}`)) })],
		['inherited keys', answer({ user: Object.assign(Object.create({ inherited: 1 }), { id: userId, email: 'a@b.test', name: '' }) })]
	];
	for (const [label, value] of refused)
		assert.throws(() => parseMe(value), (error: unknown) => {
			assert.ok(error instanceof TypeError, label);
			assert.equal(error.message, 'identity: the answer was not in the expected form', label);
			assert.ok(!String(error.stack).includes(secret), label);
			return true;
		}, label);
});
