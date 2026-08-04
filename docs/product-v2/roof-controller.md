# Product Contract — Bộ Điều Khiển Mái

## 1. Trạng thái

- Product ID: `prod_roof_controller`
- Catalog revision: `1`
- Lifecycle: `draft`
- Contract maturity: `edge_reviewed`
- Runtime hiện tại: chưa kết nối Product V2 vào hệ thống đang chạy

Contract đã khóa ranh giới ESP32/backend nhưng chưa `approved` vì motor, driver,
limit switch và loại cảm biến cụ thể chưa được xác nhận.

## 2. Phần cứng trong phạm vi

| Phần cứng | Chức năng được mô tả |
| --- | --- |
| ESP32 | Local policy, điều khiển motor, cảm biến, MQTT và Hub-Node data plane |
| Motor + driver | Mở, đóng và dừng mái |
| Cảm biến mưa | Phát hiện bắt đầu/kết thúc mưa |
| Cảm biến ánh sáng | Đo mức ánh sáng ngoài trời |
| Cảm biến nhiệt độ/độ ẩm | Đo môi trường ngoài trời |
| Nút mở và nút đóng | Điều khiển cục bộ khi online hoặc offline |

Chưa giả định có encoder, potentiometer, limit switch, obstacle sensor hoặc
current sensor.

## 3. Ranh giới trách nhiệm

### ESP32

- đọc cảm biến và nút vật lý;
- chạy bảo vệ mưa cục bộ;
- quyết định có cho motor mở/đóng hay không;
- điều khiển direction/enable của motor driver;
- luôn áp dụng maximum runtime để tránh motor chạy vô hạn;
- giữ motor dừng an toàn sau boot/reset;
- lưu mode, rain protection và maximum runtime trong NVS;
- ACK sau khi áp dụng/persist operation;
- phát state/event/diagnostics thực tế mà firmware biết.

### Backend

- xác thực permission và payload;
- gửi remote intent;
- quản lý Hub-Node topology và route;
- lưu ACK, telemetry và lịch sử;
- không tự suy đoán vị trí mái hoặc kết luận mái đã mở/đóng hoàn toàn.

## 4. Motor contract hiện tại

Các operation hỗ trợ:

- `open`: yêu cầu firmware bắt đầu chạy chiều mở;
- `close`: yêu cầu firmware bắt đầu chạy chiều đóng;
- `stop`: dừng motor;
- `set_max_run_seconds`: owner cấu hình thời gian chạy tối đa, cần xác thực lại.

Reported `movement` gồm:

- `unknown`
- `opening`
- `closing`
- `stopped`

ACK của `open`/`close` xác nhận firmware đã áp dụng lệnh motor và reported
`movement` đã đổi. ACK không chứng minh mái đã đến cuối hành trình.

Contract hiện không có:

- `current_position` theo phần trăm;
- `target_position`;
- `set_position`;
- `obstruction_detected`;
- `jammed` hoặc sự kiện kẹt motor.

Các khả năng này chỉ được thêm ở revision sau khi có phần cứng phản hồi phù hợp.

## 5. Rain protection

Rain protection chạy trên ESP32 và không phụ thuộc backend:

```text
Rain sensor đổi sang raining
  -> firmware phát rain_started
  -> local policy đánh giá mode/rain protection
  -> nếu cần, firmware bắt đầu đóng mái
  -> motor tự dừng theo limit switch tương lai hoặc maximum runtime hiện tại
```

Khi `rain_protection_enabled = true`, remote/local open phải bị firmware từ chối
nếu đang mưa. Tắt bảo vệ mưa là operation nguy hiểm, cần `safety.configure` và
reauthentication; cấu hình chỉ thành công sau khi ESP32 lưu NVS và báo lại.

## 6. Nút cục bộ và offline

- Nút mở/đóng được ESP32 xử lý trực tiếp.
- Không gửi raw electrical state liên tục; chỉ phát event `button_pressed` đã
  debounce và làm sạch.
- Nút hoạt động khi backend mất kết nối.
- Local input không được vượt qua rain protection hoặc maximum runtime.
- Contract chưa giả định có nút stop riêng.

## 7. Cảm biến môi trường

Mọi measurement do ESP32 tạo và MongoDB chỉ lưu lịch sử/bản sao:

- rain detected;
- illuminance;
- temperature;
- relative humidity.

Giới hạn, precision và unit cuối cùng phải được khóa theo model cảm biến thật.
Nếu cảm biến ánh sáng chỉ là LDR chưa hiệu chuẩn, không được quảng bá giá trị là
lux; contract phải đổi sang mức normalized trước khi Product được approved.

## 8. Boot, offline và reconnect

- Sau boot motor mặc định dừng, `movement = unknown` cho đến khi firmware khởi
  tạo xong.
- Local policy dùng config trong NVS, không tải config từ cloud mới hoạt động.
- Telemetry mất mạng có thể buffer giới hạn nhưng motor/safety tiếp tục chạy.
- Sau reconnect, backend nhận reported state từ ESP32; không ghi firmware default
  vào shadow.
- Config mới chỉ thay config cũ khi device ACK version đã persist.

## 9. Câu hỏi cần xác nhận trước `approved`

1. Model motor và motor driver.
2. Có limit switch mở/đóng hay không.
3. Có encoder/potentiometer để đo vị trí thật hay chỉ ước lượng theo thời gian.
4. Có obstacle/current sensing để phát hiện kẹt hay không.
5. Maximum runtime an toàn thực tế cho chiều mở và đóng.
6. Hai chiều có cần thời gian chạy tối đa khác nhau hay không.
7. Model cảm biến mưa, ánh sáng, nhiệt độ và độ ẩm.
8. Illuminance có được hiệu chuẩn theo lux hay chỉ là giá trị normalized.
9. Chính sách mở lại mái sau khi hết mưa.

## 10. Điều kiện nghiệm thu Product 2

- Không có position/obstruction state khi chưa có sensor tương ứng.
- Motor, sensor, button và rain policy đều chạy trên ESP32.
- Remote operation chỉ thành công sau ACK của firmware.
- Maximum runtime được lưu trên device và luôn được enforce offline.
- Rain protection hoạt động khi backend mất kết nối.
- Local button không vượt qua safety policy.
- Backend không seed reported shadow hoặc tự suy đoán mái đã tới hành trình.
