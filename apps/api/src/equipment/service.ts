import { withTenant, type Sql, type TransactionSql } from '@captain/db';
import { z } from 'zod';
import { audit } from '../audit.ts';
import { HttpError, notFound } from '../errors.ts';
import { roleOf, type Actor } from '../tenant.ts';

const day = 86_400_000;
const instant = z.string().datetime({ offset: true }).refine(value => {
 const time = Date.parse(value);
 return Number.isFinite(time) && time >= Date.parse('1900-01-01T00:00:00Z') && time < Date.parse('2200-01-01T00:00:00Z');
}, 'Use an explicit UTC or offset timestamp between 1900 and 2200.').transform(value => new Date(value));
const name = z.string().trim().min(1).max(100);
const revision = z.number().int().min(1).max(2_147_483_646);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const link = uuid.nullable().default(null);
const rangeFields = {
 title: z.string().trim().min(1).max(200), kind: z.enum(['booking', 'maintenance']).default('booking'),
 startsAt: instant, endsAt: instant, setupMinutes: z.number().int().min(0).max(10080).default(0),
 cleanupMinutes: z.number().int().min(0).max(10080).default(0), projectId: link, taskId: link, ownerId: link,
};
const validBooking = (value: { startsAt: Date; endsAt: Date }) => {
 // A failed field refinement can leave its raw input here. Preserve Zod's field error, not a TypeError.
 if (!(value.startsAt instanceof Date) || !(value.endsAt instanceof Date)) return true;
 return value.endsAt.getTime() > value.startsAt.getTime() && value.endsAt.getTime() - value.startsAt.getTime() <= 366 * day;
};
export const createReservation = z.object({ id: uuid, ...rangeFields }).strict().refine(validBooking,
 'The end must follow the start within 366 days.');
export const replaceReservation = z.object({ expectedRevision: revision, ...rangeFields }).strict().refine(validBooking,
 'The end must follow the start within 366 days.');
export const cancelReservation = z.object({ expectedRevision: revision }).strict();
export const equipmentInput = z.object({ name }).strict();
export const equipmentPatch = z.object({ expectedRevision: revision, name: name.optional(), archived: z.boolean().optional() }).strict()
 .refine(value => value.name !== undefined || value.archived !== undefined, 'Supply a name or archived state.');
export const equipmentQuery = z.object({
 offset: z.coerce.number().int().min(0).max(1_000_000).default(0), limit: z.coerce.number().int().min(1).max(100).default(50),
 archived: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
}).strict();
export const reservationsQuery = z.object({
 from: instant, to: instant, offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
 limit: z.coerce.number().int().min(1).max(200).default(200),
}).strict().refine(value => !(value.from instanceof Date) || !(value.to instanceof Date) ||
 (value.to.getTime() > value.from.getTime() && value.to.getTime() - value.from.getTime() <= 93 * day),
 'Request a positive time window of at most 93 days.');
export type Equipment = { id: string; name: string; archivedAt: Date | null; revision: number; createdAt: Date; updatedAt: Date };
type Schedule = Omit<z.infer<typeof createReservation>, 'id'>;
export type Reservation = Schedule & { id: string; equipmentId: string; status: 'confirmed' | 'cancelled'; occupiedStartsAt: Date; occupiedEndsAt: Date;
 createdBy: string; revision: number; createdAt: Date; updatedAt: Date };
const equipmentColumns = 'id, name, archived_at, revision, created_at, updated_at';
const reservationColumns = 'id, equipment_id, title, kind, status, starts_at, ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, project_id, task_id, owner_id, created_by, revision, created_at, updated_at';
const conflict = (code: string, message: string) => new HttpError(409, code, message);
const stale = () => conflict('stale_revision', 'This record changed. Refresh it before saving again.');
const idExists = () => conflict('reservation_id_exists', 'That reservation request already exists with different details. Refresh before retrying.');
const occupancy = (input: Schedule) => ({ occupiedStartsAt: new Date(input.startsAt.getTime() - input.setupMinutes * 60_000),
 occupiedEndsAt: new Date(input.endsAt.getTime() + input.cleanupMinutes * 60_000) });
