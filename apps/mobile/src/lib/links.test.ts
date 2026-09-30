import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redirectSystemPath } from '../app/+native-intent.tsx';
import { callbackUrl } from '../auth/callback.ts';
import { appScheme, linkableRoutes, linkTarget, refusedLink, safeReturnPath, systemLinkTarget } from './links.ts';

/** The same vectors as the API's return-path.test.ts and the web's session-state.test.ts. */
const kept = [
	'/', '/work', '/resources/equipment?date=2030-10-01', '/chat?filter=unread&linked=false&team=abc',
	'/chat/new?link=task%3A3f2504e0-4f89-41d3-9a0c-0305e82c3301', '/work/tasks/abc#comment-1',
	'/search?q=https://evil.test', '/@evil.test', '/%2F%2Fevil.test', '/%5Cevil.test', '/%0A', '/a/../b'
];
const refused: unknown[] = [
	'', 'work', ' /work', 'https://evil.test', 'http:/evil.test', 'javascript:alert(1)',
	'//evil.test', '///evil.test',
	'/\\evil.test', '/\\/evil.test', '\\\\evil.test', '/work\\..\\..\\evil',
	'/\t/evil.test', '/\n/evil.test', '/\r\n/evil.test', '/\u0000evil', '/\u007f', '/work\u001b',
	'/..//evil.test', '/.//evil.test', '/a/..//evil.test', '/%2e%2e//evil.test', '/a/%2E%2E//evil.test',
	`/${'a'.repeat(2048)}`,
	undefined, null, 42, ['/work'], ['/work', '/chat']
];

test('the return-path rule is the API and web rule: same-origin paths kept exactly, every escape refused', () => {
	for (const value of kept) assert.equal(safeReturnPath(value), value, JSON.stringify(value));
	for (const value of refused) assert.equal(safeReturnPath(value), null, JSON.stringify(value));
});

test('app routes open from a bare path or this build’s scheme with no host; queries and fragments are dropped', () => {
	const cases: [string, string][] = [
		['/', '/'], ['/equipment', '/equipment'], ['/equipment/', '/equipment'], ['/resources/equipment', '/equipment'],
		['/equipment?date=1#top', '/equipment'], [`${appScheme}:/equipment`, '/equipment'], [`${appScheme}:///equipment`, '/equipment'], [`${appScheme}://`, '/'],
		[`APP.ASKTHECAPTAIN.DEV:/equipment`, '/equipment']
	];
	for (const [incoming, route] of cases) assert.equal(linkTarget(incoming), route, incoming);
});

test('every sign-in callback is refused, in every form: this hook never accepts one', () => {
	const query = 'code=nh_' + 'a'.repeat(43) + '&attempt=' + 'b'.repeat(43);
	for (const incoming of [`${appScheme}:/auth/callback?${query}`, `${appScheme}:///auth/callback?${query}`, `/auth/callback?${query}`, '/auth/callback',
		`${appScheme}://auth/callback?${query}`, `${appScheme}:/auth/callback/`, `${appScheme}:/AUTH/callback`, `${appScheme}:/auth/passkey?token=pks_x`])
		assert.equal(linkTarget(incoming), refusedLink, incoming);
});

test('a system link that is exactly this build’s sign-in callback causes no navigation; lookalikes are still refused', () => {
	const query = 'code=nh_' + 'a'.repeat(43) + '&attempt=' + 'b'.repeat(43);
	// The attempt core's own prefix is one of the forms, so the two rules cannot drift apart.
	assert.equal(callbackUrl, `${appScheme}:/auth/callback`);
	for (const incoming of [`${callbackUrl}?${query}`, callbackUrl, `${callbackUrl}?`, `${appScheme}:///auth/callback?${query}`, `${appScheme}:///auth/callback`,
		`${callbackUrl}?code=junk`]) {
		assert.equal(systemLinkTarget(incoming), null, incoming);
		for (const initial of [true, false]) assert.equal(redirectSystemPath({ path: incoming, initial }), null, incoming);
	}
	for (const incoming of [
		`/auth/callback?${query}`, '/auth/callback', `${appScheme}://auth/callback?${query}`, `${appScheme}:////auth/callback`,
		`${appScheme}:/auth/callback/`, `${appScheme}:/auth/callback/?${query}`, `${appScheme}:/AUTH/callback`, `${appScheme.toUpperCase()}:/auth/callback`,
		`${appScheme}:/auth/callback#${query}`, `${appScheme}:/auth/callback?${query}#x`, `${appScheme}:/auth/callbacks`, `${appScheme}:/auth/callback.`,
		`${appScheme}:/auth/passkey?token=pks_x`, `${appScheme}:/auth/google/callback`, `${appScheme}:/auth`, `${appScheme}:/auth/`,
		`${appScheme}://evil.test/auth/callback`, `${appScheme}:/%61uth/callback`, `${appScheme}:/auth%2Fcallback`, `${appScheme}:/./auth/callback`,
		`${appScheme}:/work/../auth/callback`, `https://app.askthecaptain.app/auth/callback?${query}`, `app-askthecaptain-dev:/auth/callback`,
		`appXaskthecaptain.dev:/auth/callback`, ` ${callbackUrl}`, `${callbackUrl} `, `${callbackUrl}\n`, `${callbackUrl}?${'x'.repeat(2048)}`
	]) {
		assert.equal(systemLinkTarget(incoming), refusedLink, incoming);
		assert.equal(redirectSystemPath({ path: incoming, initial: false }), refusedLink, incoming);
	}
	for (const incoming of [undefined, null, 7, ['/work']]) assert.equal(systemLinkTarget(incoming), refusedLink);
	// Every app route is unchanged by the callback rule.
	for (const route of linkableRoutes) assert.equal(systemLinkTarget(route), route, route);
	assert.equal(systemLinkTarget(`${appScheme}:/equipment?x=1`), '/equipment');
});

test('other schemes, hosts, unknown or not-yet-built routes and malformed links are refused', () => {
	for (const incoming of [
		'https://app.askthecaptain.app/equipment', 'http://localhost/equipment', 'exp+captain-mobile://expo-development-client/?url=x', 'captain:/equipment', 'app.askthecaptain:/equipment',
		`${appScheme}://evil.test/equipment`, `${appScheme}://equipment`, `${appScheme}:equipment`, `${appScheme}:/\\evil.test`, `${appScheme}://%2Fevil.test/equipment`,
		'/work', '/work/tasks/0190c0de-0000-7000-8000-000000000000', '/settings', '/organisation', '/welcome', '/sign-in', '/link-not-allowed', '/Equipment', '/resources', '/resources/inventory',
		'/invitations/accept?token=x', '', `/${'w'.repeat(2048)}`, undefined, null, 7
	]) assert.equal(linkTarget(incoming), refusedLink, String(incoming));
});

test('every linkable route is one the link rule itself accepts', () => {
	for (const route of linkableRoutes) assert.equal(linkTarget(route), route, route);
	assert.ok(!linkableRoutes.has(refusedLink));
});
