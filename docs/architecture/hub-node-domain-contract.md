# Hub–Node Domain Contract

> Tài liệu này là phần chuyên sâu của `v2-core-architecture.md`. Backend là
> control plane quyết định topology; ESP32 là data plane thực thi assignment và
> tự fallback. Logic Product và trạng thái vật lý vẫn thuộc ESP32.

## 1. Mục tiêu

Tài liệu này khóa các quy tắc nghiệp vụ và ranh giới dữ liệu trước khi thay đổi
PostgreSQL, MQTT Worker, Device Simulator hoặc Flutter.

Kiến trúc phải hỗ trợ:

- Một tài khoản có thể sở hữu thiết bị trên nhiều mạng Wi-Fi khác nhau.
- Network là thực thể hạ tầng độc lập với danh tính account; owner chỉ là người
  quản trị ban đầu trong mô hình hiện tại.
- Mỗi mạng có đúng một Hub đang hoạt động khi mạng có thiết bị khả dụng.
- Mọi thiết bị đều có khả năng trở thành Hub.
- Thiết bị tham gia mạng đầu tiên được ưu tiên làm Hub đầu tiên.
- Những thiết bị tham gia sau có thứ tự ưu tiên lên Hub thấp dần.
- Khi Hub lỗi, các Node chuyển sang kết nối trực tiếp với server để không làm
  gián đoạn telemetry và điều khiển.
- Khi Hub mới sẵn sàng, các Node quay về đường truyền qua Hub.
- Khi người dùng unpair thiết bị, thiết bị trở về trạng thái chưa sở hữu.
- Nếu thiết bị bị unpair là Hub, thiết bị còn lại có ưu tiên cao nhất được bầu
  làm Hub mới trong cùng giao dịch dữ liệu.

## 2. Hiện trạng đã xác minh

Nền tảng Hub-Node đã được triển khai qua migration V6 và các service runtime:

- Có `device_networks`, `network_id`, `join_rank`, `topology_epoch` và
  `topology_outbox` trong PostgreSQL.
- Claim/unpair cập nhật ownership và topology trong cùng transaction.
- Topology Coordinator bầu Hub dựa trên lease, online evidence và join rank.
- MQTT Worker validate relay/direct fallback, route command và kiểm tra ACK.
- Device Simulator mô phỏng Hub relay, Node fallback và topology ACK.
- Flutter/Dashboard đã có read model topology phục vụ diagnostics.

Các điểm chuyển tiếp còn phải sửa trước V2 cutover:

- Network identity vẫn bị scope bởi `owner_id`.
- Direct fallback override hiện được lưu theo cả network thay vì từng Node.
- Node direct fallback có thể bị từ chối khi Hub lease backend vẫn còn sống.
- Simulator chưa có behavior profile đầy đủ cho từng Product.
- MQTT identity hiện chưa đủ an toàn cho relay trên phần cứng thật.

Cột `gateway_id` cũ không được dùng làm nền tảng mới vì tên và ý nghĩa không đủ
rõ. Cột này chỉ được giữ tạm cho compatibility rồi loại bỏ khi consumer cũ đã
được chuyển đổi.

## 3. Thuật ngữ

### Device Network

Một nhóm thiết bị cùng thuộc một mạng vật lý đã được xác định trong quá trình
provisioning.

Network không đồng nghĩa với account. Một account có thể quản lý nhiều network
và kiến trúc tương lai có thể cho nhiều account truy cập cùng một network mà
không tạo topology trùng lặp.

### Network Fingerprint

Chuỗi opaque dùng để nhận diện một mạng vật lý. Backend không lưu mật khẩu
Wi-Fi, SSID thô hoặc thông tin modem thô.

Provisioning layer chịu trách nhiệm tạo fingerprint ổn định. API chỉ nhận chuỗi
đã băm/HMAC. Simulator sinh fingerprint xác định được từ seed và simulated
network index.

### Join Rank

