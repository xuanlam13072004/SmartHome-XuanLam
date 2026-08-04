# Kiến trúc cốt lõi SmartHome V2

## 1. Trạng thái tài liệu

Đây là kiến trúc đích dùng để định hướng Product Catalog, database, backend,
MQTT, Simulator, Flutter và firmware. Tài liệu không tự cho phép migration hoặc
xóa dữ liệu. Mọi thay đổi database cần một bản thiết kế và cổng duyệt riêng.

## 2. Nguyên tắc bất biến

1. ESP32 là execution authority cho logic Product.
2. ESP32 là state authority cho trạng thái vật lý và điều kiện an toàn.
3. Backend là control plane cho danh tính, quyền, topology và remote intent.
4. Hub/Node là vai trò runtime của network, không phải loại Product cố định.
5. Backend bầu Hub; thiết bị thực thi assignment nhận được.
6. Node tự fallback MQTT trực tiếp khi không dùng được Hub.
7. Mất cloud không được vô hiệu hóa chức năng cục bộ thiết yếu.
8. Backend không biến command request thành reported state.

## 3. Ba miền trách nhiệm

### 3.1. Product execution plane

Chạy trên ESP32 hoặc trên một `DeviceRuntime` tương đương trong Simulator:

- đọc cảm biến và input vật lý;
- điều khiển servo, motor, relay, còi, quạt, bơm và LCD;
- xác thực PIN cục bộ;
- thực thi local automation/schedule;
- áp dụng interlock và safety constraint;
- lưu cấu hình cần hoạt động offline;
- dedupe command và phát ACK sau khi thực thi;
- phát reported state, event và diagnostics.

### 3.2. Network control plane

Chạy trên backend:

- quản lý device identity và ownership;
- quản lý network membership và thứ tự ưu tiên Hub;
- bầu Hub và phát topology assignment có version/lease;
- xác thực quyền remote command;
- định tuyến command theo route quan sát được;
- ghi audit/outbox và đồng bộ read model.

Backend không thực thi logic actuator hoặc safety policy thay cho ESP32.

### 3.3. Data plane

Chạy trên ESP32 Hub/Node và MQTT infrastructure:

- Node ưu tiên gửi dữ liệu qua Hub khi route relay khả dụng;
- Hub chuyển tiếp nguyên danh tính, sequence và payload của Node;
- Node dùng MQTT trực tiếp nếu Hub không dùng được;
- khi Hub mới sẵn sàng, Node kiểm tra kết nối rồi mới quay lại relay;
- command và ACK giữ nguyên `command_id` khi đổi route.

## 4. Ma trận nguồn sự thật

| Concern | Nguồn sự thật | Bản sao/quan sát |
| --- | --- | --- |
| Trạng thái vật lý | ESP32 | MongoDB shadow, App |
| Logic an toàn và automation cục bộ | Firmware/config trên ESP32 | Backend có thể giữ bản cấu hình đã đồng bộ |
| Tài khoản và phiên đăng nhập | PostgreSQL | Redis cache |
| Ownership và quyền | PostgreSQL | Redis/API read model |
| Network membership và Hub assignment | PostgreSQL | Redis, MongoDB diagnostics, device assignment |
| Route hiện tại của từng thiết bị | Thiết bị + backend observation | Redis/MongoDB runtime view |
| Telemetry và event history | MongoDB | Dashboard/read API |
| Product contract đã phát hành | Versioned Catalog | Cache hoặc published read model |

MongoDB shadow là reported-state mirror, không phải nguồn tạo ra trạng thái vật
lý. PostgreSQL có thể giữ remote intent/command lifecycle nhưng không được ghi
thay reported state.

## 5. Command contract

```text
App tạo remote intent
  -> Gateway xác thực identity, ownership/permission và payload
  -> PostgreSQL ghi command PENDING + outbox
  -> MQTT Worker chọn route và publish
  -> ESP32 dedupe, kiểm tra local safety, thực thi hoặc từ chối
  -> ESP32 phát ACK success/error
  -> ESP32 phát reported state/event mới
  -> Backend cập nhật command status và MongoDB shadow
  -> App nhận realtime update
```

Các trạng thái command tối thiểu:

