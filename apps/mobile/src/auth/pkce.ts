/** PKCE for native sign-in (RFC 7636; mobile foundation contract §3.2 steps 1–2). Pure: the random bytes and SHA-256
 *  come from the injected platform, so nothing here imports expo-crypto, and the encoding uses no Buffer, btoa or URL. */
import type { AuthPlatform } from './contracts.ts';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url (RFC 4648 §5). */
export function base64url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i]!; const b = bytes[i + 1]; const c = bytes[i + 2];
		out += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
		if (b !== undefined) out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
		if (c !== undefined) out += alphabet[c & 63]!;
	}
	return out;
}

/** A 43-character base64url value: what the API accepts for the challenge and the attempt. */
export const pkceValue = /^[A-Za-z0-9_-]{43}$/;

/** One attempt's secrets. The verifier and attempt stay in the attempt core's memory; only the challenge and attempt go
 *  into the start URL, and all three are sent once, to the exchange. */
export type Pkce = { readonly verifier: string; readonly challenge: string; readonly attempt: string };

async function random32(platform: Pick<AuthPlatform, 'randomBytes'>): Promise<Uint8Array> {
	const bytes = await platform.randomBytes(32);
	if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('the platform did not return 32 random bytes');
	return bytes;
}

/** base64url(SHA-256(ASCII(verifier))), the S256 challenge. */
export async function s256(verifier: string, platform: Pick<AuthPlatform, 'sha256'>): Promise<string> {
	const digest = await platform.sha256(new TextEncoder().encode(verifier));
	if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('the platform did not return a SHA-256 digest');
	return base64url(digest);
}

/** A fresh verifier and attempt (32 random bytes each) and the verifier's S256 challenge. */
export async function createPkce(platform: Pick<AuthPlatform, 'randomBytes' | 'sha256'>): Promise<Pkce> {
	const verifier = base64url(await random32(platform));
	const attempt = base64url(await random32(platform));
	return { verifier, challenge: await s256(verifier, platform), attempt };
}
