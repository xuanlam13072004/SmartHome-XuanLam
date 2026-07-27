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
- Command được kiểm tra lại tại virtual device trước khi mutate state: cấu trúc
  JSON, action/instance, argument thiếu hoặc dư, kiểu dữ liệu, min/max, enum và
  độ dài chuỗi. Payload sai nhận ACK `error` và không làm thay đổi state.
- Hỗ trợ startup ramp và jitter theo run để tránh burst telemetry đồng loạt.
- Kiểm tra trước trần user, device, MQTT client và message/giây; workload vượt
  ngân sách bị từ chối trước khi tạo dữ liệu.
- Theo dõi realtime telemetry/giây, lỗi/phút, byte đã gửi, command, ACK, số
  MQTT client online và bộ nhớ backend. Counter được giữ qua restart.
- Pause, resume, cancel và cleanup run; connect/disconnect thiết bị; gửi
  telemetry tức thì.
- Khôi phục run dở dang và thiết bị cần online sau khi backend khởi động lại.
- Pause run dừng cả generation lẫn telemetry runtime. Run paused vẫn giữ paused
  sau restart và chỉ kết nối lại MQTT khi Resume được gọi.
- Telemetry `seq` được cấp phát nguyên tử trong Registry trước khi publish; khi
  process bị dừng đột ngột sequence có thể có khoảng trống nhưng không quay lùi
  hoặc phát trùng sau Recovery.
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

Ở màn hình Create, phần Projected workload hiển thị tải kỳ vọng. Backend vẫn
kiểm tra theo trường hợp xấu nhất, không dùng tỷ lệ offline ngẫu nhiên để nới
trần an toàn. Các giới hạn có thể chủ động chỉnh trong `.env.docker`:

- `MAX_USERS_PER_RUN`
- `MAX_DEVICES_PER_RUN`
- `MAX_ACTIVE_DEVICES`
- `MAX_TELEMETRY_MESSAGES_PER_SECOND`
- `TELEMETRY_PUBLISH_CONCURRENCY`

Snapshot thiết bị trong Registry mặc định chỉ flush mỗi 5 giây để không nhân đôi
ghi MongoDB theo từng telemetry. Telemetry nghiệp vụ vẫn được gửi ngay qua MQTT.
Dashboard đọc metrics rolling qua
`GET /api/simulation-runs/:id/metrics`.

Mọi telemetry định kỳ được điều phối bởi một scheduler tập trung. Scheduler giữ
một lịch due-time chung, áp dụng jitter và chỉ chạy tối đa
`TELEMETRY_PUBLISH_CONCURRENCY` publish đồng thời; công việc vượt giới hạn được
giữ ở trạng thái due để xử lý khi có slot thay vì tạo một timer riêng cho từng
thiết bị.

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
- Mỗi account có `account_id` chỉ được cleanup khi Registry đã ghi
  `account_created_by_simulator=true`. Nếu email trùng account có sẵn, Simulator
  chỉ phục hồi một lần đăng ký bị gián đoạn sau khi identity, thời điểm tạo,
  login và `/auth/me` đều khớp; mọi trường hợp còn lại bị chặn thay vì nhận nhầm
  hoặc xóa nhầm account.
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
