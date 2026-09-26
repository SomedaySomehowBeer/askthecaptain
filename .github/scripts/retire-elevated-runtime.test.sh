#!/usr/bin/env bash
# Fixture tests for retire-elevated-runtime-lib.sh. Needs bash, jq and python3; no network, no database.
#   bash .github/scripts/retire-elevated-runtime.test.sh
set -euo pipefail
. "$(dirname "$0")/retire-elevated-runtime-lib.sh"
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
passed=0; failed=0
check() { # check NAME EXPECTED ACTUAL
	if [ "$2" = "$3" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $1: expected [$2], got [$3]"; fi
}

# check_urls ------------------------------------------------------------------------------------------------
cat > "$dir/state.json" <<'JSON'
{"resources": [
 {"mode": "managed", "type": "neon_project", "name": "captain", "instances": [{"attributes": {"id": "royal-glitter-10514027",
  "default_branch_id": "br-main-1", "database_host": "ep-x.ap-southeast-2.aws.neon.tech", "database_user": "neondb_owner", "database_password": "owner+pw/1"}}]},
 {"mode": "managed", "type": "neon_database", "name": "captain", "instances": [{"attributes": {"name": "captain", "project_id": "royal-glitter-10514027", "branch_id": "br-main-1"}}]},
 {"mode": "managed", "type": "neon_role", "name": "app", "instances": [{"attributes": {"name": "app", "project_id": "royal-glitter-10514027", "branch_id": "br-main-1", "password": "npg_old pw"}}]}
]}
JSON
host='ep-x.ap-southeast-2.aws.neon.tech'
good_old="postgresql://app:npg_old+pw@$host/captain?sslmode=require"   # tofu urlencode: space -> +
good_owner="postgresql://neondb_owner:owner%2Bpw%2F1@$host/captain?sslmode=require"
urls() { OLD_URL="$1" OWNER_URL="$2" check_urls "$dir/state.json" || true; }
check 'urls: the state'"'"'s own connections' ok "$(urls "$good_old" "$good_owner")"
check 'urls: old URL as another user' 'old URL does not sign in as app' "$(urls "postgresql://captain_runtime:npg_old+pw@$host/captain" "$good_owner")"
check 'urls: old URL with another password' "old URL password is not neon_role.app's password" "$(urls "postgresql://app:npg_new@$host/captain" "$good_owner")"
check 'urls: password compared decoded' "old URL password is not neon_role.app's password" "$(urls "postgresql://app:npg_old%20pwx@$host/captain" "$good_owner")"
check 'urls: owner URL as app' "owner URL does not sign in as the project's database user" "$(urls "$good_old" "postgresql://app:npg_old+pw@$host/captain")"
check 'urls: owner URL wrong password' "owner URL password is not the project's database password" "$(urls "$good_old" "postgresql://neondb_owner:nope@$host/captain")"
check 'urls: different host' "URLs do not both use the project's host" "$(urls "postgresql://app:npg_old+pw@ep-y.neon.tech/captain" "$good_owner")"
check 'urls: pooler host is not the project host' "URLs do not both use the project's host" "$(urls "postgresql://app:npg_old+pw@ep-x-pooler.ap-southeast-2.aws.neon.tech/captain" "$good_owner")"
check 'urls: different database' "URLs do not both use the project's database" "$(urls "postgresql://app:npg_old+pw@$host/neondb" "$good_owner")"
check 'urls: not a URL' 'OLD_URL is not a postgres URL' "$(urls 'not a url' "$good_owner")"
jq '(.resources[] | select(.type == "neon_role") | .instances[0].attributes.branch_id) = "br-other"' "$dir/state.json" > "$dir/state-branch.json"
check 'urls: role on another branch' 'role, database and default branch disagree' \
	"$(OLD_URL="$good_old" OWNER_URL="$good_owner" check_urls "$dir/state-branch.json" || true)"
jq '.resources += [.resources[2]]' "$dir/state.json" > "$dir/state-twice.json"
check 'urls: two neon_role.app' 'state does not hold exactly one neon_role.app' \
	"$(OLD_URL="$good_old" OWNER_URL="$good_owner" check_urls "$dir/state-twice.json" || true)"

# classify_auth -------------------------------------------------------------------------------------------------
auth() { printf '%s\n' "$2" > "$dir/err"; classify_auth "$1" "$dir/err"; }
check 'auth: connected' accepted "$(auth 0 '')"
check 'auth: postgres rejection' rejected "$(auth 2 'psql: error: connection to server at "ep-x" (1.2.3.4), port 5432 failed: FATAL:  password authentication failed for user "app"')"
check 'auth: proxy rejection' rejected "$(auth 2 "psql: error: connection to server at \"ep-x\", port 5432 failed: FATAL:  password authentication failed for user 'app'")"
check 'auth: another role rejected is not this one' unknown "$(auth 2 'psql: error: connection failed: FATAL:  password authentication failed for user "app_other"')"
check 'auth: timeout' unknown "$(auth 2 'psql: error: connection to server at "ep-x" (1.2.3.4), port 5432 failed: timeout expired')"
check 'auth: dns' unknown "$(auth 2 'psql: error: could not translate host name "ep-x" to address: Name or service not known')"
check 'auth: tls' unknown "$(auth 2 'psql: error: connection to server failed: SSL SYSCALL error: EOF detected')"
check 'auth: endpoint gone' unknown "$(auth 2 'psql: error: connection to server failed: ERROR:  The requested endpoint could not be found, or you don'"'"'t have access to it.')"
check 'auth: role cannot log in' unknown "$(auth 2 'psql: error: connection failed: FATAL:  role "app" is not permitted to log in')"
check 'auth: empty failure' unknown "$(auth 2 '')"

