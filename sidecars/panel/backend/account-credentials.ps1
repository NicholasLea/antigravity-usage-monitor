param([string]$JobPath = '')

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$utf8 = [Console]::OutputEncoding
$script:clientsToRestart = @()
$script:clientsStopped = $false

function Test-AccountFile($path) {
    if (-not (Test-Path -LiteralPath $path)) { return $false }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Invalid account file'
    }
    return $true
}

function Write-AccountFile($path, [byte[]]$bytes) {
    $temp = Join-Path ([IO.Path]::GetDirectoryName($path)) ([guid]::NewGuid().ToString() + '.tmp')
    try {
        [IO.File]::WriteAllBytes($temp, $bytes)
        if (Test-AccountFile $path) {
            [IO.File]::Replace($temp, $path, [NullString]::Value)
        } else {
            [IO.File]::Move($temp, $path)
        }
    } finally {
        [IO.File]::Delete($temp)
    }
}

function Ensure-VaultDirectory($path) {
    $dir = [IO.Path]::GetDirectoryName($path)
    if (-not $dir) { return }
    [void][IO.Directory]::CreateDirectory($dir)
    if ([IO.Path]::GetFileName($dir) -ieq 'AntigravityUsageMonitor') {
        try {
            $acl = Get-Acl -LiteralPath $dir
            if (-not $acl.AreAccessRulesProtected) {
                $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
                $sysSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
                $admSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
                $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
                $prop = [Security.AccessControl.PropagationFlags]::None
                $right = [Security.AccessControl.FileSystemRights]::FullControl
                $allow = [Security.AccessControl.AccessControlType]::Allow
                $acl.SetAccessRuleProtection($true, $false)
                foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
                foreach ($sid in @($userSid, $sysSid, $admSid)) {
                    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, $right, $inherit, $prop, $allow))
                }
                Set-Acl -LiteralPath $dir -AclObject $acl
            }
        } catch {}
    }
    try {
        $cutoff = [DateTime]::UtcNow.AddMinutes(-10)
        Get-ChildItem -LiteralPath $dir -Filter 'switch-*.dpapi' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTimeUtc -lt $cutoff } |
            ForEach-Object { [IO.File]::Delete($_.FullName) }
    } catch {}
}

