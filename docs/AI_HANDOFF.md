# SmartHome-XuanLam — tài liệu bàn giao cho AI tiếp tục dự án

> Cập nhật: 2026-11-03. Đây là bản tóm lược định hướng và bản đồ đọc code, không thay cho việc kiểm tra trạng thái Git, test hoặc code liên quan trước mỗi lần sửa.

## Hướng dẫn nhanh cho AI nhận bàn giao

Bạn đang làm việc trong monorepo SmartHome-XuanLam. Trước khi sửa:

1. Đọc file này, `docs/architecture/README.md`, `database/README.md` và README của module liên quan.
2. Chạy `git status --short` và kiểm tra diff của đúng các file cần đụng. Working tree đang có nhiều thay đổi chưa commit; đó có thể là công việc của người dùng. Không reset, checkout, clean hoặc ghi đè hàng loạt.
3. Xác nhận hành vi từ source hiện tại và test. Không xem nội dung tài liệu cũ, cuộc hội thoại trước hay knowledge graph là bằng chứng code hiện đang chạy.
4. Không chạy migration phá hủy, xóa dữ liệu trên ổ E, hoặc `docker compose down -v` nếu chưa có yêu cầu rõ ràng.
5. Khi test simulator, dùng DB/test data được giới hạn rõ ràng; không để lại user, device, file video hoặc dữ liệu rác trong hệ thống người dùng.

Không được giả định dịch vụ Docker hiện đang chạy hoặc image đã được rebuild. Kiểm tra trạng thái thực tế trước khi hướng dẫn/chạy.

## Nguyên tắc cốt lõi và mục tiêu quy mô (người dùng xác nhận 2026-11-03)

- Simulator chỉ là công cụ quản lý/tạo user và thiết bị ảo. App Flutter và
  backend không được biết thiết bị nào là ảo: mọi kết nối của thiết bị ảo đi qua
  đúng các kênh chính như thiết bị thật (REST API Gateway, MQTT broker có xác
  thực, Worker, WebSocket). Đã kiểm tra: không có nhánh `simulat`/`virtual`
  trong API Gateway, MQTT Worker, real-time-service, schema DB và Flutter.
- Mục tiêu: khoảng 7.000–8.000 user và 30.000 thiết bị (ảo hoặc thật) hoạt động
  được. Đánh giá mọi thay đổi theo mức tải này.
- Thứ tự ưu tiên đã thống nhất: làm ngay những gì thay đổi contract (xác thực,
  quyền, giao thức); tối ưu hiệu năng nội bộ (batch/concurrency của MQTT Worker,
  vòng quét topology, `SKIP LOCKED`, giới hạn simulator 30k) để sau khi tính
  năng ổn định, rồi đo tải theo bậc.

## Thay đổi ngày 2026-11-03

- JWT secret đã đổi; `.env.docker` không còn được Git theo dõi, dùng
  `*.env.docker.example`. Root `.env` (Git-ignored) chứa mật khẩu broker.
- Rate limit của Gateway lưu trong Redis và tính theo email/phiên/tài khoản
  (`RATE_LIMIT_*`), không còn theo IP (trừ trần thô cho đăng ký/đăng nhập).
- real-time-service xác minh token qua Gateway `/auth/me` (status +
  `token_version`) và đóng socket khi token hết hạn (`token_expired`).
- Thêm index `device_shadows.access_account_ids`,
  `active_operations.operation.actor_account_id`; Redis Streams giới hạn
  `REDIS_STREAM_MAXLEN`.
- MQTT bắt buộc xác thực: Mosquitto 2.1.2 + Dynamic Security, ACL theo MAC
  (`docs/architecture/mqtt-security.md`). Simulator không còn subscription
  wildcard `smarthome/+/topology`; thiết bị ảo nghe topic của chính nó, Node
  relay nhận topology qua Hub. Firmware đọc mật khẩu MQTT từ NVS
  `factory/mqttPassword`.
- Test mới: `api-gateway` và `real-time-service` đã có `npm test`.

## Mục tiêu sản phẩm

Xây dựng một hệ thống nhà thông minh đầu-cuối gồm:

