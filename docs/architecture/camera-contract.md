# Contract camera an ninh (v0.6)

> Trạng thái: các điểm mở đã được người dùng chốt (2026-11-04). **Đã triển khai:**
> bước 1 (backend B1–B8, Catalog revision 13, schema PostgreSQL 202), bước 2 (camera
> ảo dùng webcam/micro, mục 14.2), bước 3 (`media-relay-service`, mục 14.3) và
> bước 5 cho bản web của app (mục 14.4). Còn lại: kiểm thử đầu-cuối trên máy người
> dùng, Cloudflare Tunnel, giới hạn/audit/kiểm thử tải (mục 16).
>
> Nguồn quyết định: `docs/AI_HANDOFF.md`, mục "Quyết định camera đã chốt với
> người dùng". So với v0.1: chỉ còn **một** Product camera, chất lượng theo
> webcam/micro laptop (H.264 + AAC), làm trên Simulator trước; phần cứng thật và
> RTC để sau; truy cập từ ngoài nhà qua Cloudflare Tunnel trên tên miền của người
> dùng, video đi qua tuyến mạng riêng + Cloudflare WARP (mục 11).

## 1. Phạm vi và nguyên tắc

- Camera là **một Product riêng**: `prod_security_camera`. Nó có MAC, danh tính
  MQTT và vòng đời claim/unpair như mọi thiết bị khác, và độc lập với bộ khóa cửa.
- **Thiết bị thật và thiết bị ảo dùng chung contract này.** API Gateway, MQTT
  Worker, máy chủ media, real-time-service và Flutter không biết camera nào là ảo.
  Chúng chỉ đọc hồ sơ media của Product (mục 3).
- Product này được **phát triển trên Simulator trước**. Phần cứng thật làm sau và
  phải đáp ứng đúng hồ sơ media (mục 12).
- **MQTT chỉ chở điều khiển nhỏ** (lệnh, ACK, trạng thái, sự kiện). Hình và tiếng
  đi trên kênh media riêng (mục 6).
- **Video không được sao chép vào PostgreSQL, MongoDB hay app.** Thẻ nhớ của thiết
  bị (thật) hoặc "thẻ SD ảo" của Simulator (ảo) là nơi lưu duy nhất. Máy chủ media
  chỉ chuyển tiếp và giữ bộ đệm ngắn trong RAM.
- **Ghi hình là hành vi cục bộ.** Camera tiếp tục ghi khi mất Internet, mất MQTT
  hoặc backend dừng.

## 2. Product `prod_security_camera`

| Trường | Giá trị đề xuất |
|---|---|
| `product_id` | `prod_security_camera` |
| `ui_profile` | `security_camera` (Flutter cần profile mới) |
| `category` | `security` |
| `firmware_compatibility.family` | `security_camera` |
| `connectivity_profiles` | `["wifi"]`, **không có** `hub_node` |

Các capability instance:

| `instance_id` | Capability | Ghi chú |
|---|---|---|
| `camera` | `camera_stream` (revision 2) | Xem trực tiếp có âm thanh. `capture_snapshot` để `planned`. |
| `recording` | `video_recording` (mới) | Ghi 24/7, danh sách, phát lại, xóa, trạng thái lưu trữ |
| `system` | `system_diagnostics` | Như các Product khác |

### Không tham gia Hub–Node

Hiện tại backend đưa **mọi** thiết bị được claim vào mạng Hub–Node, nên camera có
thể bị bầu làm Hub. Contract yêu cầu: Product không có `hub_node` trong
`connectivity_profiles` **không được làm Hub và không đi relay**. Camera luôn kết nối
MQTT trực tiếp (thay đổi backend B5, mục 13).

## 3. Hồ sơ media

Khai báo trong Catalog, trên các resource của camera. Đây là trường mới, cần sửa
`catalog.schema.json`, compiler và linter.

```json
"media_profile": {
  "profile_id": "h264_aac_cmaf_v1",
  "video": {
    "codec": "h264",
    "max_width": 1920, "max_height": 1080, "max_fps": 30,
    "max_bitrate_kbps": 6000, "keyframe_interval_seconds": 2
  },
  "audio": { "codec": "aac_lc", "sample_rate_hz": 48000, "channels": 1, "bitrate_kbps": 96 },
  "container": "cmaf_fmp4",
  "fragment_seconds": 2,
  "recording": { "segment_seconds": 60 },
  "live": { "delivery": "hls", "max_viewers": 5 },
  "playback": { "delivery": "hls", "max_concurrent_sessions": 2 }
}
```

- Video **H.264, tối đa 1080p 30 khung hình/giây**. Nếu nguồn yếu hơn thì dùng đúng
  độ phân giải thật của nguồn (ví dụ webcam 720p). Độ phân giải thật được báo trong
  thuộc tính `video_resolution`.
- Âm thanh **AAC-LC 48 kHz**. Đây là định dạng điện thoại và trình phát Flutter phát
  được rộng rãi nhất.
