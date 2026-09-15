#!/usr/bin/env bash
# Sprite image specification: stock Sprite Ubuntu + Node 22+, these pinned CLIs and this shim.
set -euo pipefail
umask 077
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
sudo npm install -g @anthropic-ai/claude-code@2.1.272 @openai/codex@0.154.0
sudo mkdir -p /opt/captain
sudo chown sprite:sprite /opt/captain
# NEW Sprite only: remove bundled agent integrations before either CLI sees them.
rm -rf /home/sprite/.codex /home/sprite/.claude /home/sprite/.claude.json /home/sprite/.agents
mkdir -p /home/sprite/.codex /home/sprite/.claude
# This script is for a NEW dedicated Sprite: no repository, plugins, hooks or other workloads.
cp /tmp/captain-codex.toml /home/sprite/.codex/config.toml
cp /tmp/captain-shim.mjs /opt/captain/shim.mjs
cp /tmp/captain-login.py /opt/captain/login.py
cp /tmp/captain-register.mjs /opt/captain/register.mjs
node /tmp/captain-catalog.mjs
