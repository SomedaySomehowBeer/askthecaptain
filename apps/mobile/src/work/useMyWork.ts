import { useWorkList } from './useWorkList.ts';

/** My work's list: `useWorkList('mine')` (docs/plans/expo-mobile-all-tasks-read-2026-09.md §4.3). Kept so existing
 *  callers and references stay valid. */
export const useMyWork = () => useWorkList('mine');
