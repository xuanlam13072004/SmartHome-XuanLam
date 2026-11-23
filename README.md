# SmartHome-XuanLam

Hệ thống nhà thông minh (đồ án tốt nghiệp): thiết bị ESP32 hoặc thiết bị ảo
của Simulator ↔ MQTT ↔ backend (API Gateway, MQTT worker, realtime, media
relay, voice-service) ↔ ứng dụng Flutter (Android, iOS, web, Windows).
App và backend không phân biệt thiết bị thật hay ảo.

## Thành phần

| Thư mục | Vai trò |
|---|---|
| `api-gateway/` | REST API (Fastify, TypeScript): tài khoản, thiết bị, chia sẻ, phòng, kịch bản, tự động hóa, giọng nói, trợ lý, thanh toán |
| `mqtt-worker-service/` | Cầu nối MQTT ↔ backend: lệnh, trạng thái, Hub–Node |
| `real-time-service/` | WebSocket đẩy sự kiện tới app |
| `media-relay-service/` | Chuyển tiếp video camera (HLS) |
| `voice-service/` | Python: xác minh giọng nói, chuyển giọng thành chữ (PhoWhisper) |
| `database/` | Schema PostgreSQL (baseline 203 + migrations, hiện **213**), catalog sản phẩm, khởi tạo |
| `admin-console/` | Admin Console: trang web nội bộ của công ty (quản trị, nhân viên và phân quyền, phần Simulator) |
| `device-simulator/` | Simulator: tạo người dùng và thiết bị ảo qua API công khai (compose riêng; giao diện nằm trong Admin Console) |
| `smarthome_app/` | Ứng dụng Flutter |
| `firmware/` | Firmware ESP32 |
| `docs/` | Kiến trúc (`docs/architecture/`), Cloudflare Tunnel, bàn giao (`AI_HANDOFF.md`) |

## Khởi chạy

1. Docker Desktop. Dữ liệu lưu ở `E:/smarthome_data` (sửa trong `docker-compose.yml` nếu khác ổ).
2. Tạo `.env` ở thư mục gốc từ `.env.example`:
   - bắt buộc: `MQTT_ADMIN_PASSWORD`, `MQTT_WORKER_PASSWORD`, `MQTT_FACTORY_PASSWORD`,
     `VOICE_SERVICE_TOKEN` (chuỗi ngẫu nhiên ≥ 16 ký tự);
   - trợ lý: `GEMINI_API_KEY` (Google AI Studio; để trống = tắt trợ lý);
   - thanh toán: mặc định `PAYMENT_MODE=mock` (không tiền thật); tiền thật xem
     `docs/architecture/payments.md`;
   - truy cập từ xa: `CLOUDFLARED_CREDENTIALS_FILE` (`docs/cloudflare-tunnel.md`).
   - thông báo đẩy (không bắt buộc): đặt `secrets/firebase-service-account.json`
     và `smarthome_app/android/app/google-services.json` (`docs/architecture/push.md`).
   - Admin Console (trang nội bộ của công ty): `ADMIN_API_KEY` ngẫu nhiên ≥ 32 ký tự; dùng Simulator
     thì thêm `SIMULATOR_ADMIN_TOKEN` = `ADMIN_TOKEN` trong `device-simulator/.env.docker`
     (`docs/architecture/admin.md`).
   - `api-gateway/.env.docker`, `real-time-service/.env.docker`,
     `mqtt-worker-service/.env.docker` tạo từ các file `.env.docker.example`.
3. `docker compose up -d --build` (lần đầu lâu: voice-service tải PyTorch, ECAPA,
   PhoWhisper ~1,5 GB; cần khoảng 1,5 GB RAM cho riêng dịch vụ này).
4. Admin Console (http://localhost:4000): tạo admin gốc một lần
   `docker compose exec api-gateway node dist/tools/staff.js create-root <email> "<Họ tên>"`
   (in ra mật khẩu tạm), đăng nhập rồi đặt mật khẩu mới. Nhân viên khác do admin gốc tạo ở trang
   Nhân viên; quên mật khẩu admin gốc: `staff.js reset-root`.
5. Simulator: xem `device-simulator/README.md`.
6. Kiểm thử tải (không bắt buộc): `docker compose --profile monitoring up -d` thêm
   Prometheus + Grafana (http://localhost:3005); cách đo và số liệu cho báo cáo:
   `docs/architecture/load-testing.md`.
7. App: xem `smarthome_app/README.md`
   (`flutter run --dart-define-from-file=config/cloudflare.json` khi dùng tunnel).

## Kiểm thử

```powershell
node --test database/v2-tests/database-contract.test.js
cd api-gateway; npm test          # cần TEST_PG_URL (+ TEST_MONGO_URL) cho test tích hợp
cd real-time-service; npm test
cd mqtt-worker-service; npm test
cd device-simulator/backend; npm test
cd admin-console/backend; npm test
cd media-relay-service; npm test
docker compose run --rm voice-service python -m pytest -q
cd smarthome_app; flutter test
cd api-gateway; npm run assistant:eval   # bộ 123 câu với Gemini thật (cần GEMINI_API_KEY)
```

## Tài liệu

Bắt đầu từ `docs/architecture/README.md`; tiến độ và quyết định: `docs/AI_HANDOFF.md`.
