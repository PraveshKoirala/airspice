# XML security contract

This is the **binding input contract** for untrusted XML in AirSpice. Untrusted
XML reaches the engines through share links (#27), agent output, and file import
(#26); a hostile document (a billion-laughs entity payload, a 1000-deep nesting,
a 5 MB blob, a non-UTF-8 payload) must be **refused before it can do any work**.

The contract is **enforced identically in BOTH engines**:

- the Python reference oracle — `packages/core/src/air/xml_security.py`, gating
  `air.parser.parse_file` / `parse_string`;
- the TypeScript engine (air-ts) — `packages/air-ts/src/xml.ts`
  (`enforceSecurity` + the byte-level `decodeXmlBytes`).

The limits and diagnostic codes below are the **single source of truth**; the
two implementations keep them in lockstep. The differential fuzzer
(`scripts/fuzz_diff.mjs`, issue #43) feeds mutated and hostile input to both
engines and asserts they make the **same accept/reject decision with the same
`SEC-` code**, so drift between the two implementations fails CI.

Every rejection carries a registered `SEC-` diagnostic code (registered in
`registry/diagnostics.json` under the `security` namespace, per the
`docs/diagnostics_spec.md` new-code protocol). This document is referenced from
the #27 (share links) and #26 (file import) acceptance flows.

## The contract

| Limit | Value | Rationale | Code |
|---|---|---|---|
| **DOCTYPE / entity declarations** | rejected outright, no expansion ever | `<!DOCTYPE>` / `<!ENTITY>` are the entity-expansion (billion-laughs) and external-entity (XXE) surface. AIR documents never need them. Rejected on the declaration, **before any expansion**. | `SEC-001` |
| **Max input size** | 5 MB (`5 * 1024 * 1024` UTF-8 bytes) | Bounds parse-time memory for an untrusted blob. 5 MB is far above any realistic AIR design (the golden corpus max is a few KB) while cheaply refusing a memory-exhaustion payload. | `SEC-002` |
| **Max element nesting depth** | 64 | Bounds recursion / entity-driven nesting. Enforced by **counting** during a bounded pass, never by catching a stack overflow. 64 is far deeper than any AIR document (the deepest corpus design nests ~6). | `SEC-003` |
| **Max attributes per element** | 256 | Bounds per-element parse work. No AIR element approaches this (an MCU with the most pins uses far fewer attributes on any single element). | `SEC-004` |
| **Max attribute value length** | 65536 characters | Bounds per-attribute memory. AIR attribute values are short identifiers / quantities; 64 KiB is a generous ceiling. | `SEC-005` |
| **Max element count per document** | 100000 | Bounds total parse work for a "many tiny elements" payload. Two orders of magnitude above the largest corpus design. | `SEC-006` |
| **Encoding: UTF-8 only** | UTF-8 required; a UTF-8 BOM is tolerated and stripped; UTF-16 / UTF-32 (by BOM) and any non-UTF-8 declared encoding or invalid UTF-8 byte sequence are rejected | One decoding path means the two engines can never disagree on what the bytes say. Non-UTF-8 input from a hostile share link is refused rather than guessed at. | `SEC-007` |
| **Invalid numeric character reference** | a numeric char ref (`&#N;` / `&#xH;`) to a code point outside the XML 1.0 `Char` production (C0 controls except tab/LF/CR, surrogates, `U+FFFE`/`U+FFFF`, `> U+10FFFF`) is rejected | expat rejects these as "reference to invalid character number"; air-ts reproduces the decision in front of `fast-xml-parser` (already implemented in #7/#77). Both engines reach the same `SEC-008` code. | `SEC-008` |

### Justification of the numeric limits

The caps are chosen to be **invisible to every real AIR document and the entire
golden corpus** (so enabling the contract changes no benign behavior) while
being **cheap to check and tight enough to refuse a resource-exhaustion
payload**. Concretely, the largest golden-corpus design is a few kilobytes,
nests about six deep, and puts at most a handful of attributes on any element;
every cap above sits one-to-several orders of magnitude beyond that headroom.
Depth (SEC-003) and element count (SEC-006) are enforced by a linear counting
pass so a hostile 1000-deep or million-element document is refused **before** the
real parser allocates a tree — not by catching a parser stack overflow after the
fact.

## Enforcement order

Both engines apply the contract in the same fail-fast order (cheapest, most
dangerous first):

1. **Encoding** (SEC-007) — decode bytes to text, refusing non-UTF-8. (air-ts
   runs this at its byte entry point `decodeXmlBytes` / `parseXmlBytes`; the
   oracle runs `enforce_encoding` on the raw file/bytes.)
2. **DOCTYPE / entity declarations** (SEC-001) — reject outright, no expansion.
3. **Invalid numeric char refs** (SEC-008).
4. **Size** (SEC-002), then the **counting structural pass** for depth (SEC-003),
   element count (SEC-006), and attribute count/length (SEC-004/005).

Malformed XML that is not a security violation (an unclosed tag, junk after the
root) is a normal parse rejection, not a `SEC-` code — both engines reject it,
and the differential fuzzer checks they agree.

## Acceptance evidence (issue #43)

- **Billion-laughs completes rejection in < 100 ms in BOTH engines** — it is
  refused on the `<!DOCTYPE>` declaration (`SEC-001`), before any entity
  expansion. Measured in `tests/test_xml_security.py::test_billion_laughs_...`
  (oracle) and `packages/air-ts/tests/xml_security.test.ts` (air-ts); both assert
  `< 100 ms`.
- **All hostile fixtures are rejected identically in both engines** with the
  codes in the table. The fixtures live in `tests/xml_security/` and are driven
  from **both** engines' suites off one shared manifest
  (`tests/xml_security/manifest.json`): `billion_laughs`, `external_entity`,
  `deep_nesting` (1000-deep), `oversized` (> 5 MB, generated in-test),
  `utf16` (generated in-test), `bad_encoding_decl`, `invalid_charref`,
  `many_attributes`, `long_attr_value`.

## Oracle-first note

Enabling this contract **added enforcement to the Python oracle** for hostile
inputs: prior to #43 the oracle accepted a `<!DOCTYPE>` and expanded internal
entities (expat's default). That is an intentional oracle behavior change *for
hostile inputs only* — no benign document, and no golden-corpus fixture, is
affected (the caps sit far above any real design; DOCTYPE/entities never appear
in the corpus). The PR that introduces this carries the `oracle-first` label and
documents the change; the corpus is untouched (zero fixture changes, verified by
`tests/test_xml_security.py::...corpus_design_still_parses`).
