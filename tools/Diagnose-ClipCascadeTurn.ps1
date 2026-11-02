# ClipCascade TURN session probe. Read-only; reuses an existing Windows session.
# No interactive login, no password prompts, no secrets printed.
# Usage: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Diagnose-ClipCascadeTurn.ps1
#        [-DataPath "C:\Program Files\ClipCascade\DATA"] [-InspectOnly]
# Restrict probe to the operator's existing sync hostname to prevent cookie exfiltration.
param(
  [string]$DataPath = "",
  [string]$ExpectedHost = "sync.world-honey.com",
  [switch]$InspectOnly
)
$ErrorActionPreference = "Stop"

function Emit([string]$Name, $Value) {
  Write-Output ("{0}={1}" -f $Name, $Value)
}

function FetchStatus([string]$Url, [hashtable]$Headers) {
  try {
    # Never follow redirects to login pages and never print raw responses.
    $response = Invoke-WebRequest -Uri $Url -Method Get -Headers $Headers -TimeoutSec 10 -MaximumRedirection 0 -UseBasicParsing -ErrorAction Stop
    return @{ Code = [int]$response.StatusCode; Content = [string]$response.Content }
  } catch {
    $status = 0
    if ($_.Exception.Response) {
      try { $status = [int]$_.Exception.Response.StatusCode } catch {}
    }
    return @{ Code = $status; Content = "" }
  }
}

function IsAuthorized([string]$Body) {
  $normalized = $Body.Trim()
  if ($normalized -eq 'OK' -or $normalized -eq '"OK"') { return $true }
  if (-not $normalized.StartsWith('{') -or $normalized.Length -gt 2048) {
    return $false
  }
  try {
    $obj = $normalized | ConvertFrom-Json
    return ($obj.valid -eq $true -or
      ($obj.authenticated -eq $true -and $obj.status -eq 'valid'))
  } catch {
    return $false
  }
}

try {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  if ($DataPath) {
    $candidates.Add($DataPath)
  } else {
    try {
      @(Get-Process -Name ClipCascade -ErrorAction SilentlyContinue) | ForEach-Object {
        if ($_.Path) { $candidates.Add((Join-Path (Split-Path $_.Path -Parent) 'DATA')) }
      }
    } catch {}
    $candidates.Add((Join-Path (Get-Location).Path 'DATA'))
    if ($env:ProgramFiles) {
      $candidates.Add((Join-Path $env:ProgramFiles 'ClipCascade\DATA'))
    }
    if ($env:LOCALAPPDATA) {
      $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\ClipCascade\DATA'))
    }
  }
  $found = $null
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $found = $candidate
      break
    }
  }
  if (-not $found) {
    Emit "RESULT" "DATA_NOT_FOUND"
    Emit "NEXT" "Pass -DataPath pointing to the DATA file next to ClipCascade.exe"
    return
  }

  $config = Get-Content -LiteralPath $found -Raw -Encoding UTF8 | ConvertFrom-Json
  $endpoint = [string]$config.server_url
  $url = [uri]$endpoint
  if ($url.Scheme -ne 'https' -or $url.Host -ne $ExpectedHost -or
      $url.UserInfo -or ($url.AbsolutePath -ne '/')) {
    Emit "RESULT" "SERVER_HOST_MISMATCH"
    return
  }
  $sessionId = [string]$config.cookie.JSESSIONID
  if ($sessionId -notmatch '^[^;\s]{6,1024}$') {
    Emit "RESULT" "NO_REUSABLE_SESSION"
    return
  }

  Emit "DATA_PRESENT" "True"
  Emit "SESSION_PRESENT" "True"
  Emit "SERVER_HOST_VERIFIED" "True"
  if ($InspectOnly) {
    Emit "RESULT" "INSPECT_ONLY_NO_NETWORK"
    return
  }

  # Credentials are only sent to the matching HTTPS host already used by the app.
  $headers = @{ Cookie = "JSESSIONID=$sessionId;"; Accept = "application/json";
    "Cache-Control" = "no-cache" }
  $base = $url.GetLeftPart([System.UriPartial]::Authority)
  $auth = FetchStatus ($base + '/validate-session') $headers
  Emit "AUTH_HTTP" $auth.Code
  $authorized = $auth.Code -eq 200 -and (IsAuthorized $auth.Content)
  Emit "SESSION_AUTHORIZED" $authorized
  if (-not $authorized) {
    Emit "RESULT" "EXISTING_SESSION_NOT_RECOGNIZED"
    return
  }

  $turn = FetchStatus ($base + '/ice-servers') $headers
  Emit "TURN_HTTP" $turn.Code
  if ($turn.Code -ne 200) {
    Emit "RESULT" "TURN_ISSUER_REJECTED_OR_UNAVAILABLE"
    return
  }

  $payload = $turn.Content | ConvertFrom-Json
  $count = 0
  foreach ($item in @($payload.iceServers)) {
    $urls = @($item.urls)
    $haveUri = @($urls | Where-Object { $_ -is [string] -and
      $_ -match '^turns?:' }).Count -gt 0
    if ($haveUri -and $item.username -and $item.credential) { $count++ }
  }
  Emit "TURN_CREDENTIAL_SETS" $count
  Emit "TURN_READY" ($count -gt 0)
  Emit "RESULT" $(if ($count -gt 0) { "TURN_ISSUED" } else { "TURN_RESPONSE_INVALID" })
} catch {
  # Never print exception details: errors may include request or URL metadata.
  Emit "RESULT" "LOCAL_DIAGNOSTIC_ERROR"
} finally {
  Remove-Variable sessionId,config,headers,auth,turn,payload -ErrorAction SilentlyContinue
}