function sameRequest(row: Reservation, input: Schedule, actor: Actor) {
 return row.revision === 1 && row.status === 'confirmed' && row.createdBy === actor.userId &&
 row.title === input.title && row.kind === input.kind && row.startsAt.getTime() === input.startsAt.getTime() && row.endsAt.getTime() === input.endsAt.getTime() &&
 row.setupMinutes === input.setupMinutes && row.cleanupMinutes === input.cleanupMinutes && row.projectId === input.projectId && row.taskId === input.taskId && row.ownerId === input.ownerId;
}
/** Shared bookings. Row locks coordinate catalogue state; the GiST constraint is the final overlap authority. */
export class EquipmentService {
 readonly #db: Sql;
 constructor(db: Sql) { this.#db = db; }
 private async tx<T>(actor: Actor, organisationId: string, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  await roleOf(this.#db, actor.userId, organisationId);
  try {
   return await withTenant(this.#db, { organisationId, userId: actor.userId }, async tx => {
    const [member] = await tx`select user_id from memberships where organisation_id = ${organisationId}
     and user_id = ${actor.userId} and status = 'active' for share`;
    if (!member) throw notFound();
    return work(tx);
   });
  } catch (error) {
   if (error instanceof Error && 'code' in error) {
    if (error.code === '23P01') throw conflict('reservation_conflict', 'That equipment is unavailable during this time, including setup and cleanup. Choose another time.');
    if (error.code === '23505') {
     if ('constraint_name' in error && error.constraint_name === 'equipment_name')
      throw conflict('equipment_name_exists', 'Equipment with that name already exists, including archived equipment.');
     throw idExists();
    }
   }
   throw error;
  }
 }
 private async equipment(tx: TransactionSql, id: string, lock = false) {
  const [row] = await tx<Equipment[]>`select ${tx.unsafe(equipmentColumns)} from equipment where id = ${id} ${lock ? tx`for update` : tx``}`;
  if (!row) throw notFound(); return row;
 }
 private async reservation(tx: TransactionSql, equipmentId: string, id: string, lock = true) {
  const [row] = await tx<Reservation[]>`select ${tx.unsafe(reservationColumns)} from equipment_reservations
   where id = ${id} and equipment_id = ${equipmentId} ${lock ? tx`for update` : tx``}`;
  if (!row) throw notFound(); return row;
 }
 private async record(tx: TransactionSql, actor: Actor, organisationId: string, action: string, subjectType: string, id: string, before: Equipment | Reservation | null, after: Equipment | Reservation) {
  await audit(tx, { organisationId, actor: { kind: 'person', id: actor.userId }, requestId: actor.requestId,
   action, subjectType, subjectId: id, detail: { before, after } });
 }
 private async links(tx: TransactionSql, input: Schedule) {
  if (input.ownerId) {
   const [owner] = await tx`select user_id from memberships where user_id = ${input.ownerId} and organisation_id = current_organisation_id() and status = 'active' for share`;
   if (!owner) throw notFound();
  }
  if (input.projectId) {
   const [project] = await tx`select id from projects where id = ${input.projectId} and state = 'active' and archived_at is null for share`;
   if (!project) throw notFound();
  }
  if (input.taskId) {
   // A linked task carries its own project, or none; the reservation must name the same one (D7: projects are optional).
   const [task] = await tx`select id from tasks where id = ${input.taskId} and project_id is not distinct from ${input.projectId}::uuid and parent_id is null and status <> 'cancelled' for share`;
   if (!task) throw notFound();
  }
 }
 list(actor: Actor, organisationId: string, raw: unknown) {
  const query = equipmentQuery.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const rows = await tx<Equipment[]>`select ${tx.unsafe(equipmentColumns)} from equipment
    where (archived_at is not null) = ${query.archived} order by lower(name), id limit ${query.limit + 1} offset ${query.offset}`;
   return { equipment: rows.slice(0, query.limit), nextOffset: rows.length > query.limit ? query.offset + query.limit : null };
  });
 }
 get(actor: Actor, organisationId: string, equipmentId: string) { return this.tx(actor, organisationId, tx => this.equipment(tx, equipmentId)); }
 getBooking(actor: Actor, organisationId: string, equipmentId: string, id: string) {
  return this.tx(actor, organisationId, tx => this.reservation(tx, equipmentId, id, false));
 }
 create(actor: Actor, organisationId: string, raw: unknown) {
  const input = equipmentInput.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const [row] = await tx<Equipment[]>`insert into equipment (organisation_id, name) values (${organisationId}, ${input.name}) returning ${tx.unsafe(equipmentColumns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'equipment.created', 'equipment', row.id, null, row); return row;
  });
 }
 update(actor: Actor, organisationId: string, id: string, raw: unknown) {
  const input = equipmentPatch.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const before = await this.equipment(tx, id, true);
   if (before.revision !== input.expectedRevision) throw stale();
   if (input.archived === true && !before.archivedAt) {
    const [occupied] = await tx`select id from equipment_reservations where equipment_id = ${id} and status = 'confirmed' and occupied_ends_at > now() limit 1`;
    if (occupied) throw conflict('equipment_in_use', 'Cancel upcoming or current reservations before archiving this equipment.');
   }
   const archivedAt = input.archived === undefined ? before.archivedAt : input.archived ? before.archivedAt ?? new Date() : null;
   const [row] = await tx<Equipment[]>`update equipment set name = ${input.name ?? before.name}, archived_at = ${archivedAt}, revision = revision + 1, updated_at = now()
    where id = ${id} returning ${tx.unsafe(equipmentColumns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'equipment.updated', 'equipment', id, before, row); return row;
  });
 }
 reservations(actor: Actor, organisationId: string, equipmentId: string, raw: unknown) {
  const query = reservationsQuery.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   await this.equipment(tx, equipmentId);
   const [organisation] = await tx<{ timezone: string }[]>`select timezone from organisations where id = ${organisationId}`;
   if (!organisation) throw notFound();
   // Never join/filter work: archived work and other owners still occupy the equipment.
   const rows = await tx<Reservation[]>`select ${tx.unsafe(reservationColumns)} from equipment_reservations where equipment_id = ${equipmentId}
    and status = 'confirmed' and occupied_starts_at < ${query.to} and occupied_ends_at > ${query.from}
    order by occupied_starts_at, id limit ${query.limit + 1} offset ${query.offset}`;
   return { reservations: rows.slice(0, query.limit), nextOffset: rows.length > query.limit ? query.offset + query.limit : null,
    coverage: query.offset === 0 && rows.length <= query.limit ? 'complete' as const : 'partial' as const,
    from: query.from, to: query.to, timezone: organisation.timezone };
  });
 }
 createBooking(actor: Actor, organisationId: string, equipmentId: string, raw: unknown) {
  const input = createReservation.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const resource = await this.equipment(tx, equipmentId, true);
   const [existing] = await tx<Reservation[]>`select ${tx.unsafe(reservationColumns)} from equipment_reservations where id = ${input.id}`;
   if (existing) {
    if (existing.equipmentId !== equipmentId || !sameRequest(existing, input, actor)) throw idExists();
    return { reservation: existing, created: false };
   }
   if (resource.archivedAt) throw conflict('equipment_archived', 'This equipment is archived. Restore it before making a reservation.');
   await this.links(tx, input);
   const occupied = occupancy(input);
   const [row] = await tx<Reservation[]>`insert into equipment_reservations
    (id, organisation_id, equipment_id, title, kind, starts_at, ends_at, setup_minutes, cleanup_minutes, occupied_starts_at, occupied_ends_at, project_id, task_id, owner_id, created_by)
    values (${input.id}, ${organisationId}, ${equipmentId}, ${input.title}, ${input.kind}, ${input.startsAt}, ${input.endsAt}, ${input.setupMinutes}, ${input.cleanupMinutes},
     ${occupied.occupiedStartsAt}, ${occupied.occupiedEndsAt}, ${input.projectId}, ${input.taskId}, ${input.ownerId}, ${actor.userId}) returning ${tx.unsafe(reservationColumns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'equipment.reservation_created', 'equipment_reservation', row.id, null, row);
   return { reservation: row, created: true };
  });
 }
 replaceBooking(actor: Actor, organisationId: string, equipmentId: string, id: string, raw: unknown) {
  const input = replaceReservation.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   const resource = await this.equipment(tx, equipmentId, true);
   const before = await this.reservation(tx, equipmentId, id);
   if (before.revision !== input.expectedRevision) throw stale();
   if (before.status === 'cancelled') throw conflict('reservation_cancelled', 'This reservation is cancelled. Create a new reservation to book again.');
   if (resource.archivedAt) throw conflict('equipment_archived', 'This equipment is archived. Restore it before changing a reservation.');
   await this.links(tx, input);
   const occupied = occupancy(input);
   const [row] = await tx<Reservation[]>`update equipment_reservations set title = ${input.title}, kind = ${input.kind}, starts_at = ${input.startsAt}, ends_at = ${input.endsAt},
    setup_minutes = ${input.setupMinutes}, cleanup_minutes = ${input.cleanupMinutes}, occupied_starts_at = ${occupied.occupiedStartsAt}, occupied_ends_at = ${occupied.occupiedEndsAt},
    project_id = ${input.projectId}, task_id = ${input.taskId}, owner_id = ${input.ownerId}, revision = revision + 1, updated_at = now()
    where id = ${id} and equipment_id = ${equipmentId} returning ${tx.unsafe(reservationColumns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'equipment.reservation_updated', 'equipment_reservation', id, before, row); return row;
  });
 }
 cancelBooking(actor: Actor, organisationId: string, equipmentId: string, id: string, raw: unknown) {
  const input = cancelReservation.parse(raw);
  return this.tx(actor, organisationId, async tx => {
   await this.equipment(tx, equipmentId, true);
   const before = await this.reservation(tx, equipmentId, id);
   if (before.revision !== input.expectedRevision) throw stale();
   if (before.status === 'cancelled') return before;
   const [row] = await tx<Reservation[]>`update equipment_reservations set status = 'cancelled', revision = revision + 1, updated_at = now()
    where id = ${id} and equipment_id = ${equipmentId} returning ${tx.unsafe(reservationColumns)}`;
   if (!row) throw notFound();
   await this.record(tx, actor, organisationId, 'equipment.reservation_cancelled', 'equipment_reservation', id, before, row); return row;
  });
 }
}
