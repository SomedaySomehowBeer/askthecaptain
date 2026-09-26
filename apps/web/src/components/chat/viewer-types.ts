import type { Role } from '../../lib/api.ts';
import type { ChatScope } from '../../app/chat/types.ts';

/** Who is reading a chat page, as the thread, details and item panels need it (client-safe: types and pure helpers
 *  only). `timezone` is the organisation's, for day separators and times; `timezoneKnown` is false when it could not
 *  be read and the page shows UTC instead of guessing. */
export type Viewer = { scope: ChatScope; userId: string; role: Role; timezone: string; timezoneKnown: boolean };

/** Owners and admins who participate may remove people and delete others' messages (contract §1). Participation is
 *  implied: only participants can open a conversation at all. */
export const canModerate = (viewer: Viewer) => viewer.role === 'owner' || viewer.role === 'admin';
