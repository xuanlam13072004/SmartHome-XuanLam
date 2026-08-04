# Product Contract — Bộ Kiểm Soát Cửa Chính

## 1. Trạng thái

- Product ID: `prod_entrance_controller`
- Catalog revision: `1`
- Lifecycle: `draft`
- Contract maturity: `edge_reviewed`
- Runtime hiện tại: chưa kết nối Product V2 vào Gateway/Simulator/Flutter

`edge_reviewed` nghĩa là ranh giới ESP32/backend đã được mô tả và được linter
kiểm tra. Product chưa được `approved` vì còn câu hỏi phần cứng và protocol.

## 2. Phần cứng trong phạm vi

| Phần cứng | Vai trò |
| --- | --- |
| ESP32/ESP32-CAM | Chạy logic cục bộ, camera, Wi-Fi/MQTT và Hub-Node data plane |
| Servo SG90 | Đưa cơ cấu chốt về vị trí khóa/mở khóa |
| LCD 4x20 | Hiển thị bốn dòng, tối đa 20 ký tự mỗi dòng |
| Keypad 4x4 | Nhập PIN và thao tác cục bộ |

Không khai báo RFID, fingerprint, cảm biến cửa, limit switch hoặc cảm biến dòng
servo vì chưa được xác nhận có trên phần cứng.

## 3. Ranh giới trách nhiệm

### ESP32

- đọc keypad và không phát nội dung PIN thô;
- kiểm tra PIN/face credential cục bộ;
- áp dụng lockout sau nhiều lần xác thực thất bại;
- điều khiển servo và quyết định kết quả operation;
- quản lý nội dung/ưu tiên LCD;
- tạo camera frame, snapshot và video stream;
- lưu credential verifier/template trong secure storage;
- hoạt động xác thực cục bộ khi backend mất kết nối;
- phát ACK, reported state, event và diagnostics.

### Backend

- xác thực account và permission;
- chỉ owner có `credential.manage` mới được yêu cầu đổi PIN/face template;
- phát remote intent/command và chờ thiết bị xác nhận;
- cấp quyền/session ngắn hạn để xem camera;
- lưu command lifecycle, shadow và lịch sử sự kiện;
- không tự xác nhận servo đã khóa/mở hoặc credential đã được lưu.

## 4. Capability đang hoạt động

| Instance | Chức năng | Offline | Nơi thực thi |
| --- | --- | --- | --- |
| `main_lock` | Điều khiển vị trí chốt bằng SG90 | Điều khiển cục bộ vẫn hoạt động | ESP32 |
| `door_camera` | Stream và snapshot có session | Camera cục bộ vẫn dùng cho xác thực; App stream cần mạng | ESP32 + backend session |
| `face_auth` | Xác thực khuôn mặt | Hoạt động cục bộ | ESP32 |
| `pin_auth` | Xác thực và quản lý PIN | Xác thực cục bộ hoạt động | ESP32 |
| `keypad` | Phát action đã được làm sạch | Hoạt động cục bộ | ESP32 |
| `lcd` | Đọc nội dung thực tế và đặt thông báo tạm | Firmware/LCD vẫn hoạt động | ESP32 |
| `system` | Firmware, uptime, RSSI và connectivity | Thu thập cục bộ | ESP32 |

## 5. Lock/Servo contract

Remote `lock`/`unlock` chỉ là intent. ESP32 phải kiểm tra trạng thái firmware và
servo trước khi thực thi. Operation hoàn tất khi ESP32 báo reported
`lock_state`, không phải khi backend publish MQTT.

Với phần cứng hiện được xác nhận, `lock_state` có nghĩa là vị trí chốt mà firmware
đã điều khiển:

- `unknown`
- `locking`
- `locked`
- `unlocking`
- `unlocked`

