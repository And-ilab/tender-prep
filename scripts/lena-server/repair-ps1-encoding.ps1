#Requires -Version 5.1
<#
  Fix PS 5.1 parse errors from em dash / mojibake in .ps1 files.

  cd C:\tender-prep\scripts\lena-server
  .\repair-ps1-encoding.ps1
#>
param(
  [string]$ScriptDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$utf8 = New-Object System.Text.UTF8Encoding $false
$fixed = 0

Get-ChildItem -Path $ScriptDir -Filter "*.ps1" -File | ForEach-Object {
  $path = $_.FullName
  $text = [System.IO.File]::ReadAllText($path)
  $orig = $text
  $text = $text.Replace([char]0x2014, '-')
  $text = $text.Replace([char]0x2013, '-')
  $text = $text -replace '/\* ignore \*/', '# ignore'
  if ($text -ne $orig) {
    [System.IO.File]::WriteAllText($path, $text, $utf8)
    $fixed++
    Write-Host "Fixed: $($_.Name)"
  }
  $errors = $null
  $null = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    Write-Host "PARSE FAIL: $($_.Name)"
    foreach ($e in $errors) { Write-Host $e.ToString() }
    exit 1
  }
}

Write-Host "OK: parse check passed ($fixed file(s) repaired)"