Số nguyên tăng dần, bất biến trong suốt một lần sở hữu thiết bị trên network.
Số nhỏ hơn có quyền ưu tiên lên Hub cao hơn.

Nếu thiết bị bị unpair rồi claim lại, thiết bị nhận join rank mới.

### Active Hub

Thiết bị đang giữ vai trò Hub của network tại topology epoch hiện tại. Vai trò
này được suy ra từ `device_networks.active_hub_device_id`, không phải thuộc tính
cố định của product.

### Topology Epoch

Số nguyên tăng đơn điệu mỗi khi Active Hub hoặc topology assignment thay đổi.
Mọi thiết bị phải bỏ qua assignment có epoch thấp hơn epoch đã biết.

Epoch là fencing token để ngăn Hub cũ tiếp tục relay sau khi Hub mới đã được
bầu.

### Transport Mode

Trạng thái runtime, không phải quyền sở hữu:

- `hub`: thiết bị đang là Active Hub.
- `relay`: Node đang truyền qua Active Hub.
- `direct_fallback`: Node kết nối trực tiếp với server trong lúc Hub lỗi hoặc
  topology đang hội tụ.
- `offline`: bản thân thiết bị không thể gửi dữ liệu bằng cả relay và direct.

Không dùng trạng thái user-facing `unreachable`. Việc mất riêng đường Hub không
được phép làm thiết bị hiện offline nếu direct fallback vẫn hoạt động.

## 4. Nguồn sự thật

### ESP32

Là source of truth cho:

- Trạng thái vật lý và kết quả actuator.
- Khả năng liên lạc cục bộ từ chính Node tới Hub.
- Logic Product, local automation và safety interlock.

Backend không được suy ra reported state chỉ từ command hoặc topology.

### PostgreSQL

Là source of truth cho:

- Quyền sở hữu thiết bị.
- Network membership.
- Join rank.
- Active Hub.
- Topology epoch.
- Transactional topology outbox.

`owner_id` trong `device_networks` hiện là ràng buộc chuyển tiếp, không phải
định nghĩa danh tính network của V2.

### Redis

Là runtime/cache cho:

- Active topology theo network.
- Hub lease ngắn hạn.
- Direct/relay route hiện tại của từng thiết bị.
- Election lock và topology invalidation.

Redis không được là nguồn duy nhất quyết định quyền sở hữu hoặc Hub lâu dài.
Route fallback phải có key theo device; một Node fallback không được ép toàn bộ
network chuyển route.

### MongoDB chính

Lưu device shadow và bản sao topology/route phục vụ đọc nhanh:

- `network_id`
- `active_hub_mac`
- `topology_epoch`
- `transport_mode`
- `last_transport_change`

Các trường topology được đồng bộ từ PostgreSQL/Redis. Reported state chỉ được
cập nhật từ telemetry/event của ESP32; tất cả đều là read model và không được
dùng để tự ý thay đổi ownership hoặc trạng thái vật lý.

### Device Simulator Registry

Lưu thông tin mô phỏng riêng:

- Simulated network.
- Join rank.
- Assigned role.
- Transport mode.
- Hub heartbeat/failure profile.
- Topology epoch đã nhận.

Registry không thay thế topology source of truth của hệ thống chính.

## 5. Mô hình PostgreSQL chuyển tiếp hiện tại

Mô hình dưới đây đã tồn tại trong V1 migration V6. Nó được giữ để runtime hiện
tại hoạt động, không được coi là ERD V2 cuối cùng. ERD V2 sẽ được thiết kế sau
khi Product contract được duyệt, đặc biệt để tách network identity khỏi account.

### `device_networks`

- `id uuid primary key`
- `owner_id uuid not null`
- `network_fingerprint text not null`
- `active_hub_device_id uuid null`
- `topology_epoch bigint not null default 0`
- `next_join_rank bigint not null default 1`
- `topology_state text not null`
- `created_at timestamptz not null`
- `updated_at timestamptz not null`
- Unique: `(owner_id, network_fingerprint)`

