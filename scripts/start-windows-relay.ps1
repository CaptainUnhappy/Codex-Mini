$ErrorActionPreference = 'Stop'

$ProjectDir = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location -LiteralPath $ProjectDir

$LogDir = Join-Path $ProjectDir 'logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$script:LogPath = Join-Path $LogDir ("{0}.log" -f (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
$script:TranscriptStarted = $false
$script:ManagedCodexProcess = $null
try {
  Start-Transcript -Path $script:LogPath -Append | Out-Null
  $script:TranscriptStarted = $true
  Write-Host "Log file: $script:LogPath"
} catch {
  Write-Warning "Could not start transcript logging: $($_.Exception.Message)"
}

function Stop-DesktopLog {
  if (!$script:TranscriptStarted) { return }
  try {
    Stop-Transcript | Out-Null
  } catch {
  }
  $script:TranscriptStarted = $false
}

trap {
  Write-Host ''
  Write-Host "Fatal error: $($_.Exception.Message)"
  Stop-DesktopLog
  throw
}

$DefaultPublicBase = 'https://114.55.235.80/codex'
$LocalEnvPath = Join-Path $ProjectDir 'desktop-env.local.ps1'
if (Test-Path -LiteralPath $LocalEnvPath) {
  . $LocalEnvPath
}
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

function Save-DeviceConfig($Config) {
  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  $Config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $DeviceConfigPath -Encoding UTF8
}

function Ensure-DeviceRuntimeFields($Config) {
  if ([string]::IsNullOrWhiteSpace([string]$Config.localToken)) {
    $Config | Add-Member -NotePropertyName localToken -NotePropertyValue (New-RandomToken 18) -Force
    Save-DeviceConfig $Config
  }
  return $Config
}

function Resolve-NpmCmd([string] $NpmPath) {
  if ([string]::IsNullOrWhiteSpace($NpmPath)) {
    throw 'npm command is not configured.'
  }

  if ([IO.Path]::GetExtension($NpmPath) -ieq '.cmd') {
    return $NpmPath
  }

  $npmDir = Split-Path -Parent $NpmPath
  if (![string]::IsNullOrWhiteSpace($npmDir)) {
    $adjacentCmd = Join-Path $npmDir 'npm.cmd'
    if (Test-Path -LiteralPath $adjacentCmd) {
      return $adjacentCmd
    }
  }

  $npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCmd) {
    return $npmCmd.Source
  }

  throw 'npm.cmd was not found. Install Node.js for Windows or allow the script to install portable Node.js.'
}

function Set-NodeCommands([string] $NodePath, [string] $NpmPath) {
  $script:NodeExe = $NodePath
  $script:NpmCmd = Resolve-NpmCmd $NpmPath
  $nodeDir = Split-Path -Parent $NodePath
  if ($env:Path -notlike "*$nodeDir*") {
    $env:Path = "$nodeDir;$env:Path"
  }
}

function Invoke-Npm {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $Arguments
  )

  $npmCmd = $script:NpmCmd
  if ([string]::IsNullOrWhiteSpace($npmCmd)) {
    throw 'npm command is not configured.'
  }
  if ([IO.Path]::GetExtension($npmCmd) -ieq '.ps1') {
    throw 'npm.ps1 cannot be used here because it mis-parses variable-based calls. npm.cmd is required.'
  }
  & $npmCmd @Arguments
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
  foreach ($module in @('node_modules\ws', 'node_modules\qrcode', 'node_modules\qrcode-terminal')) {
    if (!(Test-Path -LiteralPath (Join-Path $ProjectDir $module))) {
      $missing += $module
    }
  }
  if ($missing.Count -eq 0) { return }
  Write-Host ''
  Write-Host 'Installing Node dependencies...'
  Invoke-Npm install
  if ($LASTEXITCODE -ne 0) {
    throw 'npm install failed.'
  }
}

function Test-TcpPort([string] $HostName, [int] $PortNumber) {
  $client = New-Object Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect($HostName, $PortNumber, $null, $null)
    if (!$result.AsyncWaitHandle.WaitOne(800, $false)) { return $false }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-RelayStatus([string] $BaseUrl, [string] $Token, [switch] $Quiet) {
  try {
    return Invoke-RestMethod -Method Get -Uri "$BaseUrl/codex/relay-status" -Headers @{ 'x-mobile-typer-token' = $Token } -TimeoutSec 5
  } catch {
    if (!$Quiet) {
      Write-Host "Relay status check failed: $($_.Exception.Message)"
    }
    return $null
  }
}

function Start-CodexMiniProcess {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:NodeExe
  $info.Arguments = 'server.js'
  $info.WorkingDirectory = [string]$ProjectDir
  $info.UseShellExecute = $false
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $info
  if (!$process.Start()) {
    throw 'Failed to start Codex Mini node process.'
  }
  return $process
}

function Stop-CodexMiniProcess($Process) {
  if (!$Process -or $Process.HasExited) { return }
  try {
    $Process.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 800
  } catch {
  }
  if (!$Process.HasExited) {
    try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
  }
  if ($script:ManagedCodexProcess -and $script:ManagedCodexProcess.Id -eq $Process.Id) {
    $script:ManagedCodexProcess = $null
  }
}

function Wait-ForRelayStatus([string] $BaseUrl, [string] $Token, [int] $TimeoutSeconds) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $status = Get-RelayStatus $BaseUrl $Token -Quiet
    if ($status) { return $status }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $null
}