- **Một định dạng chung cho cả ghi, phát trực tiếp và xem lại:** fMP4 chia mảnh
  2 giây (CMAF). File ghi 1 phút chỉ là các mảnh đó nối lại, nên chính các byte
  dùng để phát trực tiếp cũng là các byte được ghi vào thẻ.
- Product khác sau này (ví dụ camera giá rẻ chỉ có ảnh JPEG) là Product mới với
  `profile_id` khác. Các phần còn lại của contract giữ nguyên.

## 4. Capability

### 4.1 `camera_stream` revision 2

Thuộc tính `reported`:

| Thuộc tính | Kiểu | Ý nghĩa |
|---|---|---|
| `camera_state` | enum `offline`, `idle`, `streaming`, `unavailable`, `fault` | `unavailable`: thiết bị online nhưng không có nguồn hình (cảm biến lỗi, hoặc webcam ảo đang tắt) |
| `audio_state` | enum `ok`, `unavailable`, `fault` | Trạng thái micro |
| `video_resolution` | string, ví dụ `1280x720`, nullable | Độ phân giải thật đang ghi |
| `live_viewers` | integer 0–5 | Số người đang xem trực tiếp |

Operation:

| Operation | Quyền | Mô tả |
|---|---|---|
| `create_stream_session` | `camera.view` | Mở hoặc tham gia luồng xem trực tiếp (mục 7.1) |

Chụp ảnh nhanh (snapshot) không có trong revision 2; sẽ thêm ở revision sau.

Resource:

| Resource | `kind` | TTL phiên | Ghi chú |
|---|---|---|---|
| `live_stream` | `video_stream` | 300 giây, gia hạn được | `media_profile`, `max_concurrent_sessions: 5` |

### 4.2 `video_recording` revision 1 (mới)

Thuộc tính `reported`:

| Thuộc tính | Kiểu | Ý nghĩa |
|---|---|---|
| `recording_state` | enum `recording`, `stopped`, `waiting_time_sync`, `fault` | Trạng thái ghi |
| `storage_state` | enum `ok`, `recycling`, `missing`, `fault` | `recycling`: đầy, đang ghi vòng |
| `storage_total_bytes` | integer | Dung lượng lưu trữ |
| `storage_used_bytes` | integer | Đã dùng cho bản ghi |
| `oldest_recording_at` | datetime, nullable | Bản ghi cũ nhất còn lại |
| `newest_recording_at` | datetime, nullable | Bản ghi mới nhất đã hoàn tất |

Operation:

| Operation | Quyền | Input | Kết quả trong ACK `details` |
|---|---|---|---|
| `list_recordings` | `camera.view` | `from`, `to` (ISO 8601), `cursor?` | `ranges: [{start, end}]` (gộp các đoạn liền nhau), `next_cursor?`; tối đa 100 khoảng mỗi lần để ACK dưới 16 KB |
| `create_playback_session` | `camera.view` | `from`, `to?` | Mở phiên xem lại (mục 7.2) |
| `delete_recordings` | `camera.recording.manage` | `{from, to}` hoặc `{all: true}` | `deleted_segments`, `freed_bytes` |

Trường có dấu `?` (và `from`, `to`, `all` của `delete_recordings`) được khai báo
`"required": false` trong catalog. Quy ước chung của catalog: mọi trường input đều bắt
buộc, trừ khi ghi rõ `"required": false`. Gateway, worker (`shared/validation.js`) và
Simulator (`validateOperationInput`) cùng áp dụng quy ước này. Sửa 2026-11-08: trước đó cả
hai bộ kiểm tra bỏ qua cờ này, nên trang đầu `list_recordings` (chưa có `cursor`) bị
Gateway trả `400 OPERATION_INPUT_INVALID` và app không thấy bản ghi nào.

Event:

| Event | Mức | Khi nào |
|---|---|---|
| `storage_fault` | warning | Lưu trữ lỗi hoặc thẻ bị rút |
| `storage_recycled` | info | Ghi vòng đã xóa bản cũ; gộp tối đa 1 event mỗi giờ |
| `recordings_deleted` | info | Chủ thiết bị xóa thủ công |
| `recordings_wiped` | info | Xóa sạch khi đổi chủ hoặc unpair |

Resource:

| Resource | `kind` | TTL phiên |
|---|---|---|
| `recording_playback` | `video_stream` | 300 giây, gia hạn được (`max_concurrent_sessions: 2`) |

### 4.3 Quyền mới

| Scope | `owner_only` | `delegable` | Dùng cho |
|---|---|---|---|
| `camera.recording.manage` | true | false | Xóa bản ghi |

`camera.view` đã có. Scope mới nằm trong schema PostgreSQL 202 (bản reset sạch,
không có migration từ 201 theo quyết định của người dùng).

## 5. Kênh điều khiển MQTT

Không có topic mới. Camera dùng đúng các topic và ACL hiện có
(`docs/architecture/mqtt-security.md`):

