# Hazard Controller firmware

Firmware tham chiếu cho `prod_hazard_mitigation` revision 2, dùng ESP32 +
MQ2 + cảm biến lửa + DHT11 + buzzer + nút tắt âm cục bộ.

## Hành vi an toàn

- Cảm biến và còi hoạt động cục bộ, không phụ thuộc Internet.
- Nguy hiểm `alarm` hoặc `emergency` bật còi ngay.
- Nút tại chỗ tắt còi 60 giây. Lệnh từ backend chỉ nhận 30, 60, 180 hoặc
  300 giây.
- Tắt còi không xóa incident. Khi hết hạn, còi bật lại nếu nguy hiểm còn tồn tại.
- `test_siren` chỉ chạy 1–30 giây và bị từ chối khi đang có nguy hiểm.
- Deadline tắt còi được lưu trong NVS. Nếu thiết bị khởi động lại mà chưa lấy
  được thời gian NTP, firmware chọn fail-safe: không kéo dài trạng thái tắt còi.

## Cấu hình và build

Các chân GPIO, Wi-Fi, MQTT và ngưỡng đều nằm tại `include/board_config.h` và
có thể override bằng PlatformIO build flags. Ví dụ:

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

Không đưa mật khẩu thật vào Git. Với môi trường triển khai, truyền secret qua
build flags/CI secret hoặc cơ chế provisioning riêng.

## Giới hạn phần cứng chưa được phép đoán

`database/catalog-v2/hardware-profile.json` vẫn chưa chốt GPIO thực tế, hiệu
chuẩn MQ2, ngưỡng an toàn và debounce cảm biến lửa. Các giá trị hiện tại chỉ là
reference để test tích hợp, không phải chứng nhận an toàn.

MQ2 chỉ có một tín hiệu analog, nên firmware hiện báo `gas_level` và
`smoke_level` từ cùng một giá trị normalized. Muốn phân biệt đáng tin cậy hai
loại nguy cơ cần hiệu chuẩn/mô hình cảm biến bổ sung.

Backend đã có contract Hub–Node nhưng repository chưa chốt giao thức vô tuyến
vật lý giữa các ESP32 (ESP-NOW, BLE Mesh hoặc giao thức khác). Firmware này hỗ
trợ đầy đủ thiết bị Hub và Node ở `direct_fallback`; nếu Hub nhận lệnh relay cho
Node khi chưa có adapter vô tuyến, nó trả ACK lỗi
`EMBEDDED_RELAY_TRANSPORT_UNCONFIGURED` thay vì báo thành công giả. Phần adapter
vô tuyến cần được triển khai sau khi giao thức vật lý được chốt.
