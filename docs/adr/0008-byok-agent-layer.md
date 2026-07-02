# ADR 0008: BYOK agent layer — provider calls go direct from the browser

## Status
Accepted (2026-07-02)

## Context
The AI layer previously ran server-side with the operator's Gemini key: operator pays for all inference, and a server must exist. Anthropic, OpenAI, and Gemini all support direct browser calls (Anthropic via the `anthropic-dangerous-direct-browser-access` CORS opt-in header).

## Decision
Users supply their own API key (BYOK). Keys are stored only in browser local storage, displayed masked, never logged, and sent only in direct requests to the chosen provider's API. There is no relay, proxy, or middleman for BYOK traffic. A separate, optional, hard-budgeted "house agent" edge proxy may serve keyless users; it forwards and meters, and never grows tool execution or state.

## Consequences
- Inference cost scales with the user, not the operator.
- Key security is bounded by the user's browser profile; the settings UI must state this plainly and recommend scoped, low-limit keys.
- Provider CORS policy changes are an accepted external risk; the provider abstraction must degrade per-provider rather than globally.
- All agent tools execute client-side against the local engine, which is what makes zero-backend agents possible at all.