- Ứng dụng Flutter để đăng nhập, thêm thiết bị, xem trạng thái realtime và điều khiển thiết bị.
- Backend chịu trách nhiệm danh tính, quyền sở hữu/chia sẻ, topology thiết bị, operation, bảo vệ dữ liệu và API.
- Luồng MQTT để thiết bị thật và thiết bị ảo dùng chung hợp đồng telemetry, presence, command, ACK và event.
- Product Catalog định nghĩa capability, trạng thái, operation, resource, quyền và quy tắc sản phẩm; app/backend/simulator phải cùng diễn giải hợp đồng này.
- Device Simulator tạo user và device thử nghiệm thật trong các luồng API/database/MQTT, đồng thời cung cấp Dashboard để quan sát/thao tác.
- Firmware ESP32 làm logic an toàn cục bộ; mất Internet không được khiến logic vật lý thiết yếu phụ thuộc backend.

Simulator không phải bộ mock đứng ngoài hệ thống. Virtual device cần hành xử qua cùng API, Catalog, MQTT contract, topology, operation/ACK và history như thiết bị thật. Backend và Flutter không nên chứa nhánh nghiệp vụ `isSimulator`.

## Kiến trúc cấp cao

```text
Flutter App ──REST──> API Gateway ──PostgreSQL (dữ liệu nghiệp vụ chuẩn)
      │                    │
      │ WebSocket          ├── MongoDB chính (catalog, shadow, telemetry, event)
      │                    ├── Redis (cache, route/lease, fan-out)
      │                    └── MQTT broker <──> MQTT Worker <──> ESP32 / Device Simulator
      │
      └── API/media session cho resource bảo vệ (camera là kế hoạch chưa triển khai)

Device Simulator: Dashboard React + backend Node/TypeScript + virtual runtime,
MongoDB riêng `DeviceSimulatorDB`, kết nối API Gateway/MQTT và điều khiển thiết bị ảo.
```

### Module chính

| Thư mục | Vai trò | Điểm bắt đầu nên đọc |
|---|---|---|
| `api-gateway/` | Fastify REST, auth, quyền, claim/unpair, operation/resource session, outbox/workers | `src/index.ts`, `src/app.ts`, `src/modules/device/routes.ts`, `src/modules/device/service.ts` |
| `mqtt-worker-service/` | MQTT consumers, contract validation, telemetry/shadow, event, presence, command/credential ACK và topology | `src/index.js`, `src/workers/`, `src/services/` |
| `real-time-service/` | WebSocket, xác thực/subscription và fan-out Redis/Mongo tới app | `src/server.ts`, `src/handlers/wsHandler.ts`, `src/services/connectionManager.ts` |
| `database/` | Schema PostgreSQL, Mongo collections/indexes, initializer và contract tests | `postgres/schema_v2.sql`, `mongodb/v2/collections.js`, `initialize_v2.js` |
| `shared/catalog-v2/` | Catalog compiler/loader/linter, shared contracts và tests | `index.js`, `loader.js`, `compiler.js`, `catalog-v2.test.js` |
| `device-simulator/backend/` | Generation queue, provisioning, registry, virtual device runtime, MQTT, cleanup/recovery | `src/index.ts`, `src/generation/queue.ts`, `src/runtime/manager.ts`, `src/runtime/device-runtime.ts` |
| `device-simulator/frontend/` | React/Vite dashboard cho run/user/device, workbench vật lý ảo, telemetry/history | `src/App.tsx`, `src/components/DeviceDetail.tsx`, `src/components/device/EntrancePhysicalWorkbench.tsx` |
| `firmware/entrance-controller/` | Firmware tham chiếu ESP32 cho cửa: PIN, servo, MPU6050, LCD, keypad và MQTT | `README.md`, `src/`, `include/`, `test/` |
| `smarthome_app/` | Flutter/Riverpod UI, REST/WS, product-specific UI và capability mapping | `lib/main.dart`, `lib/features/dashboard/`, `lib/features/products/`, `lib/domain/mappers/capability_assembler.dart` |
| `firmware/hazard-controller/` | Firmware tham chiếu ESP32 cho báo cháy/khí gas: MQ2, lửa, DHT11, còi, nút tắt âm | `README.md`, `src/`, `include/`, `test/` |
| `mosquitto/` | Cấu hình broker (Dynamic Security) | `mosquitto.conf`, `docs/architecture/mqtt-security.md` |
| `docker-compose.yml` | Hệ thống chính: PostgreSQL, MongoDB, Redis, Mosquitto, initializer (DB + MQTT) và services | Compose root |
| `device-simulator/docker-compose.yml` | Simulator backend + dashboard, nối vào Docker network của hệ thống chính | Compose Simulator |

