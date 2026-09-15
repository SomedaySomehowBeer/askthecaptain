import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function masterKey(value: string): Buffer {
	if (!/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32) throw new Error('MASTER_KEY must be 32 bytes in base64');
	return Buffer.from(value, 'base64');
}
// Version byte, 12-byte IV, 16-byte tag, ciphertext. The context prevents tenant/field swaps.
export function seal(key: Buffer, value: Buffer, organisationId: string, field: string): Buffer {
	const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from(JSON.stringify([organisationId, field])));
	const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
	return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}
export function open(key: Buffer, value: Buffer, organisationId: string, field: string): Buffer {
	if (value.length < 29 || value[0] !== 1) throw new Error('invalid encrypted value');
	const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13));
	decipher.setAAD(Buffer.from(JSON.stringify([organisationId, field]))); decipher.setAuthTag(value.subarray(13, 29));
	return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]);
}
export function newDataKey(master: Buffer, organisationId: string) {
	const key = randomBytes(32);
	return { key, wrapped: seal(master, key, organisationId, 'data_key') };
}
