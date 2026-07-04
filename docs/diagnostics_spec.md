# Diagnostics spec

The **diagnostics registry** (`registry/diagnostics.json`) is the single
namespace for every error, warning, and info the AirSpice platform emits. It
exists so that the codes parity fixtures compare byte-for-byte, the repair loop
keys on, and the UI renders can never collide, drift, or ship undocumented.

This document defines: the shape of a registry entry, the namespace scheme for
**new** codes, the rule that no code ships without an entry, and how the engines
consume the registry. It is the reference that issues #13 (sim errors), #33
(import), #38 (co-sim), and #43 (XML security) point to when they mint their new
codes.

## The registry file

`registry/diagnostics.json` has two sections:

- `diagnostics` — the **active** codes: every code the oracle emits today. Each
  is one object:

  | field | meaning |
  |---|---|
  | `code` | the stable identifier, e.g. `MISSING_GROUND` (grandfathered) or `SEC-001` (new). Byte-for-byte what appears in a diagnostic's `code` field. |
  | `namespace` | the owning subsystem tag as it appears in the diagnostic's `domain` field (e.g. `schema`, `power`, `interface`, `analog`, `compiler`, `renode`). |
  | `owner` | the source module that emits it (`validation`, `simulator`, `spice`, `runners`, …). |
  | `severity` | `info` \| `warning` \| `error`. |
  | `message_template` | the message with each interpolated value written as a `{placeholder}` (Python `str.format` style). Grandfathered entries reproduce the oracle's current f-string **verbatim** — same spelling, same punctuation. |
  | `parameters` | ordered list of the `{placeholder}` names in the template. |
  | `remediation` | a short remediation hint; may be `""` for grandfathered codes that don't record one yet. |
  | `source` | `path/to/module.py:function` where the code is emitted. |
  | `grandfathered` | `true` for codes that predate the registry (kept verbatim), `false` for codes minted under this spec. |

- `pending` — codes that are **in flight in another PR** and not yet emitted on
  `main`. They are recorded (with the spelling from their source PR) so that
  whichever PR lands second does not break the other's CI enforcement. The
  registry checker exempts this section from the dead-code check until the codes
  land. See "Coordinating in-flight codes" below.

## Grandfathering: existing codes are frozen

Every code that existed when the registry was introduced is recorded **as-is**.
No renames, no message "improvements". Renaming a code or editing a message
would churn the golden corpus (`tests/golden_corpus/`) and every parity suite
that compares diagnostics byte-for-byte, for zero user value. Message quality
improvements are separate, later, **oracle-first** changes (they regenerate the
corpus deliberately). The registry inventory is a read-only operation.

## Namespace scheme for NEW codes

Codes minted from now on use a namespaced identifier: a subsystem prefix, a
hyphen, and a zero-padded number.

| prefix | subsystem | issue |
|---|---|---|
| `VAL-` | validation / semantic / electrical checks | |
| `PARSE-` | parser / normalizer structural errors | |
| `SIM-` | simulation (ngspice) errors | #13 |
| `COSIM-` | co-simulation / lockstep errors | #38 |
| `PATCH-` | patch application errors | |
| `IMP-` | part / SPICE import errors | #33 |
| `SEC-` | XML security (entity expansion, external refs, …) | #43 |

Example: the first XML-security code is `SEC-001`, the second `SEC-002`, and so
on. Numbers are allocated sequentially within a prefix and never reused.

Grandfathered `SCREAMING_SNAKE_CASE` codes keep their names forever; the
namespaced scheme applies only to codes created after this spec.

## The rule: no code without a registry entry

**A diagnostic code may not ship unless it has an entry in
`registry/diagnostics.json`.** This is enforced mechanically in CI, in both
directions, by `scripts/check_diagnostics.py`:

1. **Registry completeness.** Every code that appears in a golden-corpus
   `diagnostics.json` / report `.json`, and every registered code referenced by
   name in the test suite, must have a registry entry (active or pending). A
   code frozen into a fixture without an entry fails the build.
2. **No dead codes.** Every **active** registry entry must be exercised by at
   least one test or corpus fixture. An unexercised active entry is an orphan
   and fails the build, unless it is listed in the checker's
   `KNOWN_ORPHAN_ISSUES` map with a filed tracking issue. The `pending` section
   is exempt from this check until its codes land on `main`.

The checker ships with a `--self-test` that proves it has teeth (an
unregistered code fails check 1; an unexercised active code is flagged by
check 2; a pending-only code is exempt from check 2 but still satisfies
check 1). CI runs the self-test before the real check.

### Adding a new code — the checklist

1. Choose the next number in the right prefix (e.g. `SEC-001`).
2. Add an entry to the `diagnostics` array with `grandfathered: false` and a
   filled-in `remediation`.
3. Emit it from the owning module. For **new** codes, format the message and
   read the severity from the registry via the loader (below) so the emitted
   diagnostic and the registry can never drift.
4. Add a test that exercises the emit path (this satisfies check 2 and documents
   the code).
5. Run `python scripts/check_diagnostics.py` locally; it must pass both ways.

## How the engines consume the registry

### Python (`air.diagnostics_registry`)

The Python oracle reads the registry through `air.diagnostics_registry`:

- `load_registry()` → `{code: entry}` for the **active** codes (the `pending`
  section is excluded — those codes are not emitted yet).
- `severity_for(code)` → the registered severity.
- `render_message(code, **params)` → the message with the template filled in.
- `namespace_for(code)` → the registered namespace/`domain`.
- `get_entry(code)` raises `DiagnosticRegistryError` for an unregistered code.

New code sites should build their message via `render_message(...)` and their
severity via `severity_for(...)` instead of hardcoding strings, so the registry
is the single source of truth. **Grandfathered** call sites keep their existing
hardcoded `builder.make(...)` strings verbatim; migrating them wholesale would
churn the corpus. A grandfathered site may migrate to the loader opportunistically
the next time it is legitimately touched (an oracle-first change).

### TypeScript / other ports

There is no `packages/air-ts` in the tree yet. When a TS engine or a WASM port
lands, it consumes the **same** `registry/diagnostics.json` — the registry is
data, not code, with no per-engine variants of a code — as its source of message
templates and severities for new codes, exactly as the Python loader does. Until
then, that consumer is a documented follow-up (see the PR that introduced this
spec).

## Coordinating in-flight codes (the `pending` section)

When two PRs are in flight and one adds new codes, the code-vs-registry check
would otherwise fail whichever PR lands second (either a corpus gains a code the
registry doesn't have, or the registry gains a code no test exercises yet). To
avoid that race, a code being added by another open PR is recorded in the
`pending` section — with the spelling from that PR — and the checker exempts
`pending` from the dead-code check. When the other PR merges, its codes move
from `pending` into `diagnostics` (marked `grandfathered: true` if they landed
without going through this spec, or kept as the registered new-scheme code) and
are deleted from `pending`.

## Invariants

- The registry is **data, not code**: no logic, no per-engine variants of the
  same code.
- **Determinism**: entries are plain JSON; the checker sorts its output.
- A code's identity is its `code` string; it is stable forever once shipped.
