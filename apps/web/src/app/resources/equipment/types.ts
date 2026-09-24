/** Browser-safe shapes of the equipment API. No server/database imports. */
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type Equipment = { id: string; name: string; archivedAt: string | null; revision: number; createdAt: string; updatedAt: string };
export type EquipmentPage = { equipment: Equipment[]; nextOffset: number | null };
export type Reservation = { id: string; equipmentId: string; title: string; kind: 'booking' | 'maintenance'; status: 'confirmed' | 'cancelled';
 startsAt: string; endsAt: string; setupMinutes: number; cleanupMinutes: number; occupiedStartsAt: string; occupiedEndsAt: string;
 projectId: string | null; taskId: string | null; ownerId: string | null; createdBy: string; revision: number; createdAt: string; updatedAt: string };
export type ReservationRange = { reservations: Reservation[]; nextOffset: number | null; coverage: 'complete' | 'partial'; from: string; to: string; timezone: string };
