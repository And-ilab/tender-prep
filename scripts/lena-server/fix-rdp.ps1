#Requires -Version 5.1
<#
  Enable Remote Desktop (RDP) on Windows Server via provider console (VNC/KVM).

  Run in PowerShell AS ADMINISTRATOR on the server:
    Set-ExecutionPolicy -Scope Process Bypass
    cd C:\tender-prep\scripts\lena-server
    .\fix-rdp.ps1

  Or copy-paste commands from README section "RDP repair".
#>
param(
  [switch]$DiagnoseOnly
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Host "Run PowerShell as Administrator." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "=== RDP diagnostics ===" -ForegroundColor Cyan
Write-Host "Host: $env:COMPUTERNAME"
Write-Host ""

# 1. TermService
$svc = Get-Service -Name TermService -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "TermService: $($svc.Status), StartType=$($svc.StartType)"
} else {
  Write-Host "TermService: NOT FOUND" -ForegroundColor Red
}

# 2. Registry fDenyTSConnections (0 = RDP allowed)
$tsKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server"
$deny = (Get-ItemProperty -Path $tsKey -Name fDenyTSConnections -ErrorAction SilentlyContinue).fDenyTSConnections
Write-Host "fDenyTSConnections: $deny (0=enabled, 1=disabled)"

# 3. NLA
$nlaKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp"
$nla = (Get-ItemProperty -Path $nlaKey -Name UserAuthentication -ErrorAction SilentlyContinue).UserAuthentication
Write-Host "NLA (UserAuthentication): $nla (0=off, 1=on)"

# 4. Firewall rules
Write-Host ""
Write-Host "Firewall rules (Remote Desktop):" -ForegroundColor Cyan
Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue |
  Select-Object DisplayName, Enabled, Direction, Action |
  Format-Table -AutoSize

# 5. Port 3389 listening
Write-Host "Port 3389 listeners:" -ForegroundColor Cyan
$listen = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($listen) {
  $listen | Select-Object LocalAddress, LocalPort, State | Format-Table -AutoSize
} else {
  Write-Host "  (nothing listening on 3389)" -ForegroundColor Yellow
}

# 6. External IP hint
Write-Host "Network addresses:" -ForegroundColor Cyan
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" } |
  Select-Object InterfaceAlias, IPAddress | Format-Table -AutoSize

if ($DiagnoseOnly) {
  Write-Host "DiagnoseOnly: no changes made." -ForegroundColor Gray
  exit 0
}

Write-Host ""
Write-Host "=== Applying RDP fix ===" -ForegroundColor Cyan

# Enable RDP
Set-ItemProperty -Path $tsKey -Name fDenyTSConnections -Value 0 -Type DWord
Write-Host "[OK] RDP enabled (fDenyTSConnections=0)"

# Optional: disable NLA if old clients fail (can re-enable later)
# Set-ItemProperty -Path $nlaKey -Name UserAuthentication -Value 0 -Type DWord

# Start TermService
Set-Service -Name TermService -StartupType Automatic
if ((Get-Service TermService).Status -ne "Running") {
  Start-Service TermService
}
Write-Host "[OK] TermService Automatic + Running"

# Firewall: enable all Remote Desktop group rules
$rules = Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue
if ($rules) {
  $rules | Enable-NetFirewallRule | Out-Null
  Write-Host "[OK] Firewall: Remote Desktop rules enabled"
} else {
  # Fallback for localized Windows
  netsh advfirewall firewall set rule group="remote desktop" new enable=Yes 2>$null
  netsh advfirewall firewall set rule group="удаленный рабочий стол" new enable=Yes 2>$null
  Write-Host "[OK] Firewall: netsh remote desktop group enabled"
}

# Explicit rule for 3389 if missing
$existing = Get-NetFirewallRule -DisplayName "RDP-TCP-3389-tender-prep" -ErrorAction SilentlyContinue
if (-not $existing) {
  New-NetFirewallRule -DisplayName "RDP-TCP-3389-tender-prep" `
    -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow | Out-Null
  Write-Host "[OK] Added firewall rule RDP-TCP-3389-tender-prep"
}

# Ensure current admin can use RDP (usually already can)
$adminName = $env:USERNAME
$rdpGroup = Get-LocalGroupMember -Group "Remote Desktop Users" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like "*\$adminName" }
if (-not $rdpGroup) {
  try {
    Add-LocalGroupMember -Group "Remote Desktop Users" -Member $adminName -ErrorAction Stop
    Write-Host "[OK] Added $adminName to Remote Desktop Users"
  } catch {
    Write-Host "[WARN] Could not add to Remote Desktop Users: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

Start-Sleep -Seconds 2

Write-Host ""
Write-Host "=== After fix ===" -ForegroundColor Cyan
$deny2 = (Get-ItemProperty -Path $tsKey -Name fDenyTSConnections).fDenyTSConnections
Write-Host "fDenyTSConnections: $deny2"
Write-Host "TermService: $((Get-Service TermService).Status)"
$listen2 = Get-NetTCPConnection -LocalPort 3389 -State Listen -ErrorAction SilentlyContinue
if ($listen2) {
  Write-Host "Port 3389: LISTENING" -ForegroundColor Green
} else {
  Write-Host "Port 3389: still not listening - reboot may be required" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. In provider panel: open TCP 3389 in cloud firewall / security group"
Write-Host "  2. From laptop: mstsc -> server public IP -> user Administrator (or your admin)"
Write-Host "  3. If still fails: run .\fix-rdp.ps1 -DiagnoseOnly and send output"
Write-Host ""
