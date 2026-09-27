import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { base64url, createPkce, pkceValue, s256 } from './pkce.ts';

const sha256 = async (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

test('base64url matches Node for every length and byte pattern, with no padding', () => {
	for (let length = 0; length <= 70; length++) {
		const bytes = new Uint8Array(randomBytes(length));
		assert.equal(base64url(bytes), Buffer.from(bytes).toString('base64url'), `length ${length}`);
	}
	assert.equal(base64url(new Uint8Array([0xfb, 0xff, 0xfe])), '-__-');
});

test('RFC 7636 appendix B: the verifier from its bytes, and its S256 challenge', async () => {
	const bytes = new Uint8Array([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121]);
	const verifier = base64url(bytes);
	assert.equal(verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
	assert.equal(await s256(verifier, { sha256 }), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('each attempt has a fresh 43-character verifier and attempt, and the challenge is the verifier’s S256', async () => {
	const platform = { randomBytes: async (length: 32) => new Uint8Array(randomBytes(length)), sha256 };
	const one = await createPkce(platform); const two = await createPkce(platform);
	for (const value of [one.verifier, one.challenge, one.attempt]) assert.match(value, pkceValue);
	assert.equal(one.challenge, createHash('sha256').update(one.verifier).digest('base64url'));
	assert.notEqual(one.verifier, one.attempt);
	assert.notEqual(one.verifier, two.verifier); assert.notEqual(one.attempt, two.attempt);
});

test('a platform that returns the wrong number of bytes or a wrong digest is refused', async () => {
	await assert.rejects(createPkce({ randomBytes: async () => new Uint8Array(31), sha256 }));
	await assert.rejects(createPkce({ randomBytes: async () => new Uint8Array(33), sha256 }));
	await assert.rejects(createPkce({ randomBytes: async (length: 32) => new Uint8Array(randomBytes(length)), sha256: async () => new Uint8Array(16) }));
});
