import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callbackUrl, readCallback } from './callback.ts';

const code = `nh_${'A'.repeat(20)}-_${'z'.repeat(21)}`;
const attempt = 'b'.repeat(43);
const other = 'c'.repeat(43);

test('the exact callback is accepted in either parameter order, and only the code comes back', () => {
	assert.equal(callbackUrl, 'app.askthecaptain.dev:/auth/callback');
	assert.deepEqual(readCallback(`${callbackUrl}?code=${code}&attempt=${attempt}`, attempt), { code });
	assert.deepEqual(readCallback(`${callbackUrl}?attempt=${attempt}&code=${code}`, attempt), { code });
});

test('every other return value is refused before anything is sent', () => {
	const q = `code=${code}&attempt=${attempt}`;
	const refused: unknown[] = [
		undefined, null, 42, {}, '', callbackUrl, `${callbackUrl}?`,
		// other schemes and forms
		`https://app.askthecaptain.dev/auth/callback?${q}`, `APP.ASKTHECAPTAIN.DEV:/auth/callback?${q}`, `app.askthecaptain.dev.evil:/auth/callback?${q}`,
		`app.askthecaptain.dev://auth/callback?${q}`, `app.askthecaptain.dev:///auth/callback?${q}`, `app.askthecaptain.dev://host/auth/callback?${q}`,
		`exp+captain:/auth/callback?${q}`, ` ${callbackUrl}?${q}`,
		// wrong paths
		`app.askthecaptain.dev:/auth/callback/?${q}`, `app.askthecaptain.dev:/AUTH/callback?${q}`, `app.askthecaptain.dev:/auth/callbacks?${q}`,
		`app.askthecaptain.dev:/auth/passkey?${q}`, `app.askthecaptain.dev:/auth/callback;x?${q}`,
		// fragments
		`${callbackUrl}?${q}#`, `${callbackUrl}?${q}#x`, `${callbackUrl}#?${q}`,
		// missing, duplicate and extra parameters
		`${callbackUrl}?code=${code}`, `${callbackUrl}?attempt=${attempt}`, `${callbackUrl}?code=${code}&code=${code}`,
		`${callbackUrl}?code=${code}&attempt=${attempt}&attempt=${attempt}`, `${callbackUrl}?code=${code}&attempt=${attempt}&x=1`,
		`${callbackUrl}?code=${code}&attempt=${attempt}&`, `${callbackUrl}?&code=${code}&attempt=${attempt}`, `${callbackUrl}?code=${code}&&attempt=${attempt}`,
		`${callbackUrl}?code=${code};attempt=${attempt}`, `${callbackUrl}?code&attempt=${attempt}`, `${callbackUrl}?=${code}&attempt=${attempt}`,
		`${callbackUrl}?error=native_sign_in_disabled`, `${callbackUrl}?Code=${code}&attempt=${attempt}`,
		// the attempt must be this attempt's
		`${callbackUrl}?code=${code}&attempt=${other}`, `${callbackUrl}?code=${code}&attempt=`, `${callbackUrl}?code=${code}&attempt=${attempt}x`,
		`${callbackUrl}?code=${code}&attempt=${attempt.slice(1)}`, `${callbackUrl}?code=${code}&attempt=%62${attempt.slice(1)}`,
		// bad code shapes
		`${callbackUrl}?code=nh_short&attempt=${attempt}`, `${callbackUrl}?code=${code}x&attempt=${attempt}`, `${callbackUrl}?code=${code.replace('nh_', 'nx_')}&attempt=${attempt}`,
		`${callbackUrl}?code=${code.replace('A', '+')}&attempt=${attempt}`, `${callbackUrl}?code=${code.replace('A', '%41')}&attempt=${attempt}`,
		`${callbackUrl}?code=nh_${'a'.repeat(43)}=&attempt=${attempt}`, `${callbackUrl}?code=${'a'.repeat(46)}&attempt=${attempt}`,
		`${callbackUrl}?code=${code}&attempt=${attempt}${'&'.repeat(600)}`
	];
	for (const value of refused) assert.equal(readCallback(value, attempt), null, String(value).slice(0, 120));
});
