import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

/** The Expo web export, served by the API from its own origin (docs/plans/expo-web-session-2026-09.md §A.1).
 *  Expo Router is a single-page export: any GET that is not an API path and not a file is `index.html`. The API's
 *  paths are never shadowed; an unknown `/v1/...` is still the API's own 404. Hashed assets under `/_expo/` are
 *  immutable for a year; everything else, the page included, is `no-store`. Without the export the API still
 *  starts, and the page says the web build is missing. */

/** `apps/mobile/dist/web`, from either `src/` or the built `dist/` of this package. */
export const defaultExportDir = fileURLToPath(new URL('../../../mobile/dist/web', import.meta.url));

const apiPrefixes = ['/auth/', '/v1/', '/connections/', '/webhooks/'];
const apiExact = new Set(['/healthz', '/readyz']);
/** `/auth/passkey` is the app's step-up page, reached by the callback's redirect; every other `/auth/...` is the API. */
const pages = new Set(['/auth/passkey']);

/** True for a path the API owns, whatever it answers there. */
export function isApiPath(path: string): boolean {
	if (pages.has(path)) return false;
	return apiExact.has(path) || apiPrefixes.some((prefix) => path.startsWith(prefix));
}

const immutable = 'public, max-age=31536000, immutable';
export const missingBuild = 'The web build is missing.';

export function webExport(root: string): MiddlewareHandler {
	let handlers: { files: MiddlewareHandler; index: MiddlewareHandler } | null = null;
	const ready = () => {
		if (!handlers && existsSync(join(root, 'index.html'))) handlers = { files: serveStatic({ root }), index: serveStatic({ root, path: 'index.html' }) };
		return handlers;
	};
	// The header goes on the response itself: `serveStatic` builds its response before `onFound`, so a header set
	// on the context there would be lost.
	const cached = (response: Response, control: string) => { response.headers.set('cache-control', control); return response; };
	return async (c, next) => {
		if (isApiPath(c.req.path) || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return next();
		const serve = ready();
		if (!serve) return c.text(missingBuild, 503);
		// A file answers; otherwise the page does. Each middleware returns its response, so nothing is swallowed.
		const file = await serve.files(c, async () => undefined);
		if (file) return cached(file, c.req.path.startsWith('/_expo/') ? immutable : 'no-store');
		const page = await serve.index(c, next);
		return page ? cached(page, 'no-store') : undefined;
	};
}
