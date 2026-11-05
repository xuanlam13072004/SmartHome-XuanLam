# Contract camera an ninh (v0.4)

> Trạng thái: các điểm mở đã được người dùng chốt (2026-11-04). **Bước 1 (backend
> B1–B8, Catalog revision 13, schema PostgreSQL 202) đã triển khai**; các bước 2–7
> chưa làm (mục 16).
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

WebSocket. Có hai loại message:
- **Văn bản (JSON), điều khiển:**
  - camera → máy chủ: `hello` (mac, session, `profile_id`, độ phân giải), `segment_list` (trả lời `list`), `end` (lý do)
  - máy chủ → camera: `stop`, `fetch {segment_start}`, `cancel_fetch`
- **Nhị phân, dữ liệu:** 1 byte loại + dữ liệu:
  - `0x10` init segment (`ftyp`+`moov`)
  - `0x11` mảnh media (`moof`+`mdat`, hình và tiếng chung một mảnh)
  - `0x12` một phần file ghi được `fetch` (xem lại)

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
- Trình phát HLS có sẵn của nền tảng (gói `video_player`; trên web dùng thư viện
  HLS cho trình duyệt).
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
