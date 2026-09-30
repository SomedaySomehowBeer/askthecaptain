/** Equipment answers and failures exposed by the browser harness. */
import { equipmentControls } from './equipment-fixtures.ts';
export const readControls = [...equipmentControls, 'unavailable', 'unavailable-wait', 'refused-404', 'refused-400', 'unauthorised', 'client-bug'] as const;
export type ReadControl = (typeof readControls)[number];