| Hướng | Topic | Nội dung |
|---|---|---|
| Backend → camera | `smarthome/<MAC>/control` | `device.operation.v2` |
| Camera → backend | `smarthome/<MAC>/ack` | `device.operation.ack.v2` |
| Camera → backend | `smarthome/<MAC>/telemetry` | Thuộc tính mục 4 |
| Camera → backend | `smarthome/<MAC>/events` | Event mục 4.2 |
| Camera → backend | `smarthome/<MAC>/status` | Presence |

Vé kết nối media (mục 6.3) được gửi trong `context` của operation. ACL bảo đảm
chỉ đúng camera đó đọc được topic điều khiển của nó.

## 6. Kênh media

### 6.1 Máy chủ media (`media-relay-service`, dịch vụ mới)

- **Chỉ chuyển tiếp và đóng gói HLS.** Không lưu file, không chuyển mã. Chỉ giữ
  trong RAM khoảng 30 giây mảnh live gần nhất cho mỗi camera.
- Camera **chủ động kết nối ra máy chủ** (WebSocket ingest), nên không cần mở cổng
  ở nhà.
- **App xem bằng HLS qua HTTPS.** Đây là chuẩn phổ biến: trình phát có sẵn trên
  Android/iOS phát được, tua tự nhiên, và đi qua tunnel HTTP được.
- Mỗi camera có tối đa **một luồng live tới máy chủ**; máy chủ chia cho tối đa
  5 người xem. Mỗi phiên xem lại có ingest riêng; tối đa 2 phiên cùng lúc mỗi
  camera.
- Độ trễ live mục tiêu: **khoảng 3–6 giây** (HLS với mảnh 2 giây). Có thể giảm bằng
  LL-HLS sau này.

### 6.2 Giao thức ingest `smarthome-media-ingest.v1` (camera → máy chủ)

WebSocket tới `<MEDIA_INGEST_URL>` (`/v1/ingest`). Vé không nằm trong URL mà trong
message đầu tiên. Có hai loại message:
- **Văn bản (JSON), điều khiển:**
  - camera → máy chủ: `hello {protocol, session_id, ingest_token, mac, kind: live|playback, profile_id}`,
    `segment_list {segments: [{id, start, end, size, init_length, init_id}]}` (xem
    lại, gửi ngay sau `ready`), `fetch_done {request_id}`, `fetch_error {request_id, reason}`,
    `end {reason}`
  - máy chủ → camera: `ready {session_id}` (sau khi kiểm vé; camera chỉ ACK
    operation sau message này), `viewers {count}` (live), `stop {reason}`,
    `fetch {request_id, segment_id, offset, length|null}`, `cancel_fetch {request_id}`,
    `error {code, message}` rồi đóng kết nối
- **Nhị phân, dữ liệu:** 1 byte loại + dữ liệu:
  - `0x10` init segment (`ftyp`+`moov`)
  - `0x11` mảnh media (`moof`+`mdat`, hình và tiếng chung một mảnh)
  - `0x12` + `request_id` (u32 big-endian) + một phần byte của file được `fetch`

Camera gửi đúng các byte nó ghi vào thẻ, không xử lý lại. Khi thiếu băng thông,
camera bỏ mảnh live cũ chứ không giữ hàng đợi vô hạn. Bản ghi trên thẻ vẫn đầy đủ.

### 6.3 Vé kết nối

| Vé | Ai giữ | Phạm vi | Lưu ở backend |
|---|---|---|---|
| Vé xem (`access_token`, đã có) | App | Một phiên xem; nằm trong đường dẫn HLS | Chỉ hash, trong `device_resource_sessions` |
| Vé ingest (mới) | Camera | Một luồng của một camera, thời hạn ngắn | Chỉ hash |

Máy chủ media kiểm tra vé ở **mỗi** request HLS và khi mở ingest. Nguồn chuẩn là
PostgreSQL; máy chủ đọc qua Redis projection do Gateway ghi khi tạo, gia hạn và
thu hồi phiên.

## 7. Luồng nghiệp vụ

### 7.1 Xem trực tiếp

1. App gọi `POST /devices/:mac/resources/camera/live_stream/sessions`. Gateway
   kiểm tra quyền `camera.view`, số người xem (≤ 5) và camera online.
2. Gateway tạo phiên và operation `create_stream_session` (đã có), kèm vé ingest
   trong `context`.
3. Nếu camera chưa có luồng live: camera mở ingest, gửi init segment và các mảnh.
   Nếu đã có: camera chỉ ACK, người xem mới dùng chung luồng.
4. Camera ACK `succeeded`. **Gateway** tự tạo `resource_locator` là đường dẫn gốc
   của phiên trên máy chủ media: `<MEDIA_PUBLIC_URL>/v1/sessions/<session_id>/`.
   Gateway không lấy locator từ thiết bị, và không nhúng `access_token` vì token chỉ
   được lưu dạng hash (B3).
5. App ghép `<resource_locator><access_token>/index.m3u8` và phát bằng trình phát
   HLS.
6. App gia hạn phiên trước khi hết TTL bằng
   `POST /devices/:mac/resource-sessions/:id/renew`; Gateway kiểm tra lại quyền mỗi
   lần gia hạn. Khi rời màn hình, app gọi `DELETE /devices/:mac/resource-sessions/:id`.
