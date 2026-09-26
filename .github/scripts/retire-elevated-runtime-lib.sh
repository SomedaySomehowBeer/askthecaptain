# Pure checks for retire-elevated-runtime.sh: no network, no database, no output of secrets.
# Tested by retire-elevated-runtime.test.sh against fixtures.

# check_urls STATE_JSON: the two URLs in $OLD_URL and $OWNER_URL must be the state's own connections for this
# project. OLD_URL: user `app` with exactly neon_role.app's password; OWNER_URL: the project's database user. Both
# point at the project's host and database. Prints `ok` or one reason (never a value); returns non-zero on failure.
# URLs are read from the environment, not arguments, so they never appear in a process list.
check_urls() {
	STATE_JSON="$1" python3 - <<'PY'
import json, os, sys
from urllib.parse import urlsplit, unquote_plus, unquote

def fail(reason):
    print(reason); sys.exit(1)

state = json.load(open(os.environ['STATE_JSON']))
def attrs(kind, name):
    found = [r for r in state.get('resources', []) if r.get('mode') == 'managed' and r.get('type') == kind and r.get('name') == name]
    if len(found) != 1 or not found[0].get('instances'):
        fail(f'state does not hold exactly one {kind}.{name}')
    return found[0]['instances'][0]['attributes']
role, project, database = attrs('neon_role', 'app'), attrs('neon_project', 'captain'), attrs('neon_database', 'captain')

def parts(env):
    url = urlsplit(os.environ.get(env, ''))
    if url.scheme not in ('postgres', 'postgresql') or not url.hostname:
        fail(f'{env} is not a postgres URL')
    # tofu's urlencode writes a space as "+"; unquote_plus reverses it (unquote alone is used for the user name).
    return unquote(url.username or ''), unquote_plus(url.password or ''), url.hostname, url.path.lstrip('/'), url.port

old_user, old_password, old_host, old_db, old_port = parts('OLD_URL')
owner_user, owner_password, owner_host, owner_db, owner_port = parts('OWNER_URL')
if old_user != 'app' or role.get('name') != 'app': fail('old URL does not sign in as app')
if not role.get('password') or old_password != role['password']: fail("old URL password is not neon_role.app's password")
if owner_user != project.get('database_user') or owner_user == 'app': fail("owner URL does not sign in as the project's database user")
if not owner_password or owner_password != project.get('database_password'): fail("owner URL password is not the project's database password")
if not (old_host == owner_host == project.get('database_host')): fail("URLs do not both use the project's host")
if old_port != owner_port: fail('URLs use different ports')
if not (old_db == owner_db == database.get('name')): fail("URLs do not both use the project's database")
if database.get('project_id') != project.get('id') or role.get('project_id') != project.get('id'): fail('role, database and project disagree')
if role.get('branch_id') != project.get('default_branch_id') or database.get('branch_id') != role.get('branch_id'): fail('role, database and default branch disagree')
print('ok')
PY
}

# classify_auth EXIT_STATUS ERR_FILE: accepted | rejected | unknown for one psql attempt. Only a server-side
# password failure counts as rejected; a timeout, DNS, TLS or any other error is unknown and never read as success.
classify_auth() {
	if [ "$1" -eq 0 ]; then echo accepted
	# Postgres quotes the user with "…"; Neon's proxy may use '…'. Either way it must be this role.
	elif grep -Eq "(FATAL|ERROR): +password authentication failed for user [\"']?app[\"']?( |\$)" "$2"; then echo rejected
	else echo unknown; fi
}

# reset_operations RESPONSE_JSON: the operation ids of a reset_password response, one per line. Returns non-zero,
# printing nothing, unless the body is JSON with a non-empty `operations` array whose every id is well formed.
reset_operations() {
	jq -er '
		if (.operations | type) == "array" and (.operations | length) > 0
			and all(.operations[]; (.id | type) == "string" and (.id | test("^[A-Za-z0-9-]+$")))
		then .operations[].id else error("malformed") end' "$1" 2> /dev/null
}

