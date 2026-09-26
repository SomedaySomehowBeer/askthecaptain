# Runtime-role repair verification — 26 September 2026

[PR #162](https://github.com/SomedaySomehowBeer/askthecaptain/pull/162) merged as
`7236abbfd2c37f245d583380d9bd96f1d348e575`; its tree exactly matches tested image source
`6977fac47dce97cdd0ec2829367fccd671bc7851`. Both Claude Opus agents reviewed the implementation,
reciprocal changes and coordinator fixes. [CI](https://github.com/SomedaySomehowBeer/askthecaptain/actions/runs/36219270732)
passed on fresh PostgreSQL, including the existing browser regression. No web routes changed.

[Verification totals](verification.txt): 10 workspace typecheck tasks, 358 tests across all eight
packages, and API build passed. Latest-schema fixtures connect as SQL-created `captain_runtime`;
historical migration fixtures use their applicable role. Database tests force overlapping role
creation in two databases, check refusal cases and grant/policy parity, and exercise tenant/private
view isolation. API startup/readiness tests reject administrative roles, memberships, ownership and
row security disabled.

Earlier runs caught a role-creation race, fault injection against the wrong role, query-result
prototype assertions, and sequence privilege checks evaluated before type filtering. Each was
corrected before the passing run and CI. The restore script initially assumed migration number
0041 meant 41 migrations; the corrected rehearsal compares the actual source count (38) and latest
migration name. This is not an additional application-code change.

A disposable ACL-free dump/restore retained one organisation, all 38 migrations and 69 policies
naming the new role, with zero policy-role mismatches. It deliberately has no restored application
grants. This proves schema/policy preservation, not application-ready recovery. The roles already
existed in this disposable cluster, so this rehearsal does not exercise the backup workflow's
create-if-missing role block. Grant replay remains required before hosted backups resume.

The read-only hosted preflight found no disallowed direct application grant types, no default
role ACLs, an eligible owner, and no unowned applicable grant targets. Its first ownership query
was overly broad and counted extension objects; the corrected query scoped ownership to direct
application grants. No customer content was read, and no database writes or credentials changed.
This preflight is not proof of migration application or of isolation under a future connection.

Hosted preparation and remaining activation gates are recorded in
[the paused runbook](../../runbooks/paused.md) and [repair plan](../../plans/runtime-database-role-2026-09.md).
