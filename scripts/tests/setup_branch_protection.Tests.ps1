<#
.SYNOPSIS
    Hermetic test for scripts/setup_branch_protection.ps1 (issue #72).

.DESCRIPTION
    Verifies that the REAL-APPLY path hands the JSON payload to `gh` as a
    BOM-free UTF-8 FILE via `--input <file>` -- NOT piped on stdin via
    `--input -`, which PowerShell 5.1 mangles (gh -> HTTP 400 "Problems parsing
    JSON").

    Fully hermetic: NO GitHub call happens. A stub `gh` (scripts/tests/gh_stub.ps1,
    copied onto PATH as `gh.ps1`) records its argv and copies the raw bytes of any
    `--input <file>` payload for inspection.

    Pester available here is only 3.4.0 (a deprecated framework), so this is a
    plain-assert runnable script: it prints [PASS]/[FAIL] per assertion and exits
    non-zero if any assertion fails. Run it directly:

        powershell -NoProfile -ExecutionPolicy Bypass -File `
            scripts/tests/setup_branch_protection.Tests.ps1

    Assertions (driven against the REAL-APPLY path with a stub gh):
      1. The script passed `--input <a real file path>` (NOT `--input -`).
      2. The payload file's bytes are valid JSON, UTF-8 with NO BOM
         (first 3 bytes are not EF BB BF), and contain no CR (0x0D).
      3. The payload parses to the SAME protection settings as the script's
         `-DryRun` output (content unchanged by the transport fix).
    Control:
      - With `-DryRun`, the stub gh is invoked ZERO times (no API call).

    EXPECTED on the CURRENT (unfixed) script: RED. The current apply path pipes
    on stdin with `--input -`, so Assertion 1 fails (observed value is `-`) and
    Assertion 2 fails (no payload file is ever written/captured).
#>

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Assertion harness
# ---------------------------------------------------------------------------
$script:Failures = New-Object System.Collections.ArrayList
$script:PassCount = 0

function Assert-That {
    param(
        [bool]   $Condition,
        [string] $Name,
        [string] $Detail = ''
    )
    if ($Condition) {
        $script:PassCount++
        Write-Host "[PASS] $Name"
    } else {
        [void]$script:Failures.Add($Name)
        Write-Host "[FAIL] $Name"
        if ($Detail) { Write-Host "       $Detail" }
    }
}

# ---------------------------------------------------------------------------
# Locate product script + committed stub
# ---------------------------------------------------------------------------
$here       = Split-Path -Parent $MyInvocation.MyCommand.Path
$product    = (Resolve-Path (Join-Path $here '..\setup_branch_protection.ps1')).Path
$stubSource = Join-Path $here 'gh_stub.ps1'
if (-not (Test-Path -LiteralPath $stubSource)) {
    Write-Host "[FAIL] cannot find stub at $stubSource"
    exit 2
}

# ---------------------------------------------------------------------------
# Build a temp workspace: <work>/bin/gh.ps1 is our stub on PATH
# ---------------------------------------------------------------------------
$work    = Join-Path $env:TEMP ('bp_test_' + [guid]::NewGuid().ToString('N'))
$stubDir = Join-Path $work 'bin'
New-Item -ItemType Directory -Path $stubDir -Force | Out-Null
Copy-Item -LiteralPath $stubSource -Destination (Join-Path $stubDir 'gh.ps1') -Force

$argvLog = Join-Path $work 'argv.log'
$capture = Join-Path $work 'captured_payload.bin'

$origPath      = $env:PATH
$origArgvLog   = $env:GH_STUB_ARGV_LOG
$origCapture   = $env:GH_STUB_PAYLOAD_CAPTURE

function Reset-Captures {
    if (Test-Path -LiteralPath $argvLog) { Remove-Item -LiteralPath $argvLog -Force }
    if (Test-Path -LiteralPath $capture) { Remove-Item -LiteralPath $capture -Force }
}

function Invoke-Product {
    # Run the product script as an isolated child powershell so its `exit`,
    # $ErrorActionPreference=Stop and PATH resolution behave exactly as in real
    # use. The child inherits our modified PATH + GH_STUB_* env vars.
    param([string[]] $ScriptArgs = @())
    $psExe   = (Get-Command powershell.exe).Source
    $allArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $product) + $ScriptArgs
    $output  = & $psExe @allArgs 2>&1 | Out-String
    return [pscustomobject]@{ Output = $output; Exit = $LASTEXITCODE }
}

function Get-ArgvLogLines {
    # One non-blank line per stub invocation (compact JSON array of argv).
    if (Test-Path -LiteralPath $argvLog) {
        return @(Get-Content -LiteralPath $argvLog | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    }
    return @()
}

function Get-DryRunPayloadJson {
    # Extract the JSON block Show-Intent prints between "Payload JSON:" and the
    # following separator line of dashes.
    param([string] $Text)
    $lines = $Text -split "`r?`n"
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i].Trim() -eq 'Payload JSON:') { $start = $i + 1; break }
    }
    if ($start -lt 0) { return $null }
    $buf = New-Object System.Collections.ArrayList
    for ($i = $start; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*-{10,}\s*$') { break }
        [void]$buf.Add($lines[$i])
    }
    return ($buf.ToArray() -join "`n")
}

try {
    # Inject the stub: prepend its dir to PATH so `Get-Command gh` resolves to it.
    $env:PATH                    = $stubDir + ';' + $origPath
    $env:GH_STUB_ARGV_LOG        = $argvLog
    $env:GH_STUB_PAYLOAD_CAPTURE = $capture

    Write-Host "=========================================================="
    Write-Host "Hermetic test: setup_branch_protection.ps1 (issue #72)"
    Write-Host "Product : $product"
    Write-Host "Stub gh : $(Join-Path $stubDir 'gh.ps1')  (prepended to PATH)"
    Write-Host "=========================================================="

    # -----------------------------------------------------------------------
    # CONTROL: -DryRun must make ZERO gh calls, and gives us the reference
    #          payload to compare against.
    # -----------------------------------------------------------------------
    Reset-Captures
    $dry = Invoke-Product -ScriptArgs @('-DryRun')

    Assert-That ($dry.Exit -eq 0) 'Control: -DryRun exits 0' "exit code was $($dry.Exit)"

    $dryCalls = @(Get-ArgvLogLines)
    Assert-That ($dryCalls.Count -eq 0) `
        'Control: -DryRun invokes the gh stub ZERO times' `
        "stub recorded $($dryCalls.Count) invocation(s)"

    $refJson = Get-DryRunPayloadJson -Text $dry.Output
    $refObj  = $null
    if ($refJson) { try { $refObj = $refJson | ConvertFrom-Json } catch { $refObj = $null } }
    Assert-That ($refObj -ne $null) `
        'Reference: -DryRun payload JSON extracted and parsed' `
        'could not locate/parse the payload block in -DryRun output'

    # -----------------------------------------------------------------------
    # REAL-APPLY: drives the actual apply path against the stub gh.
    # -----------------------------------------------------------------------
    Reset-Captures
    $apply = Invoke-Product -ScriptArgs @()   # no -DryRun => real apply

    $applyLines = @(Get-ArgvLogLines)
    Assert-That ($applyLines.Count -ge 1) `
        'Real-apply: gh stub was invoked (apply path reached gh)' `
        "stub recorded $($applyLines.Count) invocation(s); child exit $($apply.Exit)"

    # Find the invocation carrying --input and grab the value that follows it.
    $inputArg = $null
    $sawInput = $false
    foreach ($line in $applyLines) {
        $parsed = $line | ConvertFrom-Json
        $c = @($parsed)
        for ($i = 0; $i -lt $c.Count; $i++) {
            if ($c[$i] -eq '--input') {
                $sawInput = $true
                if (($i + 1) -lt $c.Count) { $inputArg = [string]$c[$i + 1] } else { $inputArg = '' }
            }
        }
    }

    # ---- Assertion 1: --input <real file path>, NOT --input - --------------
    $a1 = ($null -ne $inputArg) -and ($inputArg -ne '-') -and ($inputArg.Trim() -ne '')
    Assert-That $a1 `
        'Assertion 1: script passed --input <a real file path> (NOT --input -)' `
        "observed --input value: '$inputArg'"

    # ---- Assertion 2: payload file bytes = valid JSON, UTF-8 no BOM, no CR --
    $captureExists = Test-Path -LiteralPath $capture
    $bytes   = $null
    $noBom   = $false
    $noCr    = $false
    $isJson  = $false
    $capObj  = $null
    if ($captureExists) {
        $bytes  = [System.IO.File]::ReadAllBytes($capture)
        $noBom  = -not ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
        $noCr   = -not ($bytes -contains [byte]0x0D)
        try {
            $txt    = New-Object System.Text.UTF8Encoding($false)
            $decoded = $txt.GetString($bytes)
            $capObj = $decoded | ConvertFrom-Json
            $isJson = $true
        } catch { $isJson = $false }
    }

    Assert-That $captureExists `
        'Assertion 2a: a real payload FILE was written and captured' `
        "no --input file was captured (capture path: $capture)"
    Assert-That $noBom `
        'Assertion 2b: payload is UTF-8 with NO BOM (first 3 bytes != EF BB BF)' `
        $(if ($captureExists) { "first bytes: $((($bytes | Select-Object -First 3) | ForEach-Object { $_.ToString('X2') }) -join ' ')" } else { 'no file captured' })
    Assert-That $noCr `
        'Assertion 2c: payload contains no CR (0x0D) mangling' `
        $(if ($captureExists) { 'CR byte present' } else { 'no file captured' })
    Assert-That $isJson `
        'Assertion 2d: payload bytes parse as valid JSON' `
        $(if ($captureExists) { 'ConvertFrom-Json failed' } else { 'no file captured' })

    # ---- Assertion 3: captured payload == -DryRun payload settings ---------
    $a3 = $false
    $detail3 = 'prerequisite parse(s) failed'
    if ($isJson -and $null -ne $capObj -and $null -ne $refObj) {
        $refNorm = $refObj | ConvertTo-Json -Depth 12 -Compress
        $capNorm = $capObj | ConvertTo-Json -Depth 12 -Compress
        $a3 = ($refNorm -eq $capNorm)
        if (-not $a3) { $detail3 = "dryrun=$refNorm`n       apply =$capNorm" }
    }
    Assert-That $a3 `
        'Assertion 3: captured payload settings == -DryRun payload (content unchanged)' `
        $detail3
}
finally {
    # Restore environment and clean up the temp workspace.
    $env:PATH = $origPath
    if ($null -eq $origArgvLog) { Remove-Item Env:\GH_STUB_ARGV_LOG -ErrorAction SilentlyContinue } else { $env:GH_STUB_ARGV_LOG = $origArgvLog }
    if ($null -eq $origCapture) { Remove-Item Env:\GH_STUB_PAYLOAD_CAPTURE -ErrorAction SilentlyContinue } else { $env:GH_STUB_PAYLOAD_CAPTURE = $origCapture }
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "----------------------------------------------------------"
if ($script:Failures.Count -gt 0) {
    Write-Host ("RESULT: FAILED -- {0} of {1} assertion(s) failed:" -f $script:Failures.Count, ($script:Failures.Count + $script:PassCount))
    foreach ($f in $script:Failures) { Write-Host "  - $f" }
    exit 1
} else {
    Write-Host ("RESULT: PASSED -- all {0} assertions passed." -f $script:PassCount)
    exit 0
}
