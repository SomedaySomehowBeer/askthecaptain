import type { Sql } from '@captain/db';
import type { CommitmentsService } from './service.ts';

/** Housekeeping, never a workflow (plan §6): create the next occurrence of every active series at
 *  the start of its period. Materialising is idempotent (one task per series and period, enforced by
 *  the database), so the routine simply runs every hour for each organisation with an active series;
 *  an occurrence appears within the hour after local midnight opens its period. */
export class SeriesRoutine {
	readonly #db: Sql; readonly #commitments: CommitmentsService;
	constructor(db: Sql, commitments: CommitmentsService) { this.#db = db; this.#commitments = commitments; }

	async organisations(): Promise<string[]> {
		return (await this.#db<{ organisationId: string }[]>`select organisation_id from series_organisations()`).map((row) => row.organisationId);
	}

	/** Returns how many occurrences were created. `today` is for tests; production uses the
	 *  organisation's own date. Each created task is journaled by the service as the system actor. */
	run(organisationId: string, today?: string): Promise<number> {
		return this.#commitments.materialise(organisationId, today);
	}
}

export function startSeriesSchedule(routine: Pick<SeriesRoutine, 'organisations' | 'run'>, disabled = false, intervalMs = 3_600_000): () => Promise<void> {
	if (disabled) return async () => {};
	let active: Promise<void> | undefined;
	const tick = () => {
		if (active) return;
		active = (async () => { for (const org of await routine.organisations()) await routine.run(org).catch(() => undefined); })()
			.catch(() => { console.error('[series] Scheduled materialise could not reach its database. Check API database connectivity.'); })
			.finally(() => { active = undefined; });
	};
	const timer = setInterval(tick, intervalMs); timer.unref(); tick();
	return async () => { clearInterval(timer); await active; };
}