7. Không còn người xem trong 15 giây: máy chủ gửi `stop`; camera về `idle`.

Mã lỗi: `CAMERA_OFFLINE`, `CAMERA_UNAVAILABLE` (từ thiết bị), `RESOURCE_SESSION_LIMIT`
(đã đủ người xem), `MEDIA_RELAY_NOT_CONFIGURED`.

### 7.2 Xem lại

1. App gọi `list_recordings(from, to)` để vẽ dòng thời gian từ các khoảng `ranges`.
2. App mở phiên `recording_playback` với `from` (và `to` nếu có). Camera mở ingest
   cho phiên này và gửi danh sách file 1 phút trong khoảng đó.
3. Máy chủ tạo **playlist HLS dạng VOD**. Mỗi file 1 phút là một đoạn trong playlist.
4. Khi trình phát xin một đoạn, máy chủ `fetch` file tương ứng từ camera và truyền
   ngay cho app. Tua, tạm dừng và phát tiếp do trình phát HLS tự xử lý.
5. Đoạn bị xóa trong lúc xem: máy chủ trả lỗi cho đoạn đó và gửi trạng thái
   `recording_unavailable`.

### 7.3 Ghi 24/7 và ghi vòng

- Cấu trúc lưu: `/rec/<storage_generation>/<YYYYMMDD>/<HHMMSS>.mp4`, theo UTC.
- File đang ghi có hậu tố `.part`, được đổi tên khi hoàn tất. Khi khởi động, thiết bị
  cắt file `.part` về mảnh hoàn chỉnh cuối cùng hoặc xóa nếu không dùng được.
- Khi đầy: xóa file **cũ nhất đã hoàn tất**. Không xóa file đang ghi. File đang được
  xem lại thì chờ phiên xem kết thúc.
- Lưu trữ là nguồn chuẩn cho danh sách bản ghi; không có chỉ mục ở backend.

### 7.4 Xóa bản ghi

| Tình huống | Hành vi |
|---|---|
| Đầy | Ghi vòng (7.3) |
| Chủ thiết bị xóa | `delete_recordings`; phiên xem lại đang mở trên đoạn bị xóa nhận `recording_unavailable` |
| Unpair hoặc đổi chủ | Xóa sạch (7.5) |
| Simulator dọn lần chạy | Xóa thư mục media của các camera ảo thuộc lần chạy đó |

Không xóa theo tuổi.

### 7.5 Unpair, đổi chủ, thu hồi quyền

- **Gateway:** khi unpair, thu hồi thành viên hoặc phiên hết hạn, Gateway đánh dấu
  phiên `revoked`/`expired` và cập nhật Redis projection. Máy chủ media từ chối ngay
  request HLS kế tiếp (chậm nhất khoảng 2 giây với mảnh 2 giây) và đóng ingest
  không còn người xem.
- **Ranh giới chủ sở hữu (`storage_generation`):**
  - `storage_generation` chính là `device_id` của camera trong bản phân công
    topology (`members[].device_id`). Backend tạo `device_id` mới ở mỗi lần claim
    và xóa nó khi unpair, nên không cần trường mới (B6).
  - Camera gắn generation vào thư mục ghi.
  - Khi nhận assignment rỗng (unpair), hoặc generation khác với thư mục hiện tại,
    camera **xóa sạch** bản ghi cũ, phát `recordings_wiped`, rồi mới phục vụ yêu
    cầu mới.
  - Camera đang offline lúc unpair sẽ xóa khi kết nối lại. Trong lúc đó backend
    không cấp phiên cho ai, nên chủ cũ và chủ mới đều không xem được video cũ.

## 8. Thời gian

File được đặt tên theo giờ UTC.
- **Thiết bị ảo** dùng đồng hồ của PC.
- **Thiết bị thật** (làm sau) dùng module RTC có sẵn làm đồng hồ dự phòng, đồng bộ
  NTP khi có mạng và ghi ngược giờ chuẩn vào RTC. Khi chưa có giờ hợp lệ thì ghi
  vào `unsynced/` và đổi tên sau khi có giờ.

## 9. Simulator (camera ảo), làm trước

- Webcam và micro của PC chỉ là **"cảm biến"**. Trang chi tiết thiết bị trên
  dashboard xin quyền, thu hình và tiếng, mã hóa H.264 + AAC (WebCodecs của trình
  duyệt) theo `media_profile` với độ phân giải tối đa mà webcam hỗ trợ, rồi gửi về
  backend Simulator qua một kênh nội bộ. Nếu trình duyệt không mã hóa được AAC,
  backend Simulator chuyển mã phần âm thanh; đây là việc nội bộ của "firmware ảo",
  hệ thống chính không thấy.
- **Backend Simulator đóng vai firmware:**
  - đóng gói fMP4 mảnh 2 giây, ghi file 1 phút vào thẻ SD ảo;
  - nhận operation qua MQTT bằng danh tính của chính thiết bị ảo;
  - mở ingest tới máy chủ media giống hệt camera thật.
