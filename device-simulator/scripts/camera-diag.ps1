# Thu thập dấu vết khi app không thấy/không xem lại được bản ghi camera. Chạy từ thư mục gốc repo:
#   powershell -ExecutionPolicy Bypass -File device-simulator\scripts\camera-diag.ps1
# Kết quả: device-simulator\camera-diag.txt (không chứa mật khẩu; xóa sau khi dùng).
$out = Join-Path $PSScriptRoot '..\camera-diag.txt'
function Section($title) { "`n=== $title ===" | Out-File -Append -Encoding utf8 -Width 4000 $out }
function Save { $input | ForEach-Object { "$_" } | Out-File -Append -Encoding utf8 -Width 4000 $out }

"camera-diag $(Get-Date -Format o)" | Out-File -Encoding utf8 $out

Section 'containers (thời điểm tạo lại)'
docker ps -a --format "{{.Names}}`t{{.CreatedAt}}`t{{.Status}}" 2>&1 | Save

Section 'bản build có chứa bản sửa "required: false"? (số > 0 là có)'
"api-gateway validation: "         + (docker exec api-gateway grep -c "required !== false" /app/shared/validation.js 2>&1) | Save
"api-gateway catalog cursor: "     + (docker exec api-gateway grep -c '"max_length": 128, "required": false' /app/database/catalog-v2/capabilities.json 2>&1) | Save
"mqtt-worker validation: "         + (docker exec mqtt-worker-service grep -c "required !== false" /app/shared/validation.js 2>&1) | Save
"mqtt-worker catalog cursor: "     + (docker exec mqtt-worker-service grep -c '"max_length": 128, "required": false' /app/database/catalog-v2/capabilities.json 2>&1) | Save
"simulator validateOperationInput: " + (docker exec simulator-backend grep -c "required === false" /app/dist/generation/operation-validation.js 2>&1) | Save
"simulator snapshot (phút đang ghi): " + (docker exec simulator-backend grep -c "snapshot()" /app/dist/media/media-store.js 2>&1) | Save

Section 'device_operations camera (3 giờ gần nhất)'
docker exec postgres psql -U postgres -d smarthome -c "SELECT o.created_at, d.mac, o.operation_name, o.status, o.reason_code, left(o.input::text, 160) AS input, left(o.result::text, 500) AS result FROM device_operations o JOIN device_metadata d ON d.id = o.device_id WHERE o.operation_name IN ('list_recordings','create_playback_session','create_stream_session','delete_recordings') AND o.created_at > NOW() - INTERVAL '3 hours' ORDER BY o.created_at DESC LIMIT 30" 2>&1 | Save

Section 'resource sessions'
docker exec postgres psql -U postgres -d smarthome -c "SELECT created_at, resource_id, status, reason_code, left(resource_locator, 60) AS locator FROM device_resource_sessions ORDER BY created_at DESC LIMIT 10" 2>&1 | Save

Section 'file bản ghi trong simulator (80 file mới nhất)'
docker exec simulator-backend sh -c "find /var/lib/simulator-media -type f -exec ls -l {} + 2>/dev/null | awk '{print `$5, `$9}' | sort -k2 | tail -n 80" 2>&1 | Save

Section 'simulator-backend (bỏ các dòng gửi chunk/poll)'
docker logs simulator-backend --since 3h 2>&1 | Select-String -NotMatch -Pattern 'camera/chunks|incoming request|request completed' | Select-String -Pattern 'camera|playback|recording|segment|generation|ingest|Rejected|rejected|operation|Operation|error|warn' | Select-Object -Last 80 | Save

Section 'media-relay-service'
docker logs media-relay-service --since 3h 2>&1 | Select-Object -Last 60 | Save

Section 'mqtt-worker-service'
docker logs mqtt-worker-service --since 3h 2>&1 | Select-String -Pattern 'list_recordings|playback|delete_recordings|ACK|ack|rror' | Select-Object -Last 40 | Save

Section 'api-gateway (lỗi và operation)'
docker logs api-gateway --since 3h 2>&1 | Select-String -Pattern '"level":(40|50)|playback|resource|session' | Select-Object -Last 50 | Save

Write-Host "Đã ghi $out"
