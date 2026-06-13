$ErrorActionPreference = 'Stop'

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $ProjectDir

$DefaultPublicBase = 'https://114.55.235.80/codex'
$RegistrationKeyPlaceholder = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'
$DefaultRegistrationKey = '__CODEX_MINI_RELAY_REGISTRATION_KEY__'
$PublicBase = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_PUBLIC_BASE)) { $DefaultPublicBase } else { $env:CODEX_MINI_RELAY_PUBLIC_BASE }
$PublicBase = $PublicBase.TrimEnd('/')
$RegistrationKey = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_REGISTRATION_KEY)) { $DefaultRegistrationKey } else { $env:CODEX_MINI_RELAY_REGISTRATION_KEY }
if ($RegistrationKey -eq $RegistrationKeyPlaceholder) {
  throw 'CODEX_MINI_RELAY_REGISTRATION_KEY is not configured. Use the packaged zip or set the environment variable.'
}
$RelayUrl = if ([string]::IsNullOrWhiteSpace($env:CODEX_MINI_RELAY_URL)) {
  ($PublicBase -replace '^https:', 'wss:' -replace '^http:', 'ws:') + '/tunnel'
} else {
  $env:CODEX_MINI_RELAY_URL
}

$StateRoot = if ([string]::IsNullOrWhiteSpace($env:APPDATA)) {
  Join-Path $ProjectDir '.codex-mini-state'
} else {
  Join-Path $env:APPDATA 'CodexMini'
}
$DeviceConfigPath = Join-Path $StateRoot 'relay-device.json'
$RuntimeRoot = Join-Path $ProjectDir '.runtime'
$NodeRoot = Join-Path $RuntimeRoot 'node'
$script:NodeExe = ''
$script:NpmCmd = ''

function ConvertTo-Base64Url([byte[]] $Bytes) {
  return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function New-RandomToken([int] $Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return ConvertTo-Base64Url $buffer
}

function Get-Sha256Hex([string] $Text) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    $hash = $sha.ComputeHash($bytes)
    return -join ($hash | ForEach-Object { $_.ToString('x2') })
  } finally {
    $sha.Dispose()
  }
}

function Get-MachineSeed {
  $machineGuid = ''
  try {
    $machineGuid = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid
  } catch {
    $machineGuid = ''
  }
  return @(
    $env:COMPUTERNAME,
    $env:USERDOMAIN,
    $env:USERNAME,
    $machineGuid
  ) -join '|'
}

function Get-SafeName([string] $Value, [string] $Fallback) {
  $safe = ($Value -replace '[^a-zA-Z0-9._-]+', '-').Trim('-')
  if ([string]::IsNullOrWhiteSpace($safe)) { return $Fallback }
  if ($safe.Length -gt 40) { return $safe.Substring(0, 40).Trim('-') }
  return $safe
}

function New-DeviceConfig {
  $installId = New-RandomToken 16
  $machineHash = (Get-Sha256Hex ((Get-MachineSeed) + '|' + $installId)).Substring(0, 12)
  $hostPart = Get-SafeName $env:COMPUTERNAME 'windows'
  return [ordered]@{
    publicBase = $PublicBase
    relayUrl = $RelayUrl
    deviceId = "codex-$hostPart-$machineHash".ToLowerInvariant()
    name = "Codex $hostPart"
    relaySecret = New-RandomToken 32
    passphrase = New-RandomToken 18
    fingerprint = $machineHash
    installId = $installId
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
  }
}

function Register-Device($Config) {
  Write-Host ''
  Write-Host 'First start on this computer. A new relay device approval request will be sent.'
  Write-Host "Relay: $PublicBase"
  Write-Host "Device: $($Config.deviceId)"
  Write-Host ''

  $body = @{
    registrationKey = $RegistrationKey
    deviceId = $Config.deviceId
    name = $Config.name
    relaySecret = $Config.relaySecret
    passphrase = $Config.passphrase
    fingerprint = $Config.fingerprint
  } | ConvertTo-Json -Depth 4

  $registerUrl = "$PublicBase/device/register"
  Invoke-RestMethod -Method Post -Uri $registerUrl -ContentType 'application/json' -Body $body -TimeoutSec 30 | Out-Null
  $Config.registeredAt = (Get-Date).ToUniversalTime().ToString('o')
  $Config.approvedAtFirstStart = $false
  Write-Host 'Device request submitted. Waiting for relay authorization.'
}

function Load-Or-CreateDeviceConfig {
  if (Test-Path -LiteralPath $DeviceConfigPath) {
    return Get-Content -LiteralPath $DeviceConfigPath -Raw | ConvertFrom-Json
  }

  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  $config = New-DeviceConfig
  Register-Device $config
  $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $DeviceConfigPath -Encoding UTF8
  return Get-Content -LiteralPath $DeviceConfigPath -Raw | ConvertFrom-Json
}

