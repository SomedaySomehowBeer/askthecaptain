# Inference through the organisation's subscription

Jobs: triage, draft, brief (§2). Depends on D2, D6, revised D9, D16 and D18 in
[the plan](../plan.md). One Captain-owned Sprite per organisation. No business-data
store, shared filesystem, repository, MCP servers, plugins or other workloads.
The provider login stays on its Sprite; only its HTTP connection is encrypted in
Captain using the organisation's data key. Never put tokens in prompts or logs.

## Product surface checked 2026-09-15

Sprites uses the separate `sprite` CLI and `https://api.sprites.dev/v1`, not a
`fly sprites` subcommand. Stock Sprites already include Node and Python; bootstrap
requires Node 22+, installs pinned `@anthropic-ai/claude-code@2.1.272` and
`@openai/codex@0.154.0`, and copies only the shim and login helpers. There is no
Docker-image import assumed here. The service listens on port 8080, survives
hibernation and restarts on wake. Provisioning uses the documented in-Sprite
`sprite-env services create` with `--cmd`, `--args`, `--dir` and `--http-port`.
The equivalent REST endpoint uses `PUT /v1/sprites/{name}/services/{service_name}`. The public Sprite URL forwards to
this service; **every shim route requires the separate per-Sprite bearer secret**.
Fly's organisation token is never used by Captain's inference transport.