## Ranh giới sở hữu dữ liệu

- **PostgreSQL là source of truth** cho account/session, factory identity, device ownership/sharing, Hub–Node, quyền/policy, operation, durable outbox, credential job metadata, resource access sessions và audit.
- **MongoDB chính** giữ Product Catalog đã publish, device shadow, telemetry, device events, incidents, active-operation projection và ingest receipts. Reported physical state có authority từ firmware/device runtime.
- **Redis** là cache/route/lease và realtime transport; không phải source of truth.
- **MQTT** chuyên chở telemetry/presence/operation/ACK/credential/event theo contract; không chở video frame.
- **DeviceSimulatorDB** được cấu hình riêng khỏi MongoDB chính bằng `SIMULATOR_MONGO_DB_NAME=DeviceSimulatorDB`; database name riêng, dù có thể cùng MongoDB server.
- Docker Compose root bind-mount PostgreSQL/MongoDB data dưới `E:\smarthome_data`. Không xóa hoặc reset vùng này để “dọn test”.
- Schema PostgreSQL V2 dùng migration/schema version `201`; initializer từ chối schema cũ/thiếu thay vì tự xóa dữ liệu.

## Hợp đồng Product Catalog và tính nhất quán

Catalog định nghĩa capability instances, reported state, desired state, operation, permission, event, resource, credential, firmware compatibility và giao diện sản phẩm. Runtime compiler chỉ đưa instance `active` vào runtime; instance `planned` không có operation/resource hữu dụng.

Khi đổi Catalog, lần theo tất cả consumer: API Gateway, MQTT worker, simulator loader/runtime, Flutter mapper/UI registry, firmware và tests. Revision đã pin trên thiết bị không được âm thầm nâng cấp hàng loạt. Cần migration/versioning tương thích rõ.

> **Tài liệu có chỗ mâu thuẫn:** `database/catalog-v2/README.md` mô tả Catalog V2 như draft và nói runtime dùng `database/seeds`. Đã xác minh 2026-11-03: thư mục `database/seeds` không còn, manifest `lifecycle: published` (revision 12), Gateway/Worker/seed đều import `shared/catalog-v2`. README đó đã cũ. `docs/products/README.md` ghi `prod_hazard_monitor` nhưng ID thật là `prod_hazard_mitigation`.

## Các luồng nghiệp vụ cần nắm

### Tạo user/device trong Simulator

1. Dashboard gửi cấu hình run (số user, khoảng thiết bị/user, phân phối product/network).
2. Generation queue tạo tài khoản qua API Gateway, lưu registry riêng trong Simulator.
3. Factory provisioning tạo identity/secret thiết bị; credential nhạy cảm trong registry được mã hóa.
4. Simulator đăng nhập user, claim thiết bị qua API Gateway và khởi tạo DeviceRuntime.
5. DeviceRuntime publish presence/telemetry, nhận operation, thay đổi state, ACK và tuân theo topology bằng MQTT giống contract thiết bị.
6. Dashboard đọc trạng thái, run metrics, users/devices và SSE events. Generation có thể partial, pause/resume, retry hoặc cleanup.

Không giả định user đã xuất hiện đồng nghĩa toàn bộ device đã provision/claim. Đọc riêng target, created, claimed và trạng thái run.

### Hub–Node

- Hub election thuộc về **mạng thiết bị**, không thuộc tài khoản/user.
- Mạng được nhận diện bằng fingerprint; thiết bị đầu tiên có thứ tự ưu tiên cao nhất, thiết bị sau có rank thấp dần.
- Nodes relay qua Hub đang hoạt động; nếu Hub mất lease, Nodes chuyển direct MQTT fallback để dữ liệu không bị unreachable; topology epoch mới hợp lệ đưa chúng về relay.
- ACK/downlink phải được fence bằng device/network/epoch/route.
- Backend giữ topology chính thức; runtime ảo mô phỏng việc relay/fallback. Firmware hiện mới có contract/adapter boundary, không được báo relay phần cứng thành công khi adapter vô tuyến chưa được cấu hình.

### Firmware cửa chính

