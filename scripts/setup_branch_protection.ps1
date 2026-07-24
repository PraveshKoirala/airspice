<#
.SYNOPSIS
    Configure GitHub branch protection on `main` for AirSpice (issue #42, deliverable 4).

.DESCRIPTION
    Requires the foundation CI jobs as status checks on `main`, forbids force-pushes
    and deletions, and requires a pull request before merging with ZERO required
    approving reviews: this repository operates single-account, so a formal GitHub
    review can never come from an independent account -- requiring one would only
    institutionalize self-approval. Independent verification happens via
    orchestrated verifier agents posting verdicts as PR comments (ORCHESTRATION.md);
    protection = required status checks + no force-push + orchestration discipline.

    IMPORTANT (ORCHESTRATION.md amendment 2026-07-03): enabling required checks
    before those checks exist and are green on `main` would jam every PR. This
    script is therefore delivered fully working but is EXECUTED FOR REAL only at
    the M0 gate ceremony by the maintainer/orchestrator. Until then, run it with
    -DryRun to print the exact `gh api` calls and intended settings.

    Requires: gh CLI authenticated with a token that has `repo` + admin rights on
    the repository. `gh` must be on PATH (or invoke this script from a shell where
    it is).

.PARAMETER Repo
    owner/name of the repository. Default: PraveshKoirala/airspice.

.PARAMETER Branch
    Branch to protect. Default: main.

.PARAMETER Checks
    Required status check contexts. These must match the CHECK-RUN NAMES exactly
    as GitHub reports them (the job's `name:`, including any parenthetical), not
    the bare job ids -- GitHub matches required contexts by exact string
    (issue #69, M0 gate audit). Default: guardrails, core-py (pytest + ngspice),
    ui (lint + build). Future checks (e.g. parity, #15/M2) are ADDED HERE ONLY
    WHEN THEIR JOBS EXIST AND ARE GREEN ON MAIN -- a required context that never
    reports blocks every PR.

.PARAMETER DryRun
    Print the exact gh api command and the JSON payload WITHOUT calling GitHub.
    Nothing is changed. This is the mode used before the M0 gate.

.PARAMETER ReadBack
    After applying (or, with -DryRun, instead of applying) print the command that
    reads the current protection settings back so they can be verified.

.EXAMPLE
    ./setup_branch_protection.ps1 -DryRun
    Prints the API call and payload; makes no changes.

.EXAMPLE
    ./setup_branch_protection.ps1
    Applies protection for real (M0 gate only).
#>

[CmdletBinding()]
param(
    [string]   $Repo    = "PraveshKoirala/airspice",
    [string]   $Branch  = "main",
    # Exact check-run names as reported by the check-runs API (issue #69):
    # the ci.yml jobs carry display names, and GitHub matches required contexts
    # by exact string -- bare "core-py"/"ui" would never be satisfied and would
    # jam every PR. Future checks (parity, #15/M2; others) get appended when
    # their jobs exist and are green on main, never before.
    [string[]] $Checks  = @(
        "guardrails",
        "core-py (pytest + ngspice)",
        "ui (lint + build)"
    ),
    [switch]   $DryRun,
    [switch]   $ReadBack
)

$ErrorActionPreference = "Stop"

# --- Locate gh --------------------------------------------------------------
$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $fallback = "C:\Program Files\GitHub CLI\gh.exe"
    if (Test-Path $fallback) { $gh = $fallback }
}
if (-not $gh) {
    Write-Error "gh CLI not found on PATH. Install it or add it to PATH, then re-run."
    exit 1
}

# --- Build the protection payload ------------------------------------------
# Contexts required to be green before a PR can merge into $Branch.
$requiredContexts = @($Checks)

# Payload for: PUT /repos/{owner}/{repo}/branches/{branch}/protection
# See https://docs.github.com/rest/branches/branch-protection
$payload = [ordered]@{
    required_status_checks = [ordered]@{
        strict   = $true                # branches must be up to date before merging
        contexts = $requiredContexts    # the job names that must pass
    }
    enforce_admins = $true              # admins are not exempt
    required_pull_request_reviews = [ordered]@{
        dismiss_stale_reviews           = $true   # new pushes invalidate old approvals
        require_code_owner_reviews      = $false
        required_approving_review_count = 0
        # 0, NOT 1 (orchestrator amendment, issue #42 rework round 1): this
        # repository operates single-account, so a formal GitHub approving review
        # can never come from an independent account -- requiring one would only
        # institutionalize self-approval. Independent verification happens via
        # orchestrated verifier agents posting verdicts as PR comments
        # (ORCHESTRATION.md protocol). Keeping this block non-null still REQUIRES
        # a pull request before merging (no direct pushes to main); protection =
        # required status checks + no force-push + orchestration discipline.
    }
    restrictions            = $null      # no push allow-list; open to the org
    required_linear_history = $true      # no merge commits sneaking history around
    allow_force_pushes      = $false     # forbid force-push to main
    allow_deletions         = $false     # forbid deleting main
    required_conversation_resolution = $true
    lock_branch             = $false
    allow_fork_syncing      = $true
}

$payloadJson = $payload | ConvertTo-Json -Depth 6

$apiPath = "repos/$Repo/branches/$Branch/protection"

# The exact gh api call that applies the protection. The REST branch-protection
# endpoint requires the preview accept header on some plans; include it.
$applyArgsDisplay = @(
    "api",
    "--method", "PUT",
    "-H", "Accept: application/vnd.github+json",
    "/$apiPath",
    "--input", "-"
) -join " "

$readbackArgsDisplay = @(
    "api",
    "-H", "Accept: application/vnd.github+json",
    "/$apiPath"
) -join " "

function Show-Intent {
    Write-Host "======================================================================"
    Write-Host "AirSpice branch protection - intended settings"
    Write-Host "======================================================================"
    Write-Host "Repo   : $Repo"
    Write-Host "Branch : $Branch"
    Write-Host "Required status checks (must be green, strict/up-to-date):"
    foreach ($c in $requiredContexts) { Write-Host "  - $c" }
    Write-Host "Force pushes to '$Branch'   : DISABLED"
    Write-Host "Branch deletion             : DISABLED"
    Write-Host "Linear history required     : YES"
    Write-Host "Enforce on admins           : YES"
    Write-Host "Required approving reviews  : 0 (single-account repo; independent"
    Write-Host "                              verification = orchestrated verifier"
    Write-Host "                              agents posting PR comments; PR still"
    Write-Host "                              required before merge)"
    Write-Host "Conversation resolution     : REQUIRED"
    Write-Host "----------------------------------------------------------------------"
    Write-Host "Exact gh api call:"
    Write-Host "  gh $applyArgsDisplay"
    Write-Host "  (payload piped on stdin)"
    Write-Host ""
    Write-Host "Payload JSON:"
    Write-Host $payloadJson
    Write-Host "----------------------------------------------------------------------"
    Write-Host "Read-back (verify) call:"
    Write-Host "  gh $readbackArgsDisplay"
    Write-Host "======================================================================"
}

if ($DryRun) {
    Show-Intent
    Write-Host ""
    Write-Host "DRY RUN: no changes made. Re-run without -DryRun at the M0 gate to apply."
    exit 0
}

# --- Apply for real (M0 gate only) -----------------------------------------
Show-Intent
Write-Host ""
Write-Host "Applying branch protection for real..."
# PS 5.1's pipeline mangles the payload's encoding when piped to `gh ... --input -`
# (gh sees invalid bytes and GitHub returns HTTP 400 "Problems parsing JSON").
# Write the payload to a BOM-free UTF-8 temp file and pass it as a real file path.
# Out-File/Set-Content are avoided deliberately: under PS 5.1 they add a UTF-8 BOM
# and/or CRLF, which is exactly the corruption we are fixing.
$tmp = [IO.Path]::GetTempFileName()
try {
    # Normalize CRLF -> LF for the wire body (whitespace only; the JSON settings are
    # unchanged, and the -DryRun printout still uses the original $payloadJson).
    $payloadJsonBody = $payloadJson -replace "`r", ""
    [IO.File]::WriteAllText($tmp, $payloadJsonBody, (New-Object System.Text.UTF8Encoding($false)))
    & $gh api --method PUT -H "Accept: application/vnd.github+json" "/$apiPath" --input $tmp
    if ($LASTEXITCODE -ne 0) {
        Write-Error "gh api call failed with exit code $LASTEXITCODE."
        exit $LASTEXITCODE
    }
}
finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
Write-Host "Applied. Reading back current protection settings:"
& $gh api -H "Accept: application/vnd.github+json" "/$apiPath"

if ($ReadBack) {
    Write-Host "Read-back complete (see JSON above)."
}