# plan_diagnostics PLAN_JSON: what a plan would change, as addresses, actions and changed attribute NAMES only;
# never a value. For explaining a refusal without exposing the sensitive values the plan JSON holds.
plan_diagnostics() {
	jq -r '
		def changed($c): (($c.before // {}) + ($c.after // {}) | keys)
			| map(select(. as $k | ($c.before // {})[$k] != ($c.after // {})[$k] or (($c.before // {}) | has($k)) != (($c.after // {}) | has($k))));
		(.resource_changes // [] | .[] | select(.change.actions != ["no-op"]) | "change \(.address) \(.change.actions | join(","))"),
		(.resource_drift // [] | .[] | "drift \(.address) \(.change.actions | join(",")) keys=\(changed(.change) | join(","))"),
		((.output_changes // {}) | to_entries[] | select(.value.actions != ["no-op"]) | "output \(.key) \(.value.actions | join(","))")
	' "$1" 2> /dev/null || echo 'plan JSON could not be read'
}

# plan_is_legacy_output_update PLAN_JSON: succeeds only for a plan made with refresh off that touches nothing but
# the legacy output: no drift; every resource change a no-op on one of the three targeted Neon resources, with no
# import, move or replacement; and exactly one changed output, neon_app_database_url, updated in place to a known
# string. Prints the first reason on failure.
plan_is_legacy_output_update() {
	jq -e '(.resource_drift // []) | length == 0' "$1" > /dev/null \
		|| { echo 'plan found drift, so something was refreshed'; return 1; }
	jq -e '.resource_changes // [] | all(.change.actions == ["no-op"])' "$1" > /dev/null \
		|| { echo 'plan proposes a managed change'; return 1; }
	jq -e '.resource_changes // [] | all(.change.importing == null and .previous_address == null and .action_reason == null)' "$1" > /dev/null \
		|| { echo 'plan imports, moves or replaces a resource'; return 1; }
	jq -e '[.resource_changes // [] | .[].address] | sort == ["neon_database.captain", "neon_project.captain", "neon_role.app"]' "$1" > /dev/null \
		|| { echo 'plan does not cover exactly the three targeted resources'; return 1; }
	jq -e '[(.output_changes // {}) | to_entries[] | select(.value.actions != ["no-op"]) | .key] == ["neon_app_database_url"]' "$1" > /dev/null \
		|| { echo 'the changed outputs are not exactly neon_app_database_url'; return 1; }
	jq -e '.output_changes.neon_app_database_url | .actions == ["update"] and (.after | type) == "string" and (.before | type) == "string"
		and (.after_unknown // false) == false' "$1" > /dev/null \
		|| { echo 'neon_app_database_url is not an update between two known strings'; return 1; }
	jq -e '.output_changes.neon_app_database_url | .before_sensitive == true and .after_sensitive == true' "$1" > /dev/null \
		|| { echo 'neon_app_database_url is not sensitive on both sides'; return 1; }
}

# check_output_url STATE_JSON: $OUTPUT_URL, derived from the state independently of the plan, must be `current`
# (EXPECT=current: app, neon_role.app's password, the project's host, the database) or the `stale` value it replaces
# (EXPECT=stale: the same user, host and database with any other password). Prints `ok` or one reason (never a
# value); the URL comes from the environment, never an argument.
check_output_url() {
	STATE_JSON="$1" python3 - <<'PY'
import json, os, sys
from urllib.parse import quote_plus, urlsplit, unquote_plus

class Refused(Exception):
    pass

def canonical(role, host, database, password):
    # neon.tf: format("postgresql://%s:%s@%s/%s?sslmode=require", name, urlencode(password), host, database).
    # OpenTofu's urlencode is Go's url.QueryEscape: unreserved kept, space as "+", everything else %XX in upper
    # case, which is what quote_plus with nothing marked safe produces.
    return f'postgresql://{role}:{quote_plus(password, safe="")}@{host}/{database}?sslmode=require'

def check():
    state = json.load(open(os.environ['STATE_JSON']))
    def attrs(kind, name):
        found = [r for r in state.get('resources', []) if r.get('mode') == 'managed' and r.get('type') == kind and r.get('name') == name]
        if len(found) != 1 or len(found[0].get('instances') or []) != 1:
            raise Refused(f'state does not hold exactly one {kind}.{name}')
        return found[0]['instances'][0]['attributes']
    role, project, database = attrs('neon_role', 'app'), attrs('neon_project', 'captain'), attrs('neon_database', 'captain')
    if project.get('id') != 'royal-glitter-10514027': raise Refused('state is not project royal-glitter-10514027')
    if role.get('project_id') != project['id'] or database.get('project_id') != project['id']:
        raise Refused('role, database and project disagree')
    branch = project.get('default_branch_id')
    if not branch or role.get('branch_id') != branch or database.get('branch_id') != branch:
        raise Refused('role, database and default branch disagree')
    if role.get('name') != 'app' or not role.get('password'): raise Refused('state holds no password for app')
    host, name = project.get('database_host'), database.get('name')
    if not host or not name: raise Refused('state holds no host or database name')

    value = os.environ.get('OUTPUT_URL', '')
    expect = os.environ.get('EXPECT')
    if expect == 'current':
        # Exactly the URL the configuration generates from state: same bytes, query and all.
        if value != canonical('app', host, name, role['password']):
            raise Refused("output is not the URL generated from neon_role.app's password, host and database")
    elif expect == 'stale':
        # The same generated shape around some other password.
        url = urlsplit(value)
        other = unquote_plus(url.password or '')
        if not other or value != canonical('app', host, name, other):
            raise Refused('the value being replaced is not a URL of the generated shape for app')
        if other == role['password']:
            raise Refused("the value being replaced already holds neon_role.app's password")
    else:
        raise Refused('EXPECT must be current or stale')

try:
    check()
    print('ok')
except Refused as refused:
    print(refused); sys.exit(1)
except Exception:
    # Never a traceback: an exception message could quote the value being checked.
    print('the value or state could not be parsed'); sys.exit(1)
PY
}

# same_but_password: $URL_A and $URL_B (from the environment) are identical except for their passwords, which
# differ. Prints `ok` or one reason, never a value.
same_but_password() {
	python3 - <<'PY'
import os, sys
from urllib.parse import urlsplit, unquote_plus

def verdict():
    a, b = urlsplit(os.environ.get('URL_A', '')), urlsplit(os.environ.get('URL_B', ''))
    def without_password(u):
        return (u.scheme, u.username, u.hostname, u.port, u.path, u.query, u.fragment)
    if not a.scheme or not b.scheme: return 'not two URLs'
    if without_password(a) != without_password(b): return 'the URLs differ in more than the password'
    if unquote_plus(a.password or '') == unquote_plus(b.password or ''): return 'the passwords do not differ'
    return 'ok'

try:
    result = verdict()
except Exception:
    result = 'the URLs could not be parsed' # never a traceback: it could quote a value
print(result)
sys.exit(0 if result == 'ok' else 1)
PY
}

# state_same_but_bookkeeping BEFORE_STATE AFTER_STATE: the two states are identical, compared as sorted hashes so
# no value is held or printed, apart from what an output-only apply may change: `serial`, which must increase, the
# outputs (checked separately by the caller) and recorded dependencies (checked by dependencies_restored). Lineage,
# version fields and every resource with its provider, identity, attributes and credentials are included. Prints
# `ok` or a reason.
state_same_but_bookkeeping() {
	local digest='del(.serial, .outputs) | .resources |= map(.instances |= map(del(.dependencies)))' before after
	# Hash each side separately so a state that cannot be read fails here, rather than as two equal empty hashes.
	before="$(set -o pipefail; jq -S "$digest" "$1" 2> /dev/null | sha256sum)" || { echo 'state before could not be read'; return 1; }
	after="$(set -o pipefail; jq -S "$digest" "$2" 2> /dev/null | sha256sum)" || { echo 'state after could not be read'; return 1; }
	[ "$before" = "$after" ] || { echo 'state changed beyond its serial, outputs and recorded dependencies'; return 1; }
	jq -e --slurpfile before "$1" '(.serial | type) == "number" and .serial > $before[0].serial' "$2" > /dev/null \
		|| { echo 'the state serial did not increase'; return 1; }
	echo ok
}

# dependencies_restored BEFORE_STATE AFTER_STATE: recorded dependencies may change only for neon_role.app, and only
# to its configuration's single dependency, neon_project.captain (the scoped refresh's override had removed it).
# Prints `unchanged`, `restored` or a reason; returns non-zero on the reason.
dependencies_restored() {
	local deps='[.resources[] | select(.mode == "managed") | {key: "\(.type).\(.name)", value: [.instances[].dependencies // [] | sort]}] | from_entries'
	jq -e --slurpfile after "$2" "($deps) as \$b | (\$after[0] | $deps) as \$a
		| (\$b | del(.[\"neon_role.app\"])) == (\$a | del(.[\"neon_role.app\"]))" "$1" > /dev/null \
		|| { echo 'recorded dependencies changed outside neon_role.app'; return 1; }
	if jq -e --slurpfile after "$2" "($deps)[\"neon_role.app\"] == (\$after[0] | $deps)[\"neon_role.app\"]" "$1" > /dev/null; then
		echo unchanged
	elif jq -e "($deps)[\"neon_role.app\"] == [[\"neon_project.captain\"]]" "$2" > /dev/null; then
		echo restored
	else
		echo "neon_role.app's recorded dependencies changed to something other than neon_project.captain"; return 1
	fi
}

# plan_is_password_refresh PLAN_JSON: succeeds only for a refresh-only plan that proposes no managed change, whose
# only drift is neon_role.app updated in place with nothing but `password` differing (keys on either side,
# including ones added or removed by the refresh), and whose only changed output is neon_app_database_url.
# Prints the first reason on failure.
plan_is_password_refresh() {
	jq -e '.resource_changes // [] | all(.change.actions == ["no-op"])' "$1" > /dev/null \
		|| { echo 'plan proposes a managed change'; return 1; }
	jq -e '.resource_drift // [] | all(.address == "neon_role.app")' "$1" > /dev/null \
		|| { echo 'drift outside neon_role.app'; return 1; }
	jq -e '.resource_drift // [] | all(.change.actions == ["update"])' "$1" > /dev/null \
		|| { echo 'drift is not an in-place update'; return 1; }
	jq -e '.resource_drift // [] | all(.change as $c | (($c.before // {}) + ($c.after // {}) | keys)
		| map(select(. as $k | ($c.before // {})[$k] != ($c.after // {})[$k] or (($c.before // {}) | has($k)) != (($c.after // {}) | has($k))))
		| . - ["password"] | length == 0)' "$1" > /dev/null \
		|| { echo 'drift changes more than the password'; return 1; }
	jq -e '(.output_changes // {}) | to_entries | all(.value.actions == ["no-op"] or .key == "neon_app_database_url")' "$1" > /dev/null \
		|| { echo 'an output other than neon_app_database_url changes'; return 1; }
}
