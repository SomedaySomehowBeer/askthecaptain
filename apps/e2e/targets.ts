/** Both origins come from the environment with no default: a gate that quietly tested something
 *  other than the deployment under test would be worse than no gate. */
const required = (name: 'E2E_WEB_URL' | 'E2E_API_URL'): string => {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set; point it at the deployment under test`);
	return new URL(value).origin;
};
export const webUrl = () => required('E2E_WEB_URL');
export const apiUrl = () => required('E2E_API_URL');
