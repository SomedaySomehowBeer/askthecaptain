#!/usr/bin/env bash
# The inference service's entry point on a Sprite (plan §7, D18). Captain's API uploads this file and
# its siblings to /home/sprite/captain-setup and starts a service that runs it. It is idempotent and
# needs no sudo: the pinned CLIs install under the sprite user's own npm prefix, and the runtime
# lives in the user's home. It installs what is missing, lays out the runtime, then execs the shim.
set -euo pipefail
umask 077
setup=/home/sprite/captain-setup
root=/home/sprite/captain
prefix=/home/sprite/.npm-global
export PATH="$prefix/bin:$PATH"
export CAPTAIN_ROOT="$root"
say() { printf '[captain] %s\n' "$*"; }
if ! command -v node >/dev/null; then say 'node is not on PATH'; exit 1; fi
if ! node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'; then say "node $(node --version) is older than 22"; exit 1; fi
npm_bin="$(dirname "$(command -v node)")/npm"; [ -x "$npm_bin" ] || npm_bin="$(command -v npm || true)"
if [ -z "$npm_bin" ]; then say 'npm is not installed beside node'; exit 1; fi
if ! codex --version 2>/dev/null | grep -q '^codex-cli 0.154.0$' || ! claude --version 2>/dev/null | grep -q '^2.1.272 '; then
	say 'installing the pinned CLIs'
	mkdir -p "$prefix"
	"$npm_bin" install -g --prefix "$prefix" @anthropic-ai/claude-code@2.1.272 @openai/codex@0.154.0
fi
if [ ! -d "$root" ]; then
	mkdir -p "$root"
	# NEW Sprite only: remove bundled agent integrations before either CLI sees them.
	rm -rf /home/sprite/.codex /home/sprite/.claude /home/sprite/.claude.json /home/sprite/.agents
	mkdir -p /home/sprite/.codex /home/sprite/.claude
fi
# This Sprite is dedicated: no repository, plugins, hooks or other workloads.
cp "$setup/codex.toml" /home/sprite/.codex/config.toml
cp "$setup/shim.mjs" "$root/shim.mjs"
cp "$setup/login.py" "$root/login.py"
if [ -f "$setup/runtime.json" ]; then
	# The secret moves out of the setup folder; the service reads it from the runtime folder only.
	mv "$setup/runtime.json" "$root/runtime.json"
	chmod 600 "$root/runtime.json"
fi
[ -f "$root/catalog.json" ] || node "$setup/catalog.mjs"
say 'starting the shim'
exec node "$root/shim.mjs"
