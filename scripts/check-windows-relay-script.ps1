$ErrorActionPreference = 'Stop'

$scriptPath = Join-Path $PSScriptRoot 'start-windows-relay.ps1'
$text = Get-Content -LiteralPath $scriptPath -Raw

if ($text -match '&\s+\$script:NpmCmd\b') {
  throw 'start-windows-relay.ps1 must call npm through Invoke-Npm, not directly through $script:NpmCmd.'
}

if ($text -notmatch 'function Resolve-NpmCmd') {
  throw 'start-windows-relay.ps1 must normalize npm to npm.cmd before invoking it.'
}

if ($text -notmatch 'Get-Command npm\.cmd') {
  throw 'start-windows-relay.ps1 must resolve npm.cmd instead of relying on the npm PowerShell shim.'
}

if ($text -notmatch 'npm\.ps1 cannot be used here') {
  throw 'start-windows-relay.ps1 must reject npm.ps1 so npm does not mis-parse variable-based calls.'
}

if ($text -notmatch 'desktop-env\.local\.ps1') {
  throw 'start-windows-relay.ps1 must load desktop-env.local.ps1 for local, uncommitted configuration.'
}

if ($text -notmatch 'function Watch-CodexMiniRelay') {
  throw 'start-windows-relay.ps1 must run as a supervisor instead of a one-shot npm start wrapper.'
}

if ($text -notmatch '/codex/relay-status') {
  throw 'start-windows-relay.ps1 must monitor the local /codex/relay-status endpoint.'
}

if ($text -notmatch 'function Start-CodexMiniProcess') {
  throw 'start-windows-relay.ps1 must start node server.js under supervisor control.'
}

if ($text -notmatch 'MOBILE_TYPER_TOKEN') {
  throw 'start-windows-relay.ps1 must set MOBILE_TYPER_TOKEN so relay-status checks can authenticate.'
}

if ($text -notmatch 'ManagedCodexProcess') {
  throw 'start-windows-relay.ps1 must clean up the supervised node process on script exit.'
}

if ($text -notmatch 'codex-stopped') {
  throw 'start-windows-relay.ps1 must treat codex-stopped as a paused relay state instead of restarting the local service.'
}

$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref] $tokens, [ref] $parseErrors) | Out-Null
if ($parseErrors.Count -gt 0) {
  $messages = $parseErrors | ForEach-Object { "$($_.Extent.StartLineNumber):$($_.Extent.StartColumnNumber) $($_.Message)" }
  throw "PowerShell parse failed: $($messages -join '; ')"
}
