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

## Setup

**Operator, once per platform.** Create a Sprites organisation that will hold nothing but Captain
runtimes, generate an API token for it at sprites.dev/account, and set it as the API secret
`SPRITES_API_TOKEN`. Without it Settings → Inference says runtimes cannot be created yet. The
token can create and destroy Sprites and write files to them; keep it out of every other system.

Token restrictions, learned on 2026-09-19: a restricted token may not set labels (Captain sends
none), and a token's **sprite creation limit counts creations over the token's lifetime, not
active Sprites**: once the count is reached, deleting Sprites does not free it, and every
further create answers 403 "token has reached its sprite creation limit". Set the limit to the
number of organisations you expect to onboard plus room for retries, or leave it unlimited and
guard the secret instead. A failed create records `sprites_create_403` in the journal and writes
Sprites' own sentence to the API's server log (`flyctl logs -a <api app> | grep '\[sprites\]'`).

**Owner, from any device.**

1. Configure API `MASTER_KEY` using the existing D16 process (operator). In Settings → Inference
   set a monthly token allowance above zero; zero prevents probes as well as workflow inference.
2. Choose Claude or Codex and press **Set up subscription**. The API creates the Sprite
   `captain-<organisation-uuid>` through the Sprites HTTP API, uploads `infra/sprites/*` and a
   generated `runtime.json` (provider and per-Sprite secret, mode 0600) to
   `/home/sprite/captain-setup`, defines the `inference` service running `bootstrap.sh`, starts it,
   makes the Sprite URL public (the shim authenticates every route itself) and stores the URL and
   secret sealed with the organisation's data key. The status reads **Setting up**.
3. `bootstrap.sh` installs the pinned CLIs when missing under the sprite user's own npm prefix
   (`/home/sprite/.npm-global`; no sudo, learned 2026-09-19: the Sprite's sudo cannot see npm),
   lays out `/home/sprite/captain`, moves the secret there and execs the shim. Its output is the
   service log: `POST /v1/sprites/<name>/services/inference/start` streams it. When the shim answers `/health`, refreshing Settings moves the status
   to **Needs sign-in**. First boot takes a few minutes.
4. Press **Sign in**. The API asks the shim to start `login.py`, which runs `claude setup-token`
   or `codex login --device-auth` on the Sprite. Settings shows **Open sign-in** with the
   provider's allowlisted URL and, for Codex, the device code in large type. Sign in on the phone.
   Codex completes on its own: refresh, then **Verify sign-in**. Claude hands back a one-time
   code: paste it into the code field; the API forwards it once to the shim, which writes it to
   the CLI's stdin, and the long-lived token is written to `/home/sprite/captain/claude-token` (0600) on
   the Sprite. The code is never stored or journaled; the journal records only that one was
   forwarded. Then **Verify sign-in**. A sign-in that does not finish within fifteen minutes
   reads failed; press Sign in again.
5. **Disconnect runtime** destroys the Sprite through the same API, and the subscription login
   with it. A partial failure leaves the status **Failed** with the operation and HTTP status in
   the audit journal; disconnect and set up again.

The initial implementation checks used stubs and an isolated fake Sprites API. Subsequent setup
and sign-in fixes are recorded in PRs #82–#98; the [pause record](paused.md) identifies an existing
Sprite, but neither establishes current readiness. Verify the pinned CLI installation, sign-in
and wake behaviour when the owner resumes the service, when pins change or when a new
organisation's Sprite is created, before enabling its workflows. Ryan owns the Anthropic hosting-clause consideration before operating
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
- Disconnect in Settings clears Captain's secret, blocks further inference and, when
  `SPRITES_API_TOKEN` is set, destroys the Sprite and its login through the Sprites API.
  Without the token, Settings says so and the operator runs
  `sprite destroy -o <fly-org> -s <sprite-name>`; revoke the subscription login if necessary.
- `model_usage.run_id` is nullable; migration 0023 added its composite tenant FK to
  `workflow_runs` (a deleted run leaves the usage row without a run).

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
