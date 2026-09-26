#!/usr/bin/env bash
# Fixture tests for the checks reconcile-retired-output.sh uses. Needs bash, jq and python3; no network, no database.
#   bash .github/scripts/reconcile-retired-output.test.sh
set -euo pipefail
. "$(dirname "$0")/retire-elevated-runtime-lib.sh"
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
passed=0; failed=0
check() { # check NAME EXPECTED ACTUAL
	if [ "$2" = "$3" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); echo "FAIL $1: expected [$2], got [$3]"; fi
}

host='ep-x.ap-southeast-2.aws.neon.tech'
cat > "$dir/state.json" <<JSON
{"resources": [
 {"mode": "managed", "type": "neon_project", "name": "captain", "instances": [{"attributes": {"id": "royal-glitter-10514027",
  "default_branch_id": "br-main-1", "database_host": "$host", "database_user": "neondb_owner", "database_password": "owner"}}]},
 {"mode": "managed", "type": "neon_database", "name": "captain", "instances": [{"attributes": {"name": "captain", "project_id": "royal-glitter-10514027", "branch_id": "br-main-1"}}]},
 {"mode": "managed", "type": "neon_role", "name": "app", "instances": [{"attributes": {"name": "app", "project_id": "royal-glitter-10514027", "branch_id": "br-main-1", "password": "npg new/pw+1"}}]}
]}
JSON
# What neon.tf generates: urlencode (Go QueryEscape) turns "npg new/pw+1" into "npg+new%2Fpw%2B1".
current="postgresql://app:npg+new%2Fpw%2B1@$host/captain?sslmode=require"
stale="postgresql://app:npg_old@$host/captain?sslmode=require"

# check_output_url ----------------------------------------------------------------------------------------------
url() { OUTPUT_URL="$2" EXPECT="$1" check_output_url "${3:-$dir/state.json}" || true; }
check 'current: the generated URL' ok "$(url current "$current")"
check 'current: the stale value' "output is not the URL generated from neon_role.app's password, host and database" "$(url current "$stale")"
check 'current: without sslmode' "output is not the URL generated from neon_role.app's password, host and database" "$(url current "postgresql://app:npg+new%2Fpw%2B1@$host/captain")"
check 'current: with a fragment' "output is not the URL generated from neon_role.app's password, host and database" "$(url current "$current#x")"
check 'current: pooler host' "output is not the URL generated from neon_role.app's password, host and database" \
	"$(url current "postgresql://app:npg+new%2Fpw%2B1@ep-x-pooler.ap-southeast-2.aws.neon.tech/captain?sslmode=require")"
check 'current: lower-case escapes are not what urlencode writes' "output is not the URL generated from neon_role.app's password, host and database" \
	"$(url current "postgresql://app:npg+new%2fpw%2b1@$host/captain?sslmode=require")"
check 'current: %20 for a space is not what urlencode writes' "output is not the URL generated from neon_role.app's password, host and database" \
	"$(url current "postgresql://app:npg%20new%2Fpw%2B1@$host/captain?sslmode=require")"
check 'stale: a generated URL with another password' ok "$(url stale "$stale")"
check 'stale: already the current password' "the value being replaced already holds neon_role.app's password" "$(url stale "$current")"
check 'stale: another host' 'the value being replaced is not a URL of the generated shape for app' "$(url stale "postgresql://app:npg_old@ep-y.neon.tech/captain?sslmode=require")"
check 'stale: another user' 'the value being replaced is not a URL of the generated shape for app' "$(url stale "postgresql://captain_runtime:npg_old@$host/captain?sslmode=require")"
check 'stale: no password' 'the value being replaced is not a URL of the generated shape for app' "$(url stale "postgresql://app@$host/captain?sslmode=require")"
malformed="$(url stale 'postgresql://app:SECRET-M@[bad/captain')"
check 'stale: malformed URL, no traceback' 'the value or state could not be parsed' "$malformed"
check 'unknown expectation' 'EXPECT must be current or stale' "$(url later "$current")"
jq '(.resources[] | select(.type == "neon_project") | .instances[0].attributes.id) = "other-project"
	| (.resources[] | select(.type != "neon_project") | .instances[0].attributes.project_id) = "other-project"' "$dir/state.json" > "$dir/other-project.json"
check 'state: another project' 'state is not project royal-glitter-10514027' "$(url current "$current" "$dir/other-project.json")"
jq '(.resources[] | select(.type == "neon_database") | .instances[0].attributes.branch_id) = "br-other"' "$dir/state.json" > "$dir/branch.json"
check 'state: database on another branch' 'role, database and default branch disagree' "$(url current "$current" "$dir/branch.json")"
jq '(.resources[] | select(.type == "neon_role") | .instances[0].attributes.project_id) = "p2"' "$dir/state.json" > "$dir/role-project.json"
check 'state: role in another project' 'role, database and project disagree' "$(url current "$current" "$dir/role-project.json")"
jq '.resources += [.resources[2]]' "$dir/state.json" > "$dir/twice.json"
check 'state: two neon_role.app' 'state does not hold exactly one neon_role.app' "$(url current "$current" "$dir/twice.json")"

