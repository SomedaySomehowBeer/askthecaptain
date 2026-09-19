import { readFile } from 'node:fs/promises';
import { InferenceError } from '@captain/model';

/** The Sprites HTTP API (api.sprites.dev), bearer-authenticated with a token scoped to the Sprites
 *  organisation that holds nothing but Captain runtimes (plan §7, D18 as amended 2026-09-19). Only
 *  plain HTTP is used: create, write files, create and start the service, make the URL public,
 *  read the URL, destroy. Errors carry the operation and status, never a response body. */
export type Provisioned = { url: string; region: string };
export interface Provisioner { provision(spriteName: string, files: Record<string, Buffer>): Promise<Provisioned>; destroy(spriteName: string): Promise<void> }
export class SpritesError extends Error {
	readonly op: string; readonly status: number;
	constructor(op: string, status: number) { super(`sprites ${op} failed with status ${status}`); this.name = 'SpritesError'; this.op = op; this.status = status; }
}

/** Where the API writes the runtime's files on the Sprite; bootstrap.sh moves the secret out of it. */
export const setupDir = '/home/sprite/captain-setup';
const spriteName = /^[a-z0-9-]{1,63}$/;

export class SpritesClient implements Provisioner {
	readonly #token: string; readonly #transport: typeof fetch; readonly #base: string;
	constructor(token: string, transport: typeof fetch = fetch, base = 'https://api.sprites.dev') { this.#token = token; this.#transport = transport; this.#base = base; }
	async #call(op: string, method: string, path: string, body?: unknown, ok: number[] = [200, 201]): Promise<unknown> {
		const binary = Buffer.isBuffer(body);
		let response: Response;
		try {
			response = await this.#transport(new URL(path, this.#base), { method, redirect: 'error', signal: AbortSignal.timeout(60_000),
				headers: { authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }) },
				body: body === undefined ? undefined : binary ? new Uint8Array(body as Buffer) : JSON.stringify(body) });
		} catch { throw new SpritesError(op, 0); }
		if (!ok.includes(response.status)) { await response.body?.cancel().catch(() => {}); throw new SpritesError(op, response.status); }
		const text = await response.text().catch(() => '');
		try { return text ? JSON.parse(text) : null; } catch { return null; }
	}
	async provision(name: string, files: Record<string, Buffer>): Promise<Provisioned> {
		if (!spriteName.test(name)) throw new SpritesError('create', 0);
		// 409 means it already exists: never create a second Sprite for the same organisation; finish setting it up.
		await this.#call('create', 'POST', '/v1/sprites', { name, labels: ['captain'] }, [201, 409]);
		for (const [file, bytes] of Object.entries(files)) {
			const q = new URLSearchParams({ path: `${setupDir}/${file}`, mode: '0600', mkdirParents: 'true' });
			await this.#call(`write ${file}`, 'PUT', `/v1/sprites/${name}/fs/write?${q}`, bytes);
		}
		await this.#call('service', 'PUT', `/v1/sprites/${name}/services/inference`, { name: 'inference', cmd: 'bash', args: [`${setupDir}/bootstrap.sh`], needs: [], http_port: 8080 });
		await this.#call('start', 'POST', `/v1/sprites/${name}/services/inference/start`);
		// The shim authenticates every route with its own secret, so the Sprite URL itself can be public.
		await this.#call('url', 'PUT', `/v1/sprites/${name}`, { url_settings: { auth: 'public' } });
		const info = await this.#call('read', 'GET', `/v1/sprites/${name}`) as { url?: unknown; primary_region?: unknown } | null;
		if (!info || typeof info.url !== 'string') throw new SpritesError('read', 0);
		const url = new URL(info.url); url.pathname = '/'; url.search = ''; url.hash = '';
		return { url: url.toString(), region: typeof info.primary_region === 'string' && info.primary_region ? info.primary_region : 'unknown' };
	}
	async destroy(name: string): Promise<void> {
		if (!spriteName.test(name)) throw new SpritesError('destroy', 0);
		await this.#call('destroy', 'DELETE', `/v1/sprites/${name}`, undefined, [200, 204, 404]);
	}
}

/** The runtime's files from `infra/sprites`, plus its generated configuration. */
export async function spriteFiles(provider: 'claude' | 'codex', secret: string, dir = new URL('../../../../infra/sprites/', import.meta.url)): Promise<Record<string, Buffer>> {
	const files: Record<string, Buffer> = {};
	for (const file of ['bootstrap.sh', 'shim.mjs', 'catalog.mjs', 'codex.toml', 'login.py']) files[file] = await readFile(new URL(file, dir));
	files['runtime.json'] = Buffer.from(JSON.stringify({ provider, secret }));
	return files;
}

export const provisioningFailed = () => new InferenceError('runtime_not_ready');