function Set-NodeCommands([string] $NodePath, [string] $NpmPath) {
  $script:NodeExe = $NodePath
  $script:NpmCmd = $NpmPath
  $nodeDir = Split-Path -Parent $NodePath
  if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
  }
}

function Get-PortableNodeArch {
  $arch = "$env:PROCESSOR_ARCHITEW6432 $env:PROCESSOR_ARCHITECTURE"
  if ($arch -match 'ARM64') { return 'win-arm64' }
  return 'win-x64'
}

function Install-PortableNode {
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  $arch = Get-PortableNodeArch
  $baseUrl = 'https://nodejs.org/dist/latest-v24.x'
  $sumsUrl = "$baseUrl/SHASUMS256.txt"

  Write-Host ''
  Write-Host 'Node.js was not found. Downloading portable Node.js into this folder...'
  Write-Host "Architecture: $arch"

  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -TimeoutSec 60).Content
  $zipName = $null
  $expectedHash = $null
  foreach ($line in ($sums -split "`n")) {
    if ($line -match "^([a-fA-F0-9]{64})\s+(node-v[0-9]+\.[0-9]+\.[0-9]+-$arch\.zip)") {
      $expectedHash = $Matches[1].ToLowerInvariant()
      $zipName = $Matches[2]
      break
    }
  }
  if ([string]::IsNullOrWhiteSpace($zipName)) {
    throw "Could not find a Node.js Windows zip for $arch."
  }

  $zipUrl = "$baseUrl/$zipName"
  $zipPath = Join-Path $RuntimeRoot $zipName
  $expandedName = [IO.Path]::GetFileNameWithoutExtension($zipName)
  $expandedPath = Join-Path $RuntimeRoot $expandedName

  Write-Host "Downloading $zipName..."
  Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zipPath -TimeoutSec 180
  $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $zipPath -Force
    throw 'Downloaded Node.js zip failed SHA256 verification.'
  }

  if (Test-Path -LiteralPath $expandedPath) {
    Remove-Item -LiteralPath $expandedPath -Recurse -Force
  }
  if (Test-Path -LiteralPath $NodeRoot) {
    Remove-Item -LiteralPath $NodeRoot -Recurse -Force
  }
  Expand-Archive -LiteralPath $zipPath -DestinationPath $RuntimeRoot -Force
  Move-Item -LiteralPath $expandedPath -Destination $NodeRoot

  $nodePath = Join-Path $NodeRoot 'node.exe'
  $npmPath = Join-Path $NodeRoot 'npm.cmd'
  if (!(Test-Path -LiteralPath $nodePath) -or !(Test-Path -LiteralPath $npmPath)) {
    throw 'Portable Node.js download did not contain node.exe and npm.cmd.'
  }
  Set-NodeCommands $nodePath $npmPath
}

function Ensure-NodeRuntime {
  $portableNode = Join-Path $NodeRoot 'node.exe'
  $portableNpm = Join-Path $NodeRoot 'npm.cmd'
  if ((Test-Path -LiteralPath $portableNode) -and (Test-Path -LiteralPath $portableNpm)) {
    Set-NodeCommands $portableNode $portableNpm
    return
  }

  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  $systemNpm = Get-Command npm -ErrorAction SilentlyContinue
  if ($systemNode -and $systemNpm) {
    Set-NodeCommands $systemNode.Source $systemNpm.Source
    return
  }

  Install-PortableNode
}

function Ensure-NodeDependencies {
  $missing = @()
  foreach ($module in @('node_modules\ws', 'node_modules\qrcode')) {
    if (!(Test-Path -LiteralPath (Join-Path $ProjectDir $module))) {
      $missing += $module
    }
  }
  if ($missing.Count -eq 0) { return }
  Write-Host ''
  Write-Host 'Installing Node dependencies...'
  & $script:NpmCmd install
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install failed.'
  }
}

$device = Load-Or-CreateDeviceConfig

$env:CODEX_MINI_RELAY_URL = [string]$device.relayUrl
$env:CODEX_MINI_RELAY_PUBLIC_BASE = [string]$device.publicBase
$env:CODEX_MINI_RELAY_DEVICE_ID = [string]$device.deviceId
$env:CODEX_MINI_RELAY_SECRET = [string]$device.relaySecret
$env:CODEX_MINI_RELAY_PASSPHRASE = [string]$device.passphrase
$env:CODEX_MINI_QR_DIR = [string]$ProjectDir

Ensure-NodeRuntime
Ensure-NodeDependencies

Write-Host ''
Write-Host 'Starting Codex Mini desktop relay...'
Write-Host "Device ID: $($device.deviceId)"
Write-Host "Device config: $DeviceConfigPath"
Write-Host 'Phone URL:'
Write-Host "  $($device.publicBase)/#k=$([uri]::EscapeDataString($device.passphrase))"
Write-Host ''
Write-Host 'Keep this window open while using the phone client.'
Write-Host ''

& $script:NpmCmd start
