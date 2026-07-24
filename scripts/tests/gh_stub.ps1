<#
.SYNOPSIS
    Hermetic stub for the `gh` CLI, used by setup_branch_protection.Tests.ps1.

.DESCRIPTION
    The branch-protection test copies this file onto a temp directory named
    `gh.ps1`, prepends that directory to PATH, and drives
    scripts/setup_branch_protection.ps1 in REAL-APPLY mode. The product script
    resolves `gh` via `Get-Command gh` and then invokes `& $gh api ...`, so this
    stub stands in for the real GitHub CLI -- NO network call ever happens.

    Behaviour on every invocation:
      1. Records the FULL argument list (as a compact JSON array, one line per
         invocation) to the file named by $env:GH_STUB_ARGV_LOG. The test parses
         this to prove the script passed `--input <file>` and not `--input -`.
      2. If `--input <path>` is present and <path> is a real file (not `-`),
         copies that file's RAW BYTES verbatim to $env:GH_STUB_PAYLOAD_CAPTURE.
         Raw copy preserves BOM/CR exactly so the test can inspect encoding.
      3. Exits 0 so the product script's `$LASTEXITCODE` check passes and it
         proceeds (e.g. to the read-back call).

    Config is passed via environment variables (inherited by child processes):
      GH_STUB_ARGV_LOG        - append-only log of argv, one JSON array per line
      GH_STUB_PAYLOAD_CAPTURE - destination for the raw bytes of the --input file
#>

# --- Resolve capture paths (env-driven; fall back next to this stub) ----------
$argvLog = $env:GH_STUB_ARGV_LOG
if ([string]::IsNullOrEmpty($argvLog)) {
    $argvLog = Join-Path $PSScriptRoot 'gh_stub_argv.log'
}
$payloadCapture = $env:GH_STUB_PAYLOAD_CAPTURE
if ([string]::IsNullOrEmpty($payloadCapture)) {
    $payloadCapture = Join-Path $PSScriptRoot 'gh_stub_payload.bin'
}

# --- 1. Record the full argument list (JSON array, one line per invocation) ---
$argvArray = @($args)
$argvJson  = ConvertTo-Json -InputObject $argvArray -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::AppendAllText($argvLog, $argvJson + "`n", $utf8NoBom)

# --- 2. If --input <path> is a real file (not stdin '-'), capture its bytes ---
for ($i = 0; $i -lt $argvArray.Count; $i++) {
    if ($argvArray[$i] -eq '--input') {
        $inputPath = $null
        if (($i + 1) -lt $argvArray.Count) { $inputPath = $argvArray[$i + 1] }
        if ($inputPath -and $inputPath -ne '-' -and (Test-Path -LiteralPath $inputPath -PathType Leaf)) {
            [System.IO.File]::Copy($inputPath, $payloadCapture, $true)
        }
    }
}

# --- 3. Succeed so the product script proceeds --------------------------------
exit 0
