#!/usr/bin/env bash
# Update the legacy `neon_app_database_url` output in Terraform state so it matches the state's own neon_role.app
# password, after the retirement reset (run 36235270751) and scoped refresh (run 36236405227) left the output
# holding the retired password. Run by .github/workflows/reconcile-retired-output.yml from infra/tofu, after init.
#
# It makes no provider refresh, no Neon or database call, no password change and no infrastructure change: one plan
# with refresh off, targeted at the three resources the output reads, checked to change nothing but that output to
# a value independently derived from state, then that saved plan applied. Nothing secret is printed: values are
# masked and never echoed, and state/plan JSON stays in a private directory that is removed on exit.
set -euo pipefail
umask 077
. "$(dirname "$0")/retire-elevated-runtime-lib.sh"

TARGETS=(-target=neon_role.app -target=neon_project.captain -target=neon_database.captain)
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
say() { echo "[reconcile] $*"; }
fail() { echo "::error::[reconcile] $*"; exit 1; }
mask() { if [ -n "$1" ]; then echo "::add-mask::$1"; fi; }
other_outputs() { jq -S '.outputs // {} | del(.neon_app_database_url)' "$1" | sha256sum | cut -d' ' -f1; }

# 1. State before. -----------------------------------------------------------------------------------------------
tofu state pull > "$work/before.json"
mask "$(jq -r '.resources[] | select(.mode == "managed" and .type == "neon_role" and .name == "app") | .instances[0].attributes.password // empty' "$work/before.json")"
mask "$(jq -r '.resources[] | select(.mode == "managed" and .type == "neon_project" and .name == "captain") | .instances[0].attributes.database_password // empty' "$work/before.json")"
for output in neon_app_database_url neon_owner_database_url; do mask "$(jq -r --arg o "$output" '.outputs[$o].value // empty' "$work/before.json")"; done
current="$(jq -r '.outputs.neon_app_database_url.value // empty' "$work/before.json")"
if OUTPUT_URL="$current" EXPECT=current check_output_url "$work/before.json" > /dev/null; then
	fail 'the output already matches neon_role.app; nothing to reconcile'
fi
say 'state read; the output does not yet match neon_role.app'

# 2. Plan with refresh off, and check it. -------------------------------------------------------------------------
tofu plan -refresh=false "${TARGETS[@]}" -input=false -no-color -out="$work/output.tfplan" > /dev/null
tofu show -json "$work/output.tfplan" > "$work/plan.json"
refuse() { plan_diagnostics "$work/plan.json" | sed 's/^/[reconcile] plan: /'; fail "plan not applied: $1"; }
reason="$(plan_is_legacy_output_update "$work/plan.json")" || refuse "$reason"
planned="$(jq -r '.output_changes.neon_app_database_url.after' "$work/plan.json")"; mask "$planned"
replaced="$(jq -r '.output_changes.neon_app_database_url.before' "$work/plan.json")"; mask "$replaced"
[ "$replaced" = "$current" ] || refuse 'the value the plan replaces is not the output held in state'
reason="$(OUTPUT_URL="$planned" EXPECT=current check_output_url "$work/before.json")" || refuse "planned value: $reason"
reason="$(OUTPUT_URL="$replaced" EXPECT=stale check_output_url "$work/before.json")" || refuse "replaced value: $reason"
reason="$(URL_A="$replaced" URL_B="$planned" same_but_password)" || refuse "planned change: $reason"
rm -f "$work/plan.json" # kept until here so a refusal above can still print its diagnostics
say 'plan: every resource a no-op; only neon_app_database_url changes, to the state-derived URL'

# 3. Apply that saved plan, and nothing else. --------------------------------------------------------------------
tofu apply -input=false -no-color "$work/output.tfplan" > /dev/null
say 'saved plan applied'

# 4. State after. -------------------------------------------------------------------------------------------------
tofu state pull > "$work/after.json"
reason="$(state_same_but_bookkeeping "$work/before.json" "$work/after.json")" || fail "$reason"
[ "$(other_outputs "$work/before.json")" = "$(other_outputs "$work/after.json")" ] || fail 'another output changed'
dependencies="$(dependencies_restored "$work/before.json" "$work/after.json")" || fail "$dependencies"
say "resource attributes unchanged; neon_role.app recorded dependencies: $dependencies"
stored="$(jq -r '.outputs.neon_app_database_url.value // empty' "$work/after.json")"; mask "$stored"
reason="$(OUTPUT_URL="$stored" EXPECT=current check_output_url "$work/after.json")" || fail "stored output: $reason"
[ "$stored" = "$planned" ] || fail 'the stored output is not the planned value'
say 'done: the output is the URL generated from neon_role.app; every resource and other output unchanged'
