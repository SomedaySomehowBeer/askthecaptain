import { withTenant, type Sql } from '@captain/db';
import { startSeriesSchedule } from '../commitments/routine.ts';
/** D13 housekeeping: expired text is inaccessible immediately; physical deletion runs hourly. */
export function startAttachmentExpiry(db: Sql) {
 return startSeriesSchedule({
  organisations: async () => (await db`select organisation_id from attachment_text_organisations()`).map(r => String(r.organisationId)),
  run: org => expireAttachments(db, org)
 });
}
export function expireAttachments(db: Sql, organisationId: string) {
 return withTenant(db, { organisationId }, async tx => (await tx`delete from attachment_text where expires_at <= now() returning message_id`).length);
}
