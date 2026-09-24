# Embedding service

`infra/embed` is the retrieval index's encoder (D21): one small sentence encoder behind a bearer
secret, shared by every organisation, holding no data. Mail and note text reaches it over TLS, is
embedded in memory and never written or logged; it returns numbers. It is not the inference Sprite
(D18) and there is no third-party embeddings service.

**Encoder.** `bge-small-en-v1.5` (BAAI), 384 dimensions, 8-bit ONNX, CLS pooling, normalised, run by
transformers.js on CPU. Units are encoded eight at a time; the tokenizer truncates at 512 tokens.
`model.mjs` fixes the name and a version; a change to either is a new version, and housekeeping
re-embeds rows carrying an older one. Measured on a shared CPU: 3 s to load, about 70 ms per unit,
peak 270 MB, so the app runs one `shared-cpu-1x` 512 MB machine in Sydney that scales to zero.

**API.** `GET /healthz` → `{ ok, encoder, version, dimensions }`. `POST /embed` with
`Authorization: Bearer <EMBED_TOKEN>` and `{ "units": ["…"] }` (1 to 64 strings, each up to 8000
characters, body up to 1 MB) → `{ encoder, version, dimensions, vectors }`. 401 without the secret,
400 on a bad body, 413 when too large, 500 without detail when encoding fails. Logs carry counts and
timings only.

## Owner steps (once)

1. Create the app in the same Fly organisation as the API:
   `flyctl apps create askthecaptain-embed --org <org>`.
2. Give it the secret: `flyctl secrets set EMBED_TOKEN="$(openssl rand -hex 32)" --app askthecaptain-embed`.
3. Deploy: the `deploy` workflow's `embed` job deploys the service whenever `infra/embed/**`
   changes on `main` (it skips with a notice until the app exists). The app exists since
   2026-09-21; the workflow and the machine are stopped under [the pause](paused.md). Or from a checkout:
   `flyctl deploy infra/embed --config infra/embed/fly.toml --ha=false`.
4. Check it: `curl https://askthecaptain-embed.fly.dev/healthz`.
5. Point the API at it with the same secret: `EMBED_URL=https://askthecaptain-embed.fly.dev` and
   `EMBED_TOKEN=<the value from step 2>` on `askthecaptain-api-staging` (and the production API
   when it is promoted). The API treats a missing `EMBED_URL` as "no index yet": rows stay
   unembedded for housekeeping to fill later.

## The index in the API

With `EMBED_URL` and `EMBED_TOKEN` set, the API keeps the retrieval index (migration
`0030_content_vectors`, pgvector): one row per chunk in `content_vectors` tagged with the encoder name
and version, the thread vector on `mail_threads` and the note vector on `notes`, each cascading with
its source and under the tenant's RLS. Mail sync embeds what each save batch stored, outside the
transaction; a note is embedded when saved; an hourly fill (`INDEX_DISABLED=1` stops it) embeds
whatever an outage or a cold start left behind. A message with under about 40 tokens of its own text
inherits its parent's vector. A service that is down leaves rows unembedded; nothing fails.
`packages/retrieval` holds the client, the unit rules and `similar()`, the similarity half of retrieval.
Local Postgres for tests must carry the extension: `pgvector/pgvector:pg18`, as CI does.

## Local

```
cd infra/embed && npm ci && npm run fetch-model     # downloads the encoder into ./models
EMBED_TOKEN=$(openssl rand -hex 32) npm start        # http://localhost:8080
npm test                                             # the HTTP layer, encoder stubbed
```
