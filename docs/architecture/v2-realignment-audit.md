# Audit tái định hướng kiến trúc V2

## 1. Phạm vi và trạng thái

Tài liệu này ghi nhận hiện trạng sau khi chốt lại nguyên tắc: logic vật lý và
logic an toàn của Product chạy trên ESP32; backend quản lý danh tính, quyền,
topology, vận chuyển command và đồng bộ dữ liệu cho ứng dụng.

Audit này không chạy migration, không thay dữ liệu PostgreSQL/MongoDB đang sử
dụng và không kết nối Product Catalog V2 vào runtime.

## 2. Kết luận ngắn

Phần Hub-Node hiện tại không cần làm lại toàn bộ. Các nền tảng quan trọng đã đi
đúng hướng:

- Claim/unpair và thay đổi topology được bảo vệ bằng transaction PostgreSQL.
- Backend là nơi giữ topology chính thức và bầu Hub.
- MQTT Worker định tuyến command qua Hub hoặc trực tiếp.
- Simulator có firmware runtime riêng cho từng thiết bị ảo, thực thi command
  rồi mới ACK và phát telemetry sau command.
- Backend không tự sửa reported state khi vừa nhận command từ App.
- MongoDB shadow được cập nhật từ telemetry đã qua validation.

Sai lệch nằm ở một số ranh giới chi tiết và ở bản nháp Database V2 được thiết
kế quá sớm.

## 3. Phân loại KEEP

Các phần sau được giữ làm nền tảng, nhưng vẫn phải có regression test khi tích
hợp Product V2:

| Khu vực | Lý do giữ |
| --- | --- |
| Transaction claim/unpair | Ownership, network membership và outbox được commit cùng nhau |
| Join rank và topology epoch | Phù hợp với ưu tiên Hub và chống assignment cũ |
| Backend Topology Coordinator | Đúng vai trò control plane bầu Hub |
| Topology outbox | Không phát topology trước khi PostgreSQL commit |
| Route-aware MQTT command | Có relay/direct fallback và giữ nguyên command ID |
| ACK validation/idempotency | Chống ACK trùng, muộn và sai route |
| Telemetry sequence/deduplication | Hạn chế trùng dữ liệu khi đổi tuyến |
| Simulator `DeviceRuntime` | State thay đổi trong firmware ảo, không phải API Gateway |
| Product V2 loader/linter/compiler | Có thể tiếp tục dùng sau khi sửa contract edge-first |
| Semantic metadata Flutter | Chỉ ảnh hưởng cách hiển thị, không chuyển logic lên cloud |

## 4. Phân loại MODIFY

### 4.1. Device Network đang bị đồng nhất với owner

Schema và repository hiện định danh network bằng cặp
`(owner_id, network_fingerprint)`. Đây là mô hình chuyển tiếp dùng được khi mọi
thiết bị trong một mạng đều do một account sở hữu, nhưng không phải kiến trúc
đích.

Network là thực thể hạ tầng độc lập với account. Account có thể là người quản
trị ban đầu, nhưng không được trở thành một phần của danh tính network. Thiết kế
database sau này phải tách network identity, network administration và quyền
truy cập thiết bị.

### 4.2. Direct fallback hiện có phạm vi toàn network

MQTT Worker đang lưu route override theo `network_id`. Một Node mất đường cục
bộ đến Hub có thể làm command của mọi Node trong network chuyển sang direct.

Fallback phải là trạng thái theo từng device. Hub lease/network state chỉ dùng
để backend quyết định có cần bầu Hub mới hay không.

### 4.3. Node có thể bị từ chối fallback trong khi Hub lease còn sống

Inbound telemetry `direct_fallback` hiện bị từ chối nếu backend vẫn thấy Hub
lease khỏe. Trong thực tế, một Node có thể mất liên kết cục bộ đến Hub dù Hub
vẫn online với server.

Backend phải chấp nhận direct fallback hợp lệ theo danh tính thiết bị, sequence
và topology epoch; sau đó ghi nhận route của riêng Node. Fallback không tự động
đồng nghĩa Hub đã hỏng.

### 4.4. Shadow được khởi tạo bằng default state trước telemetry

Claim hiện đưa `product.default_state` vào shadow. Giá trị mặc định của Catalog
không phải bằng chứng về trạng thái vật lý.

