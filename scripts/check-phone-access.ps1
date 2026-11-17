# Kiểm tra vì sao điện thoại không mở được http://<IP laptop>:3000/health.
# Chỉ đọc thông tin, không thay đổi gì trên máy.
# Chạy trong thư mục dự án:
#   powershell -ExecutionPolicy Bypass -File scripts\check-phone-access.ps1

$ErrorActionPreference = 'SilentlyContinue'
$ports = 3000, 3001, 8090

function Test-Port($hostName, $port) {
    Test-NetConnection -ComputerName $hostName -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
}

Write-Host '== 1. Dich vu tren laptop (Docker)'
foreach ($port in $ports) {
    $state = if (Test-Port '127.0.0.1' $port) { 'dang mo' } else { 'KHONG mo - Docker chua chay dich vu nay?' }
    Write-Host "  localhost:$port -> $state"
}
$containers = docker ps --format '{{.Names}}  {{.Ports}}' 2>$null | Select-String 'api-gateway|real-time|media-relay'
foreach ($line in $containers) { Write-Host "  $line" }

Write-Host ''
Write-Host '== 2. Mang va dia chi IP'
foreach ($connection in Get-NetConnectionProfile) {
    Write-Host "  $($connection.InterfaceAlias): '$($connection.Name)', loai mang: $($connection.NetworkCategory)"
}
$addresses = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|Loopback'
}
foreach ($address in $addresses) {
    $state = if (Test-Port $address.IPAddress 3000) { 'mo' } else { 'KHONG mo' }
    Write-Host "  $($address.InterfaceAlias): $($address.IPAddress)  (cong 3000 qua IP nay: $state)"
}

Write-Host ''
Write-Host '== 3. Tuong lua Windows'
foreach ($fw in Get-NetFirewallProfile) {
    $on = if ($fw.Enabled) { 'bat' } else { 'tat' }
    Write-Host "  Ho so $($fw.Name): $on"
}
$blocks = Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True |
    Where-Object { $_.DisplayName -match 'docker|wsl|vpnkit' }
if ($blocks) {
    foreach ($rule in $blocks) { Write-Host "  CHAN: '$($rule.DisplayName)' (ho so: $($rule.Profile))" }
} else {
    Write-Host '  Khong co quy tac nao chan Docker.'
}
$allows = Get-NetFirewallRule -DisplayName 'SmartHome dev*'
if ($allows) {
    foreach ($rule in $allows) { Write-Host "  Cho phep: '$($rule.DisplayName)' (ho so: $($rule.Profile), bat: $($rule.Enabled))" }
} else {
    Write-Host "  Chua co quy tac 'SmartHome dev' mo cong 3000/3001/8090."
}

Write-Host ''
Write-Host '== 4. Phan mem diet virus co tuong lua rieng'
$products = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct
if ($products) {
    foreach ($product in $products) { Write-Host "  $($product.displayName)" }
} else {
    Write-Host '  Khong co (chi dung tuong lua cua Windows).'
}
