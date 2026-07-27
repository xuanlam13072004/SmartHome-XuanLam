# Device Simulator

Hệ thống giả lập user và thiết bị IoT cho SmartHome-XuanLam. User ảo đăng ký và
claim qua API Gateway thật; thiết bị ảo được provision vào PostgreSQL thật, kết
nối Mosquitto, gửi telemetry và nhận command theo cùng contract với thiết bị thật.

Simulator chỉ giữ metadata quản lý trong database MongoDB riêng
`DeviceSimulatorDB`. PostgreSQL và `SmartHomeDB` vẫn là nguồn dữ liệu nghiệp vụ;
registry riêng chỉ giúp xác định chính xác dữ liệu nào do simulator tạo để hiển
thị, khôi phục và cleanup an toàn.

## Chức năng

- Tạo run theo số user, khoảng thiết bị/user, seed và phân phối product.
- Đăng ký user qua `/auth/register`; provision factory identity và claim qua
  `/devices/claim`.
- Mỗi thiết bị có MQTT client riêng, state theo catalog, telemetry QoS 1,
  command validation, ACK và telemetry phản hồi.
- Pause, resume, cancel và cleanup run; connect/disconnect thiết bị; gửi
  telemetry tức thì.
- Khôi phục run dở dang và thiết bị cần online sau khi backend khởi động lại.
- Xem run, user, device, trạng thái, telemetry gần nhất và audit event.
- Credential/secret được mã hóa trong registry; thao tác reveal cần admin token
  và được ghi audit.
- Run tự động mặc định được cleanup sau 24 giờ tính từ lúc hoàn thành. Run tạo
  thủ công hoặc chuyển thành permanent được giữ cho tới khi chủ động cleanup.

## Bốn collection registry

- `simulation_runs`: cấu hình, tiến độ, trạng thái và lịch cleanup.
- `simulated_users`: identity user do từng run tạo và credential đã mã hóa.
- `simulated_devices`: factory identity, provisioning, MQTT và state snapshot.
- `simulator_events`: audit/runtime event, tự hết hạn theo TTL.

Việc tách collection giúp index, TTL và truy vấn từng loại dữ liệu đúng mục
đích. Chúng vẫn nằm chung trong một database `DeviceSimulatorDB`.

## Chạy bằng Docker

Yêu cầu stack SmartHome chính đang chạy:

```powershell
docker compose up -d
```

Tạo cấu hình riêng của simulator:

```powershell
.\device-simulator\scripts\Initialize-SimulatorEnv.ps1
```

Script tự sinh `ADMIN_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`, đồng thời đồng bộ
PostgreSQL và MongoDB nghiệp vụ từ `api-gateway/.env.docker`. File kết quả
`.env.docker` bị Git ignore. Dùng thêm `-Force` chỉ khi muốn chủ động tạo lại
secret; không tạo lại khi registry còn credential cần giải mã hoặc cleanup.

Sao chép admin token vào clipboard mà không in ra terminal:

```powershell
((Get-Content .\device-simulator\.env.docker | Where-Object { $_ -like 'ADMIN_TOKEN=*' }) -replace '^ADMIN_TOKEN=', '') | Set-Clipboard
```

Khởi động module:

```powershell
docker compose -f device-simulator\docker-compose.yml up -d --build
```

Mở `http://localhost:4000`, nhập `ADMIN_TOKEN`, chạy Infrastructure Preflight,
sau đó mới tạo workload.

Compose riêng chỉ tạo hai container `simulator-backend` và
`simulator-dashboard`; nó tham gia external network của SmartHome và không tạo
volume dữ liệu. Vì vậy:

- `docker compose -f device-simulator\docker-compose.yml down` chỉ dừng/xóa hai
  container simulator.
- Lệnh trên không xóa PostgreSQL, MongoDB, user thật hay user ảo.
- Không dùng `docker compose down -v` ở stack SmartHome chính vì tùy chọn `-v`
  xóa named volume do stack chính quản lý.
- Muốn xóa dữ liệu test, dùng Cleanup của từng run. Cleanup đối chiếu registry và
  chặn thao tác nếu phát hiện ownership ngoài phạm vi đã ghi nhận.

Nếu tên external network khác mặc định, đặt biến trước khi chạy:

```powershell
$env:SMARTHOME_DOCKER_NETWORK='ten-network-thuc-te'
```

## Chạy phát triển

Tạo cấu hình:

```powershell
Copy-Item device-simulator\.env.example device-simulator\.env
```

Terminal backend:

```powershell
Set-Location device-simulator\backend
npm install
npm run dev
```

Terminal frontend:

```powershell
Set-Location device-simulator\frontend
npm install
npm run dev
```

Vite phục vụ dashboard tại `http://localhost:5173` và proxy `/api` sang backend
`http://localhost:4001`. Có thể override bằng `VITE_SIMULATOR_API_URL`.

## An toàn và retention

- Backend không chạy khi `SIMULATOR_ENABLED=false`.
- `NODE_ENV=production` yêu cầu cả `SIMULATOR_ENABLED=true` và
  `ALLOW_PRODUCTION_SIMULATOR=true`.
- Không thay `CREDENTIAL_ENCRYPTION_KEY` khi registry còn credential cần khôi
  phục hoặc cleanup.
- Timer 24 giờ bắt đầu khi run hoàn thành, không phải khi run bắt đầu.
- User tạo thủ công ngoài simulator không có registry record và không thuộc
  cleanup tự động.
- Tốc độ đăng ký/claim được giới hạn bằng delay để tôn trọng rate limit của API
  Gateway. Trường `concurrency` không được expose vì pipeline hiện chạy tuần tự
  có chủ đích.

## Kiểm tra

```powershell
Set-Location device-simulator\backend
npm run check

Set-Location ..\frontend
npm run lint
npm run build

Set-Location ..
docker compose config
```