- Thẻ SD ảo: `E:/smarthome_data/device-simulator/media/<run_id>/<mac>/<storage_generation>/...`,
  mount bền vững vào container Simulator. Một camera ảo không đọc được thư mục
  của camera khác.
- Tổng dung lượng toàn bộ camera ảo tối đa 10 GB (`SIMULATOR_MEDIA_QUOTA_BYTES`),
  ghi vòng trên toàn kho khi chạm trần. Ở 1080p khoảng 5 Mbps, mức này lưu được
  khoảng **4–5 giờ**; tăng quota nếu cần lưu lâu hơn.
  - Mỗi camera ảo báo `storage_total_bytes` bằng quota này.
  - `storage_used_bytes` là phần dữ liệu của riêng camera đó.
- Webcam chỉ bật khi người dùng bấm trong trang chi tiết thiết bị. Mỗi lúc chỉ một
  camera ảo giữ webcam.
- **Trang dashboard phải mở** thì webcam mới hoạt động, vì trình duyệt giữ quyền
  camera. Đóng trang hoặc tắt webcam:
  - `camera_state = unavailable`, ngừng ghi;
  - phiên live kết thúc với `CAMERA_UNAVAILABLE`;
  - bản ghi cũ vẫn xem lại được khi Simulator chạy.
- Thư mục file là nguồn chuẩn. Simulator có thể giữ chỉ mục trong
  `DeviceSimulatorDB` để tăng tốc, nhưng phải dựng lại được từ file khi khởi động.
- Dashboard Simulator được xem live và xem lại trực tiếp từ kho của nó. Đây là
  công cụ quản trị, không đi qua hệ thống chính.

## 10. Flutter

- Profile UI `security_camera`:
  - thẻ nhỏ (trạng thái);
  - màn hình chi tiết (live, dòng thời gian, chọn ngày, play/pause/tua, thanh
    dung lượng);
  - nút xóa, chỉ hiện với chủ thiết bị.
- Trình phát: bản web dùng `<video>` + hls.js (mục 14.4). Bản di động/desktop
  thay file `hls_video_view_stub.dart` bằng trình phát nền tảng khi cần.
- Trạng thái trung lập: `Camera ngoại tuyến`, `Không có bản ghi`,
  `Bản ghi không còn khả dụng`, `Đã đủ người xem`. Không bao giờ nhắc tới Simulator.

## 11. Truy cập từ ngoài nhà và bảo mật

### 11.1 Cloudflare Tunnel: ràng buộc cần biết

- Khi xem từ ngoài nhà, app phải tới được **cả ba dịch vụ**: API Gateway (REST),
  real-time-service (WebSocket) và máy chủ media (HLS). MQTT broker và thiết bị
  vẫn ở trong mạng nhà, không mở ra ngoài.
- Cloudflare mã hóa TLS giữa app và Cloudflare, và tunnel cũng được mã hóa. Vì vậy
  không cần tự quản lý chứng chỉ.
- **Ràng buộc điều khoản:** trên các gói Free/Pro/Business, Cloudflare **không cho
  phép truyền video** qua hostname công khai của tunnel. Việc này không áp dụng cho
  tuyến mạng riêng (private network route)
  ([Cloudflare: Delivering videos](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)).
  **Người dùng đã chọn phương án (a):**

| Dịch vụ | Cách đưa ra ngoài | Ghi chú |
|---|---|---|
| API Gateway | Tunnel, hostname công khai trên tên miền của người dùng (ví dụ `api.<tên-miền>`) | Cloudflare lo TLS |
| real-time-service | Tunnel, hostname công khai (ví dụ `ws.<tên-miền>`), WebSocket | Cloudflare lo TLS |
| Máy chủ media (HLS) | **Tuyến mạng riêng** của tunnel (Cloudflare Zero Trust); **không** có hostname công khai | Thiết bị xem cài Cloudflare WARP và đăng nhập tổ chức Zero Trust của người dùng |

- Máy chủ media có một địa chỉ riêng (ví dụ `media.<tên-miền>` trỏ tới IP trong mạng
  nhà). Ở nhà, app tới thẳng địa chỉ này qua mạng LAN; ở ngoài, WARP định tuyến tới
  đó qua tunnel. `MEDIA_PUBLIC_URL` của Gateway dùng địa chỉ này.
