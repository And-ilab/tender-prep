#Requires -Version 5.1
<#
  Проверка DNS и доступности github.com (перед git fetch).

  .\test-github-dns.ps1
#>
$ErrorActionPreference = "Continue"

Write-Host "=== test-github-dns ==="

$dnsOk = $false
try {
  $r = Resolve-DnsName github.com -ErrorAction Stop | Select-Object -First 1
  Write-Host "DNS OK: github.com -> $($r.IPAddress)"
  $dnsOk = $true
} catch {
  Write-Host "DNS FAIL: cannot resolve github.com — $($_.Exception.Message)"
}

if (-not $dnsOk) {
  Write-Host ""
  Write-Host "Проверьте интернет и DNS на сервере:"
  Write-Host "  Get-DnsClientServerAddress -AddressFamily IPv4"
  Write-Host "  ping 8.8.8.8"
  Write-Host "Пример (замените Ethernet на ваш адаптер):"
  Write-Host '  Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("8.8.8.8","1.1.1.1")'
  exit 1
}

$tcpOk = $false
try {
  $t = Test-NetConnection -ComputerName github.com -Port 443 -WarningAction SilentlyContinue
  if ($t.TcpTestSucceeded) {
    Write-Host "TCP OK: github.com:443"
    $tcpOk = $true
  } else {
    Write-Host "TCP FAIL: cannot reach github.com:443 (firewall/proxy?)"
  }
} catch {
  Write-Host "TCP test error: $($_.Exception.Message)"
}

if (-not $tcpOk) { exit 2 }
Write-Host "OK: github.com reachable"
exit 0
