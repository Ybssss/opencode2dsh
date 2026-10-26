<#
.SYNOPSIS
Point the opencode2dsh plugin at the local relay.

.DESCRIPTION
The plugin has no base-URL setting: `ZEN_BASE_URL` is a module constant in
`packages/plugin/lib/catalog-*.js` (installed copy under the DSH profile). This
rewrites that one constant to the relay.

The profile's node_modules are pnpm HARDLINKS into the global store, so editing in
place would corrupt the store for every other project. The file is unlinked first
(copy aside -> delete -> move back), which leaves a private copy.

Everything is done on BYTES: the file is UTF-8 with em-dashes in its comments, and
a PowerShell text round-trip turns those into U+FFFD. Only the ASCII bytes of the
constant are touched, and the result is parsed back to prove it still loads.

Idempotent, and reversible with -Revert.

.EXAMPLE
.\scripts\point-plugin-at-relay.ps1
.\scripts\point-plugin-at-relay.ps1 -Revert
.\scripts\point-plugin-at-relay.ps1 -RelayUrl http://127.0.0.1:9000/inference
#>
[CmdletBinding()]
param(
  [string]$RelayUrl = 'http://127.0.0.1:8899/inference',
  [string]$Profile = 'desktop',
  [switch]$Revert
)

$ErrorActionPreference = 'Stop'

$pluginLib = Join-Path $env:USERPROFILE ".dsh\profiles\$Profile\node_modules\@opencode2dsh\dsh-plugin\lib"
if (-not (Test-Path $pluginLib)) {
  throw "plugin lib not found: $pluginLib (is opencode2dsh installed in the '$Profile' profile?)"
}

$target = Get-ChildItem -Path $pluginLib -Filter 'catalog-*.js' |
  Where-Object { Select-String -Path $_.FullName -Pattern 'const ZEN_BASE_URL' -Quiet } |
  Select-Object -First 1
if (-not $target) { throw "no catalog-*.js with ZEN_BASE_URL in $pluginLib" }

$file = $target.FullName
$original = 'https://opencode.ai/inference'
$bytes = [System.IO.File]::ReadAllBytes($file)
$text = [System.Text.Encoding]::UTF8.GetString($bytes)

# Break the hardlink so the pnpm store is untouched.
$links = @(fsutil hardlink list $file 2>$null)
if ($links.Count -gt 1) {
  Write-Host "unlinking $($target.Name) from the pnpm store ($($links.Count) paths share this inode)"
  $scratch = "$file.relay-tmp"
  [System.IO.File]::WriteAllBytes($scratch, $bytes)
  Remove-Item -LiteralPath $file -Force
  Move-Item -LiteralPath $scratch -Destination $file
}

$from, $to = if ($Revert) { $RelayUrl, $original } else { $original, $RelayUrl }

if ($text.Contains($to)) {
  Write-Host "already at $to"
  return
}
if (-not $text.Contains($from)) {
  throw "ZEN_BASE_URL is neither $original nor $RelayUrl; refusing to guess. Inspect $file"
}

# Byte-level replace of the first occurrence.
$fromBytes = [System.Text.Encoding]::UTF8.GetBytes($from)
$toBytes = [System.Text.Encoding]::UTF8.GetBytes($to)
$buffer = [System.Collections.Generic.List[byte]]::new()
$i = 0
$replaced = 0
while ($i -lt $bytes.Length) {
  if ($replaced -eq 0 -and $i + $fromBytes.Length -le $bytes.Length) {
    $match = $true
    for ($j = 0; $j -lt $fromBytes.Length; $j += 1) {
      if ($bytes[$i + $j] -ne $fromBytes[$j]) { $match = $false; break }
    }
    if ($match) {
      $buffer.AddRange($toBytes)
      $i += $fromBytes.Length
      $replaced += 1
      continue
    }
  }
  $buffer.Add($bytes[$i])
  $i += 1
}

[System.IO.File]::WriteAllBytes($file, $buffer.ToArray())
Write-Host "patched: ZEN_BASE_URL -> $to"

# Prove the module still loads, and that no replacement character appeared.
$after = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($file))
if ($after.Contains([char]0xFFFD)) {
  Write-Warning 'the file contains U+FFFD; it was already damaged before this run'
}
$moduleUrl = "file:///$($file -replace '\\','/')"
node --input-type=module -e "import('$moduleUrl').then(() => console.log('verified: module parses')).catch(e => { console.log('PARSE FAIL: ' + e.message); process.exit(1) })"
if ($LASTEXITCODE -ne 0) { throw 'the patched module does not parse; revert with -Revert' }

Write-Host 'restart DSH for the change to take effect'
