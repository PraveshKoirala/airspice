# house-agent (prototype, issue #20)

Cloudflare Worker that proxies keyless AirSpice users to an upstream LLM
provider using OUR key, with a signed daily-budget token, per-IP rate limit,
and a hard monthly spend cap that fails closed to BYOK.

**Not deployed.** Feature-flagged OFF in production builds
(`VITE_ENABLE_HOUSE_AGENT=false` by default). See
[`docs/house_agent_design.md`](../../docs/house_agent_design.md) for the full
design; that doc is authoritative — this README is setup notes only.

## Layout

```
src/
├── index.ts      Worker handler: kill switch → rate limit → daily budget →
│                 monthly cap → forward → SSE translation
├── budget.ts     KV-shaped budget/rate-limit primitives + in-memory stub
└── token.ts      Signed daily-budget token (HMAC-SHA256 receipt)
tests/
├── worker.test.ts   Full smoke against a mocked upstream (no network)
└── token.test.ts    Round-trip + tamper + wrong-day rejection
```

## Local test (CI-safe)

```sh
cd packages/house-agent
npm ci
npm test
```

Every test uses `InMemoryKv` and a stubbed upstream `Response`. No wrangler,
no network, no secrets required — this is the acceptance path the issue calls
for ("prototype must LOAD and its tests must pass in mock mode").

## Local wrangler dev (documented, not required)

```sh
# Install wrangler as a global dev tool (not added to repo deps).
npm i -g wrangler

# Provider key and HMAC signing secret — never in the repo (AGENTS.md rule 15).
wrangler secret put ANTHROPIC_KEY --name airspice-house-agent
wrangler secret put TOKEN_SIGNING_SECRET --name airspice-house-agent

# Local dev with the KV binding stubbed by --local:
wrangler dev --local --var HOUSE_AGENT_ENABLED:true
```

`wrangler dev` is **not** part of `npm test`; it is a manual smoke tool for
the maintainer verifying spend controls end-to-end before any real deploy.

## Deploy is intentionally NOT wired

The design doc lists the deploy checklist. Two properties this repo enforces
until spend controls are verified live:

1. `wrangler.toml`'s `[[kv_namespaces]]` block is commented out — a fresh
   `wrangler deploy` from this file would fail cleanly rather than accidentally
   stand up a live endpoint.
2. `HOUSE_AGENT_ENABLED = "false"` is the default in `wrangler.toml` — even if
   step (1) is worked around, the Worker fails closed on every request.

Both are belt-and-suspenders on the "no deploy in this PR" statement in the
[pull request](../../docs/house_agent_design.md#deployment-documented-not-performed-in-this-pr).