# same_but_password ---------------------------------------------------------------------------------------------
pair() { URL_A="$1" URL_B="$2" same_but_password || true; }
check 'pair: only the password differs' ok "$(pair "$stale" "$current")"
check 'pair: same password' 'the passwords do not differ' "$(pair "$current" "$current")"
check 'pair: host differs too' 'the URLs differ in more than the password' "$(pair "$stale" "postgresql://app:npg+new%2Fpw%2B1@ep-y.neon.tech/captain?sslmode=require")"
check 'pair: query differs too' 'the URLs differ in more than the password' "$(pair "$stale" "postgresql://app:npg+new%2Fpw%2B1@$host/captain")"
check 'pair: malformed, no traceback' 'the URLs could not be parsed' "$(pair 'postgresql://app:SECRET-N@[bad/captain' "$current")"

# plan_is_legacy_output_update ------------------------------------------------------------------------------------
noop() { printf '{"address": "%s", "change": {"actions": ["no-op"]}}' "$1"; }
three="$(noop neon_role.app), $(noop neon_project.captain), $(noop neon_database.captain)"
url_change='"neon_app_database_url": {"actions": ["update"], "before": "a", "after": "b", "after_unknown": false, "before_sensitive": true, "after_sensitive": true}'
others='"neon_owner_database_url": {"actions": ["no-op"]}, "neon_project_id": {"actions": ["no-op"]}'
plan() { printf '%s' "$1" > "$dir/plan.json"; plan_is_legacy_output_update "$dir/plan.json" && echo ok || true; }
check 'plan: the output alone' ok "$(plan "{\"resource_changes\": [$three], \"output_changes\": {$url_change, $others}}")"
check 'plan: no resources' 'plan does not cover exactly the three targeted resources' "$(plan "{\"resource_changes\": [], \"output_changes\": {$url_change}}")"
check 'plan: resources absent' 'plan does not cover exactly the three targeted resources' "$(plan "{\"output_changes\": {$url_change}}")"
check 'plan: two resources' 'plan does not cover exactly the three targeted resources' \
	"$(plan "{\"resource_changes\": [$(noop neon_role.app), $(noop neon_project.captain)], \"output_changes\": {$url_change}}")"
check 'plan: a fourth resource' 'plan does not cover exactly the three targeted resources' \
	"$(plan "{\"resource_changes\": [$three, $(noop cloudflare_dns_record.app)], \"output_changes\": {$url_change}}")"
check 'plan: a resource updates' 'plan proposes a managed change' \
	"$(plan "{\"resource_changes\": [$(noop neon_project.captain), $(noop neon_database.captain), {\"address\": \"neon_role.app\", \"change\": {\"actions\": [\"update\"]}}], \"output_changes\": {$url_change}}")"
check 'plan: an import' 'plan imports, moves or replaces a resource' \
	"$(plan "{\"resource_changes\": [$(noop neon_project.captain), $(noop neon_database.captain), {\"address\": \"neon_role.app\", \"change\": {\"actions\": [\"no-op\"], \"importing\": {\"id\": \"x\"}}}], \"output_changes\": {$url_change}}")"
check 'plan: a move' 'plan imports, moves or replaces a resource' \
	"$(plan "{\"resource_changes\": [$(noop neon_project.captain), $(noop neon_database.captain), {\"address\": \"neon_role.app\", \"previous_address\": \"neon_role.app_production\", \"change\": {\"actions\": [\"no-op\"]}}], \"output_changes\": {$url_change}}")"
check 'plan: drift' 'plan found drift, so something was refreshed' \
	"$(plan "{\"resource_drift\": [{\"address\": \"neon_role.app\", \"change\": {\"actions\": [\"update\"]}}], \"resource_changes\": [$three], \"output_changes\": {$url_change}}")"
check 'plan: another output changes too' 'the changed outputs are not exactly neon_app_database_url' \
	"$(plan "{\"resource_changes\": [$three], \"output_changes\": {$url_change, \"neon_owner_database_url\": {\"actions\": [\"update\"]}}}")"
check 'plan: the output does not change' 'the changed outputs are not exactly neon_app_database_url' \
	"$(plan "{\"resource_changes\": [$three], \"output_changes\": {$others}}")"
check 'plan: the output is created' 'neon_app_database_url is not an update between two known strings' \
	"$(plan "{\"resource_changes\": [$three], \"output_changes\": {\"neon_app_database_url\": {\"actions\": [\"create\"], \"before\": null, \"after\": \"b\", \"before_sensitive\": true, \"after_sensitive\": true}}}")"
check 'plan: the new value is unknown' 'neon_app_database_url is not an update between two known strings' \
	"$(plan "{\"resource_changes\": [$three], \"output_changes\": {\"neon_app_database_url\": {\"actions\": [\"update\"], \"before\": \"a\", \"after\": null, \"after_unknown\": true, \"before_sensitive\": true, \"after_sensitive\": true}}}")"
