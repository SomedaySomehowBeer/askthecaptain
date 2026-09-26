#!/usr/bin/env bash
# Retire the Neon-made administrative `app` password and reconcile `neon_role.app` in Terraform state.
# Run by .github/workflows/retire-elevated-runtime.yml from infra/tofu, after `tofu init`.
#
# Order, each step a gate for the next:
#   1. Identify the role from state: project royal-glitter-10514027, role `app`, on the project's default branch.
#      The old and owner URLs must be that state's own connections: `app` with exactly neon_role.app's password,
#      the project's database user, the project's host and database (check_urls).
#   2. Staging must already run the guarded API: /readyz 200. The guarded image fails readiness on an
#      administrative role, so this is the proof; a `captain_runtime` session and the role's safety are
#      corroboration (a session alone could be unrelated).
#   3. The old password must still work (so the rejection in 5 means something). If it is already rejected by the
#      server, an earlier run's reset took effect: skip to 5. Anything else stops with nothing changed.
#   4. POST reset_password exactly once, never retried. On 200 with well-formed operations, wait for them all:
#      Neon keeps the old password valid until the last finishes, and drops the role's connections. Any other
#      outcome is recorded as unconfirmed, never as success; step 5 then decides.
#   5. The old password is rejected by the server, the owner sees no `app` sessions, `captain_runtime` is still
#      safe, and /readyz is 200 again.
#   6. A refresh-only plan targeted at neon_role.app alone (an ephemeral override pins its project and branch so
#      the project is not refreshed with it), checked to change nothing but that role's password and the output
#      built from it (plan_is_password_refresh) and to have found that change, is applied. That writes state only;
#      nothing is provisioned. A refusal prints addresses, actions and changed attribute names, never values.
#
# Nothing secret is printed: URLs and passwords are masked and never echoed, the reset response and the plan
# JSON are read inside a private directory and deleted, and only statuses and counts are logged.
# Resumable: a run that stops after the reset finds the old password rejected at step 3 and continues from 5.
# Do not rerun after step 6 has completed: state then holds the new, unused password, and a rerun would reset
# that one again for no benefit.
set -euo pipefail
umask 077
. "$(dirname "$0")/retire-elevated-runtime-lib.sh"

PROJECT='royal-glitter-10514027'
ROLE='app'
RUNTIME='captain_runtime'
READYZ='https://api-staging.askthecaptain.app/readyz'
NEON='https://console.neon.tech/api/v2'
PSQL="${PG_BIN:-/usr/lib/postgresql/18/bin}/psql"
export PGCONNECT_TIMEOUT=15

work="$(mktemp -d)"
# Step 6's ephemeral override (see there). Every exit removes it, but only if this run created it: a file that was
# already there is refused and left alone.
override="$PWD/zz_retire_scoped_role_override.tf"
override_created=0
remove_override() { if [ "$override_created" = 1 ]; then rm -f "$override"; override_created=0; fi; }
trap 'rm -rf "$work"; remove_override' EXIT
say() { echo "[retire] $*"; }
fail() { echo "::error::[retire] $*"; exit 1; }
mask() { if [ -n "$1" ]; then echo "::add-mask::$1"; fi; }

# 1. Identify the role and its connections from state. --------------------------------------------------------
tofu state pull > "$work/state.json"
attr() { jq -r --arg type "$1" --arg name "$2" --arg key "$3" \
	'[.resources[] | select(.mode == "managed" and .type == $type and .name == $name)] | if length == 1 then .[0].instances[0].attributes[$key] // empty else empty end' \
	"$work/state.json"; }
mask "$(attr neon_role app password)"; mask "$(attr neon_project captain database_password)"
[ "$(attr neon_role app project_id)" = "$PROJECT" ] || fail 'neon_role.app is not in the expected project'
[ "$(attr neon_project captain id)" = "$PROJECT" ] || fail 'neon_project.captain is not the expected project'
[ "$(attr neon_role app name)" = "$ROLE" ] || fail 'neon_role.app does not name the role app'
branch="$(attr neon_role app branch_id)"
[[ "$branch" =~ ^br-[a-z0-9-]+$ ]] || fail 'neon_role.app records no valid branch id'
[ "$branch" = "$(attr neon_project captain default_branch_id)" ] || fail "neon_role.app's branch is not the project's default branch"