- PIN 6 chữ số được xác minh tại thiết bị, không gửi PIN thô lên backend.
- PIN đúng mở chốt bằng servo; mở khóa khác với cửa vật lý mở. MPU6050 đo cánh cửa; auto-lock theo điều kiện/thời gian firmware.
- LCD 4x20, keypad, door state và event theo contract chung. Simulator có workbench tương ứng để kiểm thử.
- Không làm logic an toàn cửa phụ thuộc camera, app hoặc kết nối Internet.
- Firmware hiện trong repo là tham chiếu `esp32dev`, chưa phải PCB/sản phẩm đã chốt; GPIO, trục MPU, cơ khí và nguồn phải đo thật.

## Quyết định camera đã chốt với người dùng (2026-11-04)

Contract chi tiết: `docs/architecture/camera-contract.md` (v0.3, các điểm mở đã chốt). Các mục
dưới đây là quyết định của người dùng, thay thế phần "Chưa chốt" bên dưới nếu mâu
thuẫn:

- **Một** Product camera riêng `prod_security_camera` (MAC, danh tính broker riêng),
  độc lập với bộ khóa cửa trên app, không tham gia Hub–Node.
- **Ưu tiên Simulator.** Thiết bị thật làm sau; Simulator dùng để phát triển sản
  phẩm tương lai, nên chất lượng theo webcam/micro laptop: H.264 đến 1080p30 +
  AAC, fMP4 mảnh 2 giây, file ghi 1 phút. Phần cứng thật sau này phải đáp ứng đúng
  hồ sơ đó (ESP32-S3 không đủ; ứng viên ESP32-P4).
- Âm thanh: chỉ thu (micro), không loa/đàm thoại hai chiều.
- Ghi liên tục 24/7, chưa ghi theo sự kiện. Snapshot để sau.
- Xem trực tiếp và xem lại kể cả từ ngoài nhà qua máy chủ trung gian
  (`media-relay-service`, HLS); tối đa 5 người xem mỗi camera.
- Xóa: khi đầy (ghi vòng), khi unpair/đổi chủ, hoặc chủ thiết bị tự xóa trên app
  (quyền mới `camera.recording.manage`). Không xóa theo tuổi. Simulator: trần tổng
  10 GB, xóa sạch khi dọn lần chạy.
- **Bỏ hẳn** `door_camera` và `face_auth` khỏi bộ khóa cửa, tăng revision và migrate
  dữ liệu thiết bị cửa, nạp lại firmware cửa.
- RTC: người dùng có module, dùng khi làm thiết bị thật (chưa ưu tiên).
- Truy cập từ ngoài: Cloudflare Tunnel cố định trên tên miền của người dùng. API và
  WebSocket qua hostname công khai; video (máy chủ media) qua tuyến mạng riêng +
  Cloudflare WARP, vì điều khoản Cloudflare cấm truyền video qua hostname công khai
  trên gói miễn phí (contract mục 11.1).
- Thứ tự: backend B1–B8 + Catalog revision 13 → Simulator → media relay → Flutter →
  tunnel (contract mục 16).
- **Bước 1 đã làm (2026-11-04):** Catalog revision 13 (`prod_security_camera`,
  `camera_stream` rev 2, `video_recording` rev 1, `media_profile`; cửa revision 6
  không còn camera/face, firmware cửa `CATALOG_REVISION = 6`), PostgreSQL schema
  **202** (quyền `camera.recording.manage`, `device_operations.result`,
  `device_resource_sessions.ingest_token_hash`), Gateway B1–B7. Camera ảo trả lời
  `CAMERA_UNAVAILABLE` cho tới bước 2. Người dùng cho phép **xóa sạch dữ liệu dự án**
  khi đổi schema (không viết migration 201→202). Bước tiếp theo: Simulator webcam.

## Trạng thái camera: kế hoạch, chưa phải tính năng hoàn tất

Đây là mục tiêu sắp tới đã được người dùng làm rõ:

