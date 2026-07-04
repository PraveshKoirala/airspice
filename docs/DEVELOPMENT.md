# Development

Practical setup and process notes for working in the AirSpice repository.
See [AGENTS.md](../AGENTS.md) for the rules of engagement and
[ORCHESTRATION.md](ORCHESTRATION.md) for the swarm execution model.

This guide takes you from a fresh clone to a running app and a passing test suite
with one documented command block per platform. It covers the **Python reference
engine** (`packages/core`) and the **server-coupled React UI** (`packages/ui`) —
the *oracle*, not the shipped product (see [NORTH_STAR.md](NORTH_STAR.md) and the
top-level [README](../README.md) for that distinction).

> The engine degrades gracefully: with only Python and Node installed (no ngspice,
> Renode, or PlatformIO), the app starts and every non-simulation feature works.
> Analog simulation falls back to a built-in DC solver and tells you what to
> install. See [Environment variables](#environment-variables) and
> [Graceful degradation](#graceful-degradation).

## Prerequisites

| Tool | Version | Required? | Install |
|---|---|---|---|
| Python | 3.12+ | yes | [python.org/downloads](https://www.python.org/downloads/) · macOS `brew install python@3.12` · Debian/Ubuntu `sudo apt-get install python3.12 python3.12-venv` |
| Node.js | 22+ | yes (for the UI) | [nodejs.org](https://nodejs.org/en/download) · macOS `brew install node@22` · Linux [nodesource](https://github.com/nodesource/distributions) or [nvm](https://github.com/nvm-sh/nvm) |
| ngspice | any | optional | [ngspice.sourceforge.io/download.html](https://ngspice.sourceforge.io/download.html) · macOS `brew install ngspice` · Debian/Ubuntu `sudo apt-get install ngspice` |
| Renode | 1.16+ | optional | [renode.io/#downloads](https://renode.io/#downloads) |
| PlatformIO | any | optional | `pip install platformio` ([docs](https://docs.platformio.org/en/latest/core/installation/index.html)) |

The three optional tools power simulation, firmware co-simulation, and firmware
builds respectively. You can do everything else without them.

## Setup

Run these from the repository root.

### Python engine

```bash
# 1. Create and activate a virtual environment
python -m venv .venv
# macOS/Linux:
source .venv/bin/activate
# Windows (PowerShell):
#   .venv\Scripts\Activate.ps1

# 2. Editable install with the dev extra (pulls in pytest, fastapi, httpx,
#    uvicorn, python-dotenv — everything the suite and the API/CLI need)
pip install -e ".[dev]"
```

> The repository root `pyproject.toml` **is** the `air` core package (its sources
> live under `packages/core/src` via `package-dir`). Install from the root — there
> is no separate `pyproject.toml` under `packages/core`. `pip install -e ".[dev]"`
> is sufficient; you do not need to install anything by hand.

### Frontend

```bash
cd packages/ui
npm ci
cd ../..
```

### Environment file (optional)

```bash
cp .env.example .env   # then edit if you have tool paths or an API key
```

Everything works with **no** `.env` at all. Only add one when you need an LLM key
or a tool that lives outside your `PATH` (see the table below).

## Running

### Option A — one command (recommended)

Convenience scripts live in the root `package.json`. Install its single dev
dependency (`concurrently`) once, then start the backend API and the Vite dev
server together:

```bash
npm install          # installs `concurrently` at the repo root
npm run dev          # runs `air serve` (API on :8000) + Vite UI concurrently
```

`npm run dev` relies on the `air` console script, which the editable install
(`pip install -e ".[dev]"`) puts on your `PATH`. Activate the virtualenv in the
same shell first.

### Option B — two terminals (no root npm install)

```bash
# Terminal 1 — backend API
#   the console script:
air serve --host 127.0.0.1 --port 8000
#   or, without the editable install, run the module (set the src layout on the path):
#     PYTHONPATH=packages/core/src python -m air.cli serve --host 127.0.0.1 --port 8000
#   PowerShell: $env:PYTHONPATH = "packages/core/src"; python -m air.cli serve

# Terminal 2 — frontend
cd packages/ui
npm run dev
```

### Other root scripts

```bash
npm run test:py      # python -m pytest tests/
npm run build:ui     # production build of the UI (tsc -b && vite build)
```

## Testing

```bash
# Full Python suite (from the repo root, virtualenv active)
python -m pytest tests/

# or via the convenience script
npm run test:py
```

Tests requiring optional tools/keys (Renode, PlatformIO, live-LLM) **self-skip**
with a reason via env-gated markers (`AIR_RUN_TANDEM` / `AIR_RUN_BUILD` /
`AIR_RUN_E2E` + `GEMINI_API_KEY`) — they never fail cryptically. Analog
simulation tests run against ngspice when it is present and against the built-in
DC fallback when it is not; both are green.

If you have not run the editable install, prefix pytest with the src layout:
`PYTHONPATH=packages/core/src python -m pytest tests/` (PowerShell:
`$env:PYTHONPATH = "packages/core/src"`).

## Linting

```bash
cd packages/ui
npm run lint         # eslint
npm run build        # tsc -b && vite build — also a type check
```

There is no separate Python linter gate in CI; `pytest` is the Python gate.

## Environment variables

Every variable is **optional**. The engine resolves each external tool by
checking its `AIR_*` override first, then `PATH` (see
[`air/tools.py`](../packages/core/src/air/tools.py)). Set an override only when a
binary lives outside `PATH`.

| Variable | Read by | What it configures | What happens when it is missing |
|---|---|---|---|
| `GEMINI_API_KEY` | AI generate/repair commands | Google Gemini provider credential | AI commands with `--provider gemini` fail with a clear "no API key" error. The default `mock` provider and every non-AI feature keep working. Never commit a real key — `.env` is gitignored. |
| `AIR_NGSPICE` | `air/tools.py` → `ngspice_path()` | Absolute path to the `ngspice` binary | `simulate`/`check` fall back to the built-in DC solver and attach an `NGSPICE_NOT_FOUND` info diagnostic ("ngspice not found — install from …"). No traceback; simulation still returns results. |
| `AIR_RENODE` | `air/tools.py` → `renode_path()` | Absolute path to the `renode` binary | Renode-backed co-simulation (`run-renode`, mixed-signal) is unavailable; analog and DC features are unaffected. |
| `AIR_PLATFORMIO` | `air/tools.py` → `platformio_path()` | Absolute path to the `platformio` binary | `build-firmware` is unavailable; design, validation, compile, and analog simulation are unaffected. |
| `AIR_PIO` | `air/tools.py` → `platformio_path()` | Fallback path to the `pio` binary (alias of PlatformIO) | Same as `AIR_PLATFORMIO`; either variable satisfies PlatformIO resolution. |

See [`.env.example`](../.env.example) for a copy-paste starting point.

## Graceful degradation

The engine never crashes because an optional tool is absent — a missing tool
produces an **actionable diagnostic**, not a stack trace:

- **Missing ngspice** — `air simulate design.air.xml` (or `check`) still runs. The
  analog numbers come from the built-in DC solver, the report's `backend` reads
  `builtin_dc_fallback`, and each report carries an `NGSPICE_NOT_FOUND` info
  diagnostic pointing at the install link. Install ngspice or set `AIR_NGSPICE` to
  get real transient simulation.
- **Missing Renode / PlatformIO** — the commands that need them are unavailable;
  nothing else is affected.

To see it yourself with no tools installed:

```bash
air simulate examples/esp32_battery_sensor/design.air.xml --profile analog_only --json
# -> "backend": "builtin_dc_fallback" and an NGSPICE_NOT_FOUND diagnostic
```

The missing-ngspice path is covered by a hermetic regression test
(`tests/test_cli_flow.py::CliFlowTests::test_missing_ngspice_reports_actionable_diagnostic_not_traceback`)
that forces the missing path regardless of the host, so it passes in CI where
ngspice **is** installed.

## CI alignment

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs two required
jobs on every PR:

- **core-py** — Python 3.12, installs ngspice via `apt`, then installs the package
  and test deps and runs the full `pytest` suite. CI installs those deps
  explicitly (`pip install -e . pytest fastapi httpx uvicorn python-dotenv`); the
  `[dev]` extra in `pyproject.toml` mirrors that exact list, so
  `pip install -e ".[dev]"` reproduces the CI environment locally. Keep the two in
  sync when either changes.
- **ui** — Node 22, `npm ci` + `npm run lint` + `npm run build` in `packages/ui`,
  using `packages/ui/package-lock.json` as its cache key. The root `package.json`
  added for convenience scripts does not affect this job.

A third required job, **guardrails**, is documented below.

### Golden corpus workflow

[`.github/workflows/corpus.yml`](../.github/workflows/corpus.yml) guards the frozen
oracle fixtures in `tests/golden_corpus/`. It has two jobs:

- **corpus-check** — runs on every push to `main` / PR that touches the corpus,
  `scripts/export_golden.py`, `packages/core/src/air/**`, or the workflow file. It
  regenerates into a temp dir, diffs byte-exact against the committed corpus, and
  runs the mutation self-test. This is the per-PR reproducibility gate.
- **corpus-generate** — `workflow_dispatch` **only** (issue #54). Regenerates the
  corpus with CI's apt ngspice and uploads it as the `golden-corpus` artifact. It
  ran on every push/PR as a bootstrap crutch while the workflow was not yet on
  `main`; now that it is, restricting it keeps a single live corpus source per PR.

Note that `tests/golden_corpus/README.md` and `ENGINE_VERSIONS` are themselves
exporter output (baked into `export_golden.py`), so never hand-edit anything under
that directory — corpus-check diffs it byte-exact and would fail.

**Oracle-first regeneration recipe.** When an `oracle-first` PR intentionally changes
the oracle and must re-pin the corpus to CI's ngspice, do not regenerate locally;
dispatch the generate job against your pushed branch (`--ref <branch>` works because
the workflow file lives on `main`, while the run checks out and regenerates *your*
branch's code):

```
git push -u origin <your-branch>
gh workflow run corpus.yml --ref <your-branch>
gh run list --workflow corpus.yml --branch <your-branch>   # grab the run id
gh run watch <run-id>
gh run download <run-id> -n golden-corpus -D tests/golden_corpus
python scripts/export_golden.py --check                     # confirm it reproduces, then commit
```

## Guardrails CI (mechanized AGENTS.md)

`AGENTS.md` is prose; prose does not gate merges. The `guardrails` job
(`.github/workflows/guardrails.yml` + `scripts/guardrails.py`) converts every
mechanically checkable rule into a deterministic, diff-aware CI gate. It uses
regex/path logic only -- no AI, no heuristics -- so every failure is
explainable and reproducible.

### Rules enforced

| ID | Rule | Scope |
|----|------|-------|
| R1 | Fixture/port separation (ADR 0009) | A PR touching `tests/golden_corpus/**` AND any port package (`packages/{air-ts,sim-wasm,mpy-wasm,cosim,agent,ui}/**`) fails unless labeled `oracle-first`. |
| R2 | Test-weakening detection | Added lines with `.skip`/`.only`, `xit(`, `xdescribe(`, `test.todo`, `@pytest.mark.skip` without an issue-referencing `reason=`, `continue-on-error: true`, or `\|\| true` fail. |
| R3 | Wall-clock ban | `Date.now`, `performance.now`, `setTimeout`, `setInterval` anywhere under `packages/{mpy-wasm,cosim}/src` (whole-tree) fail. Only `*.progress.ts` files are exempt. |
| R4 | Fixture special-casing | Golden-corpus design names (read from the corpus itself) referenced in product source outside `tests/`, `bench/`, `examples/` fail. Degrades gracefully: when the corpus is absent the check is skipped and passes, activating automatically once the corpus lands. |
| R5 | Secret hygiene | Obvious API-key/secret patterns in any added line fail. The offending value is redacted in the message. |

R1, R2, R5 are **diff-aware** (they inspect the `+` lines / touched paths of the
change). R3 is **whole-tree** (a pre-existing violation is still caught). R4 is
diff-aware for the reference but reads the design-name list from the corpus.

**Exemption model (narrow by construction).** The ONLY exemption anywhere in
the checker: markdown documentation (`*.md`) is exempt from the **R2** token
scan, because markdown is never executed by a test runner or CI -- a banned
token there describes a pattern, it cannot weaken anything. Nothing else is
exempt: workflow files (including `guardrails.yml` itself), the checker's own
source, and every other file are always scanned, and **R5 (secrets) has no
exemption at all** -- a real-shaped secret fires in any file, markdown and
`guardrails.py` included. `scripts/guardrails.py` keeps itself scannable by
construction: its regexes use escape sequences (which never match their own
source text), its self-test fixtures are concatenation-split, and its comments
paraphrase tokens instead of spelling them. If a guardrails run flags a line
you are adding to the checker, write the token in split/paraphrased form --
do not add an exemption.

**Closed hole (PR #52 rework round 1, disclosed).** An earlier revision
exempted the four guardrails definition files from the R2/R5 line-token scans
wholesale (`SELF_DEFINITION_PATHS`). The independent verifier proved this was
an exploitable neutering vector, not just a false-positive tradeoff: a diff
adding `continue-on-error: true` or an OR-true suffix to
`.github/workflows/guardrails.yml` -- which makes the guardrails job report
success even when the checker exits 1 -- passed the scan (attacks A and B), and
a real-shaped secret in `scripts/guardrails.py` also passed (attack C). The
one file whose weakening disables all enforcement was the one file the scan
skipped. The blanket exemption was removed; all three attacks are now
permanent self-tests that must FAIL the checker, and CI-weakening tokens fire
in every workflow file with no exception.

### Running the checker locally

```
# Self-tests (one violating + one clean synthetic diff per rule, the override
# path, corpus present/absent states, and the three PR #52 attack reproducers
# that must always FAIL the checker):
python scripts/guardrails.py --self-test

# Check your current branch against main:
git diff --no-color $(git merge-base HEAD main) HEAD > /tmp/pr.diff
python scripts/guardrails.py --diff-file /tmp/pr.diff \
    --label oracle-first          # (optional) simulate PR labels \
    --tree-root .
```

The self-test is wired into the workflow and runs **first**: if the checker
itself is broken (a regex typo), the guardrails job fails before it can
false-pass a real change.

### Override mechanism

False positives will happen. The correct response is to refine the check or use
the **visible** override -- never to delete the check or add an inline
suppression comment (there is no inline suppression syntax).

To override:

1. Add the `guardrails-override` label to the PR.
2. Add a `## Guardrails override` section to the PR description stating which
   check fired and why the exception is justified (reference an issue).

The job then passes but prints the justification into its job summary, so the
exception is visible at PR level. Both a `oracle-first` (for R1) and the general
`guardrails-override` path are human checkpoints (see ORCHESTRATION.md).

## Branch protection (`main`)

Branch protection makes the foundation CI jobs required before any PR can merge.
It is configured with `scripts/setup_branch_protection.ps1`.

**Timing (ORCHESTRATION.md amendment 2026-07-03):** enabling required checks
before those checks exist and are green on `main` would jam every PR, so
enablement is **deferred to the M0 gate ceremony**. Until then, the script is
run only in dry-run mode to show exactly what it will do.

### Intended settings

- Required status checks (strict / up-to-date): `guardrails`, `core-py`, `ui`,
  `parity`.
- Force-pushes to `main`: **disabled**.
- Branch deletion: **disabled**.
- Linear history: **required**.
- Enforce on admins: **yes**.
- Pull request required before merging, with **0 required approving reviews**
  (orchestrator amendment, issue #42 rework round 1): this repository operates
  single-account, so a formal GitHub review can never come from an independent
  account -- requiring one would only institutionalize self-approval.
  Independent verification instead happens through orchestrated verifier
  agents posting verdicts as PR comments (see ORCHESTRATION.md); merge
  protection = required status checks + no force-push + orchestration
  discipline. Stale-review dismissal stays on so any review that IS posted is
  invalidated by new pushes.
- Conversation resolution: **required**.

### Dry-run (before M0)

```powershell
# From the repo root, with gh authenticated:
./scripts/setup_branch_protection.ps1 -DryRun
```

This prints the exact `gh api` PUT call, the full JSON payload, and the
read-back command -- and makes no changes.

### Applying for real (M0 gate, maintainer only)

```powershell
./scripts/setup_branch_protection.ps1
```

This applies the protection and immediately reads the settings back for
verification. Run once by the maintainer at the M0 gate ceremony.