OLD_URL="$(tofu output -raw neon_app_database_url)"; mask "$OLD_URL"
OWNER_URL="$(tofu output -raw neon_owner_database_url)"; mask "$OWNER_URL"
export OLD_URL OWNER_URL
identity="$(check_urls "$work/state.json")" || fail "connection identity check failed: $identity"
rm -f "$work/state.json"
say "role $ROLE on project $PROJECT, default branch $branch; both URLs are the state's own connections"

owner() { "$PSQL" "$OWNER_URL" -X -At -v ON_ERROR_STOP=1 -c "$1" 2> /dev/null; }
old_password() {
	local status=0
	"$PSQL" "$OLD_URL" -X -At -c 'select 1' > /dev/null 2> "$work/old.err" || status=$?
	classify_auth "$status" "$work/old.err"
	rm -f "$work/old.err"
}
readyz() { curl -sS -o "$work/readyz.json" -w '%{http_code}' --max-time 15 "$READYZ" 2> /dev/null || true; }
ready() { [ "$(readyz)" = 200 ] && jq -e '.ok == true' "$work/readyz.json" > /dev/null 2>&1; }
runtime_safe() {
	[ "$(owner "select rolcanlogin and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)
		and not exists (select 1 from pg_auth_members m where m.member = r.oid)
		and not exists (select 1 from pg_shdepend d where d.refclassid = 'pg_authid'::regclass and d.refobjid = r.oid and d.deptype = 'o')
		from pg_roles r where rolname = '$RUNTIME'")" = t ]
}
app_sessions() { owner "select count(*) from pg_stat_activity where usename = '$ROLE'"; }

# 2. Staging runs the guarded API. ------------------------------------------------------------------------------
[ "$(owner 'select 1')" = 1 ] || fail 'owner connection failed'
ready || fail 'staging /readyz is not 200 ok; activate captain_runtime on the guarded image first'
connected="$(owner "select count(*) from pg_stat_activity where usename = '$RUNTIME'")" || fail 'owner could not read sessions'
[ "${connected:-0}" -ge 1 ] || fail "no $RUNTIME session is connected; staging does not appear to run as $RUNTIME yet"
runtime_safe || fail "$RUNTIME is not a safe login role"
before="$(app_sessions)" || fail 'owner could not read sessions'
say "staging ready; $RUNTIME sessions $connected, safe; $ROLE sessions before reset $before"

# 3. Baseline for the old password. ----------------------------------------------------------------------------
baseline="$(old_password)"
say "old password before reset: $baseline"
case "$baseline" in
	accepted) reset_status='pending' ;;
	rejected) reset_status='skipped: already rejected by the server, an earlier reset took effect' ;;
	*) fail 'old password neither accepted nor rejected by the server (network, TLS or endpoint problem); nothing was changed' ;;
esac

# 4. Reset exactly once. --------------------------------------------------------------------------------------
if [ "$reset_status" = pending ]; then
	curl_status=0
	code="$(curl -sS -o "$work/reset.json" -w '%{http_code}' --max-time 60 -X POST \
		-H "Authorization: Bearer $NEON_API_KEY" -H 'Accept: application/json' \
		"$NEON/projects/$PROJECT/branches/$branch/roles/$ROLE/reset_password" 2> /dev/null)" || curl_status=$?
	operations=''
	if [ "$curl_status" -eq 0 ] && [ "$code" = 200 ]; then
		if operations="$(reset_operations "$work/reset.json")"; then
			reset_status='confirmed: 200 with operations'
		else
			operations=''
			reset_status='unconfirmed: 200 but the operations could not be read'
			echo "::warning::[retire] reset returned 200 without readable operations; not retrying, verifying instead"
		fi
	elif [ "$curl_status" -eq 0 ] && [ "$code" = 423 ]; then
		fail 'project is busy with other operations (HTTP 423); nothing was changed, rerun later'
	elif [ "$curl_status" -eq 0 ] && [[ "$code" =~ ^4 ]]; then
		fail "reset refused with HTTP $code; nothing was changed"
	else
		# The reset may or may not have happened. No retry: step 5 decides, and a rerun re-checks at step 3.
		reset_status="unconfirmed: curl $curl_status, HTTP ${code:-none}"
		echo "::warning::[retire] reset outcome uncertain ($reset_status); not retrying, verifying instead"
	fi
	rm -f "$work/reset.json" # holds the new password; nothing beyond the operation ids is read

	for op in $operations; do
		for attempt in $(seq 1 120); do
			status="$(curl -sS --max-time 15 -H "Authorization: Bearer $NEON_API_KEY" -H 'Accept: application/json' \
				"$NEON/projects/$PROJECT/operations/$op" 2> /dev/null | jq -r '.operation.status // "unknown"' 2> /dev/null || true)"
			case "$status" in
				finished|skipped) say "operation $op $status"; break ;;
				failed|error|cancelled) fail "operation $op $status; the old password may still work" ;;
			esac
			[ "$attempt" -lt 120 ] || fail "operation $op still ${status:-unknown} after 10 minutes"
			sleep 5
		done
	done