- `pending`: đã được backend tiếp nhận;
- `sending`: worker đang xử lý;
- `sent`: đã publish nhưng chưa biết kết quả vật lý;
- `acked`: thiết bị xác nhận thực thi thành công;
- `failed`: thiết bị từ chối hoặc lỗi thực thi;
- `timeout`: không nhận được kết quả trong thời hạn.

ACK success và reported state là hai thông tin liên quan nhưng không thay thế
nhau. Với actuator chậm, ACK có thể xác nhận đã nhận/chấp nhận operation và event
hoàn tất sẽ xác nhận kết quả cuối; policy này phải được khai báo theo operation.

## 6. Offline contract

- Nút vật lý, safety response, keypad/PIN, schedule và control loop cục bộ không
  phụ thuộc backend.
- Remote command không thể đến khi không có đường mạng; firmware không suy diễn
  remote command bị thiếu.
- Telemetry có thể buffer có giới hạn theo Product/hardware rồi phát lại với
  sequence và timestamp gốc.
- Config từ backend chỉ có hiệu lực sau khi firmware validate, lưu thành công và
  ACK version tương ứng.
- Reconnect phải reconcile theo version, không ghi đè mù quáng config mới hơn
  trên thiết bị.

## 7. Hub-Node contract

- Backend phát topology chính thức và chọn Hub theo eligibility, online evidence
  và `join_rank`.
- Assignment mang `network_id`, `topology_epoch`, role và Hub identity.
- Hub chỉ relay khi assignment/lease còn hợp lệ.
- Node tự phát hiện lỗi đường local đến Hub và chuyển direct ngay.
- Direct fallback là trạng thái của từng Node, không phải bằng chứng duy nhất để
  kết luận Hub đã chết.
- Backend bầu Hub mới khi Hub lease/presence thực sự hết hoặc có bằng chứng lỗi
  đủ mạnh.
- Hub cũ quay lại không tự giành vai trò.

Chi tiết state machine và wire contract nằm trong
`hub-node-domain-contract.md`.

## 8. Product Catalog là contract, không phải cloud program

Catalog mô tả:

- state/event/resource mà firmware có thể phát;
- operation/config intent mà App có thể yêu cầu;
- schema và quyền backend phải kiểm tra;
- local safety firmware phải thực thi;
- offline behavior và persistence;
- ACK/completion semantics;
- metadata hiển thị cho App.

Catalog không chứa workflow để backend điều khiển GPIO hoặc tự chạy logic an
toàn. `expected effect` chỉ phục vụ UI/timeout/reconciliation, không cho phép
backend tự ghi reported state.

## 9. Ranh giới lưu trữ

### PostgreSQL

Chỉ giữ dữ liệu cần transaction và consistency: identity, ownership, permission,
network topology, command intent/lifecycle, audit và outbox.

### MongoDB

Giữ dữ liệu linh hoạt/cường độ cao: device shadow, telemetry, event, incident,
diagnostics và lịch sử quan sát route/topology.

### Redis

Chỉ là cache/runtime coordination: presence, lease, election lock, route
observation và invalidation. Redis không là nguồn duy nhất của ownership hoặc
Hub assignment lâu dài.

## 10. Security boundary

- Mỗi thiết bị thật cần danh tính/credential riêng.
- Hub không được biết private credential của Node.
- Relay payload phải bảo toàn danh tính và bằng chứng nguồn của Node.
- Wi-Fi password chỉ tồn tại ở provisioning endpoint và device secure storage;
  không dùng làm network identity và không ghi log/database.
- Credential Product như PIN không đi qua generic telemetry/log.
- Backend xác thực ai được yêu cầu đổi PIN; firmware lưu và kiểm tra PIN cục bộ.

## 11. Cổng triển khai

1. Duyệt kiến trúc và invariant.
2. Duyệt lần lượt bốn Product contract.
3. Duyệt ERD PostgreSQL và MongoDB collections.
4. Duyệt migration/cleanup cụ thể.
5. Cập nhật runtime và Simulator.
6. Chạy contract, offline, failover, restart, security và load test.

Không được dùng schema để dẫn dắt ngược Product behavior; database chỉ được
thiết kế sau khi domain contract ổn định.