Sau claim, shadow chỉ nên có metadata và trạng thái `awaiting_initial_report`.
Reported state chỉ xuất hiện sau telemetry/snapshot được ESP32 xác nhận.

### 4.5. Product V2 còn dùng ngôn ngữ dễ hiểu thành cloud execution

Một số operation dùng effect `set_desired`. Field này chỉ được phép mang nghĩa
"ý định đang chờ thiết bị xử lý", không được ghi thành reported state hoặc kết
quả vật lý.

Product contract cần bổ sung rõ execution authority, state authority, offline
behavior, persistence, ACK policy và safety constraints cho firmware.

### 4.6. Simulator chưa mô phỏng đầy đủ logic Product

Simulator đã thực thi command trong `DeviceRuntime`, nhưng behavior vẫn chủ yếu
dựa vào generic catalog/state evolution. Cần bổ sung behavior profile riêng cho
từng Product, local policy, điều kiện an toàn, cấu hình lưu bền và lỗi phần cứng.

### 4.7. Danh tính MQTT thiết bị chưa đủ cho phần cứng thật

Credential chung và kiểm tra MAC/topic phù hợp cho môi trường phát triển nhưng
không đủ chứng minh nguồn Node khi dữ liệu được Hub relay. Firmware thật cần
credential riêng hoặc chữ ký từng device; Hub chỉ forward payload đã ký.

## 5. Phân loại REMOVE/HOLD

Các file sau là bản nháp chưa nối runtime và không được dùng làm baseline cho
database mới:

- `database/postgres/schema_v2.sql`
- `database/mongodb/v2/`
- `database/initialize_v2.js`
- `database/v2-tests/`
- `database/README_V2.md`
- `docs/product-v2/database-v2.md`

Chúng được giữ ở trạng thái HOLD trong lúc review để tránh xóa ngoài ý muốn.
Sau khi kiến trúc và Product contract được duyệt, chúng sẽ được xóa hoặc viết
lại từ đầu dựa trên mô hình dữ liệu đã chốt.

Những phần sharing, membership, credential service và policy tables trong bản
nháp cũ không được triển khai ở giai đoạn Product normalization.

## 6. Thứ tự khắc phục

1. Duyệt `v2-core-architecture.md` và Hub-Node contract đã hiệu chỉnh.
2. Sửa Product/Capability V2 theo edge-first contract, từng Product một.
3. Audit schema V1 và thiết kế ERD/collection V2 mới.
4. Trình duyệt database trước khi migration hoặc xóa dữ liệu phát triển.
5. Sửa runtime theo thứ tự database, backend, MQTT Worker, Simulator, Flutter
   và firmware contract.
6. Chạy contract, failover, offline, restart và load test.

## 7. Bằng chứng kiểm tra hiện trạng

Các kiểm tra không ghi database đã chạy thành công:

- Product Catalog V1/V2: 14/14 test pass.
- MQTT topology runtime: 10/10 test pass.
- Device Simulator: 37/37 test pass và TypeScript build pass.
- API Gateway: TypeScript build pass.
- `git diff --check`: pass.

Test pass chứng minh code hiện tại nhất quán với contract cũ, không có nghĩa mọi
contract cũ đều đúng với kiến trúc vừa chốt. Hai test hiện khóa chính xác những
điểm cần thay đổi ở giai đoạn runtime:

- MQTT test yêu cầu direct fallback chỉ được chấp nhận sau khi Hub lease mất.
- Simulator test yêu cầu network fingerprint bị cô lập theo user/network.

Hai kỳ vọng này phải được thay bằng contract mới sau khi ERD và protocol được
duyệt; không sửa vội trong giai đoạn tài liệu.

## 8. Các invariant dùng làm tiêu chí nghiệm thu

- Backend không tự xác nhận trạng thái vật lý.
- Reported state luôn có nguồn từ thiết bị.
- Command thành công chỉ sau ACK của thiết bị đích.
- Logic an toàn hoạt động khi backend mất kết nối.
- Backend là nơi duy nhất phát topology chính thức và bầu Hub.
- Node được fallback ngay mà không cần backend cấp phép trước.
- Fallback của một Node không ép mọi Node khác đổi route.
- Không có hai Hub cùng lease/topology epoch hợp lệ.
- Network identity không phụ thuộc danh tính account.
- PostgreSQL và MongoDB không cùng là source of truth cho một concern.
