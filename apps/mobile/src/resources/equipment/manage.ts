/** The Equipment screen's reads and writes (bookings contract §3): the list, active or archived, and the three
 *  revision-checked, journalled writes a person makes there (add, rename, archive or unarchive). Each write carries a
 *  client change set id and answers with it (versions contract §5). Strict parsers: one bad row refuses the answer.
 *  Shapes follow apps/api/src/equipment/service.ts. Pure: no React Native import, so Node tests import it. */
import type { ReadScope } from '../../account/contracts.ts';
import { equipmentPageSize, isCanonicalInstant, organisationPath } from '../../api/paths.ts';
import { queryPath } from '../../threads/api.ts';
import type { Write } from '../../threads/cards/records.ts';
import { array, integer, keys, object, text, uuid } from '../../threads/parse.ts';

const bad = (): never => { throw new TypeError('equipment: unexpected response'); };
const instant = (x: unknown): string => isCanonicalInstant(x) ? x : bad();

export type ManagedEquipment = { readonly id: string; readonly name: string; readonly archivedAt: string | null; readonly revision: number };
const equipmentKeys = ['id', 'name', 'archivedAt', 'revision', 'createdAt', 'updatedAt'];

export function parseManagedEquipment(raw: unknown, extra: string[] = []): ManagedEquipment {
	const x = object(raw); keys(x, equipmentKeys, extra);
	instant(x.createdAt); instant(x.updatedAt);
	const name = text(x.name, 100);
	if (!name.trim() || name !== name.trim()) bad();
	return Object.freeze({ id: uuid(x.id), name, archivedAt: x.archivedAt === null ? null : instant(x.archivedAt), revision: integer(x.revision, 1) });
}
export type EquipmentList = { readonly archived: boolean; readonly equipment: readonly ManagedEquipment[]; readonly more: boolean };
/** `GET …/equipment?archived=&limit=100&offset=0`: every row in the state asked for, unique ids. */
export function parseEquipmentList(raw: unknown, archived: boolean): EquipmentList {
	const x = object(raw); keys(x, ['equipment', 'nextOffset']);
	const equipment = array(x.equipment, (row) => parseManagedEquipment(row), equipmentPageSize);
	if (new Set(equipment.map((e) => e.id)).size !== equipment.length || equipment.some((e) => (e.archivedAt !== null) !== archived)) bad();
	if (x.nextOffset !== null && (x.nextOffset !== equipmentPageSize || equipment.length !== equipmentPageSize)) bad();
	return Object.freeze({ archived, equipment: Object.freeze(equipment), more: x.nextOffset !== null });
}
export const equipmentListPath = (scope: ReadScope, archived: boolean) =>
	queryPath(organisationPath(scope.organisationId, 'equipment'), { archived: String(archived), limit: equipmentPageSize, offset: 0 });

/** A write's answer: the equipment asked about, with the change set that was sent. */
export function parseEquipmentWrite(raw: unknown, expected: { id?: string; changeSetId: string; name?: string; archived?: boolean }): ManagedEquipment & { changeSetId: string } {
	const x = object(raw); const e = parseManagedEquipment(x, ['changeSetId']);
	if (uuid(x.changeSetId) !== expected.changeSetId || (expected.id && e.id !== expected.id)) bad();
	if (expected.name !== undefined && e.name !== expected.name) bad();
	if (expected.archived !== undefined && (e.archivedAt !== null) !== expected.archived) bad();
	return { ...e, changeSetId: expected.changeSetId };
}

/** The API's name rule: trimmed, 1 to 100 characters. Null when valid. */
export function equipmentNameProblem(name: string): string | null {
	const v = name.trim();
	if (!v) return 'Enter a name for the equipment.';
	if (v.length > 100) return 'A name is at most 100 characters.';
	return null;
}

export const equipmentWrites = {
	add: (scope: ReadScope, changeSetId: string, name: string): Write<ManagedEquipment & { changeSetId: string }> =>
		({ method: 'POST', path: organisationPath(scope.organisationId, 'equipment'), body: { changeSetId, name: name.trim() },
			parse: (v) => parseEquipmentWrite(v, { changeSetId, name: name.trim(), archived: false }) }),
	rename: (scope: ReadScope, item: ManagedEquipment, changeSetId: string, name: string): Write<ManagedEquipment & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'equipment', uuid(item.id)), body: { changeSetId, expectedRevision: item.revision, name: name.trim() },
			parse: (v) => parseEquipmentWrite(v, { id: item.id, changeSetId, name: name.trim() }) }),
	archive: (scope: ReadScope, item: ManagedEquipment, changeSetId: string, archived: boolean): Write<ManagedEquipment & { changeSetId: string }> =>
		({ method: 'PATCH', path: organisationPath(scope.organisationId, 'equipment', uuid(item.id)), body: { changeSetId, expectedRevision: item.revision, archived },
			parse: (v) => parseEquipmentWrite(v, { id: item.id, changeSetId, archived }) })
};

/** Refusals these writes document, in words (the saver's general copy covers the rest). */
export const equipmentRefusals: Readonly<Record<string, string>> = Object.freeze({
	equipment_name_exists: 'Equipment with that name already exists, including archived equipment. Choose another name.',
	equipment_in_use: 'This equipment has upcoming or current bookings. Cancel them before archiving it.'
});
