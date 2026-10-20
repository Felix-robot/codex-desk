param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
$buildDir = Join-Path $env:USERPROFILE 'Applications\Codex Desk'
$dataDir = Join-Path $env:USERPROFILE '.codex-desk'
$previousDir = Join-Path $dataDir 'tools'
if(Get-Process electron -ErrorAction SilentlyContinue | Where-Object {$_.Path -eq (Join-Path $buildDir 'node_modules\electron\dist\electron.exe')}){
 throw '请先关闭 Codex Desk，再更新本机安装。桌面快捷方式可直接启动现有安装。'
}
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$node = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $previousDir 'runtime\node.exe' }
if (-not (Test-Path -LiteralPath $node)) { throw '没有找到 Node.js，现有桌面应用仍可直接启动。' }
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
# Protect local settings and plugin OAuth files; never change official Codex ACLs.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$ids = @([Security.Principal.WindowsIdentity]::GetCurrent().User,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'),[Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach($sid in $ids){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'))}
$currentAcl = Get-Acl -LiteralPath $dataDir
$allowedSids = @($ids | ForEach-Object {$_.Value})
$unexpectedRules = @($currentAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object {$_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin $allowedSids})
if(-not $currentAcl.AreAccessRulesProtected -or $unexpectedRules.Count -gt 0){Set-Acl -LiteralPath $dataDir -AclObject $acl}
Copy-Item -LiteralPath (Join-Path $sourceDir 'package.json'),(Join-Path $sourceDir 'package-lock.json') -Destination $buildDir
& npm.cmd ci --prefix $buildDir --no-audit --no-fund
if($LASTEXITCODE -ne 0){throw 'Windows runtime installation failed. Install Node.js with npm and retry.'}
if(-not (Test-Path -LiteralPath (Join-Path $buildDir 'node_modules\electron\dist\electron.exe'))){
 & $node (Join-Path $buildDir 'node_modules\electron\install.js')
 if($LASTEXITCODE -ne 0){throw 'Electron binary download failed.'}
}
$prepared = & $node (Join-Path $sourceDir 'scripts\windows-prepare.cjs') $sourceDir $buildDir $dataDir $previousDir
if($LASTEXITCODE -ne 0){throw 'Windows workspace preparation failed.'}
$paths = $prepared | ConvertFrom-Json
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcut = $shell.CreateShortcut((Join-Path $desktop 'Codex Desk.lnk'))
$shortcut.TargetPath = $paths.executable
$shortcut.Arguments = '"' + $paths.build + '"'
# All launch paths are absolute. Avoid Explorer validating an unnecessary Start in field.
$shortcut.WorkingDirectory = ''
if(-not $shortcut.IconLocation){$shortcut.IconLocation = (Join-Path $paths.build 'assets\desk.ico') + ',0'}
$shortcut.Save()
$programs = [Environment]::GetFolderPath('Programs')
Copy-Item -LiteralPath $shortcut.FullName -Destination (Join-Path $programs 'Codex Desk.lnk') -Force
Write-Output 'Windows native workspace installed. Official Codex configuration was not changed.'
if($Launch){Start-Process -FilePath $shortcut.FullName}
