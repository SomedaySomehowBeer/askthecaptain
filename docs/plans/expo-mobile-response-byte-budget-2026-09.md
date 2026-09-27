# Mobile transport response byte-budget contract

Status: adopted by this planning amendment, 27 September 2026. Outcome: **manage shared work** through bounded
mobile reads. My work (#199) is merged. This addresses the JavaScript response-budget gate in
[the My work contract](expo-mobile-my-work-read-2026-09.md); implementation follows adoption.
Native buffering remains a separate device gate.

Outcome: the transport **accumulates and passes to `JSON.parse` at most a fixed number of body bytes per response**
(`maxResponseBytes`). A response whose body would exceed that is abandoned: the download is cancelled, nothing of it is
parsed, and it is treated like any unusable answer, never as data and never as a client bug.

**What this bounds, and what it does not.** It bounds the **accumulated body bytes kept in JavaScript** and the **JSON
text given to the parser**. It is **not** a bound on total process memory for a request. In particular, it does not
bound:
- **native buffering:** what iOS or Android buffered before JavaScript started streaming (§1), and the OS network
  stack's own buffers;
- **a single transient chunk:** native may deliver more than the limit in one chunk (up to the whole body), which
  exists in JavaScript memory until it is dropped;
- **decoding and parsing overhead:** the decoded UTF-16 string parts, their single join (together up to about four
  times the counted bytes, briefly) and the parsed JSON objects. The bytes themselves are decoded chunk by chunk and
  never concatenated (§2.2).

Those are named limits and device gates (§4), not claims.

Unchanged:
- native sign-in stays off;
- the fixed-origin, no-redirect, bearer-only transport rules;
- every existing outcome mapping for a readable body.

## 1. Evidence (installed SDK, expo 57.0.25; read locally, not browsed)

**Today** (`apps/mobile/src/api/client.ts:94-97`): the transport calls `response.text()` and `JSON.parse`, bounded
only by the 30 s timeout, so a large body is read whole.

**`expo/fetch` exposes a real stream** (`expo/src/winter/fetch/FetchResponse.ts:281-349`).
`response.body` is a `ReadableStream<Uint8Array>` whose `pull` calls native `startStreaming()`. From then on, each
native chunk is delivered as `didReceiveResponseData`. Cancelling the stream calls native `cancelStreaming`; aborting
the request's `AbortSignal` calls `response.abort()` and `request.cancel()` (`fetch.ts:80-85`), which stops the
native download.

**Native buffering before streaming starts** (the important limit):
- iOS (`ios/Fetch/NativeResponse.swift:160-176`, `ResponseSink.swift`) and Android (`NativeResponse.kt:194-216`)
  append body data to an in-memory `ResponseSink` from the moment headers arrive **until JS starts streaming**.
- `startStreaming()` then emits everything buffered so far as **one chunk**, or, if the body already completed,
  returns the **whole body** as one chunk (`NativeResponse.swift:40-53`, `NativeResponse.kt:56-69`).
- A JS byte count therefore bounds what JS keeps and parses, and cancels the download at the first chunk that crosses
  the budget. It **cannot** bound what native (or the OS network stack) has already buffered, or the size of one
  chunk.

**Compression.**
- Android's `TransparentCompressionInterceptor` decompresses zstd/br/gzip and **removes `Content-Length`**
  (`TransparentCompressionInterceptor.kt:58-77`).
- iOS `URLSession` decompresses gzip/deflate/br transparently.
- JS therefore sees **decompressed** bytes, so counting them in JS also bounds a compression bomb as far as JS is
  concerned. `Content-Length` can be absent, or describe the compressed size.

**Decoding.**
- `expo/src/winter/TextDecoder.ts` is a UTF-8 decoder installed when the runtime lacks one. It supports
  `{ fatal: true }` (it throws on invalid bytes) and streaming state for split sequences.
- `FetchResponse.text()` itself uses `new TextDecoder()` on cloned bodies.
- Node 22 (the tests) has `TextDecoder`, `ReadableStream` and `Response` globally.

**Web.** The production web export never sends an API request (it is web-only and never ready), and the harness never
uses the transport. `fetch.web.ts` is the browser's `fetch`, whose `Response.body` is also a byte stream.

## 2. Design (A: `src/api/client.ts`, `src/platform/native-send.ts` types, tests)

### 2.1 Fixed limit

```ts
/** The most decoded (after transport decompression) body bytes any single API response may have. */
export const maxResponseBytes = 1_048_576; // 1 MiB
```

**Why 1 MiB: a policy choice, not a measurement.**
- It is a round, conservative ceiling for JSON API responses on a phone, applied uniformly.
- It is not derived from measured payload sizes, and this draft makes no claim about typical or worst-case sizes.
  Task titles and tags per task have no stored limit (see the My work contract §2), so no response size can be proved
  from the schema.
- The only structural facts relied on: `/v1/me` accepts at most 500 memberships (`me.ts:12`), and the native exchange
  and My work pages have fixed shapes. None of these is expected to approach the limit, but that expectation is
  checked in operation, not asserted here.
- **If a legitimate response ever exceeds it,** the user sees the existing "couldn't load" state with Try again, never
  wrong or partial data. Raising the limit, or giving that route its own limit, is then a reviewed contract change.

It is **one fixed limit for every response**. There is no per-route override in this increment; a later read that
needs a smaller limit adds one in its own contract. A server that legitimately exceeds it is an API-contract change,
to be reviewed together.

### 2.2 Reading the body

`Send`'s response type changes from `text(): Promise<string>` to
`body: ReadableStream<Uint8Array> | null`. `expo/fetch`, browser and Node responses all provide it, so `nativeSend`
still passes the response through and no new dependency is needed.

The existing checks come first, unchanged: redirect, final URL, 3xx, then status and `Retry-After` read from the
headers. After them, the body is read under the **same single 30 s timer** that already covers the request (B's S4).
There is no second timer.

**0. Stop state, `halt`, and the timer** (B's F1–F3).
- `request` creates one local state object per request, shared with `readBody` and not public API:
  `const state = { stopped: false, reader: null as Reader | null, parts: [] as string[] }`.
- **Every** non-normal exit goes through one idempotent helper. Each step is guarded, so no step can throw out of it
  or skip a later step:

  ```ts
  const halt = (state: StopState, controller: AbortController, reason: string): void => {
    state.stopped = true;              // first: the loop does nothing more from here on
    state.parts.length = 0;            // no decoded text kept by a loop left waiting on a read
    const reader = state.reader; state.reader = null;
    if (reader !== null) { try { void reader.cancel(reason).catch(() => {}); } catch { /* best effort */ } }
    try { controller.abort(); } catch { /* best effort */ }
  };
  ```

  The order is: stop, clear, cancel (guarded against both rejection and a synchronous throw), then abort (guarded).
  Cancelling before aborting keeps B's S3 reasoning: it marks the expo stream closed, so late native events are
  dropped, and the abort then stops the native request.
- **The timer resolves first, then cleans up:**
  `timer = setTimeout(() => { resolve({ timeout: true }); halt(state, controller, 'timeout'); }, timeoutMs)`.
  - Today's callback (`client.ts:87`) is `controller.abort(); resolve(...)`. `abort()` runs the signal's listeners
    synchronously (on `expo/fetch`: `response.abort` and native `request.cancel`, `fetch.ts:80-85`). A listener or
    polyfill that throws would skip `resolve`, and the request would never settle. Resolving first removes that
    dependency.
  - A consequence, also intended: the timeout is resolved before the abort can reject `sent`, so a `send` that rejects
    synchronously inside its abort listener can no longer win the pre-headers race and report `network` instead of
    `timeout`.
- **The outcome never depends on cleanup.** On every path, the status and `Retry-After` have already been read, and
  the result (unreadable, or `no-answer`/`timeout` before headers) is fixed before `halt` runs or regardless of what it
  throws.
- **`request`'s own `catch`** (a throw from `send` or anything outside the body phase) also calls `halt`; with no
  reader, that is a guarded abort only.
- The **normal path** never calls `halt`. After a normal `done` the request is complete, and nothing is cancelled or
  aborted.

**1. Early `Content-Length` refusal: abort only, no body access** (B's R5).
- If the header is present and consists of digits only, compare it with the limit, **by length first**, so a huge
  value can't overflow `Number`; leading zeros are ignored.
- If it declares more than `maxResponseBytes`:
  - `halt(state, controller, 'too-large')`: `state.reader` is still `null`, so this is stop plus a guarded
    `controller.abort()` (on `expo/fetch` that runs `response.abort()` and native `request.cancel()`);
  - return the body as unreadable.
- **`response.body` is never touched** on this path. On `expo/fetch` the getter creates the stream, and cancelling it
  would call native `cancelStreaming` before `startStreaming` ever ran, an unexercised native path.
- `Content-Length` is never permission to read. Absent, malformed or small values change nothing; the byte count
  decides.

**2. The read loop, raced against the timeout** (B's R1–R2).
- `const loop = readBody(response, state, controller); loop.catch(() => undefined);` then
  `await Promise.race([loop, timedOut.then(() => null)])`.
- The loop is **never** the only exit. A `startStreaming()` that never settles, a stream that ignores the abort, or a
  throwing `cancel` all end at the timeout.
- **On timeout**, the timer has already resolved and run `halt(state, controller, 'timeout')` (step 0). `request`
  awaits no cleanup (B's R1) and returns the body as unreadable. A loop still waiting on a `read()` is stopped by
  `state.stopped` whenever that read settles (step 3).
- **Handled rejections only.** Every promise created here has a rejection handler attached before it is raced or
  abandoned: the loop, every `reader.cancel(...)`, and a pending `read()` left behind by a timeout or budget stop.
  `reader.closed` is never used or awaited.

**3. Inside `readBody`:**
- Pass the response itself. Read its `body` getter and call `getReader()` inside this function's own try.
  A throwing getter or reader acquisition after headers resolves unreadable, preserving status and Retry-After.
  This function never rejects. The outer network-error catch does not handle body acquisition.
- `body === null` (for example a 204): the text is empty, so it is unreadable as JSON, as today.
- `const reader = body.getReader(); state.reader = reader;` (synchronously, before the first `await`, so the timer's
  `halt` can always reach it), and **one** `const decoder = new TextDecoder('utf-8', { fatal: true })`. The decoder
  uses the default `ignoreBOM: false`, so a leading BOM is removed, as `text()` does today; `ignoreBOM` is never set.
- **Stop check (B's F1).** Immediately after **every** `await reader.read()` settles, whether it resolves or rejects,
  and before anything else, `if (state.stopped) return unreadable`. So after a timeout, a budget stop or any throw, a
  late read causes no type check, count, decode, push, further `read()`, flush or `JSON.parse`. Parts are kept only
  in `state.parts`, which `halt` clears.
- For each `{ done, value }`, after the stopped check, handle `done` **before** inspecting `value`.
  Normal completion has `value: undefined`: flush the decoder, join, parse and release the lock.
  Assert that successful completion calls neither cancel nor abort.
  Only a non-done result is type-checked and counted below.
  - **Type check** (B's S1): `value` must be a `Uint8Array`; anything else makes the body unreadable, and it is never
    coerced.
  - **Count before decoding** (B's R3). If `total + value.byteLength > maxResponseBytes`, the order is (B's S3, F3):
    1. drop the chunk: it is neither decoded nor kept;
    2. `halt(state, controller, 'budget')`: stop, clear the parts, a guarded cancel (which marks the expo stream
       closed, so late native events are dropped), then a guarded abort (which stops the native request, since
       `abort` alone would be a no-op once the stream is closed);
    3. return unreadable, whatever `halt`'s calls did.

    A single chunk larger than the limit takes the same path and is never decoded.
  - Otherwise, `total += value.byteLength`, then `parts.push(decoder.decode(value, { stream: true }))`. Multi-byte
    sequences split across chunks are carried by the decoder's streaming state. The **bytes are not concatenated**.
  - On `done`: `parts.push(decoder.decode())` flushes; an incomplete final sequence throws under `fatal`. Then join
    the parts once and `JSON.parse` the result, exactly as today. The flush, join and parse happen synchronously right
    after the stop check, so a stopped request never reaches them.
- **Any throw** (`getReader`, a `read()` rejection when the abort errors the stream, a `fatal` decode error, or
  `JSON.parse`) calls `halt(state, controller, 'error')` and makes the body unreadable. No partial text is ever
  parsed. If `state.stopped` was already set, the throw is simply the expected consequence of that stop, and `halt` is
  idempotent.

**4. Reader lock** (B's R4).
- `reader.releaseLock()` is called **only** after the loop ended normally with `done` and no read is pending, inside
  `try`.
- After a budget stop, a timeout or an abort, the lock is **not** released: a pending read would make `releaseLock`
  reject or throw. It isn't needed, because nothing else ever reads this body; the response is discarded when the
  function returns.
- Every reference to the reader, the decoder and the parts is dropped (`state.reader = null`, and `halt` clears
  `state.parts`).

**What stays in JavaScript at peak.** At most `maxResponseBytes` bytes have been counted and decoded, and they are
never held together as one byte buffer. What remains is the string parts and their single join (UTF-16), and then the
parsed JSON, plus the transient items listed in the Outcome as unbounded.

### 2.3 Classification (no new outcome kinds)

An oversized, undecodable or aborted-mid-body response keeps its **status** and gets `body: { readable: false }`.
That is exactly the shape of today's unparseable body, so every existing mapping applies unchanged:

| Status | Oversized or undecodable body means |
|---|---|
| 2xx on a read | `unavailable` (`failure.ts:24`); on a scoped read, `{ kind: 'unavailable', wait }` |
| 2xx on the native exchange | `uncertain` (`failure.ts:49`, the existing "200 with unreadable body" rule) |
| 401 | still `unauthorised`: the status decides, the body is not needed |
| 403/404 | still `refused` with code `unknown`, so a scoped read still reports `refused`, with the same account effect as today |
| 429/5xx | still `unavailable`, and **`Retry-After` is still honoured** (read from headers before the body) |
| Timeout before headers | unchanged: `no-answer` / `timeout` |
| Timeout **after** headers (while reading the body) | still `answered` with the status and `Retry-After` already read, and the body unreadable. A 429 whose body times out still carries its `Retry-After` (B's S5) |

**An intended behaviour change: invalid UTF-8** (B's S2). Today `text()` replaces invalid UTF-8 with U+FFFD and the
result may still parse. With the fatal decoder, such a body is **unreadable**: a 2xx read is `unavailable`, and an
exchange 200 is `uncertain`. This is the safe direction, since corrupted text never becomes data, and it is tested
explicitly.

**Not `client-bug`.** An oversized body is the server's or the network's doing, not a programming error in the app,
and the adopted `client-bug` outcome is reserved for the latter.

**Why `unavailable` and not a new kind:**
- It shows the honest existing wording ("Couldn't load your work" with Try again).
- It never becomes an empty list.
- It is retry-safe: explicit only, still bounded by each screen's own caps.
- If it recurs, it is an API change that this contract says must be reviewed.
- Nothing is logged, since no body, size or URL is recorded (the existing rule).

## 3. Tests (Claude A except the scoped-read regression; node, with `Response`/`ReadableStream` fakes, no device)

A test-wide `process.on('unhandledRejection')` (and `uncaughtException`) hook fails the test on any unhandled
rejection or throw, so every "no unhandled rejection" item below is checked, not assumed.

- **Exactly at the limit:** a body of `maxResponseBytes` bytes (valid JSON, padded) parses. One byte more is
  unreadable; the order is `reader.cancel('budget')`, then `abort`; and the crossing chunk is never passed to the
  decoder (a spy decoder, or a chunk whose bytes would throw if decoded).
- **Chunking:**
  - many small chunks crossing the limit stop at the crossing chunk; later chunks are never requested;
  - one chunk larger than the limit is rejected, never decoded and not retained;
  - valid 2-, 3- and 4-byte sequences (é, €, 🍺) split across chunks decode exactly, including 🍺 split 1+3, 2+2 and
    3+1;
  - a non-`Uint8Array` chunk (a string, an `ArrayBuffer`, a plain array) is unreadable.
- **`Content-Length`:**
  - a declared size over the limit refuses **before any body access**: the fake's `body` getter throws if touched, and
    `abort` is called;
  - declared small but actually large is still capped by counting;
  - absent, malformed (`12abc`, negative, `1e9`, spaces) or small changes nothing;
  - leading zeros (`0000001048577`) are compared correctly;
  - a 400-digit value is refused with no `Number` overflow.
- **Decoding (the intended change):**
  - invalid UTF-8 is unreadable: a lone continuation byte, an overlong form, a surrogate half, and an invalid
    sequence split across two chunks;
  - an incomplete sequence at the end fails at the final flush and is unreadable;
  - a BOM is stripped;
  - an empty body and `body: null` are unreadable as JSON, as today;
  - a 2xx with invalid UTF-8 is `unavailable`, and an exchange 200 with invalid UTF-8 is `uncertain`.
- **Timeout and hostile streams** (B's R1, R2, R4):
  - a `startStreaming` that never resolves (the first `read()` never settles): at the 30 s timer the body is unreadable
    with `abort` called; then settling or rejecting the pending read later is harmless;
  - a stream that ignores the abort: the timeout still returns;
  - `reader.cancel` that throws or rejects, on both the budget and the timeout paths: no unhandled rejection, and the
    result is unchanged;
  - the timeout path does **not** await cleanup: `request` returns even though `cancel` never settles;
  - `releaseLock` is not called after a budget stop or a timeout (a spy), and is called once after a normal `done`;
  - `reader.closed` is never read (a fake whose `closed` getter throws);
  - one timer only: headers at 20 s and a body stalled from then on give unreadable at 30 s in total, not 50 s.
- **Late settlement after an ignored cancel or abort does nothing** (B's F1). The fakes ignore both `cancel` and the
  signal. Two spies are installed for the test and restored in `finally`:
  - a `TextDecoder` stand-in that counts `decode` calls (a subclass assigned to `globalThis.TextDecoder`);
  - a `JSON.parse` wrapper that records calls whose argument is the fixture text, so the test runner's own parsing is
    not counted.

  Cases:
  - **Timeout, then a late valid chunk:** the first `read()` is pending when the timer fires, and `request` returns
    unreadable. The pending read then resolves with a valid JSON chunk, and a later `done` is available. `read` is
    called exactly once in total, `decode` is never called, and the fixture text is never parsed.
  - **Timeout, then a late rejection:** the same, with the pending read rejecting. There is no unhandled rejection and
    no `halt` side effect beyond the first (the cancel spy was called once).
  - **Budget stop with more data available:** the crossing chunk is not decoded, and `read` is never called again even
    though the fake still has chunks and a `done`. No parse.
  - **Timeout during a mid-body read**, after earlier chunks were decoded: the later chunk and `done` are never decoded
    or parsed, and the decode count stays at the number of chunks counted before the timeout.
- **An abort that throws synchronously** (B's F2, F3), using a **controllable fake controller**.
  - A throwing listener on a real Node `AbortSignal` cannot test this. Node's `EventTarget` catches listener exceptions
    and reports them asynchronously as an uncaught exception, so `abort()` itself never throws: that setup would not
    exercise the `try`, and would trip the test-wide `uncaughtException` hook.
  - Instead, `globalThis.AbortController` is replaced for the test (restored in `finally`) by a fake:
    - its `signal` comes from an inner, real `AbortController`, so `send` fakes still observe it;
    - its `abort()` aborts that inner controller and then throws.
  - Cases, each giving exactly the normal result with no unhandled rejection or uncaught exception:
    - **before headers**, with a `send` that never settles: `no-answer` / `timeout` at the timer. `request` settles
      because `resolve` ran before `abort`;
    - **after headers**, with a stalled body: `answered` with the status and `Retry-After`, and the body unreadable;
    - **the budget path:** unreadable, and the cancel was still attempted before the abort;
    - **the early `Content-Length` refusal:** unreadable, and `.body` was never touched.
- **`cancel` throwing synchronously** (not just rejecting), on the budget and timeout paths: the same result, and the
  guarded abort still runs after it (an abort spy is called once).
- **The timer resolves before it aborts:** a `send` fake that rejects synchronously inside its abort listener gives
  `no-answer` / `timeout`, not `network`.
- **429 and `Retry-After` preserved with an unusable body** (B's S5):
  - a 429 with `Retry-After: 20` whose body **times out** → `answered`, status 429, `retryAfter: 20`, unreadable →
    `unavailable` with `retryAfter: 20`;
  - the same with an **oversized** body, and with an **invalid UTF-8** body.
- **Classification through `apiOutcome` and `exchangeOutcome`:**
  - 2xx oversize → `unavailable`;
  - exchange 200 oversize → `uncertain`;
  - 401 oversize → `unauthorised`;
  - 403 oversize → `refused` with `unknown`;
  - 429 oversize with `Retry-After: 20` → `unavailable` with `retryAfter: 20`.
- **Timeout mid-body:** a stream that stops producing yields `no-answer`/timeout before headers, or unreadable after
  them. The signal is aborted, and no partial JSON is parsed.
- **Stream error mid-body:** unreadable; nothing thrown out of `request`.
- **Existing tests:** every current transport, client, failure and attempt test is adapted from `text()` fakes to
  `body` streams, with the same expectations.
- **Scoped read (Claude B, after the transport implementation):** a My work read whose body is oversized resolves `{ kind: 'unavailable', wait: null }`, not
  `client-bug`, and the list keeps its rows (a runner test plus a hook-level check).

Additional ordinary-stream and body-acquisition cases:
- A valid multi-chunk JSON body ending in `{ done: true, value: undefined }` parses successfully.
- After headers, separately throwing `body` and `getReader()` preserve classification for 200
  (unavailable), 401 (unauthorised), 403 (refused), and 429 with Retry-After: 20 (unavailable with that wait).
  None becomes no-answer/network or produces an unhandled rejection.

## 4. Native proof limits (device gates, added to foundation §8/§10)

Node tests prove the transport's logic with fake streams only. On devices, with the isolated synthetic environment and
native sign-in off elsewhere:
1. **Cancelling stops the download.** An over-limit response (for example 5 MiB) ends the native transfer soon after
   the limit (network inspector or server log), on iOS and Android.
2. **Pre-streaming buffer.** Measure the first chunk size on a fast local network. That shows how much native buffers
   before JS starts streaming. The contract bounds JS retention only; native buffering before streaming, and one
   native chunk, are **not** bounded by this change.
3. **Compression.** A gzip (iOS) and zstd/br/gzip (Android) body whose decompressed size exceeds the limit is refused.
   This shows JS counts decompressed bytes.
4. **Decoder.** Hermes uses the platform or Expo `TextDecoder` with `fatal: true`: invalid UTF-8 is refused, and a
   split multi-byte character decodes.
5. **Unchanged behaviour** on real `/v1/me`, exchange and My work responses from the isolated synthetic environment.
   Record their observed sizes as operational evidence for the policy limit, not as a proof about all data.

No simulator or device evidence is claimed by the implementation PR.

## 5. Scope and ownership

| Owner | Files |
|---|---|
| A | `src/api/client.ts` (the budgeted body reader, `maxResponseBytes`), the `Send` type in `client.ts`/`native-send.ts`, and all transport, client, failure and exchange test updates |
| B | Independent review; one runner or hook regression that an oversized scoped read is `unavailable`, not `client-bug` |
| Root | Integration, CI, docs (record implemented transport bounds separately from pending native gates), git |

Not in scope:
- a native (Swift/Kotlin) byte limit (a patch to Expo);
- request-body limits (the app sends only small JSON);
- per-route budgets;
- streaming JSON parsing;
- any change to the API.

## 6. Adopted choices

Decided by root after B's review:
1. The 1 MiB fixed limit, as a **policy**.
2. **Per-chunk streaming decoding** with one fatal `TextDecoder` (§2.2), with no byte concatenation, to reduce peak
   copies.
3. The early `Content-Length` refusal: **yes, abort only**, with no body access (§2.2, step 1).

Adopted in revision 4, with root's agreement: B's F1–F3. They are the stop state, resolve-before-cleanup, and every
cleanup call guarded.

**Not directly tested:** that `halt` clears `state.parts` isn't observable without exposing the state. It is checked in
code review, and indirectly by the decode and parse spies.

The implementation requires independent review, focused transport/account regressions, mobile and workspace
checks, four exports with boundary scans and all applicable CI before merge. Native proof remains separate.
