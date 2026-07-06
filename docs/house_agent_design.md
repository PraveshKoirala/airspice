# House agent — hosted proxy for keyless users (design)

Issue: [#20](https://github.com/PraveshKoirala/airspice/issues/20) — P2, M3.
Status: **DESIGN + PROTOTYPE** (this PR). Not deployed. Feature-flagged OFF.

## Scope binding

ADR 0008 puts BYOK on the direct-browser path with no relay. The house agent is
the **opposite lane**: our key on our edge worker, hard-budgeted, opt-in for
users who will not paste a key. NORTH_STAR §"Zero-backend default" (rule 4) and
§"Cost model" both call this out as the **one intentional server-side lane** in
an otherwise zero-backend architecture. That single sentence is the whole risk:
if this lane grows tool execution, prompt assembly, or memory of the design, it
silently kills the zero-backend property. The guardrails below exist to keep
the lane thin.

## Topology

```
Browser (BYOK path, ADR 0008)
    KeyVault ──► AnthropicProvider ──► api.anthropic.com          (default)

Browser (house path, this PR — OFF by default)
    HouseProvider ──► houseagent.airspice.dev/v1/chat  ──► api.anthropic.com
    (anonymous)         │  Cloudflare Worker           │
                        │  ── budget check (KV)         │
                        │  ── IP rate limit (KV/DO)     │
                        │  ── inject ANTHROPIC_KEY      │
                        │  ── translate SSE to our      │
                        │      neutral event stream     │
                        └────────────────────────────────
```

Both lanes emit the same neutral `AgentEvent` stream (`text-delta` / `tool-call`
/ `usage` / `done` / `error`), so callers never branch on which lane produced
the events. `HouseProvider` implements `AgentProvider` with `id: "house"` — it
is *one more entry alongside* Anthropic/OpenAI/Gemini/Mock, not a bypass.

### Why Cloudflare Workers

- Free tier: 100k requests/day → survives the smoke phase at zero cost.
- Global edge → sub-100ms overhead on the wrapper.
- KV + Durable Objects give per-day counters + IP rate limits without a DB.
- `wrangler secret put ANTHROPIC_KEY` keeps the key out of the repo.
- Reverse-swappable: any edge fn (Deno Deploy, Vercel Edge, Fly Machines) can
  host the same 200-line worker; nothing browser-facing depends on Cloudflare.

### Wire format (neutral, provider-agnostic)

The worker exposes ONE endpoint:

```
POST /v1/chat
    Content-Type: application/json
    X-AirSpice-Token: <signed daily budget token, optional>

    Body (JSON, mirrors the neutral ChatRequest minus the AbortSignal):
    {
      "system":     "<system prompt>",
      "messages":   [ { "role": "...", "content": "...", ... } ],
      "tools":      [ { "name", "description", "parameters" } ],
      "maxTokens":  <int>,
      "model":      "<optional client hint>"
    }

    Response: text/event-stream
    Each event is one of our neutral AgentEvent shapes, serialized as JSON:
        data: {"type":"text-delta","text":"..."}\n\n
        data: {"type":"tool-call","id":"...","name":"...","args":{...}}\n\n
        data: {"type":"usage","inputTokens":n,"outputTokens":n}\n\n
        data: {"type":"done","stopReason":"stop"|"tool_use"|"max_tokens"|"aborted"}\n\n
        data: {"type":"error","kind":"...","retryable":bool,"message":"..."}\n\n
```

The client's job on this wire is essentially `readSSE → JSON.parse → yield`.
That is what makes the worker interchangeable with any future provider we host.
The worker's job is (a) budget gate, (b) inject our provider key, (c) call the
provider, (d) translate the provider's SSE (Anthropic messages format today)
into the neutral event stream above.

### What the worker MUST NOT grow (invariant)

The worker forwards and meters. Concretely, the CI-visible bullets:

1. **No tool execution.** Tools run in the browser against air-ts + sim-wasm.
   The worker only relays `tool-call` events; it never invokes them.
2. **No prompt assembly.** The client sends `{system, messages, tools}`
   verbatim; the worker never rewrites or synthesizes them.
3. **No conversation state.** The worker holds no memory of prior turns; the
   client sends the full transcript on every request (same as BYOK).
4. **No design/xml persistence.** The worker never sees the AIR IR outside a
   single request's `messages[]` payload, and never writes it anywhere.

Violating any of these silently reintroduces a backend that scales with users.
The prototype's total line count (~200 in `src/index.ts`) is the ceiling for a
merge; growth beyond that is a discussion issue, not a stealth PR.

## Abuse control

Two layers, both fail-closed:

### 1. Per-anonymous-user daily budget (signed token)

On first `/v1/chat` request from a browser that has no token, the worker mints
a **signed daily budget token**:

```
token = base64url({
  "day":    "2026-07-05",
  "budget": 50000,           // token cap for the day
  "nonce":  <random 128b>
}) + "." + base64url(HMAC-SHA256(secret, header))
```

The token is a **budget receipt**, not a user id — there is no user table,
no login, no identifier that maps to a person. The nonce prevents collision.
The client caches it in `sessionStorage`; a rejected token (`day` != today,
budget exhausted, bad signature) triggers a mint on the next call.

Each request DEBITS the day's KV counter by the LLM's actual token spend
(after the upstream `usage` event arrives). When the KV counter for a token
reaches its cap, the worker returns `{"type":"error","kind":"quota",
"retryable":false, "message":"Daily budget exhausted — bring your own key in
Settings."}` and the client surfaces the BYOK upsell.

### 2. IP rate limit

A **hard second layer** because signed tokens are only anonymous, not
rationed: KV keyed by `sha256(ip + secret)`, sliding-window counter, default
30 req/min per IP. Prevents a bot from minting fresh tokens on a loop. The IP
hash is transient (worker request scope only), not persisted.

### 3. Hard monthly spend cap (kill switch)

A global `MONTHLY_USD_CAP` in KV, decremented by the same upstream `usage`
math. Blast radius across all users. When crossed, the worker returns
`{"type":"error","kind":"quota","retryable":false, "message":"House agent
temporarily unavailable — add your own key in Settings to continue."}`. The
UI degrades to a banner ("House agent unavailable this month") and the
provider picker demotes the "House" option to disabled + copy pointing at
BYOK setup. **This is the operator's ejection seat**: if a bug or a botnet
starts burning money, one env var flip disables the lane globally.

The lane also carries a `HOUSE_AGENT_ENABLED` env var (see kill switch below)
that shuts the whole worker down regardless of budget state — the same
fail-closed path.

## Privacy

- **No prompt/response persistence** beyond transient in-request processing.
  The `messages[]` payload is streamed to the upstream provider and its
  response is streamed back; nothing is written to KV, R2, D1, or a log.
- **No user identification.** The signed token is a rate-limit receipt, not
  a login; no email, no cookie beyond the day's nonce, no fingerprint.
- **IP handling.** The IP is hashed with a rotating secret for the rate-limit
  bucket key ONLY; the raw IP never appears in KV or logs.
- **Upstream provider's own policy.** The worker relays to Anthropic; that
  request is subject to Anthropic's data-use policy. The in-app banner names
  the current upstream provider so the user can decide against it.
- **Publish it.** The Settings panel's "House agent" section carries this
  privacy note verbatim, with a "learn more" link to this doc.

## Cost model

### Anchor: 6/6 repair baseline (issue #19)

`packages/agent/bench/results/2026-07-05-anthropic.json` — full 6-case repair
bench on `claude-sonnet-5`, EVERY case fixed in a single iteration:

- **147,501 tokens across the 6 fixes**.
- Repair turns are input-heavy (large design + diagnostics per turn, small
  patch out). At `claude-sonnet-5` introductory pricing ($2 in / $10 out per
  MTok through 2026-08-31): all-input floor ≈ **$0.30**, all-output ceiling
  ≈ **$1.48**; blended ≈ **$0.35** for the 6-case run.
- **~$0.06 per repair** (blended, on the flagship Sonnet 5 tier).

### Default tier for the house agent

`claude-haiku-5` is the default. Anthropic's Haiku family is priced roughly
1/12 of Sonnet ($0.25 in / $1.25 out per MTok — same ratios as prior Haiku
generations, adjust when the live sheet moves). Applying the 12× discount to
the anchor:

- Repair (autonomous): **~$0.005 per fixed repair** on Haiku 5.
- Chat turn (non-repair, ~15k input + 1k output typical): **~$0.005 per turn**.

### Rounded planning numbers

|            | Sonnet 5 anchor | Haiku 5 (default) |
|---|---:|---:|
| Per chat turn   | ~$0.06 | ~$0.005 |
| Per repair fix  | ~$0.06 | ~$0.005 |
| Per DAU (5 turns/day + 1 repair/wk) | ~$0.36/day | ~$0.03/day |
| 100 DAU / month | ~$1,000/mo | ~$90/mo |
| 1,000 DAU / month | ~$10,000/mo | ~$900/mo |

The DAU × 100 line is where the operator either stops eating the cost or
raises the monthly cap deliberately. `MONTHLY_USD_CAP` starts at **$50/month**
in `wrangler.toml.example` — enough for ~500 fixed repairs on Haiku (a smoke
launch), fails closed above that, and the operator can only raise it by
editing the deployed secret (a deliberate rare action, not a config nudge).

Per-daily-budget default: **50,000 tokens/day** per anonymous browser, which
is **≈2–3 Sonnet-anchor repairs OR ≈8 chat turns** — enough to try the demo,
not enough to farm free inference.

### Model choice invariants

- Default tier is the cheapest available on the upstream provider (Haiku-class
  today). The worker rejects a client `model` hint that names a tier costlier
  than the configured default; upgrading is a deploy action.
- One provider at a time. Multi-provider fanout in the worker is out of scope
  (it grows the "thin proxy" surface and the abuse-control math has to be
  re-derived per provider). If a second provider becomes strategic, ship it
  as a second worker.

## Kill switch

Three layers, coarse → fine, ALL fail-closed to BYOK:

1. **Client build flag** — `VITE_ENABLE_HOUSE_AGENT` (default `false`).
   When false, the client never constructs a `HouseProvider`, never surfaces
   the "House" option in the provider picker, and the settings panel does not
   mention it. Zero blast radius.
2. **Client env URL** — `VITE_HOUSE_AGENT_URL`. When absent or empty, the
   provider constructor throws; the picker shows "House agent unavailable
   (not configured)". Lets a fork ship BYOK-only builds cleanly.
3. **Worker env** — `HOUSE_AGENT_ENABLED` (default `"false"`). When false,
   the worker returns a canned error `{"type":"error","kind":"quota",
   "retryable":false,"message":"House agent temporarily unavailable — add
   your own key in Settings."}` regardless of budget state. The UI shows an
   in-app banner:

   > **House agent unavailable.** Add your own API key in Settings to
   > continue. (Your usage of your own key never leaves your browser.)

   and the chat picker demotes "House" to disabled. This is the operator's
   ejection seat: flip the env var, redeploy the worker (< 30s), the whole
   lane goes cold. BYOK keeps working because the browser never talks to
   the worker for BYOK.

### Kill-switch invariant

The client MUST render the BYOK upsell banner, not a raw error, whenever the
worker responds with `kind: "quota"` on the *first* `/v1/chat` of a session
(before any usage is charged). This is the acceptance path the issue names.

## Deployment (documented, not performed in this PR)

The prototype under `packages/house-agent/` is wrangler-runnable locally, but
this PR does not deploy. When we do deploy:

```sh
# 1. Install wrangler (workspace-local; not added to repo deps).
npm i -g wrangler

# 2. Provider key — never in the repo (AGENTS.md rule 15).
wrangler secret put ANTHROPIC_KEY --name airspice-house-agent

# 3. HMAC secret for the daily budget token signatures.
wrangler secret put TOKEN_SIGNING_SECRET --name airspice-house-agent

# 4. Deploy with the lane still off.
wrangler deploy --var HOUSE_AGENT_ENABLED:false

# 5. Only when spend controls are verified end-to-end:
wrangler deploy --var HOUSE_AGENT_ENABLED:true
```

The first PR that actually deploys the worker also flips
`VITE_ENABLE_HOUSE_AGENT=true` in the UI production build and adds the
in-app privacy note. Neither happens in this PR.

## Prototype layout (this PR)

```
packages/house-agent/
├── README.md            Local wrangler + test instructions
├── wrangler.toml        Cloudflare Worker config; no secrets
├── package.json         Vitest + wrangler devDeps only
├── src/
│   ├── index.ts         The worker (~200 lines: gate → forward → translate)
│   ├── budget.ts        In-memory + KV budget/rate-limit primitive
│   └── token.ts         HMAC daily-budget token mint/verify
└── tests/
    └── worker.test.ts   Mocked-fetch smoke: rate limit trips, budget trips,
                         kill switch trips, streaming path relays events

packages/agent/src/providers/
└── house.ts             HouseProvider (AgentProvider impl, id: "house")
```

The worker never runs `wrangler dev` in CI — the prototype must LOAD and its
tests must pass in **mock mode** using vitest with a stubbed `fetch` (same
pattern the BYOK providers use in `packages/agent/tests/anthropic.test.ts`).

## Follow-ups (filed as separate issues on merge, not done here)

- Wire `HouseProvider` into `SettingsPanel` behind `VITE_ENABLE_HOUSE_AGENT`
  with a "House agent (metered, no key required)" option in the picker.
- Publish the privacy note verbatim in the Settings panel.
- Wrangler deploy pipeline gated on the spend-controls verification checklist.
- Model-tier telemetry (Haiku vs. Sonnet actual costs) once live.

## Explicit non-goals

- No login, no user table, no email capture.
- No streaming to a real Cloudflare instance in this PR.
- No change to the BYOK path — `SettingsPanel` untouched here.
- No new deps in the `agent` package (HouseProvider reuses `readSSE`,
  `redactKey`, `parseToolArgs`, `RedactedError`).