- WARP mã hóa đường đi, nhưng trình phát trên Android/iOS mặc định chặn HTTP không
  mã hóa. Máy chủ media cần **HTTPS bằng chứng chỉ thật** cho `media.<tên-miền>`
  (ví dụ Let's Encrypt cấp qua DNS challenge, không cần mở cổng). Phương án dự
  phòng là cho phép HTTP riêng tên miền này trong cấu hình mạng của app.
- Thiết bị dùng để demo (điện thoại hoặc laptop) phải cài sẵn WARP.
- Quick Tunnel (`trycloudflare.com`) chỉ dùng để thử nhanh; bản demo dùng tunnel cố
  định trên tên miền của người dùng.

### 11.2 Bảo mật khác

- Vé chỉ lưu dạng hash. Phiên có TTL, gia hạn phải kiểm tra lại quyền, thu hồi có
  hiệu lực từ request HLS kế tiếp.
- Đường camera ↔ máy chủ media nằm trong mạng nhà (Simulator chạy cùng máy). Camera
  thật ở mạng khác thì cần WSS.
- Vé ingest đi qua MQTT chưa mã hóa; chấp nhận được khi broker chỉ nằm trong mạng
  nhà. Cần TLS cho MQTT nếu thiết bị kết nối từ ngoài.
- Máy chủ media giới hạn: số người xem, kích thước mảnh (đề xuất ≤ 4 MB),
  băng thông mỗi luồng và thời gian rảnh.

## 12. Phần cứng thật (làm sau)

Thiết bị thật phải xuất **đúng hồ sơ `h264_aac_cmaf_v1`**: H.264 bằng phần cứng,
AAC, fMP4. ESP32-S3 không đáp ứng được (chỉ nén H.264 bằng phần mềm ở độ phân
giải rất thấp). Ứng viên là ESP32-P4 (H.264 phần cứng đến 1080p30) kèm micro và
module RTC. Nếu dùng phần cứng yếu hơn thì phải là Product khác với hồ sơ khác.
Khi bắt đầu phần cứng: làm bản thử nghiệm đo khung hình/giây, bitrate, TLS và tốc
độ ghi thẻ trước khi viết firmware.

## 13. Thay đổi backend cần có (hệ thống hiện tại chưa hỗ trợ)

| # | Thay đổi | Lý do |
|---|---|---|
| B1 ✅ | Lưu kết quả ACK (`details`, giới hạn 16 KB) vào cột `device_operations.result`; đưa vào sự kiện realtime `operation_status` (trường `result`) và thêm `GET /devices/:mac/operations/:id` | Trước đây app chỉ nhận trạng thái và mã lỗi |
| B2 ✅ | API mở phiên xem nhận body `{ input }` (ví dụ `from`, `to`), kiểm tra theo schema của operation (có định dạng `date-time`) | Phiên xem lại cần khoảng thời gian |
| B3 ✅ | Gateway tự tạo `resource_locator` cho `video_stream` (`MEDIA_PUBLIC_URL`); thêm endpoint gia hạn và đóng phiên | Trước đây locator lấy từ thiết bị |
| B4 ✅ | Giới hạn `max_concurrent_sessions` của resource (khóa theo thiết bị, không bị vượt khi tạo đồng thời); Redis projection `media:session:<id>`; kênh `media.session.revoked` khi đóng phiên, phiên lỗi và unpair | Mục 7.1, 7.5 |
| B5 ✅ | Product không có `hub_node` luôn nhận mạng riêng một thành viên (bỏ qua dấu hiệu mạng gửi lên), nên không làm Hub của thiết bị khác và không relay | Mục 2 |
| B6 ✅ | Không cần sửa: dùng `device_id` có sẵn trong assignment | Mục 7.5 |
| B7 ✅ | Vé ingest: tạo, lưu hash (`device_resource_sessions.ingest_token_hash`), gửi thiết bị trong `context` cùng `media_ingest_url`; không xuất hiện trong bản sao trạng thái lệnh gửi cho app | Mục 6.3 |
| B8 ✅ | Schema Catalog `media_profile` + `max_concurrent_sessions`; quyền `camera.recording.manage` trong schema PostgreSQL 202 | Mục 3, 4.3 |

## 14. Thay đổi Catalog (revision 13)

1. Thêm capability `camera_stream` revision 2, `video_recording` revision 1, trường
   `media_profile` trong schema.
2. Thêm Product `prod_security_camera` revision 1.
3. Thêm permission scope `camera.recording.manage` (migration PostgreSQL).
4. **Bỏ `door_camera` và `face_auth` khỏi `prod_entrance_controller`** (người dùng đã
   chốt): tăng revision Product cửa từ 5 lên 6, migrate `catalog_revision` của thiết
   bị cửa trong PostgreSQL, MongoDB và registry Simulator, đổi
   `CATALOG_REVISION` trong firmware cửa và nạp lại mạch thật. Giá trị `face` trong
   `lock_changed.source` được giữ để đọc được lịch sử cũ.

### 14.1 Camera ảo trước khi có webcam (bước 1)

Cho tới bước 2, camera ảo trả lời trung thực như một camera chưa có nguồn hình và
thẻ trống:
- `create_stream_session` → `CAMERA_UNAVAILABLE`;
- `create_playback_session` → `RECORDING_UNAVAILABLE`;
- `list_recordings` → `ranges: []`;
- `delete_recordings` → `deleted_segments: 0`.

Simulator không còn tạo locator giả `simulator://`.

### 14.2 Camera ảo dùng webcam (bước 2, đã làm 2026-11-05)

Cách triển khai mục 9, kèm các chi tiết đã chốt khi làm:

- **Phân vai.** Trình duyệt chỉ là cảm biến kiêm bộ mã hóa: WebCodecs H.264
  (Constrained Baseline trước, rồi Main, High), `latencyMode: realtime`, khung hình
  khóa mỗi 2 giây; AAC-LC 96 kbps nếu trình duyệt mã hóa được. Backend Simulator
  đóng vai firmware: đóng gói CMAF (`src/media/fmp4.ts`), ghi file, trả lời MQTT.
  Cần Chrome hoặc Edge (WebCodecs + `MediaStreamTrackProcessor`).
- **Không có AAC thì không có tiếng.** Nếu trình duyệt không mã hóa được AAC, camera
  ghi hình không tiếng và báo `audio_state = unavailable`; backend không chuyển mã
  âm thanh. Chrome/Edge trên Windows có AAC.
- **Kênh nội bộ** dashboard → backend Simulator: HTTP
  `POST /api/devices/:mac/camera/source` (bật/tắt, cấu hình giải mã) và
  `POST /api/devices/:mac/camera/chunks` (lô chunk nhị phân khoảng 0,5 giây). Gửi
  theo nhịp đầu ra của bộ mã hóa chứ không theo hẹn giờ, nên vẫn chạy khi tab bị ẩn.
  Không có dữ liệu trong 6 giây: camera về `unavailable` và đóng file đang ghi.
  Hệ thống chính không thấy kênh này.
- **File ghi:** mỗi file bắt đầu bằng init segment rồi đến các mảnh 2 giây, nên tự
  phát được. Tên file là giây bắt đầu theo UTC; file đổi ở ranh giới phút UTC hoặc
  khi bật lại nguồn. Thư mục camera dùng MAC bỏ dấu `:` vì Windows không cho dấu
  này trong tên file.
- **Thế hệ chủ sở hữu:** lấy `members[].device_id` của assignment; khi chưa nhận
  assignment, lấy `device_id` lưu lúc claim (cùng là `device_metadata.id`). Chưa
  biết thế hệ thì không ghi (`recording_state = stopped`).
- **`delete_recordings`** xóa các file 1 phút đã hoàn tất **giao** với khoảng
  `[from, to)`, hoặc tất cả khi `all = true`; file đang ghi không bao giờ bị xóa.
- **Phút đang ghi** (bổ sung 2026-11-08): `list_recordings`, `create_playback_session` và
  việc phục vụ file của phiên xem lại tính cả file phút đang ghi, tới fragment hoàn chỉnh
  cuối cùng (`SegmentWriter.snapshot()`), nên đoạn vừa quay xem lại được ngay mà không
  phải đợi hết phút. Phiên xem lại giữ kích thước đã báo của phút đó (khớp playlist), kể
  cả sau khi file `.part` được đổi tên thành `.mp4`. App làm mới dòng thời gian mỗi 20 giây
  khi đang xem lại ngày hôm nay; khoảng có bản ghi tô vàng, không có bản ghi để trắng.
  Thước thời gian phóng to/thu nhỏ liên tục từ 24 giờ xuống 2 phút (chụm hai ngón, cuộn
  chuột, nút +/−, mẫu 24 giờ · 6 giờ · 1 giờ · 15 phút · 5 phút), kéo để di chuyển; khi
  mở, tự kéo dãn để bản ghi mới nhất chiếm khoảng một phần ba thước (đoạn 5 phút → khung
  15 phút).
- **`list_recordings`** gộp các file cách nhau ≤ 3 giây thành một khoảng, tối đa
  120 khoảng mỗi trang; `next_cursor` là thời điểm kết thúc của khoảng cuối trang.
- **Live và xem lại:** khi có nguồn hình, `create_stream_session` trả
  `MEDIA_INGEST_UNAVAILABLE`. Khi có bản ghi trong khoảng, `create_playback_session`
  cũng trả `MEDIA_INGEST_UNAVAILABLE`. Hai lệnh này chạy được ở bước 3.
- **Docker:** thư mục `E:/smarthome_data/device-simulator/media` (đổi bằng
  `SIMULATOR_MEDIA_HOST_DIR`) mount vào `/var/lib/simulator-media`.
- **Kiểm thử:** file ghi từ H.264 + AAC thật (ffmpeg) giải mã sạch. Pipeline trình
  duyệt đã chạy với camera giả của Chromium: 1080p H.264, file giải mã đúng.
  Phần AAC chỉ kiểm được trên Chrome/Edge thật.

### 14.3 Máy chủ media (bước 3, đã làm 2026-11-06)

- Dịch vụ mới `media-relay-service` (Node/TypeScript, `ws`, `ioredis`), cổng **8090**
  trong `docker-compose.yml`. Chỉ chuyển tiếp và đóng gói HLS; không lưu file,
  không chuyển mã.
- **Xác thực:** đọc Redis projection `media:session:<id>` do Gateway ghi; so hash
  SHA-256 của vé (so sánh thời gian hằng); vé xem chỉ hợp lệ khi phiên `ready`, vé
  ingest hợp lệ khi `requested` hoặc `ready` và MAC khớp. Kênh
  `media.session.revoked` xóa cache và cắt kết nối ngay.
- **HLS** (đường dẫn có vé xem, CORS `*`):
  - `GET /v1/sessions/<id>/<token>/index.m3u8`: live chờ tối đa 10 giây cho 2 mảnh
    đầu; xem lại chờ `segment_list`.
  - Live: `live/init-<n>.mp4`, `live/<seq>.m4s`; cửa sổ 15 mảnh (khoảng 30 giây);
    đổi init segment thì thêm `EXT-X-DISCONTINUITY`.
  - Xem lại: playlist VOD, mỗi file 1 phút là một đoạn `rec/<file>/media.m4s` (file
    bỏ phần init), `rec/<file>/init.mp4` làm `EXT-X-MAP`; mỗi đoạn có
    `EXT-X-PROGRAM-DATE-TIME`; khoảng trống > 3 giây hoặc đổi init thì
    `EXT-X-DISCONTINUITY`.
- **Live dùng chung:** một ingest mỗi camera; người xem thứ hai trở đi chỉ tạo
  phiên mới, camera ACK ngay. Máy chủ báo số người xem (`viewers`) để camera báo
  `live_viewers`. Không còn request HLS nào trong 15 giây (sau 25 giây đầu) thì máy
  chủ gửi `stop`; camera về `idle`.
- **Xem lại:** máy chủ `fetch` file từ camera khi trình phát xin đoạn đó và truyền
  thẳng cho app; camera giới hạn bộ đệm gửi 4 MB. Phiên xem lại không có request
  trong 90 giây, hết hạn hoặc bị thu hồi thì máy chủ đóng ingest.
- **Camera ảo:** `src/media/ingest-client.ts` dùng WebSocket có sẵn của Node 22;
  mảnh live là đúng các byte được ghi vào thẻ; bỏ mảnh khi bộ đệm gửi vượt 8 MB.
  Tối đa 720 file (12 giờ) mỗi phiên xem lại.
- **Cấu hình:** Compose đặt cho Gateway `MEDIA_PUBLIC_URL`
  (mặc định `http://localhost:8090`, URL trình phát của app mở) và `MEDIA_INGEST_URL`
  (mặc định `ws://media-relay-service:8090/v1/ingest`); đổi bằng file `.env` ở thư
  mục gốc.
- **Kiểm thử:** test relay (vé, chia sẻ live, dừng khi hết người xem, VOD, fetch)
  và test đầu-cuối camera ảo + relay. Với H.264 + AAC thật, ffprobe đọc được cả
  playlist live lẫn VOD qua relay, ffmpeg giải mã sạch.

### 14.4 Flutter web (bước 5, đã làm 2026-11-06)

- Profile `security_camera`: thẻ nhỏ (trạng thái, ghi hình, bộ nhớ; không có biểu
  tượng Hub–Node) và trang chi tiết là chính khung video (`CameraViewerPanel`): vào
  trang là tự mở xem trực tiếp, không có hero, Hub–Node hay chẩn đoán (2026-11-07,
  theo yêu cầu người dùng).
- Khung video: bắt đầu ở chế độ tắt tiếng; lớp điều khiển riêng (nhãn TRỰC TIẾP,
  số người xem, phát/dừng khi xem lại, bật tiếng, toàn màn hình) chạy hls.js
  (`web/vendor/hls/hls.min.js`, bản 1.6.15, Apache-2.0); dòng thời gian 24 giờ theo
  ngày, chọn ngày, chọn đoạn; tua trong phiên dựa trên `EXT-X-PROGRAM-DATE-TIME`;
  xóa bản ghi trong ngày hoặc toàn bộ (chủ thiết bị hoặc người có
  `camera.recording.manage`), có hộp xác nhận.
- Phiên được gia hạn 60 giây trước khi hết hạn và đóng khi rời màn hình hoặc
  chuyển tab.
- Chỉ bản web có trình phát; bản Android/Windows hiện thông báo.

## 15. Quyết định đã chốt (2026-11-04)

1. Video từ ngoài nhà: **phương án (a)**, tuyến mạng riêng Cloudflare + WARP
   (mục 11.1).
2. Tên miền: người dùng **đã có**, dùng cho tunnel cố định.

## 16. Thứ tự triển khai đề xuất

1. Backend B1–B8 (mục 13) và Catalog revision 13, kèm migration bộ khóa cửa.
2. Simulator: webcam/micro → H.264 + AAC → fMP4, ghi file 1 phút vào thẻ SD ảo,
   quota 10 GB.
3. `media-relay-service`: ingest, HLS live, HLS xem lại; phiên trên Gateway, thu hồi.
4. Kiểm thử đầu-cuối bằng camera ảo, không cần phần cứng.
5. Flutter: profile `security_camera`, trình phát HLS, dòng thời gian, xóa.
6. Cloudflare Tunnel: hostname công khai cho API/WebSocket, tuyến mạng riêng + WARP
   cho máy chủ media, chứng chỉ HTTPS cho `media.<tên-miền>`; demo từ ngoài nhà.
7. Giới hạn, audit, kiểm thử tải. Phần cứng thật ở giai đoạn sau (mục 12).