fi
say "reset: $reset_status"

# 5. Verify. ------------------------------------------------------------------------------------------------
for attempt in $(seq 1 24); do
	result="$(old_password)"
	[ "$result" = rejected ] && break
	[ "$attempt" -lt 24 ] || fail "old password still $result after 2 minutes (reset: $reset_status); do not assume it is retired"
	sleep 5
done
say 'old password rejected by the server'
sessions="$(app_sessions)" || fail 'owner could not read sessions'
[ "$sessions" = 0 ] || fail "the owner still sees $sessions $ROLE sessions"
runtime_safe || fail "$RUNTIME is no longer a safe login role"
for attempt in $(seq 1 24); do
	ready && break
	[ "$attempt" -lt 24 ] || fail 'staging /readyz did not recover within 2 minutes'
	sleep 5
done
say "no $ROLE sessions; $RUNTIME still safe; staging /readyz 200"

# 6. Reconcile state with a checked refresh-only plan. ---------------------------------------------------------
# neon_role.app takes project_id and branch_id from neon_project.captain, so targeting the role also refreshes the
# project, whose server-managed fields drift on their own. An override file (OpenTofu merges `*_override.tf` into
# the resource of the same address, each argument replacing the original's) pins both to the values validated in
# step 1, which equal the role's state. The role then has no dependency and is refreshed alone. The file exists
# only in this checkout, only for plan and apply, and is removed on exit; every gate below is unchanged.
for existing in ./*override.tf ./*override.tf.json ./*override.tofu ./*override.tofu.json; do
	if [ -e "$existing" ]; then fail 'an override file already exists in infra/tofu; not adding another'; fi
done
[ -z "$(git ls-files -- "$override")" ] || fail 'the override path is tracked by git'
[[ "$branch" =~ ^br-[a-z0-9-]+$ ]] || fail 'branch id unexpectedly changed shape'
# Exclusive creation: with noclobber, bash opens the path with O_EXCL, so this fails rather than truncating a file
# that appeared since the check above. Ownership is recorded only once creation has succeeded.
if ( set -o noclobber; : > "$override" ) 2> /dev/null; then override_created=1
else fail 'could not create the override exclusively; not refreshing'; fi
cat >> "$override" <<HCL
# Ephemeral: written by .github/scripts/retire-elevated-runtime.sh for one refresh, removed on exit. Never commit.
resource "neon_role" "app" {
  project_id = "$PROJECT"
  branch_id  = "$branch"
}
HCL
tofu plan -refresh-only -target=neon_role.app -input=false -no-color -out="$work/refresh.tfplan" > /dev/null
tofu show -json "$work/refresh.tfplan" > "$work/plan.json"
if ! reason="$(plan_is_password_refresh "$work/plan.json")"; then
	plan_diagnostics "$work/plan.json" | sed 's/^/[retire] plan: /'
	fail "refresh-only plan not applied: $reason"
fi
drifted="$(jq '[.resource_drift // [] | .[]] | length' "$work/plan.json")"
if [ "$drifted" = 0 ]; then
	plan_diagnostics "$work/plan.json" | sed 's/^/[retire] plan: /'
	fail 'no password drift observed by the refresh; state reconciliation not confirmed, so nothing is applied'
fi
rm -f "$work/plan.json"
tofu apply -input=false -no-color "$work/refresh.tfplan" > /dev/null
remove_override
say "state reconciled from a refresh-only plan (drift: neon_role.app password only); nothing provisioned"
say "done (reset: $reset_status); do not rerun this workflow"
