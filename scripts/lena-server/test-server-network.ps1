#Requires -Version 5.1
<#
  DNS и TCP для git fetch и Telegram.

  .\test-server-network.ps1
#>
param(
  [string[]]$Hosts = @("github.com", "api.telegram.org")
)

$ErrorActionPreference = "Continue"
$fail = 0

Write-Host "=== test-server-network ==="

foreach ($h in $Hosts) {
  Write-Host ""
  Write-Host "--- $h ---"
  $dnsOk = $false
  try {
    $r = Resolve-DnsName $h -ErrorAction Stop | Select-Object -First 1
    Write-Host "DNS OK: $($r.IPAddress)"
    $dnsOk = $true
  } catch {
    Write-Host "DNS FAIL: $($_.Exception.Message)"
    $fail = 1
    continue
  }
  if ($dnsOk) {
    try {
      $t = Test-NetConnection -ComputerName $h -Port 443 -WarningAction SilentlyContinue
      if ($t.TcpTestSucceeded) {
        Write-Host "TCP OK: ${h}:443"
      } else {
        Write-Host "TCP FAIL: ${h}:443"
        $fail = 2
      }
    } catch {
      Write-Host "TCP error: $($_.Exception.Message)"
      $fail = 2
    }
  }
}

Write-Host ""
Write-Host "DNS servers (IPv4):"
Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.ServerAddresses.Count -gt 0 } |
  ForEach-Object { Write-Host ("  {0}: {1}" -f $_.InterfaceAlias, ($_.ServerAddresses -join ", ")) }

if ($fail -ne 0) {
  Write-Host ""
  Write-Host "Fix DNS example (replace InterfaceAlias):"
  Write-Host '  Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("8.8.8.8","1.1.1.1")'
  exit $fail
}
Write-Host ""
Write-Host "OK: network checks passed"
exit 0
