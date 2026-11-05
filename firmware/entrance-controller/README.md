# Entrance Controller firmware

Firmware tham chiếu cho `prod_entrance_controller` revision 6, dùng ESP32 +
servo SG90 + MPU6050 + LCD I2C 4x20 + bàn phím ma trận 4x4.

Simulator và firmware dùng cùng Product Catalog, trạng thái, lệnh và sự kiện
MQTT. Backend không có nhánh xử lý riêng cho thiết bị ảo.

## Luồng hoạt động cục bộ

- Khi cửa đang khóa, LCD mặc định hiển thị `Xin chao!`, `Cua dang khoa` và
  `Nhan A de mo khoa`.
- Nhấn `A` để bắt đầu, nhập đúng 6 chữ số, dùng `*` để xóa/hủy và `#` để xác
  nhận. PIN được kiểm tra ngay trên ESP32, kể cả khi mất Internet.
- PIN đúng đưa servo từ 0° sang 90°. Đây là trạng thái **mở khóa**, chưa đồng
  nghĩa cửa vật lý đã mở.
- MPU6050 đo góc cửa so với vị trí đóng đã hiệu chuẩn. Nếu sau khi mở khóa mà
  cửa không mở trong 30 giây, firmware tự khóa lại.
- Nếu cửa đã mở rồi đóng, góc phải ổn định ở vùng đóng liên tục 3 giây trước
  khi servo về vị trí khóa.
- Firmware không điều khiển servo sang vị trí khóa khi cửa chưa đóng hoặc tín
  hiệu MPU6050 không đáng tin cậy.
- Ba lần nhập sai khóa bàn phím trong 30 giây. Không có phím bấm hay PIN thô
  nào được gửi lên MQTT.

Bộ khóa cửa không có camera hay nhận diện khuôn mặt. Camera là một Product
riêng (`prod_security_camera`, xem `docs/architecture/camera-contract.md`).

## PIN và secure storage

PIN được lưu dưới dạng verifier có salt trong NVS namespace `entrance-sec`,
không lưu plaintext. Luồng production nhận `device.credential.v2`, giải mã
envelope `RSA-OAEP-256+A256GCM`, kiểm tra đúng job/instance/credential rồi mới
commit verifier và trả ACK.

Private key factory cần được provision vào NVS trước khi giao thiết bị:

- namespace: `factory`
- key: `credentialKey`
- value: private key PEM khớp public key trong `factory_devices`

`SMARTHOME_BOOTSTRAP_PIN` chỉ dành cho bring-up tại bàn test. Production phải
để trống, bật Secure Boot + Flash Encryption của ESP32 và provision private key
qua quy trình nhà máy; không đưa PIN hay private key vào Git hoặc serial log.

## Hiệu chuẩn MPU6050

Lần khởi động đầu tiên, firmware giữ servo ở vị trí mở an toàn và yêu cầu hiệu
chuẩn. Đóng cửa hoàn toàn, giữ cửa đứng yên rồi nhấn `D`. Mốc góc đóng được lấy
từ 30 mẫu, lưu vào NVS và dùng làm góc tương đối 0°.

Nếu thay đổi vị trí lắp MPU6050, xóa cờ `mpuCal`/giá trị `mpuClosed` trong
namespace `entrance-run` rồi hiệu chuẩn lại. Chọn pitch/roll bằng
`SMARTHOME_MPU_DOOR_AXIS` sau khi xác nhận hướng lắp thật.

## MQTT và lịch sử sử dụng

Firmware phát telemetry trạng thái khóa, trạng thái/góc cửa, LCD và chẩn đoán
theo `device.telemetry.v2`. Các sự kiện vật lý được phát riêng qua
`smarthome/<MAC>/events` với schema `device.event.v2`, gồm kết quả xác thực PIN,
khóa/mở khóa, cửa mở/đóng và lỗi MPU6050. MQTT Worker kiểm tra Product Contract,
chống trùng `event_id`, lưu vào MongoDB `device_events`, rồi phát realtime cho
chủ sở hữu. Nếu thiết bị chưa đồng bộ NTP, backend dùng thời điểm nhận và đánh
dấu thời gian thiết bị là chưa đáng tin cậy.

