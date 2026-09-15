#!/usr/bin/env bash
# OWNER ONLY. This script creates a billable Sprite. Never run it from CI or an agent.
set -euo pipefail
umask 077
: "${ATC_ORGANISATION_ID:?Set the Captain organisation UUID}"
: "${ATC_PROVIDER:?Choose claude or codex}"
: "${ATC_FLY_ORG:?Set the Captain Fly organisation}"
[[ "$ATC_ORGANISATION_ID" =~ ^[a-f0-9-]{36}$ ]] || exit 1
[[ "$ATC_PROVIDER" == claude || "$ATC_PROVIDER" == codex ]] || exit 1
atc_sprite="captain-${ATC_ORGANISATION_ID}"
atc_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
sprite create -o "$ATC_FLY_ORG" "$atc_sprite"
sprite exec -o "$ATC_FLY_ORG" -s "$atc_sprite" --file "$atc_dir/bootstrap.sh:/tmp/captain-bootstrap.sh" --file "$atc_dir/codex.toml:/tmp/captain-codex.toml" --file "$atc_dir/shim.mjs:/tmp/captain-shim.mjs" --file "$atc_dir/catalog.mjs:/tmp/captain-catalog.mjs" --file "$atc_dir/login.py:/tmp/captain-login.py" --file "$atc_dir/register.mjs:/tmp/captain-register.mjs" -- bash /tmp/captain-bootstrap.sh
# Generate the per-Sprite bearer secret remotely; stdout never carries it.
sprite exec -o "$ATC_FLY_ORG" -s "$atc_sprite" -- node -e 'const fs=require("fs"),crypto=require("crypto");fs.writeFileSync("/opt/captain/runtime.json",JSON.stringify({provider:process.argv[1],secret:crypto.randomBytes(32).toString("hex")}),{mode:0o600})' "$ATC_PROVIDER"
sprite exec -o "$ATC_FLY_ORG" -s "$atc_sprite" -- sprite-env services create inference --cmd node --args /opt/captain/shim.mjs --dir /opt/captain --http-port 8080
# Sprite URL auth would require a Fly org token. The shim authenticates EVERY route with its own secret.
sprite url update -o "$ATC_FLY_ORG" -s "$atc_sprite" --auth public
sprite url -o "$ATC_FLY_ORG" -s "$atc_sprite"
printf '%s\n' 'Sprite created. Follow docs/runbooks/inference-sprite.md to attach it to Captain and sign in.'