function Save-Vault($path, $vault) {
    $bytes = $utf8.GetBytes((ConvertTo-Json -InputObject $vault -Depth 10 -Compress))
    try {
        $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
        Ensure-VaultDirectory $path
        Write-AccountFile $path $encrypted
    } finally {
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

function Write-SwitchState($request, $state, $errorCode = '') {
    $data = @{ email = $request.email; state = $state; error = $errorCode; updatedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    Write-AccountFile $request.statusFile ($utf8.GetBytes((ConvertTo-Json -InputObject $data -Compress)))
}

function Get-AccountClients {
    $sessionId = (Get-Process -Id $PID).SessionId
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $candidates = @(Get-CimInstance Win32_Process -Filter "Name = 'Antigravity.exe' OR Name = 'Antigravity IDE.exe' OR Name = 'agy.exe' OR Name = 'language_server.exe'")
    $owned = @($candidates | Where-Object {
        $_.SessionId -eq $sessionId -and $_.ExecutablePath -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid).Sid -eq $userSid
    })
    $roots = @($owned | Where-Object {
        $_.Name -in @('Antigravity.exe', 'Antigravity IDE.exe') -and
        $_.CommandLine -notmatch '(?:^|\s)(?:--type|--import|--inspect|--inspect-brk|--ms-enable-electron-run-as-node)(?:=|\s)' -and
        $_.CommandLine -notmatch 'sidecar_sdk[\\/]register_loader\.js' -and
        [Diagnostics.FileVersionInfo]::GetVersionInfo($_.ExecutablePath).ProductName -like 'Antigravity*'
    })
    $installDirectories = @($roots | ForEach-Object { [IO.Path]::GetDirectoryName($_.ExecutablePath) + [IO.Path]::DirectorySeparatorChar } | Select-Object -Unique)
    $agyCliHubPath = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.gemini\bin\agy.exe'))
    $hubs = @($owned | Where-Object {
        $candidate = $_
        $trustedPath = [string]::Equals($candidate.ExecutablePath, $agyCliHubPath, [StringComparison]::OrdinalIgnoreCase) -or
            @($installDirectories | Where-Object { $candidate.ExecutablePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        ($candidate.Name -eq 'language_server.exe' -or
         ($candidate.Name -eq 'agy.exe' -and $candidate.CommandLine -match '(?:^|\s)--hub(?:\s|$)')) -and $trustedPath
    })
    return @{ roots = $roots; hubs = $hubs; sessionId = $sessionId }
}

function Stop-AccountClients {
    $snapshot = Get-AccountClients
    $roots = $snapshot.roots
    $hubs = $snapshot.hubs
    $sessionId = $snapshot.sessionId
    $byExe = @{}
    $launch = @()
    foreach ($root in $roots) {
        $exeKey = $root.ExecutablePath.ToLowerInvariant()
        $hasDebugPort = $root.CommandLine -match '(?:^|\s)--remote-debugging-port(?:=|\s)'
        if (-not $byExe.ContainsKey($exeKey)) {
            $entry = @{ path = $root.ExecutablePath; useDebugPort = [bool]$hasDebugPort }
            $byExe[$exeKey] = $entry
            $launch += $entry
        } elseif ($hasDebugPort) {
            $byExe[$exeKey].useDebugPort = $true
        }
    }
    $script:clientsToRestart = $launch
    $script:clientsStopped = $true
    foreach ($root in $roots) {
        $process = Get-Process -Id $root.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
    }
    $clientPaths = @($launch | ForEach-Object { $_.path })
    if ($roots.Count) {
        for ($i = 0; $i -lt 10; $i++) {
            $aliveRoots = @(Get-Process -Id @($roots.ProcessId) -ErrorAction SilentlyContinue)
            if ($aliveRoots.Count -eq 0) { break }
            Start-Sleep -Milliseconds 150
        }
    }
    $remaining = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId -and $_.Path -in $clientPaths })
    foreach ($process in $remaining) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    foreach ($hub in $hubs) {
        if (Get-Process -Id $hub.ProcessId -ErrorAction SilentlyContinue) { Stop-Process -Id $hub.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    foreach ($processId in @($remaining.Id) + @($hubs.ProcessId)) {
        if ($processId) { Wait-Process -Id $processId -Timeout 10 -ErrorAction SilentlyContinue }
    }
    if (@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId -and $_.Path -in $clientPaths }).Count) {
        throw 'clientCloseFailed'
    }
    foreach ($hub in $hubs) {
        if (Get-Process -Id $hub.ProcessId -ErrorAction SilentlyContinue) { throw 'clientCloseFailed' }
    }
}

function Start-AccountClients {
    foreach ($envVar in @('ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'VSCODE_IPC_HOOK', 'CHROME_CRASHPAD_PIPE_NAME')) {
        Remove-Item -Path ("Env:\" + $envVar) -ErrorAction SilentlyContinue
    }
    foreach ($client in $script:clientsToRestart) {
        $start = @{ FilePath = $client.path; WorkingDirectory = [IO.Path]::GetDirectoryName($client.path) }
        if ($client.useDebugPort) { $start.ArgumentList = '--remote-debugging-port=0' }
        [void](Start-Process @start -PassThru)
    }
    $script:clientsToRestart = @()
    $script:clientsStopped = $false
}

function Schedule-AccountSwitch($request) {
    if (Test-AccountFile $request.statusFile) {
        $status = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($request.statusFile))
        if ($status.state -eq 'starting' -and ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $status.updatedAt) -lt 120000) {
            return @{ error = 'busy' }
        }
    }
    $request.action = 'switch'
    $request | Add-Member -NotePropertyName restartClients -NotePropertyValue $true -Force
    $job = Join-Path ([IO.Path]::GetDirectoryName($request.vault)) ('switch-' + [guid]::NewGuid().ToString() + '.dpapi')
    Save-Vault $job $request
    Write-SwitchState $request 'starting'
    $scriptPath = $request.scriptPath.Replace("'", "''")
    $jobLiteral = $job.Replace("'", "''")
    $code = "& '$scriptPath' -JobPath '$jobLiteral'"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
    $shell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $command = '"' + $shell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + $encoded
    try {
        # WMI starts the worker outside the client job so closing the App cannot terminate the switch.
        $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }
        if ($started.ReturnValue -ne 0) { throw 'switchStartFailed' }
    } catch {
        [IO.File]::Delete($job)
        Write-SwitchState $request 'failed' 'switchStartFailed'
        return @{ error = 'switchStartFailed' }
    }
    return @{ scheduled = $true; accounts = @(); selectedEmail = $request.email }
}

function Add-NativeCredentialType {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class NativeAccountCredential {
    private const uint Generic = 1;
    private const uint PersistLocalMachine = 2;
    private const int NotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint BlobSize;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredReadW(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredWriteW(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    private static extern bool CredDeleteW(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);

    public static byte[] Read(string target) {
        IntPtr pointer;
        if (!CredReadW(target, Generic, 0, out pointer)) {
            int error = Marshal.GetLastWin32Error();
            if (error == NotFound) return null;
            throw new Win32Exception(error);
        }
        try {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            var bytes = new byte[credential.BlobSize];
            if (bytes.Length > 0) Marshal.Copy(credential.Blob, bytes, 0, bytes.Length);
            return bytes;
        } finally {
            CredFree(pointer);
        }
    }

    public static void Write(string target, byte[] bytes) {
        var buffer = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try {
            var credential = new Credential {
                Type = Generic, Persist = PersistLocalMachine, TargetName = target,
                UserName = "antigravity", Blob = buffer.AddrOfPinnedObject(), BlobSize = (uint)bytes.Length
            };
            if (!CredWriteW(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally {
            buffer.Free();
        }
    }

    public static void Restore(string target, byte[] bytes) {
        if (bytes != null) Write(target, bytes);
        else if (!CredDeleteW(target, Generic, 0)) {
            int error = Marshal.GetLastWin32Error();
            if (error != NotFound) throw new Win32Exception(error);
        }
    }
}
'@
}

function Invoke-AccountAction($request) {
    Add-Type -AssemblyName System.Security
    $vault = @{ entries = @(); selectedEmail = '' }
    if (Test-AccountFile $request.vault) {
        $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($request.vault), $null, 'CurrentUser')
        try {
            $vault = ConvertFrom-Json -InputObject ($utf8.GetString($plain))
        } finally {
            if ($plain) { [Array]::Clear($plain, 0, $plain.Length) }
        }
    }
    $vaultSecured = [bool]($vault.security -and $vault.security.enabled)
    $entry = $vault.entries | Where-Object { $_.email -eq $request.email } | Select-Object -First 1
    if ($null -ne $request.expectedCredential -and $entry.credential -cne $request.expectedCredential) {
        return @{ error = 'credentialChanged' }
    }

    switch ($request.action) {
        'inspectClients' {
            $clients = Get-AccountClients
            return @{ clients = @($clients.roots | ForEach-Object { @{ name = $_.Name; path = $_.ExecutablePath } }); hubs = $clients.hubs.Count }
        }
        'readVault' {
            return @{
                entries = @($vault.entries)
                selectedEmail = [string]$vault.selectedEmail
                security = $vault.security
            }
        }
        'writeVault' {
            $nextVault = @{
                entries = @($request.entries)
                selectedEmail = [string]$request.selectedEmail
            }
            if ($request.security) {
                $nextVault.security = $request.security
            }
            Save-Vault $request.vault $nextVault
            $vault = $nextVault
            $vaultSecured = [bool]($vault.security -and $vault.security.enabled)
            if ($request.clearStatus -and $request.statusFile -and (Test-AccountFile $request.statusFile)) {
                try { [IO.File]::Delete($request.statusFile) } catch {}
            }
        }
        'scheduleSwitch' {
            if ($vaultSecured -and (-not $request.vaultUnlocked -or $request.expectedSecuritySalt -cne [string]$vault.security.salt)) {
                return @{ error = 'vaultLocked' }
            }
            if (-not $entry) { return @{ error = 'notFound' } }
            $scheduled = Schedule-AccountSwitch $request
            $scheduled.accounts = @($vault.entries | ForEach-Object { $_.email })
            if ($vaultSecured) {
                $scheduled.security = @{ enabled = $true; salt = [string]$vault.security.salt }
            }
            return $scheduled
        }
        'readCurrent' {
            Add-NativeCredentialType
            $bytes = [NativeAccountCredential]::Read($request.target)
            try {
                if (-not $bytes) {
                    foreach ($path in $request.fallbacks) {
                        if (Test-AccountFile $path) {
                            $bytes = [IO.File]::ReadAllBytes($path)
                            if ($bytes) { break }
                        }
                    }
                }
                if (-not $bytes) { return @{ error = 'noCurrentCredential' } }
                return @{ credential = $utf8.GetString($bytes).TrimStart([char]0xfeff).Trim() }
            } finally {
                if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
            }
        }
        'read' {
            if (-not $entry) { return @{ error = 'notFound' } }
            $readOut = @{ credential = $entry.credential }
            if ($vaultSecured) {
                $readOut.security = @{ enabled = $true; salt = [string]$vault.security.salt }
            }
            return $readOut
        }
        'save' {
            if ($vaultSecured -and (-not $request.vaultUnlocked -or $request.expectedSecuritySalt -cne [string]$vault.security.salt)) {
                return @{ error = 'vaultLocked' }
            }
            if ($entry) { $entry.credential = $request.credential }
            else { $vault.entries = @($vault.entries) + @(@{ email = $request.email; credential = $request.credential }) }
            Save-Vault $request.vault $vault
        }
        'saveQuota' {
            if (-not $entry) { return @{ error = 'notFound' } }
            $entry | Add-Member -NotePropertyName quota -NotePropertyValue $request.quota -Force
            Save-Vault $request.vault $vault
        }
        'switch' {
            if (-not $entry) { return @{ error = 'notFound' } }
            $replacement = $utf8.GetBytes($request.credential)
            if ($replacement.Length -gt 2560) {
                [Array]::Clear($replacement, 0, $replacement.Length)
                return @{ error = 'credentialTooLarge' }
            }
            Add-NativeCredentialType
            if ($request.restartClients) { Stop-AccountClients }
            $previous = [NativeAccountCredential]::Read($request.target)
            $fallbacks = @(foreach ($path in $request.fallbacks) {
                if (Test-AccountFile $path) { @{ path = $path; original = [IO.File]::ReadAllBytes($path) } }
                elseif ([IO.Directory]::Exists([IO.Path]::GetDirectoryName($path))) { @{ path = $path; original = $null } }
            })
            $written = @()
            try {
                [NativeAccountCredential]::Write($request.target, $replacement)
                try {
                    foreach ($fallback in $fallbacks) {
                        Write-AccountFile $fallback.path $replacement
                        $written += $fallback
                    }
                    $entry.credential = if ($request.vaultCredential) { $request.vaultCredential } else { $entry.credential }
                    $vault.selectedEmail = $request.email
                    Save-Vault $request.vault $vault
                } catch {
                    $restored = $true
                    try { [NativeAccountCredential]::Restore($request.target, $previous) } catch { $restored = $false }
                    foreach ($fallback in $written) {
                        try {
                            if ($null -eq $fallback.original) { [IO.File]::Delete($fallback.path) }
                            else { Write-AccountFile $fallback.path $fallback.original }
                        } catch { $restored = $false }
                    }
                    if (-not $restored) { return @{ error = 'rollbackFailed' } }
                    throw
                }
            } finally {
                if ($replacement) { [Array]::Clear($replacement, 0, $replacement.Length) }
                if ($previous) { [Array]::Clear($previous, 0, $previous.Length) }
            }
        }
        'remove' {
            if ($vaultSecured -and (-not $request.vaultUnlocked -or $request.expectedSecuritySalt -cne [string]$vault.security.salt)) {
                return @{ error = 'vaultLocked' }
            }
            if (-not $entry) { return @{ error = 'notFound' } }
            $vault.entries = @($vault.entries | Where-Object { $_.email -ne $request.email })
            if ($vault.selectedEmail -eq $request.email) { $vault.selectedEmail = '' }
            Save-Vault $request.vault $vault
            if ($request.statusFile -and (Test-AccountFile $request.statusFile)) {
                try {
                    $st = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($request.statusFile))
                    if ($st.email -eq $request.email -and $st.state -ne 'starting') { [IO.File]::Delete($request.statusFile) }
                } catch {}
            }
        }
    }
    $quotas = @{}
    foreach ($account in $vault.entries) { if ($account.quota) { $quotas[$account.email] = $account.quota } }
    $result = @{ accounts = @($vault.entries | ForEach-Object { $_.email }); selectedEmail = $vault.selectedEmail; quotas = $quotas }
    if ($vaultSecured) {
        $result.security = @{ enabled = $true; salt = [string]$vault.security.salt }
    }
    if ($request.statusFile -and (Test-AccountFile $request.statusFile)) {
        try { $result.switchState = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($request.statusFile)) } catch {}
    }
    return $result
}

$mutex = $null
$locked = $false
try {
    if ($JobPath) {
        Add-Type -AssemblyName System.Security
        $jobPlain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($JobPath), $null, 'CurrentUser')
        try {
            $request = ConvertFrom-Json -InputObject ($utf8.GetString($jobPlain))
        } finally {
            if ($jobPlain) { [Array]::Clear($jobPlain, 0, $jobPlain.Length) }
        }
    } else {
        $request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
    }
    $mutex = [Threading.Mutex]::new($false, 'Local\AntigravityUsageMonitor.AccountCredentials')
    $waitTimeoutMs = if ($JobPath) { 15000 } else { 5000 }
    try { $locked = $mutex.WaitOne($waitTimeoutMs) } catch [Threading.AbandonedMutexException] { $locked = $true }
    $result = if ($locked) { Invoke-AccountAction $request } else { @{ error = 'busy' } }
    if ($JobPath) { Write-SwitchState $request $(if ($result.error) { 'failed' } else { 'written' }) $result.error }
} catch {
    $result = @{ error = 'storeFailed' }
    $nativeError = $_.Exception.InnerException
    if ($nativeError -is [ComponentModel.Win32Exception] -and $nativeError.NativeErrorCode -in 5, 1312) {
        $result.error = 'credentialAccessDenied'
    }
    if ($_.Exception.Message -match 'clientCloseFailed') { $result.error = 'clientCloseFailed' }
    if ($JobPath -and $request) { Write-SwitchState $request 'failed' $result.error }
} finally {
    if ($JobPath) {
        if ($script:clientsStopped) {
            try { Start-AccountClients } catch { Write-SwitchState $request 'failed' 'clientRestartFailed' }
        }
        [IO.File]::Delete($JobPath)
    }
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
[Console]::Write((ConvertTo-Json -InputObject $result -Depth 10 -Compress))