`topology_state` chỉ gồm:

- `stable`
- `degraded_direct`
- `electing`
- `empty`

### `device_metadata`

Bổ sung:

- `network_id uuid null`
- `join_rank bigint null`

Ràng buộc:

- Một device chỉ thuộc tối đa một network.
- `(network_id, join_rank)` là duy nhất khi `network_id` khác null.
- `join_rank` không thay đổi trong thời gian ownership còn hiệu lực.

### `topology_outbox`

Ghi topology change trong cùng transaction với claim, unpair hoặc election:

- Event ID đơn điệu.
- Network ID.
- Topology epoch.
- Reason.
- Payload assignment.
- Attempts, last error và processed time.

Không publish Redis/MQTT trực tiếp trước khi PostgreSQL commit.

## 6. Claim contract

Claim request được mở rộng với:

- `network_fingerprint`: chuỗi opaque bắt buộc đối với provisioning Hub–Node.
- `name`: giữ nguyên tùy chọn hiện tại.

Luồng transaction:

1. Xác thực factory device và secret.
2. Lock network theo `(owner_id, network_fingerprint)`.
3. Tạo network nếu chưa tồn tại.
4. Cấp `join_rank = next_join_rank`, sau đó tăng `next_join_rank`.
5. Ghi ownership và network membership.
6. Nếu network chưa có Hub, gán thiết bị này làm Active Hub.
7. Tăng topology epoch vì membership/assignment đã thay đổi.
8. Ghi device shadow outbox và topology outbox.
9. Commit.
10. Dispatcher đồng bộ MongoDB, Redis và topology assignment.

Trong giai đoạn tương thích, claim không có fingerprint tạo một network cô lập
cho chính thiết bị đó. Không tự gom tất cả thiết bị cũ của một owner vào cùng
một network.

## 7. Unpair contract

Luồng transaction:

1. Lock device ownership và network liên quan.
2. Xóa ownership/membership và trả `factory_devices.is_claimed = false`.
3. Nếu thiết bị không phải Active Hub, giữ nguyên Hub nhưng vẫn tăng epoch vì
   network membership đã thay đổi.
4. Nếu thiết bị là Active Hub:
   - Chọn device còn sở hữu có `join_rank` nhỏ nhất.
   - Gán device đó làm Hub mới.
   - Tăng topology epoch.
   - Chuyển network sang `electing`; các Node dùng direct fallback cho đến khi
     Hub mới ACK đúng epoch, sau đó network mới trở lại `stable`.
5. Nếu không còn device, đánh dấu network `empty`; giữ lại network để bảo toàn
   fingerprint, join-rank monotonic và lịch sử outbox.
6. Ghi shadow outbox và topology outbox.
7. Commit rồi mới phát sự kiện.

Thiết bị đã unpair phải bị xóa khỏi topology cache và không được phép relay hay
publish telemetry cho owner cũ.

## 8. Failover contract

### Phát hiện lỗi

- Hub có lease riêng, ngắn hơn device presence lease.
- Node đồng thời theo dõi heartbeat cục bộ của Hub.
- Khi mất heartbeat Hub, Node chuyển sang `direct_fallback` trước khi device
  presence lease hết hạn.
- Node không chờ backend cho phép fallback và fallback của một Node không tự
  kết luận Active Hub đã hỏng.

### Bầu Hub

1. Topology Coordinator nhận Hub lease expiry.
2. Network chuyển sang `degraded_direct`.
3. Coordinator lấy election lock và lock PostgreSQL network row.
4. Chọn device online/đang direct có `join_rank` nhỏ nhất, loại Active Hub cũ.
5. Gán Hub mới, tăng topology epoch và ghi topology outbox.
6. Hub mới xác nhận assignment.
7. Node chuyển từ direct sang relay.
8. Network trở lại `stable`.

Hub cũ hồi phục không tự giành lại vai trò. Nó nhận epoch mới và tham gia lại
như một Node. Chỉ bầu lại khi Active Hub hiện tại lỗi hoặc bị unpair. Quy tắc
này tránh topology flap.