# reset_operations ------------------------------------------------------------------------------------------------
ops() { printf '%s' "$1" > "$dir/reset.json"; reset_operations "$dir/reset.json" | tr '\n' ' ' || echo MALFORMED; }
check 'ops: well formed' 'op-1 op-2 ' "$(ops '{"role": {"name": "app", "password": "x"}, "operations": [{"id": "op-1"}, {"id": "op-2"}]}')"
check 'ops: missing' MALFORMED "$(ops '{"role": {"name": "app"}}')"
check 'ops: empty' MALFORMED "$(ops '{"operations": []}')"
check 'ops: not an array' MALFORMED "$(ops '{"operations": {"id": "op-1"}}')"
check 'ops: id missing' MALFORMED "$(ops '{"operations": [{"id": "op-1"}, {"status": "running"}]}')"
check 'ops: id with a path' MALFORMED "$(ops '{"operations": [{"id": "../op"}]}')"
check 'ops: not json' MALFORMED "$(ops '<html>502</html>')"
check 'ops: empty body' MALFORMED "$(ops '')"

# plan_is_password_refresh ------------------------------------------------------------------------------------
plan() { printf '%s' "$1" > "$dir/plan.json"; plan_is_password_refresh "$dir/plan.json" && echo ok || true; }
role_drift() { # role_drift BEFORE AFTER [ACTIONS]
	printf '{"resource_drift": [{"address": "neon_role.app", "change": {"actions": %s, "before": %s, "after": %s}}], "resource_changes": [], "output_changes": {"neon_app_database_url": {"actions": ["update"]}, "neon_owner_database_url": {"actions": ["no-op"]}}}' \
		"${3:-[\"update\"]}" "$1" "$2"
}
base='{"id": "app", "name": "app", "project_id": "p", "branch_id": "b", "password": "old"}'
check 'plan: password only' ok "$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "branch_id": "b", "password": "new"}')")"
check 'plan: nothing drifted' ok "$(plan '{"resource_drift": [], "resource_changes": [{"address": "neon_role.app", "change": {"actions": ["no-op"]}}], "output_changes": {}}')"
check 'plan: another attribute changes' 'drift changes more than the password' \
	"$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "branch_id": "b2", "password": "new"}')")"
check 'plan: a key only after the refresh' 'drift changes more than the password' \
	"$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "branch_id": "b", "password": "new", "protected": true}')")"
check 'plan: a key only before the refresh' 'drift changes more than the password' \
	"$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "password": "new"}')")"
check 'plan: a key becoming null' 'drift changes more than the password' \
	"$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "branch_id": null, "password": "new"}')")"
check 'plan: replace' 'drift is not an in-place update' \
	"$(plan "$(role_drift "$base" '{"id": "app", "name": "app", "project_id": "p", "branch_id": "b", "password": "new"}' '["delete", "create"]')")"
check 'plan: role deleted outside' 'drift is not an in-place update' "$(plan "$(role_drift "$base" 'null' '["delete"]')")"
check 'plan: other drift' 'drift outside neon_role.app' \
	"$(plan '{"resource_drift": [{"address": "neon_project.captain", "change": {"actions": ["update"], "before": {}, "after": {}}}], "resource_changes": []}')"
check 'plan: a managed change' 'plan proposes a managed change' \
	"$(plan '{"resource_drift": [], "resource_changes": [{"address": "neon_role.app", "change": {"actions": ["update"]}}]}')"
check 'plan: a create' 'plan proposes a managed change' \
	"$(plan '{"resource_changes": [{"address": "cloudflare_dns_record.app", "change": {"actions": ["create"]}}]}')"
check 'plan: another output changes' 'an output other than neon_app_database_url changes' \
	"$(plan '{"resource_drift": [], "resource_changes": [], "output_changes": {"neon_owner_database_url": {"actions": ["update"]}}}')"

echo "retire-elevated-runtime lib: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
