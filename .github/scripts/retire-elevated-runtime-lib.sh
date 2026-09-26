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