### Split-brain protection

- Mọi relay envelope và topology ACK mang topology epoch.
- MQTT Worker chỉ chấp nhận relay từ Active Hub đúng epoch.
- Hub cũ với epoch thấp bị từ chối.
- Command phải idempotent theo `command_id` tại thiết bị đích.

## 9. MQTT contract mục tiêu

### Telemetry

Payload luôn giữ MAC của thiết bị nguồn, kể cả khi Hub relay:

```json
{
  "device_id": "NODE_MAC",
  "seq": 42,
  "metrics": {},
  "transport": {
    "mode": "relay",
    "hub_mac": "HUB_MAC",
    "network_id": "NETWORK_UUID",
    "topology_epoch": 7
  }
}
```

Direct fallback dùng `mode = direct_fallback`; `hub_mac` có thể chứa Hub được
assignment gần nhất để chẩn đoán nhưng không được coi là origin.

MQTT Worker phải đối chiếu:

- Device nguồn còn ownership.
- Device nguồn thuộc network khai báo.
- Relay Hub là Active Hub của network.
- Epoch bằng epoch hiện tại.
- Topic origin khớp `device_id`.

Direct fallback hợp lệ không bị từ chối chỉ vì Hub lease còn sống. Worker ghi
route observation theo device; Topology Coordinator vẫn dùng Hub lease/presence
để quyết định có bầu Hub mới hay không.

### Command

- Stable relay: command được gửi vào Hub downlink kèm target MAC.
- Direct fallback: command được gửi thẳng đến target MAC.
- Trong cửa sổ chuyển trạng thái, retry có thể đổi route nhưng giữ nguyên
  `command_id`.
- Thiết bị đích phải dedupe command để tránh thực thi hai lần.

### ACK

ACK luôn mang target device MAC, route và topology epoch. Hub chỉ forward ACK,
không thay đổi danh tính thiết bị đích.

## 10. Bảo mật bắt buộc trước phần cứng thật

MQTT hiện dùng credential chung và payload chưa chứng minh được danh tính thiết
bị nguồn. Trong mô hình relay, chỉ kiểm tra Hub là chưa đủ vì Hub có thể giả mạo
Node.

Trước khi dùng với thiết bị thật cần một trong hai cơ chế:

- Chữ ký bất đối xứng theo device; factory lưu public key, device giữ private
  key. Hub forward payload và chữ ký nguyên vẹn.
- Hoặc credential/ACL riêng theo device kết hợp cơ chế ủy quyền relay có thời
  hạn.

Không lưu Wi-Fi password trong PostgreSQL, MongoDB, Redis, log hoặc Simulator
Registry.

## 11. Ranh giới giao diện

Flutter mặc định chỉ cần biết:

- Device online/offline.
- Vai trò Hub/Node nếu người dùng mở phần thông tin kỹ thuật.
- Network label nếu sau này có màn quản lý mạng.

`degraded_direct`, `electing` và thay đổi Hub ngắn hạn không hiển thị như lỗi
cho người dùng. Có thể lưu trong diagnostics cho quản trị và Simulator
Dashboard.

## 12. Thứ tự hiệu chỉnh tiếp theo

1. Khóa kiến trúc cốt lõi và Product contract edge-first.
2. Thiết kế lại network identity trong ERD V2, không migration ngay.
3. Chuyển route observation/fallback override từ network sang device.
4. Cho phép Node fallback độc lập trong inbound validation.
5. Bổ sung behavior profile và local-link fault cho Simulator.
6. Bổ sung device identity/signature contract cho relay.
7. Chạy fault tests: lỗi riêng đường Node-Hub, Hub crash, Hub unpair,
   split-brain, restart, stale epoch và command trong lúc failover.

Mỗi thay đổi phải giữ compatibility cho runtime hiện tại cho đến clean cutover,
trừ khi kế hoạch migration đã được duyệt rõ ràng.
