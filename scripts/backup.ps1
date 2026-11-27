# Sao lưu dữ liệu SmartHome vào E:\smarthome_data\backups\<ngày-giờ>\.
# Dữ liệu nằm trong volume của Docker (ổ đĩa ảo của Docker Desktop, đặt trên ổ E:);
# script này chép một bản ra thư mục thường để giữ lâu hoặc mang sang máy khác.
# Chỉ đọc dữ liệu, không dừng dịch vụ nào. Chạy trong thư mục dự án, khi các
# container đang chạy:
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Destination D:\backup
# Khôi phục: docs/architecture/load-testing.md, mục "Sao lưu và khôi phục".

param(
    [string]$Destination = 'E:\smarthome_data\backups'
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$target = Join-Path $Destination $stamp
New-Item -ItemType Directory -Force -Path $target | Out-Null

function Invoke-Docker([string[]]$Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "docker $($Arguments -join ' ') that bai (ma $LASTEXITCODE)" }
}

function Test-Running([string]$Name) {
    $state = docker inspect -f '{{.State.Running}}' $Name 2>$null
    return $LASTEXITCODE -eq 0 -and $state -eq 'true'
}

# Dump inside the container, copy it out, remove the temporary file.
function Save-FromContainer([string]$Container, [string]$Command, [string]$InsidePath, [string]$FileName) {
    Invoke-Docker @('exec', $Container, 'sh', '-c', $Command)
    Invoke-Docker @('cp', "${Container}:$InsidePath", (Join-Path $target $FileName))
    Invoke-Docker @('exec', $Container, 'rm', '-f', $InsidePath)
    Write-Host "  $FileName"
}

Write-Host "Sao luu vao $target"
$saved = 0

if (Test-Running 'postgres') {
    Save-FromContainer 'postgres' 'pg_dump -U postgres -d smarthome -Fc -f /tmp/smarthome.dump' '/tmp/smarthome.dump' 'postgres-smarthome.dump'
    $saved++
} else { Write-Host '  bo qua PostgreSQL: container postgres khong chay' }

if (Test-Running 'mongodb') {
    Save-FromContainer 'mongodb' 'mongodump --quiet --gzip --archive=/tmp/mongodb.archive.gz' '/tmp/mongodb.archive.gz' 'mongodb.archive.gz'
    $saved++
} else { Write-Host '  bo qua MongoDB: container mongodb khong chay' }

if (Test-Running 'emqx') {
    # Retained messages and anything changed in the dashboard (logins are in PostgreSQL).
    Invoke-Docker @('exec', 'emqx', 'sh', '-c', 'rm -rf /opt/emqx/data/backup && /opt/emqx/bin/emqx ctl data export >/dev/null')
    $file = (docker exec emqx sh -c 'ls -t /opt/emqx/data/backup/*.tar.gz | head -1').Trim()
    if (-not $file) { throw 'EMQX khong tao duoc file export' }
    # The file keeps its name: EMQX imports an archive only under the name it was exported with.
    $name = Split-Path $file -Leaf
    Invoke-Docker @('cp', "emqx:$file", (Join-Path $target $name))
    Write-Host "  $name"
    $saved++
} else { Write-Host '  bo qua EMQX: container emqx khong chay' }

if (Test-Running 'voice-service') {
    Save-FromContainer 'voice-service' 'tar czf /tmp/voice-data.tgz -C /data .' '/tmp/voice-data.tgz' 'voice-data.tgz'
    $saved++
}

# The Simulator's registry, when it runs on this computer.
if (Test-Running 'simulator-mongodb') {
    Save-FromContainer 'simulator-mongodb' 'mongodump --quiet --gzip --archive=/tmp/simulator.archive.gz' '/tmp/simulator.archive.gz' 'simulator-mongodb.archive.gz'
    $saved++
}

if ($saved -eq 0) {
    Remove-Item $target
    throw 'Khong co container nao dang chay de sao luu.'
}
Write-Host "Xong: $saved phan trong $target"