- Thiết bị thật tự ghi video lên microSD của thiết bị.
- Thiết bị ảo dùng webcam PC và “SD ảo” trên PC; bật webcam chủ động từ trang chi tiết thiết bị trong Simulator, không tự bật khi tạo device.
- Simulator sở hữu video ảo và giới hạn **tổng kho Simulator khoảng 10 GB** (không phải mỗi thiết bị). Khi thiếu dung lượng, retention phải dọn các bản ghi cũ đã hoàn tất một cách an toàn.
- Flutter xem live và xem lại qua API/media session đã xác thực; không truy cập đường dẫn file PC, không mount thư mục Simulator, không phân biệt nguồn thật/ảo và không hiện lời nhắc “bật từ Simulator”.
- Simulator cũng có thể xem live và playback từ chính kho của nó.
- Tách bạch dữ liệu quản trị Simulator, dữ liệu hệ thống chính và file video. Video Simulator không được ghi bản sao vào database/app; metadata/index có thể riêng ở Simulator nhưng chỉ mục không thay thế media file gốc.
- Tắt webcam dừng live nhưng video đã ghi còn xem lại khi Simulator/PC hoạt động. Nếu PC/Simulator dừng thì file vẫn còn nhưng tạm thời không truy cập được.
- MQTT dùng cho trạng thái/yêu cầu/ACK nhỏ; video truyền qua media transport riêng. Catalog capability `camera_stream` và `door_camera` hiện còn `planned`; API/resource-session hiện có mới là khung phân quyền, chưa phải media server.

### Camera cần thiết kế trước khi code

1. Viết contract thiết bị chung: identity, authenticated publish, start/stop live, list recordings, playback range, storage status, heartbeat, lỗi và versioning.
2. Quyết định media transport/codec sau prototype với đúng ESP32 camera và SD. Webcam browser có thể đưa frame theo một adapter; firmware cần cùng contract media ở boundary. Không ép webcam và ESP32 phải cùng loại thiết bị vật lý, nhưng backend/app chỉ tiêu thụ cùng giao diện giao thức.
3. Mô phỏng SD bằng thư mục riêng, ví dụ `E:\smarthome_data\device-simulator\media`, được mount bền vững vào Simulator. Một thiết bị ảo không được truy cập media của thiết bị khác.
4. Lưu chỉ mục bản ghi riêng trong SimulatorDB hoặc để device adapter là source of truth; quyết định phải bảo đảm restart reconciliation. Không đưa file vào MongoDB/PostgreSQL.
5. API Gateway kiểm tra quyền rồi cấp phiên media thời gian giới hạn; worker/runtime định tuyến yêu cầu tới thiết bị theo contract. Revoke/unpair/expiry phải ngắt phiên đang hoạt động, không chỉ chặn phiên mới.
6. Xem trực tiếp và xem lại dùng quyền/session scope phù hợp. Đổi chủ không được để chủ mới kế thừa video cũ; cần storage generation/owner boundary và quy tắc xóa/giữ khi unpair.
7. Simulator UI: chọn webcam, permission, bật/tắt, xem preview, storage gauge `/10 GB`, danh sách/preview bản ghi. Chỉ một device ảo giữ webcam trong giai đoạn đầu.
8. Flutter: vùng camera live, lịch sử, chọn thời gian, play/pause/seek và trạng thái trung lập (`Camera ngoại tuyến`, `Không có bản ghi`, `Bản ghi không còn khả dụng`).
9. Chạy quota test với dung lượng nhỏ và fixture tổng hợp, không tạo 10 GB dữ liệu rác. Test restart, file dở, full disk, stale metadata, đọc song song, permission revoke, offline và unpair.
10. Camera thật/microSD là phase phần cứng riêng: xác định chính xác board, PSRAM, SD bus, pin map, khả năng ghi đồng thời với stream và định dạng. README firmware hiện nói camera còn planned và firmware cửa không tích hợp camera/SD.

**Chưa chốt:** codec/container, segment duration, media transport cuối, chính sách retention theo tuổi ngoài quota, hành vi khi hết dung lượng mà vẫn live, và quy tắc giữ/xóa video khi unpair. AI tiếp theo phải trình bày tradeoff hoặc thử prototype nhỏ trước; không tự coi giả định là quyết định của người dùng.

## Mục tiêu và lộ trình tiếp theo

### Ưu tiên 1 — tiếp tục ổn định những phần đã sửa

- Rà soát run generation partial/recovery, rate-limit retry, count target/created/claimed và duplicate prevention trên source đang có.
- Kiểm tra revoke/unpair và cleanup đảm bảo không xóa dữ liệu của chủ cũ/sở hữu hiện tại sai cách.
- Rà soát regression xuyên Catalog → API/MQTT → Simulator → Flutter cho tưới tiêu, báo động, mái che và cửa.
- Trước mỗi thay đổi nhỏ, tái hiện bằng test cô lập; chạy đúng test/build của module liên quan. Không tuyên bố pass nếu chưa chạy lại trên code hiện thời.