Sources: [quickstart](https://docs.sprites.dev/quickstart/),
[CLI commands](https://docs.sprites.dev/cli/commands/),
[services](https://docs.sprites.dev/concepts/services/),
[services API](https://docs.sprites.dev/api/v001-rc48/services/).
The documented create command has no region flag: record the actual region, or
`unknown`, rather than claiming Sydney. Confirm region availability with Fly if
residency is required before provisioning.

## Owner/operator setup (creates billable resources)

1. Configure API `MASTER_KEY` using the existing D16 process. In Settings →
   Inference choose Claude or Codex and set a monthly token allowance. Zero is the
   initial allowance and prevents probes as well as workflow inference.
2. On the operator's machine install `sprite` from its official instructions and
   authenticate with `sprite org auth`. Set **non-secret** `ATC_ORGANISATION_ID`,
   `ATC_PROVIDER` (`claude` or `codex`) and `ATC_FLY_ORG`; run
   `infra/sprites/provision.sh`. Run once per new runtime; inspect and clean up any
   partial failure manually, never create a second Sprite for the same tenant.
3. The script generates `/opt/captain/runtime.json` on the Sprite (mode 0600),
   starts the service and prints its exact HTTPS URL. It does not print the secret.
   It deliberately makes URL routing public because the shim supplies its own
   authentication. Do not add other services or routes to this Sprite.
4. Run `sprite exec -o <fly-org> -s captain-<organisation-uuid> --tty -- python3
   /opt/captain/login.py <provider>` (as one line). This wrapper runs unmodified
   `claude setup-token` or `codex login --device-auth` on the Sprite. It displays
   only allowlisted sign-in URLs and device codes. Claude's generated long-lived
   token is captured into `/opt/captain/claude-token` (0600), never echoed; Codex
   stores its own login in `/home/sprite/.codex/auth.json`.
5. While that session waits, open a second Sprite console and run
   `node /opt/captain/register.mjs`. Supply the API HTTPS origin, organisation,
   exact Sprite URL/name, region and account email. Paste the current sign-in URL
   from step 4. Supply an owner Captain session at the hidden prompt; obtain it
   from your own signed-in browser cookie without pasting it into chat, a command,
   history or a log. Registration sends the generated secret directly from the
   Sprite to the owner-only `/inference/runtime/configure` endpoint for encryption.
6. Refresh Settings → Inference and select **Complete sign-in**. Enter Codex's
   device code, or paste Claude's returned code into the waiting Sprite session.
   These CLI logins require that operator session; a link alone is not sufficient.
   If the URL expires, restart step 4 and register the fresh URL. Run **Verify
   sign-in** after login completes. Verification checks `/health` and asks for the
   empty JSON object with `maxTokens: 1`, accounting for its actual usage.

The implementation was verified locally with stubs and an isolated fake provider,
not a live subscription or provisioned Sprite. The owner must verify the pinned
CLI installation, sign-in and wake behaviour on the first Sprite before enabling
workflows. Ryan owns the Anthropic hosting-clause consideration before operating
Claude; this runbook does not make a legal determination.

## Data-only invocation

Claude: `claude -p --model <model> --output-format json --json-schema <JSON>`
plus `--tools '' --strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
`--disable-slash-commands --no-session-persistence --setting-sources ''`, disabled
hooks and `--system-prompt <instruction>`. **`--json-schema` takes JSON, not a
filename.** Data arrives on stdin inside escaped `<untrusted_data>` boundaries.
`CLAUDE_CODE_MAX_OUTPUT_TOKENS` bounds the requested output. The CLI receives only
its login and a minimal environment, not Captain's HTTP secret or any API key.
[Claude CLI reference](https://code.claude.com/docs/en/cli-reference).

Codex: `codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json
--color never --model <model> --output-schema <file> -`, with an instruction file
and our model catalog selected by `-c`. `codex.toml` disables shell, images, apps,
plugins, hooks, agents, goals, search and other tools. Read-only **alone** leaves
`apply_patch` exposed; the version-pinned catalog additionally removes patch,
clock and asynchronous-user tools and chooses ordinary output mode. Unknown
models are rejected before execution. Re-run `check-codex-tools.py` against the
runtime's generated catalog before changing the pinned release or catalog.
[Codex configuration](https://developers.openai.com/codex/config-reference),
[release tool registry](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/core/src/tools/spec_plan.rs#L1255).

Codex has no documented CLI hard output-token cap. `maxTokens` is an allowance
estimate for Codex, not an enforced ceiling. A call can exceed its estimate; the
actual usage is charged and subsequent calls stop when their estimate will not
fit. Missing provider usage is an error, never fabricated zero usage. A timeout
may consume provider tokens that Captain cannot measure: investigate the
subscription before retrying; Captain records the failure, not invented usage.
Ephemeral request/schema files, Claude configuration/logs and Codex logs/state use
`/dev/shm` and are removed in `finally`; subscription login files remain on the Sprite.

## Allowances, failures and operation

- UTC calendar months. Missing rows are created lazily from the organisation's
  configured default. Month rows serialize calls until actual usage is settled;
  there are no dollar reservations or rollover background processes.
- Model env: `MODEL_CLAUDE_SMALL=claude-sonnet-5`,
  `MODEL_CLAUDE_LARGE=claude-opus-5`, `MODEL_CODEX_SMALL=gpt-5.6-luna`,
  `MODEL_CODEX_LARGE=gpt-6-astra`. Override exact IDs for the tenant's entitlement;
  do not add date suffixes. Codex IDs came from the pinned CLI catalog; `--help`
  does not enumerate them. Unavailable models fail, with no silent substitution.
- Runtime not ready: attach its encrypted connection and verify. Needs login:
  repeat the owner sign-in flow. Rate limited/provider unavailable: wait and
  inspect the subscription. Invalid output: two schema failures were accounted
  for; inspect the step's schema. Budget spent: increase the allowance or wait
  for the new month. Never log provider stdout/stderr or prompts when diagnosing.
- Disconnect in Settings clears Captain's secret and blocks further inference.
  The owner then runs `sprite destroy -o <fly-org> -s <sprite-name>` and revokes
  the subscription login if necessary. No automatic Fly deletion occurs.
- `model_usage.run_id` is nullable and has no FK yet because `workflow_runs` is
  not in this checkout. The runner migration must add a composite tenant FK.

## Adding the API path

The seam is present, but API-key execution and cost enforcement are not implemented.
`inference_runtimes.provider` admits `anthropic_api` and fails closed today;
`model_usage.cost_micros` and `model_budgets.cost_limit_micros` are nullable and remain
null for subscriptions. The budget check accepts `Limits` (tokens now, cost later).

1. Approve the launch/pricing decision in the plan. Define the units, price table
   and model versions used to compute integer micro-dollar costs, including cached
   input and rounding; add a migration for prices and cost accounting as needed.
2. Implement `ApiProvider` in `packages/model` against the unchanged `Provider`
   interface using the first-party provider SDK. Keep credentials in the transport;
   return the same structured output, actual token usage, model and latency.
3. Add owner-only API-key entry, encrypted with the organisation's existing data
   key using field-bound encryption; verify the key on entry before marking it
   ready. Never send it to the web again, a prompt, a workflow definition or a log.
4. Extend `model_usage`'s provider constraint to admit `anthropic_api`. Derive
   `cost_micros` from actual usage and the price table. Extend `Limits` checks with
   `cost_limit_micros` and settle cost atomically under the same monthly lock,
   including invalid-output retries. Never silently reinterpret a token allowance.
5. Select the adapter from the runtime provider in `InferenceService`; add Settings
   entry and honest cost/verification states. Add cross-tenant, role, encryption,
   key-verification, price/rounding and concurrent cost-budget tests, plus a
   production-build Playwright check. No Sprite is provisioned for the API adapter.
