import { expect, test } from '@playwright/test';
import { apiUrl, webUrl } from '../targets.ts';

test('the API is up and can reach its database', async ({ request }) => {
	expect((await request.get(`${apiUrl()}/healthz`)).status()).toBe(200);
	const ready = await request.get(`${apiUrl()}/readyz`);
	expect(ready.status()).toBe(200);
	expect(await ready.json()).toEqual({ ok: true });
});

test('the web origin serves the Expo shell', async ({ request }) => {
	const response = await request.get(`${webUrl()}/`, { maxRedirects: 0 });
	expect(response.status()).toBe(200);
	expect(response.headers()['content-type']).toContain('text/html');
	const html = await response.text();
	expect(html).toMatch(/<div\b[^>]*\bid=["']root["']/);
	expect(html).toContain('/_expo/');
});