### Ưu tiên 2 — xây dựng camera theo từng lát dọc

1. Contract + hardware feasibility prototype.
2. Simulator local storage, media index, quota/retention/recovery.
3. Thiết bị media endpoint và API session/authorization, transport server/proxy nếu cần.
4. Webcam publisher và playback trong Dashboard Simulator.
5. Flutter live/playback tiêu thụ cùng API.
6. Firmware ESP32 camera + SD adapter và kiểm thử phần cứng.
7. Hardening: auth, TLS, rate/size limits, audit, expiry/revoke, Docker volume/backup, cleanup.

Không mở `door_camera` từ `planned` thành `active` trước khi các tầng tương ứng và test contract đã có; tạo Catalog revision mới và lộ trình tương thích rõ.

### Mục tiêu dài hạn của dự án

- Hoàn thiện các product controller/sensor với firmware thật và safe local behavior.
- Chốt adapter mạng Hub–Node vật lý sau khi chọn công nghệ vô tuyến; giữ nguyên backend contract và direct fallback.
- Hoàn tất quyền thành viên, lịch sử thiết bị, operation/event và realtime UX.
- Dùng Simulator để test chức năng, tải và lỗi mạng mà không để dữ liệu kiểm thử làm bẩn hệ thống.
- Đóng gói khởi động Docker dễ hiểu, dữ liệu persistent tại E, health/preflight rõ, tài liệu vận hành có test.

## Build/test/khởi chạy để tham khảo

Chỉ chạy khi cần và sau khi đọc module config/scripts hiện thời:

```powershell
# Từ repository root: database/catalog contract
node --test database/v2-tests/database-contract.test.js
node --test shared/catalog-v2/catalog-v2.test.js

# Simulator backend
cd device-simulator/backend
npm test
npm run build

# MQTT worker
cd ../../mqtt-worker-service
npm test

# Flutter
cd ../smarthome_app
flutter test
flutter analyze

# Firmware cửa: PlatformIO cần toolchain/thư viện phù hợp
cd ../firmware/entrance-controller
pio test -e native
pio run -e esp32dev
```

Lệnh Docker khởi chạy phải đối chiếu compose/env thật trước khi dùng. Root compose chứa DB, broker và backend chính; Simulator dùng compose riêng và network ngoài. Rebuild image không đồng nghĩa đã thay đổi container đang chạy.

## Rủi ro/điểm cần hỏi hoặc xác minh sớm

- Có nhiều thay đổi chưa commit trong repo (thời điểm lập bản này, `git status --short` báo khoảng 88 entries). Giữ nguyên và phân biệt code của người dùng với phần sửa của AI.
- `.understand-anything/knowledge-graph.json` được sinh 2026-08-11, hash commit cũ; dùng để định hướng đọc, không dùng làm trạng thái hiện tại.
- README Catalog V2 có mô tả cũ/mâu thuẫn như đã nêu.
- Camera hardware còn chưa có module/pin/SD hardware profile được chốt; không sửa pin map hoặc hứa ghi/stream đồng thời trước khi thử phần cứng.
- Không giả định Docker đang chạy, hoặc dữ liệu E là dữ liệu test có thể xóa.
- Nếu yêu cầu người dùng là review/giải thích/kế hoạch, không tự ý sửa code; nếu họ nói triển khai/sửa thì mới thay đổi và báo file/test cụ thể.

## Prompt gợi ý để dùng với AI nhận bàn giao

> Đọc toàn bộ `docs/AI_HANDOFF.md` trước. Sau đó đọc `docs/architecture/README.md`, `database/README.md` và những source/test liên quan trực tiếp yêu cầu của tôi. Trước khi sửa, báo lại ngắn gọn luồng hiện tại và kiểm tra `git status --short`; giữ nguyên toàn bộ thay đổi chưa commit của tôi. Không xóa database, không reset Git, không tự chạy Docker destructive. Phân biệt rõ hành vi đã có với kế hoạch chưa làm. Với thay đổi code, sửa theo từng lát nhỏ, thêm regression tests và chạy test/build liên quan; cuối cùng báo file đã sửa, cách xử lý, kết quả xác minh và việc nào còn phụ thuộc phần cứng/quyết định của tôi.