Nó không chứng minh cửa vật lý đã đóng hoặc chốt không bị kẹt. Vì chưa có cảm
biến phản hồi nên Product không khai báo `jammed`. Nếu sau này thêm limit switch,
door contact hoặc current sensing, contract sẽ tăng revision và bổ sung trạng
thái vật lý tương ứng.

## 6. PIN và credential contract

Luồng đổi PIN từ App:

```text
Owner nhập PIN mới
  -> Gateway re-check identity và credential.manage
  -> PIN đi qua kênh bảo vệ, không ghi log/telemetry/history
  -> ESP32 validate độ dài/định dạng
  -> ESP32 lưu verifier vào secure storage
  -> ESP32 ACK persisted_on_device
  -> Backend chỉ lưu job metadata/status, không coi request là thành công sớm
```

PIN verification diễn ra trên ESP32 và vẫn hoạt động offline. Event chỉ chứa
credential ID hoặc kết quả đã làm sạch; không chứa PIN, hash có thể tái sử dụng
hoặc secret.

Trong mô hình sharing tương lai, `credential.manage` là owner-only và
non-delegable. Người được chia sẻ quyền xem/điều khiển không tự động có quyền đổi
PIN.

## 7. LCD 4x20 contract

- `displayed_lines` luôn có đúng bốn phần tử.
- Mỗi dòng tối đa 20 ký tự theo encoding firmware hỗ trợ.
- App có thể đặt thông báo tùy chỉnh có thời hạn.
- Thông báo authentication/safety của firmware luôn ưu tiên hơn custom message.
- ACK thành công khi ESP32 đã áp dụng nội dung; App đọc lại nội dung thật từ
  reported state.
- Custom message không được dùng làm nguồn chứa secret.

## 8. Camera contract

- Frame/video được tạo bởi ESP32-CAM.
- Backend chỉ xác thực quyền và tạo session ngắn hạn.
- URL/token session không phải device state.
- Stream App không hoạt động khi mất mạng; camera vẫn có thể phục vụ logic xác
  thực cục bộ.
- Snapshot/video không được nhét vào MongoDB telemetry. Khi cần lưu media, sẽ
  dùng object storage riêng và MongoDB chỉ giữ metadata/event reference.

## 9. Luồng command và state

```text
App -> command PENDING -> MQTT route -> ESP32
ESP32 validate -> thực thi/từ chối -> ACK
ESP32 -> reported state/event -> MongoDB shadow/history -> App
```

Compiled Catalog chỉ phát `firmware_default_state` cho firmware/Simulator khởi
tạo. Gateway claim phải dùng `reported_state_seed_policy = device_report_only`
và chờ báo cáo đầu tiên từ ESP32.

## 10. Câu hỏi cần xác nhận trước `approved`

1. Góc servo khóa/mở và hành vi an toàn khi boot/restart.
2. Có thêm door contact, limit switch hoặc current sensing hay không.
3. Auto-relock delay mặc định và cách hủy auto-relock tại chỗ.
4. Encoding LCD: ASCII, UTF-8 rút gọn hay bảng ký tự tùy chỉnh.
5. PIN dài bao nhiêu, số lần sai và thời gian lockout.
6. Thuật toán nhận diện/enrollment phù hợp bộ nhớ ESP32-CAM.
7. Giao thức stream: MJPEG, WebRTC gateway hoặc giao thức khác.
8. Credential/material có cần recovery sau factory reset hay phải enrollment lại.

## 11. Điều kiện nghiệm thu Product 1

- Không có capability cho phần cứng chưa tồn tại.
- Mọi reported/diagnostic property có authority là device firmware.
- Mọi physical operation chạy trên ESP32 và có ACK/completion rõ ràng.
- PIN/face credential hoạt động offline và chỉ thành công sau secure persistence.
- LCD đúng 4x20 và firmware message có quyền ưu tiên.
- Camera resource do device tạo, backend cấp quyền theo session.
- Backend không seed reported shadow từ firmware defaults.
- Linter từ chối capability edge-reviewed thiếu bất kỳ invariant nào ở trên.
