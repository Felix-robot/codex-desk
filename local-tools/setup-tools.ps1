param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:USERPROFILE '.codex-desk\tools'
$venvDir = Join-Path $dataDir 'python'
$pythonExe = Join-Path $venvDir 'Scripts\python.exe'
if (-not $CheckOnly) {
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        $systemPython = (Get-Command python.exe -ErrorAction Stop).Source
        & $systemPython -m venv $venvDir
        if ($LASTEXITCODE -ne 0) { throw 'Could not create the independent Python environment.' }
    }
    & $pythonExe -m pip install -r (Join-Path $PSScriptRoot 'requirements-tools.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Tool dependency installation failed.' }
    Copy-Item -LiteralPath $pythonExe -Destination (Join-Path $venvDir 'Scripts\python3.exe') -Force
    $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1'
    & npm.cmd install --prefix (Join-Path $dataDir 'browser') --no-audit --no-fund --ignore-scripts playwright@1.58.2
    if ($LASTEXITCODE -ne 0) { throw 'Browser driver installation failed.' }
}
& $pythonExe -m pip check
if ($LASTEXITCODE -ne 0) { throw 'Tool dependency check failed.' }
& $pythonExe (Join-Path $PSScriptRoot 'tools\check-python.py') (Join-Path $dataDir 'checks\python-tools')
if ($LASTEXITCODE -ne 0) { throw 'Tool execution check failed.' }
