/** Explicit deployment origins, with no fallback. E2E_WEB_URL names the API-served Expo client;
 *  it may equal E2E_API_URL after the owner completes the DNS cutover. */
const required = (name: 'E2E_WEB_URL' | 'E2E_API_URL'): string => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set; point it at the deployment under test`);
	return new URL(value).origin;
};
export const webUrl = () => required('E2E_WEB_URL');
export const apiUrl = () => required('E2E_API_URL');
