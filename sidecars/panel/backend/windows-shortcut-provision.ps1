[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$enableFlag = $env:AGY_LAUNCH_ENABLED -eq '1'
$updated = New-Object System.Collections.Generic.List[string]
$configured = New-Object System.Collections.Generic.List[string]
$readOnly = New-Object System.Collections.Generic.List[string]
$discoveredDirs = New-Object System.Collections.Generic.List[string]
$ws = $null
$userDesktopDir = [Environment]::GetFolderPath('Desktop')
$commonDesktopDir = [Environment]::GetFolderPath('CommonDesktopDirectory')
$userProgramsDir = [Environment]::GetFolderPath('Programs')
$commonProgramsDir = [Environment]::GetFolderPath('CommonPrograms')
$userStartupDir = [Environment]::GetFolderPath('Startup')
$zhDesktop = ([string][char]0x684C + [string][char]0x9762)

$flatSpecs = New-Object System.Collections.Generic.List[object]
$seenScanDir = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

function Add-ScanDir([string]$dirPath, [bool]$isCommon, [string]$kind, [bool]$expandVendorSubdir, [bool]$recordDiscovered) {
  if (-not $dirPath) { return }
  if (-not $seenScanDir.Add($dirPath)) { return }
  $exists = $false
  try { $exists = [bool](Test-Path -LiteralPath $dirPath -ErrorAction SilentlyContinue) } catch { $exists = $false }
  if (-not $exists) { return }
  $flatSpecs.Add(@{ Dir = $dirPath; IsCommon = $isCommon; Kind = $kind })
  if ($recordDiscovered) { $discoveredDirs.Add($dirPath) }
  if ($expandVendorSubdir) {
    try {
      foreach ($sub in @(Get-ChildItem -LiteralPath $dirPath -Directory -ErrorAction SilentlyContinue)) {
        if ($sub -and $sub.Name -and ($sub.Name -match '(?i)antigravity|^google(?:\b|[\s_-]|$)') -and $sub.FullName -and $seenScanDir.Add([string]$sub.FullName)) {
          $flatSpecs.Add(@{ Dir = [string]$sub.FullName; IsCommon = $isCommon; Kind = $kind })
          if ($recordDiscovered) { $discoveredDirs.Add([string]$sub.FullName) }
        }
      }
    } catch {}
  }
}

Add-ScanDir $userDesktopDir $false 'desktop' $false $true
foreach ($d in @(
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE 'Desktop' } else { '' }),
  $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE $zhDesktop } else { '' })
)) {
  Add-ScanDir $d $false 'desktop' $false $false
}
foreach ($od in @($env:OneDrive, $env:OneDriveConsumer, $env:OneDriveCommercial)) {
  if ($od) {
    Add-ScanDir (Join-Path $od 'Desktop') $false 'desktop' $false $false
    Add-ScanDir (Join-Path $od $zhDesktop) $false 'desktop' $false $false
  }
}
Add-ScanDir $userProgramsDir $false 'programs' $true $true
Add-ScanDir ([Environment]::GetFolderPath('StartMenu')) $false 'startmenu' $false $false
Add-ScanDir $userStartupDir $false 'startup' $false $true
if ($env:APPDATA) {
  Add-ScanDir (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar') $false 'taskbar' $false $false
}
Add-ScanDir $commonDesktopDir $true 'desktop' $false $true
Add-ScanDir $commonProgramsDir $true 'programs' $true $true

$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
foreach ($spec in $flatSpecs) {
  $dir = [string]$spec.Dir
  $items = @()
  try {
    $items = @(Get-ChildItem -LiteralPath $dir -Filter '*.lnk' -File -ErrorAction SilentlyContinue)
  } catch { continue }

  foreach ($item in $items) {
    if ($item.Length -lt 32 -or $item.Length -gt 65536) { continue }
    $lnkPath = [string]$item.FullName
    if (-not $seen.Add($lnkPath)) { continue }
    try {
      $rawBytes = [System.IO.File]::ReadAllBytes($lnkPath)
      $u16 = [System.Text.Encoding]::Unicode.GetString($rawBytes)
      $lat = [System.Text.Encoding]::GetEncoding(28591).GetString($rawBytes)
      if ($u16.IndexOf('antigravity.exe', [System.StringComparison]::OrdinalIgnoreCase) -lt 0 -and
          $lat.IndexOf('antigravity.exe', [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        continue
      }
      if (-not $ws) { $ws = New-Object -ComObject WScript.Shell }
      $sc = $ws.CreateShortcut($lnkPath)
      $target = [string]$sc.TargetPath
      if ([System.IO.Path]::GetFileName($target) -ine 'Antigravity.exe') { continue }
      $curArgs = [string]$sc.Arguments
      if ($enableFlag) {
        if ($curArgs -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($lnkPath)
          continue
        }
        $nextArgs = ($curArgs.Trim() + ' --remote-debugging-port=0').Trim()
        try {
          $sc.Arguments = $nextArgs
          $sc.Save()
          $updated.Add($lnkPath)
          $configured.Add($lnkPath)
        } catch {
          $readOnly.Add($lnkPath)
          if ($spec.IsCommon -and $spec.Kind -eq 'programs' -and $userProgramsDir -and (Test-Path -LiteralPath $userProgramsDir -ErrorAction SilentlyContinue)) {
            $fallbackLnk = Join-Path $userProgramsDir ([System.IO.Path]::GetFileName($lnkPath))
            if (-not (Test-Path -LiteralPath $fallbackLnk -ErrorAction SilentlyContinue)) {
              try {
                $uSc = $ws.CreateShortcut($fallbackLnk)
                $uSc.TargetPath = $target
                $uSc.Arguments = $nextArgs
                if ($sc.WorkingDirectory) { $uSc.WorkingDirectory = $sc.WorkingDirectory }
                if ($sc.IconLocation) { $uSc.IconLocation = $sc.IconLocation }
                if ($sc.Description) { $uSc.Description = $sc.Description }
                $uSc.Save()
                $updated.Add($fallbackLnk)
                $configured.Add($fallbackLnk)
              } catch {}
            }
          }
        }
      } else {
        $stripped = ([regex]::Replace($curArgs, '(?:^|\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\s|$)', ' ')).Trim()
        if ($stripped -ne $curArgs.Trim()) {
          try {
            $sc.Arguments = $stripped
            $sc.Save()
            $updated.Add($lnkPath)
          } catch {
            $readOnly.Add($lnkPath)
          }
        }
        if ($stripped -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($lnkPath)
        }
      }
    } catch {}
  }
}

$runTargets = @(
  @{ Root = [Microsoft.Win32.Registry]::CurrentUser; Label = 'HKCU'; SubPath = 'Software\Microsoft\Windows\CurrentVersion\Run' },
  @{ Root = [Microsoft.Win32.Registry]::LocalMachine; Label = 'HKLM'; SubPath = 'Software\Microsoft\Windows\CurrentVersion\Run' },
  @{ Root = [Microsoft.Win32.Registry]::LocalMachine; Label = 'HKLM'; SubPath = 'Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' }
)
foreach ($rt in $runTargets) {
  try {
    $runReadKey = $rt.Root.OpenSubKey($rt.SubPath, $false)
    if (-not $runReadKey) { continue }
    $runNames = @($runReadKey.GetValueNames())
    $runReadKey.Close()
    foreach ($valName in $runNames) {
      $rk = $rt.Root.OpenSubKey($rt.SubPath, $false)
      if (-not $rk) { continue }
      $rawCmd = [string]$rk.GetValue($valName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $rk.Close()
      if (-not $rawCmd) { continue }
      if ($rawCmd -notmatch '^\s*(?:"([^"]+)"|([^\s"]+))(.*)$') { continue }
      $exeCandidate = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      $restPart = [string]$Matches[3]
      if ([System.IO.Path]::GetFileName($exeCandidate) -ine 'Antigravity.exe') { continue }
      $quotedExe = if ($Matches[1] -or $exeCandidate -match '\s') { '"' + $exeCandidate + '"' } else { $exeCandidate }
      $entryId = if ($rt.Label -eq 'HKLM') { "HKLM:Run:$($rt.SubPath)|$valName" } else { "HKCU:Run:$valName" }
      if ($enableFlag) {
        if ($restPart -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($entryId)
          continue
        }
        $nextRest = ($restPart.Trim() + ' --remote-debugging-port=0').Trim()
        $nextVal = "$quotedExe $nextRest"
        $saved = $false
        try {
          $wk = $rt.Root.OpenSubKey($rt.SubPath, $true)
          if ($wk) {
            $wk.SetValue($valName, $nextVal, [Microsoft.Win32.RegistryValueKind]::String)
            $wk.Close()
            $saved = $true
          }
        } catch {}
        if ($saved) {
          $updated.Add($entryId)
          $configured.Add($entryId)
        } elseif ($rt.Label -eq 'HKLM') {
          $readOnly.Add($entryId)
        }
      } else {
        $strippedRest = ([regex]::Replace($restPart, '(?:^|\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\s|$)', ' ')).Trim()
        $nextVal = if ($strippedRest) { "$quotedExe $strippedRest" } else { $quotedExe }
        if ($nextVal -ne $rawCmd.Trim()) {
          $saved = $false
          try {
            $wk = $rt.Root.OpenSubKey($rt.SubPath, $true)
            if ($wk) {
              $wk.SetValue($valName, $nextVal, [Microsoft.Win32.RegistryValueKind]::String)
              $wk.Close()
              $saved = $true
            }
          } catch {}
          if ($saved) {
            $updated.Add($entryId)
          } elseif ($rt.Label -eq 'HKLM') {
            $readOnly.Add($entryId)
          }
        }
        if ($strippedRest -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($entryId)
        }
      }
    }
  } catch {}
}

$exactClassSubKeys = @(
  'Software\Classes\antigravity\shell\open\command',
  'Software\Classes\Applications\Antigravity.exe\shell\open\command',
  'Software\Classes\AntigravitySourceFile\shell\open\command'
)
$classRoots = @(
  @{ Root = [Microsoft.Win32.Registry]::CurrentUser; Label = 'HKCU'; FullPrefix = 'HKEY_CURRENT_USER' },
  @{ Root = [Microsoft.Win32.Registry]::LocalMachine; Label = 'HKLM'; FullPrefix = 'HKEY_LOCAL_MACHINE' }
)
foreach ($cr in $classRoots) {
  foreach ($relSubKey in $exactClassSubKeys) {
    try {
      $rOpen = $cr.Root.OpenSubKey($relSubKey, $false)
      if (-not $rOpen) { continue }
      $rawOpen = [string]$rOpen.GetValue('', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $rOpen.Close()
      if (-not $rawOpen) { continue }
      if ($rawOpen -notmatch '^\s*(?:"([^"]+)"|([^\s"]+))(.*)$') { continue }
      $exeCand = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      $restOpen = ([string]$Matches[3]).Trim()
      if ([System.IO.Path]::GetFileName($exeCand) -ine 'Antigravity.exe') { continue }
      $quotedOpenExe = if ($Matches[1] -or $exeCand -match '\s') { '"' + $exeCand + '"' } else { $exeCand }
      $fullKeyName = if ($cr.Label -eq 'HKLM') { "HKLM:Class:$relSubKey" } else { "$($cr.FullPrefix)\$relSubKey" }
      if ($enableFlag) {
        if ($restOpen -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($fullKeyName)
          continue
        }
        $nextOpen = if ($restOpen) { "$quotedOpenExe --remote-debugging-port=0 $restOpen" } else { "$quotedOpenExe --remote-debugging-port=0" }
        $saved = $false
        try {
          $wOpen = $cr.Root.OpenSubKey($relSubKey, $true)
          if ($wOpen) {
            $wOpen.SetValue('', $nextOpen, [Microsoft.Win32.RegistryValueKind]::String)
            $wOpen.Close()
            $saved = $true
          }
        } catch {}
        if ($saved) {
          $updated.Add($fullKeyName)
          $configured.Add($fullKeyName)
        } elseif ($cr.Label -eq 'HKLM') {
          $readOnly.Add($fullKeyName)
        }
      } else {
        $strippedOpen = ([regex]::Replace($restOpen, '(?:^|\s+)--remote-debugging-port=(?:"0"|''0''|0)(?=\s|$)', ' ')).Trim()
        $nextOpen = if ($strippedOpen) { "$quotedOpenExe $strippedOpen" } else { $quotedOpenExe }
        if ($nextOpen -ne $rawOpen.Trim()) {
          $saved = $false
          try {
            $wOpen = $cr.Root.OpenSubKey($relSubKey, $true)
            if ($wOpen) {
              $wOpen.SetValue('', $nextOpen, [Microsoft.Win32.RegistryValueKind]::String)
              $wOpen.Close()
              $saved = $true
            }
          } catch {}
          if ($saved) {
            $updated.Add($fullKeyName)
          } elseif ($cr.Label -eq 'HKLM') {
            $readOnly.Add($fullKeyName)
          }
        }
        if ($strippedOpen -match '(?:^|\s)--remote-debugging-port(?:=|\s|$)') {
          $configured.Add($fullKeyName)
        }
      }
    } catch {}
  }
}

[pscustomobject]@{
  ok = $true
  updatedPaths = @($updated)
  configuredPaths = @($configured)
  readOnlyPaths = @($readOnly)
  discoveredDirs = @($discoveredDirs)
} | ConvertTo-Json -Compress
