/** The only file in the app that imports `expo/fetch` (the boundary guard enforces it). Typecheck-only: it binds a
 *  native module, so node tests cover `createNativeSend` in ./native-send.ts instead. Not used on web, where native
 *  sign-in is never offered. */
import { fetch as expoFetch } from 'expo/fetch';
import { createNativeSend } from './native-send.ts';

/** The transport's `send` on device: `expo/fetch` with `redirect: 'error'` and `credentials: 'omit'` forced. */
export const nativeSend = createNativeSend(expoFetch);
