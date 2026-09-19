#!/usr/bin/env bash
# The inference service's entry point on a Sprite (plan §7, D18). Captain's API uploads this file and
# its siblings to /home/sprite/captain-setup and starts a service that runs it. It is idempotent: it
# installs the pinned CLIs when they are missing, lays out /opt/captain, then execs the shim.
set -euo pipefail
umask 077
setup=/home/sprite/captain-setup
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
if ! codex --version 2>/dev/null | grep -q '^codex-cli 0.154.0$' || ! claude --version 2>/dev/null | grep -q '^2.1.272 '; then
	sudo npm install -g @anthropic-ai/claude-code@2.1.272 @openai/codex@0.154.0
fi
if [ ! -d /opt/captain ]; then
	sudo mkdir -p /opt/captain
	sudo chown sprite:sprite /opt/captain
	# NEW Sprite only: remove bundled agent integrations before either CLI sees them.
	rm -rf /home/sprite/.codex /home/sprite/.claude /home/sprite/.claude.json /home/sprite/.agents
	mkdir -p /home/sprite/.codex /home/sprite/.claude
fi
# This Sprite is dedicated: no repository, plugins, hooks or other workloads.
cp "$setup/codex.toml" /home/sprite/.codex/config.toml
cp "$setup/shim.mjs" /opt/captain/shim.mjs
cp "$setup/login.py" /opt/captain/login.py
if [ -f "$setup/runtime.json" ]; then
	# The secret moves out of the setup folder; the service reads it from /opt/captain only.
	mv "$setup/runtime.json" /opt/captain/runtime.json
	chmod 600 /opt/captain/runtime.json
fi
[ -f /opt/captain/catalog.json ] || node "$setup/catalog.mjs"
exec node /opt/captain/shim.mjs
