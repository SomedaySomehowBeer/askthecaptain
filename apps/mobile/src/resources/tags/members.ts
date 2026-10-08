/** Members for owner names and choices on the Tags and series screens: read once per screen, never cached beyond it. */
import { useEffect, useState } from 'react';
import type { ReadScope } from '../../account/contracts.ts';
import { parseMembers, type Member } from '../../account/members.ts';
import { organisationPath } from '../../api/paths.ts';
import type { ThreadCalls } from '../../threads/api.ts';
import type { Option } from '../../threads/cards/Fields.tsx';
import { tagsCopy } from './tags.ts';

/** The members, for owner names and choices; read once per screen. Null until read (or when the read failed). */
export function useMembers(calls: ThreadCalls, scope: ReadScope): readonly Member[] | null {
	const [members, setMembers] = useState<readonly Member[] | null>(null);
	useEffect(() => {
		let live = true;
		void calls.request(scope, 'GET', organisationPath(scope.organisationId, 'members'), undefined, parseMembers).then((r) => { if (live && r.kind === 'ok') setMembers(r.value); });
		return () => { live = false; };
	}, []);
	return members;
}
export const ownerOptions = (members: readonly Member[] | null, current: string | null, currentName: string | null): Option[] => {
	const rows: Option[] = [{ value: '', label: tagsCopy.noOwner }, ...(members ?? []).map((m) => ({ value: m.userId, label: m.name || m.email }))];
	if (current && !rows.some((r) => r.value === current)) rows.push({ value: current, label: `${currentName ?? 'Former member'}${members ? ' (not a member now)' : ''}` });
	return rows;
};