function Watch-CodexMiniRelay([string] $BaseUrl, [string] $Token, [string] $ExpectedDeviceId) {
  $process = $null
  $restartDelayMs = 1000
  $offlineSince = $null
  $lastState = ''
  $managedProcess = $true
  $localPort = 8787
  if (![string]::IsNullOrWhiteSpace($env:PORT)) {
    $localPort = [int]$env:PORT
  }

  $existing = Get-RelayStatus $BaseUrl $Token -Quiet
  if ($existing -and $existing.deviceId -eq $ExpectedDeviceId) {
    Write-Host ''
    Write-Host "Existing Codex Mini service is already running on $BaseUrl."
    Write-Host 'Monitoring existing service. Restart this script if that old service stops responding.'
    $managedProcess = $false
  } elseif (Test-TcpPort '127.0.0.1' $localPort) {
    throw "Port $localPort is already in use, but it did not expose this device's relay status. Close the old Codex Mini window and run this script again."
  }

  while ($true) {
    if ($managedProcess -and (!$process -or $process.HasExited)) {
      if ($process -and $process.HasExited) {
        Write-Host "Codex Mini node process exited with code $($process.ExitCode). Restarting..."
        Start-Sleep -Milliseconds $restartDelayMs
        $restartDelayMs = [Math]::Min($restartDelayMs * 2, 30000)
      }
      $process = Start-CodexMiniProcess
      $script:ManagedCodexProcess = $process
      Write-Host "Supervisor started Codex Mini node process PID $($process.Id)."
      Wait-ForRelayStatus $BaseUrl $Token 20 | Out-Null
      $offlineSince = $null
    }

    $status = Get-RelayStatus $BaseUrl $Token -Quiet
    $now = Get-Date
    if ($status -and $status.connected -eq $true) {
      $offlineSince = $null
      $restartDelayMs = 1000
      if ($lastState -ne 'connected') {
        Write-Host "Relay status: connected as $($status.deviceId)."
        $lastState = 'connected'
      }
      Start-Sleep -Seconds 5
      continue
    }

    $state = if ($status) { [string]$status.state } else { 'local-unreachable' }
    if ($state -eq 'codex-stopped' -or $state -eq 'codex-checking') {
      $offlineSince = $null
      if ($lastState -ne $state) {
        if ($state -eq 'codex-stopped') {
          Write-Host 'Relay access is paused because Codex is not running. Waiting for Codex to start...'
        } else {
          Write-Host 'Checking Codex desktop before opening relay access...'
        }
        $lastState = $state
      }
      Start-Sleep -Seconds 5
      continue
    }

    if (!$offlineSince) {
      $offlineSince = $now
      Write-Host "Relay status: $state. Waiting for automatic recovery..."
      $lastState = $state
    } elseif ($lastState -ne $state) {
      Write-Host "Relay status: $state."
      $lastState = $state
    }

    $offlineSeconds = ($now - $offlineSince).TotalSeconds
    if ($offlineSeconds -ge 60) {
      if ($managedProcess) {
        Write-Host "Relay has been unavailable for $([int]$offlineSeconds) seconds. Restarting Codex Mini node process..."
        Stop-CodexMiniProcess $process
        $process = $null
        $offlineSince = $null
      } else {
        Write-Host 'Existing Codex Mini service is unhealthy and was not started by this supervisor. Close the old Codex Mini window, then run this script again.'
        Start-Sleep -Seconds 10
      }
    } else {
      Write-Host "Relay reconnecting... $([int]$offlineSeconds)s elapsed."
      Start-Sleep -Seconds 5
    }
  }
}

$device = Ensure-DeviceRuntimeFields (Load-Or-CreateDeviceConfig)

$env:CODEX_MINI_RELAY_URL = [string]$device.relayUrl
$env:CODEX_MINI_RELAY_PUBLIC_BASE = [string]$device.publicBase
$env:CODEX_MINI_RELAY_DEVICE_ID = [string]$device.deviceId
$env:CODEX_MINI_RELAY_SECRET = [string]$device.relaySecret
$env:CODEX_MINI_RELAY_PASSPHRASE = [string]$device.passphrase
$env:MOBILE_TYPER_TOKEN = [string]$device.localToken
$env:CODEX_MINI_QR_DIR = [string]$ProjectDir
if ([string]::IsNullOrWhiteSpace($env:PORT)) { $env:PORT = '8787' }

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
Write-Host 'Supervisor will restart the local relay automatically if it becomes unhealthy.'
Write-Host ''

try {
  Watch-CodexMiniRelay "http://127.0.0.1:$env:PORT" ([string]$device.localToken) ([string]$device.deviceId)
} finally {
  Stop-CodexMiniProcess $script:ManagedCodexProcess
  Stop-DesktopLog
}