check 'plan: the output is not sensitive' 'neon_app_database_url is not sensitive on both sides' \
	"$(plan "{\"resource_changes\": [$three], \"output_changes\": {\"neon_app_database_url\": {\"actions\": [\"update\"], \"before\": \"a\", \"after\": \"b\", \"after_unknown\": false, \"before_sensitive\": true, \"after_sensitive\": false}}}")"

# dependencies_restored -------------------------------------------------------------------------------------------
deps_state() { # deps_state ROLE_DEPS PROJECT_DEPS
	printf '{"resources": [{"mode": "managed", "type": "neon_role", "name": "app", "instances": [{"dependencies": %s, "attributes": {}}]},
		{"mode": "managed", "type": "neon_database", "name": "captain", "instances": [{"dependencies": %s, "attributes": {}}]}]}' "$1" "$2"
}
deps() { deps_state "$1" "$2" > "$dir/before.json"; deps_state "$3" "$4" > "$dir/after.json"; dependencies_restored "$dir/before.json" "$dir/after.json" || true; }
check 'deps: unchanged' unchanged "$(deps '["neon_project.captain"]' '["neon_project.captain"]' '["neon_project.captain"]' '["neon_project.captain"]')"
check 'deps: restored after the override' restored "$(deps '[]' '["neon_project.captain"]' '["neon_project.captain"]' '["neon_project.captain"]')"
check 'deps: restored from absent' restored "$(deps 'null' '["neon_project.captain"]' '["neon_project.captain"]' '["neon_project.captain"]')"
check 'deps: changed to something else' "neon_role.app's recorded dependencies changed to something other than neon_project.captain" \
	"$(deps '[]' '["neon_project.captain"]' '["neon_database.captain"]' '["neon_project.captain"]')"
check 'deps: another resource changes' 'recorded dependencies changed outside neon_role.app' \
	"$(deps '[]' '["neon_project.captain"]' '["neon_project.captain"]' '[]')"

# state_same_but_bookkeeping ------------------------------------------------------------------------------------
base_state='{"version": 4, "terraform_version": "1.10.5", "serial": 7, "lineage": "L1",
 "outputs": {"neon_app_database_url": {"value": "old", "type": "string", "sensitive": true}},
 "resources": [{"mode": "managed", "type": "neon_role", "name": "app", "provider": "provider[\"registry.opentofu.org/kislerdm/neon\"]",
  "instances": [{"schema_version": 0, "attributes": {"name": "app", "password": "SECRET-P"}, "sensitive_attributes": [], "dependencies": []}]}]}'
printf '%s' "$base_state" > "$dir/state-before.json"
same() { printf '%s' "$base_state" | jq "$1" > "$dir/state-after.json"; state_same_but_bookkeeping "$dir/state-before.json" "$dir/state-after.json" || true; }
check 'state: serial, output and dependency only' ok \
	"$(same '.serial = 8 | .outputs.neon_app_database_url.value = "new" | .resources[0].instances[0].dependencies = ["neon_project.captain"]')"
check 'state: serial not increased' 'the state serial did not increase' "$(same '.outputs.neon_app_database_url.value = "new"')"
check 'state: serial decreased' 'the state serial did not increase' "$(same '.serial = 6')"
check 'state: a credential changed' 'state changed beyond its serial, outputs and recorded dependencies' "$(same '.serial = 8 | .resources[0].instances[0].attributes.password = "SECRET-Q"')"
check 'state: lineage changed' 'state changed beyond its serial, outputs and recorded dependencies' "$(same '.serial = 8 | .lineage = "L2"')"
check 'state: provider changed' 'state changed beyond its serial, outputs and recorded dependencies' "$(same '.serial = 8 | .resources[0].provider = "provider[\"other\"]"')"
check 'state: a resource added' 'state changed beyond its serial, outputs and recorded dependencies' "$(same '.serial = 8 | .resources += [.resources[0] | .name = "other"]')"
check 'state: sensitive attribute paths changed' 'state changed beyond its serial, outputs and recorded dependencies' \
	"$(same '.serial = 8 | .resources[0].instances[0].sensitive_attributes = [[{"type": "get_attr", "value": "password"}]]')"
check 'state: tofu version changed' 'state changed beyond its serial, outputs and recorded dependencies' "$(same '.serial = 8 | .terraform_version = "1.11.0"')"
printf 'not json' > "$dir/state-after.json"
check 'state: after unreadable' 'state after could not be read' "$(state_same_but_bookkeeping "$dir/state-before.json" "$dir/state-after.json" || true)"
check 'state: no value is printed' no "$(case "$(same '.serial = 8 | .resources[0].instances[0].attributes.password = "SECRET-Q"')" in *SECRET*) echo yes ;; *) echo no ;; esac)"

check 'no value is ever printed' no "$(case "$malformed" in *SECRET*) echo yes ;; *) echo no ;; esac)"
echo "reconcile-retired-output checks: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
