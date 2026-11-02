# Offline ClipCascade JSESSIONID metadata inspection (no network, no login).
# Never prints the token, signature, username, password, CSRF or token payload.
# HMAC signature cannot be verified without the secret: this is NOT an auth test.
# Example: powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\Inspect-ClipCascadeSessionOffline.ps1
param(
  [string]$DataPath = ""
)
$ErrorActionPreference = 'Stop'

function Emit([string]$Name, $Value) {
  Write-Output ("{0}={1}" -f $Name, $Value)
}

function Decode-B64Url([string]$Part) {
  if ($Part -cnotmatch '^[A-Za-z0-9_-]{1,2048}$') { throw 'Invalid token encoding' }
  $s = $Part.Replace('-', '+').Replace('_', '/')
  if ($s.Length % 4 -eq 1) { throw 'Invalid token length' }
  $s = $s.PadRight($s.Length + ((4 - $s.Length % 4) % 4), '=')
  $bytes = [Convert]::FromBase64String($s)
  return ([System.Text.UTF8Encoding]::new($false, $true)).GetString($bytes)
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
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'ClipCascade\DATA')) }
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
    Emit 'RESULT' 'DATA_NOT_FOUND'
    return
  }

  $config = Get-Content -LiteralPath $found -Raw -Encoding UTF8 | ConvertFrom-Json
  $url = [Uri]([string]$config.server_url)
  # Match only the established ClipCascade origin; never read an unrelated
  # site's cookie by accidentally passing another installation's DATA.
  if ($url.Scheme -ne 'https' -or $url.Host -ne 'sync.world-honey.com' -or
      $url.UserInfo -or $url.AbsolutePath -ne '/') {
    Emit 'RESULT' 'SERVER_HOST_MISMATCH'
    return
  }

  $session = [string]$config.cookie.JSESSIONID
  if (-not $session -or $session.Length -gt 4096) {
    Emit 'RESULT' 'NO_LOCAL_SESSION'
    return
  }
  Emit 'DATA_PRESENT' 'True'
  Emit 'SESSION_PRESENT' 'True'
  Emit 'NETWORK_REQUESTS' '0'

  # The original 2026-10-03 Worker reportedly used:
  # base64url(JSON{v,sub,auth,csrf,exp}).base64url(HMAC-SHA256).
  # An opaque cookie is also a legitimate possibility after source changes.
  if (-not ($session -cmatch '^([A-Za-z0-9_-]{8,2048})\.([A-Za-z0-9_-]{40,64})$')) {
    Emit 'SESSION_FORMAT' 'OPAQUE_OR_DIFFERENT'
    Emit 'RESULT' 'LOCAL_FORMAT_UNKNOWN'
    return
  }

  $payloadText = Decode-B64Url $Matches[1]
  if ($payloadText.Length -gt 2048) {
    Emit 'RESULT' 'LOCAL_PAYLOAD_INVALID'
    return
  }
  $payload = $payloadText | ConvertFrom-Json
  if ($null -eq $payload -or $payload -isnot [pscustomobject]) {
    Emit 'RESULT' 'LOCAL_PAYLOAD_INVALID'
    return
  }

  Emit 'SESSION_FORMAT' 'SIGNED_TWO_PART_CANDIDATE'
  Emit 'SIGNATURE_VERIFIED' 'False'
  Emit 'PAYLOAD_VERSION_ONE' ($payload.v -eq 1)
  $username = [string]$config.username
  if ($username -and $payload.sub -is [string] -and $payload.sub) {
    Emit 'SUBJECT_MATCHES_LOCAL_CONFIG' ([string]::Equals(
      $username, [string]$payload.sub, [StringComparison]::Ordinal))
  } else {
    Emit 'SUBJECT_MATCHES_LOCAL_CONFIG' 'Unknown'
  }

  $exp = 0L
  if (-not [Int64]::TryParse([string]$payload.exp, [ref]$exp) -or
      $exp -lt 0 -or $exp -gt 4102444800L) {
    Emit 'RESULT' 'LOCAL_EXPIRY_UNREADABLE'
    return
  }
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  Emit 'EXPIRED_BY_PAYLOAD_TIME' ($exp -le $now)
  Emit 'EXPIRY_UTC' ([DateTimeOffset]::FromUnixTimeSeconds($exp).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ'))
  Emit 'RESULT' 'LOCAL_METADATA_ONLY'
} catch {
  # Intentionally do NOT print exception messages or input values.
  Emit 'RESULT' 'LOCAL_INSPECTION_ERROR'
} finally {
  Remove-Variable session,payload,payloadText,config -ErrorAction SilentlyContinue
}