## Cấu hình và build

GPIO trong `include/board_config.h` là layout tham chiếu cho ESP32 DevKit, không
phải sơ đồ PCB đã chốt. Servo phải dùng nguồn riêng đủ dòng và nối chung GND;
hãy kiểm tra điện áp, pull-up I2C và xung servo trước khi cắm phần cứng.

Ví dụ cấu hình bằng PlatformIO build flags:

```ini
build_flags =
    -D SMARTHOME_WIFI_SSID=\"MyWifi\"
    -D SMARTHOME_WIFI_PASSWORD=\"secret\"
    -D SMARTHOME_MQTT_HOST=\"192.168.1.10\"
```

Sau khi cài PlatformIO:

```powershell
pio test -e native
pio run -e esp32dev
pio run -e esp32dev -t upload
pio device monitor
```

## Danh tính MQTT

Broker bắt buộc xác thực (`docs/architecture/mqtt-security.md`). Firmware luôn
đăng nhập với username = MAC của thiết bị và chỉ được dùng topic
`smarthome/<MAC>/...`. Mật khẩu là secret riêng của từng thiết bị, cấp ở bước
factory:

```powershell
cd mqtt-worker-service
$env:MQTT_BROKER_URL="mqtt://192.168.1.10:1883"; $env:MQTT_FACTORY_PASSWORD="<root .env>"
node src/tools/provisionDeviceIdentity.js AA:BB:CC:DD:EE:FF
```

Ghi giá trị `mqttPassword` in ra vào NVS namespace `factory`, key
`mqttPassword`. Chạy lại lệnh sẽ xoay mật khẩu; thêm `--revoke` để thu hồi.
Riêng mạng lab có thể dùng `-D SMARTHOME_MQTT_PASSWORD=\"...\"` làm dự phòng
khi NVS chưa có giá trị. Kết nối chưa có TLS nên chỉ dùng trong mạng tin cậy.

## Giới hạn phần cứng chưa được phép đoán

Ngưỡng góc 4°/12°, hướng MPU6050, góc servo, GPIO và địa chỉ I2C cần được kiểm
chứng trên cơ khí/PCB thật. Chúng đang là giá trị tham chiếu có thể override,
không phải thông số sản xuất cuối cùng.

Backend đã có contract Hub–Node nhưng repository chưa chốt adapter vô tuyến
giữa các ESP32. Firmware hỗ trợ Hub và `direct_fallback`; khi nhận relay cho
Node mà chưa có adapter vật lý, Hub trả
`EMBEDDED_RELAY_TRANSPORT_UNCONFIGURED` thay vì báo thành công giả. Sau khi chọn
ESP-NOW, BLE Mesh hoặc giao thức khác, adapter đó phải chuyển nguyên envelope
operation/credential/event và giữ nguyên quy tắc ACK/idempotency hiện tại.

Trước bản firmware production còn ba hạng mục phần cứng phải chốt:

- Event chờ gửi và bộ đếm khóa bàn phím hiện nằm trong RAM. Cần journal có
  wear-leveling trong NVS/FRAM nếu yêu cầu lịch sử và lockout vẫn còn nguyên sau
  mất điện; không được ghi NVS theo từng vòng lặp cảm biến.
- LCD HD44780 chỉ bảo đảm bộ ký tự theo ROM của module. Nội dung ASCII hiện dùng
  được ngay; nếu cần tiếng Việt phải chốt ROM/custom glyph và cùng một quy tắc
  normalize trên app, Simulator và firmware.
- Broker đã bắt buộc xác thực và ACL theo MAC/topic. Bản triển khai thật còn
  phải bật TLS cho MQTT.
