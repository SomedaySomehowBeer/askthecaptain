import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticatorTransport } from '@simplewebauthn/server';
import type { WebAuthn } from './passkeys.ts';

/** The production WebAuthn adapter: the relying party is the web app's origin (APP_URL), so a
 *  passkey made for app.askthecaptain.app works nowhere else. Discoverable credentials are not
 *  required; the account is known from the Google sign-in that precedes the step-up. */
export function simpleWebAuthn(appUrl: string, rpName = 'Ask The Captain'): WebAuthn {
	const origin = new URL(appUrl).origin; const rpID = new URL(appUrl).hostname;
	const transports = (value: string[]) => value as AuthenticatorTransport[];
	const plain = (key: Uint8Array) => new Uint8Array(key) as Uint8Array<ArrayBuffer>;
	return {
		async registrationOptions(input) {
			const options = await generateRegistrationOptions({ rpName, rpID, userName: input.userName, userDisplayName: input.displayName,
				attestationType: 'none', excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
				authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' } });
			return { challenge: options.challenge, options };
		},
		async verifyRegistration(input) {
			const result = await verifyRegistrationResponse({ response: input.response as Parameters<typeof verifyRegistrationResponse>[0]['response'], expectedChallenge: input.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
			if (!result.verified || !result.registrationInfo) throw new Error('registration not verified');
			const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
			return { credentialId: credential.id, publicKey: credential.publicKey, counter: credential.counter, transports: credential.transports ?? [], deviceType: credentialDeviceType, backedUp: credentialBackedUp };
		},
		async authenticationOptions(input) {
			const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: input.allowCredentialIds.map((id) => ({ id })) });
			return { challenge: options.challenge, options };
		},
		async verifyAuthentication(input) {
			const result = await verifyAuthenticationResponse({ response: input.response as Parameters<typeof verifyAuthenticationResponse>[0]['response'], expectedChallenge: input.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false,
				credential: { id: input.credential.id, publicKey: plain(input.credential.publicKey), counter: input.credential.counter, transports: transports(input.credential.transports) } });
			if (!result.verified) throw new Error('authentication not verified');
			return { newCounter: result.authenticationInfo.newCounter };
		}
	};
}
