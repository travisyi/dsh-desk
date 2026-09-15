#Requires -Version 5.1
<#
.SYNOPSIS
  Create Desktop and Start Menu shortcuts for the DeepSeek Harness desktop app.

.DESCRIPTION
  Points the shortcuts at Electron in this folder's node_modules, so the app
  starts with its own branded icon and no console window. Run `npm install`
  first: without node_modules there is no electron.exe to point at.

.PARAMETER NoDesktop
  Skip the Desktop shortcut.

.PARAMETER NoStartMenu
  Skip the Start Menu shortcut.

.PARAMETER Startup
  Also place a shortcut in the per-user Startup folder (start with Windows).

.PARAMETER Remove
  Remove the shortcuts instead of creating them.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-shortcuts.ps1
#>
[CmdletBinding()]
param(
  [switch]$NoDesktop,
  [switch]$NoStartMenu,
  [switch]$Startup,
  [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$AppDir = Split-Path -Parent $PSScriptRoot
$AppName = 'DeepSeek Harness'
$Electron = Join-Path $AppDir 'node_modules\electron\dist\electron.exe'
$Icon = Join-Path $AppDir 'assets\icon.ico'

function Get-ShortcutTargets {
  $targets = @()
  if (-not $NoDesktop) {
    $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")
  }
  if (-not $NoStartMenu) {
    $programs = Join-Path ([Environment]::GetFolderPath('Programs')) $AppName
    $targets += (Join-Path $programs "$AppName.lnk")
  }
  if ($Startup) {
    $targets += (Join-Path ([Environment]::GetFolderPath('Startup')) "$AppName.lnk")
  }
  return $targets
}

if ($Remove) {
  foreach ($target in Get-ShortcutTargets) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Force
      Write-Host "removed  $target"
    }
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $Electron)) {
  Write-Error "electron.exe not found at $Electron`nRun 'npm install' in $AppDir first."
}

$shell = New-Object -ComObject WScript.Shell
foreach ($target in Get-ShortcutTargets) {
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $shortcut = $shell.CreateShortcut($target)
  $shortcut.TargetPath = $Electron
  $shortcut.Arguments = '"' + $AppDir + '"'
  $shortcut.WorkingDirectory = $AppDir
  $shortcut.Description = 'DeepSeek Harness desktop shell'
  if (Test-Path -LiteralPath $Icon) {
    $shortcut.IconLocation = "$Icon,0"
  }
  $shortcut.Save()
  Write-Host "created  $target"
}

Write-Host ''
Write-Host "App folder : $AppDir"
Write-Host "Launcher   : $Electron"
Write-Host "Settings   : $(Join-Path $AppDir 'settings.json')"
