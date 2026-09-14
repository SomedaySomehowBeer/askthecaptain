/** Server-side configuration. The API origin is never sent to the browser; every read is made by the
 *  web server on the person's behalf. */
export const apiUrl = process.env.API_URL ?? 'http://127.0.0.1:8080';
export const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
export const secureCookies = appUrl.startsWith('https://');
