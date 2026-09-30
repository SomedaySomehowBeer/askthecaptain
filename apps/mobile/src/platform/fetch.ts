/** The only file in the app that imports `expo/fetch` (the boundary guard enforces it). Typecheck-only: it binds a
 *  platform module, so node tests cover `createNativeSend` (./native-send.ts) and `createWebSend` (./web-send.ts)
 *  instead. On iOS and Android `expo/fetch` is Expo's native fetch; on the web it is the browser's own fetch
 *  (expo 57: `src/winter/fetch/fetch.web.ts` exports `globalThis.fetch`). */
import { fetch as expoFetch } from 'expo/fetch';
import { createNativeSend } from './native-send.ts';
import { createWebSend } from './web-send.ts';

/** The transport's `send` on device: `expo/fetch` with `redirect: 'error'` and `credentials: 'omit'` forced. */
export const nativeSend = createNativeSend(expoFetch);

/** The transport's `send` on the web: the browser's fetch with cookies, the web client header and `redirect: 'error'`
 *  forced, and never a bearer. */
export const webSend = createWebSend(expoFetch);
