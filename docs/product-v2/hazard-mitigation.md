# Product 3 — Hệ Thống Cảnh Báo An Toàn Bếp

## Trạng thái thiết kế

- Product ID: `prod_hazard_mitigation`
- Contract maturity: `edge_reviewed`
- Lifecycle: `draft`
- Phạm vi của giai đoạn này: chuẩn hóa hợp đồng giữa firmware, backend và ứng dụng; chưa triển khai migration hay thay đổi dữ liệu runtime.
- `edge_reviewed` có nghĩa là ranh giới xử lý tại ESP32 đã được rà soát, không có nghĩa là phần cứng đã được phê duyệt sản xuất.

## Phần cứng đang được coi là có thật

- Cảm biến khí gas, khói và lửa.
- Còi cảnh báo.
- Quạt thông gió.
- Nút tắt tiếng còi tại chỗ.
- Đo điện áp, dòng điện, công suất và điện năng tích lũy.
- Wi-Fi và chế độ Hub–Node.

Ethernet và relay cắt tải chưa được xác nhận nên không thuộc hợp đồng hoạt động. `load_cutoff` chỉ nằm trong danh sách `planned_capability_instances` và không được compiler đưa vào operation/state runtime.

## Ranh giới xử lý

ESP32 là authority đối với cảm biến, đánh giá nguy hiểm, vòng đời sự cố, còi và quạt. Khi mất backend hoặc mất MQTT, thiết bị vẫn phải phát hiện hazard và thực hiện phản ứng an toàn cục bộ. Backend chỉ quản lý danh tính, quyền, topology, lưu lịch sử, chuyển lệnh và hiển thị reported state do thiết bị gửi lên.

Không được dùng desired state từ backend để ghi đè trạng thái vật lý mà firmware chưa xác nhận.

## Ba lớp trạng thái độc lập

### 1. Nguy cơ và vòng đời sự cố

- `risk_level`: `normal`, `warning`, `alarm`, `emergency`, `sensor_fault`.
- `incident_state`: `idle`, `active`, `acknowledged`.
- `active_incident_id`: định danh sự cố đang hoạt động.

Khi boot hoặc cảm biến chưa sẵn sàng, `risk_level` phải là `sensor_fault`; thiết bị không được phát `normal` trước khi hoàn tất tự kiểm tra cảm biến.

`acknowledge_incident` chỉ ghi nhận người dùng đã thấy cảnh báo. Nó không tắt cơ chế giảm thiểu và không đồng nghĩa hazard đã hết. `reset_incident` chỉ được firmware chấp nhận khi đúng incident, hazard đã hết và toàn bộ cảm biến liên quan khỏe mạnh.

### 2. Còi

- `audible_state`: `silent`, `sounding`, `muted`.
- `mute_siren` có thao tác tương đương tại chỗ qua nút mute.
- Mute không thay đổi `incident_state` và không dừng quạt.
- `test_siren` là thao tác kiểm thử riêng, có thời lượng giới hạn.

`audible_state` hiện là đầu ra được firmware ra lệnh, không phải bằng chứng còi thực sự phát âm thanh. Muốn báo lỗi còi vật lý phải bổ sung feedback phần cứng trước.

### 3. Thông gió

- `fan_state`: `off`, `running`.
- `control_source`: `safety_policy`, `manual`, `automation`.
- Khi hazard hoạt động và chính sách an toàn yêu cầu quạt, firmware có quyền cưỡng bức quạt chạy.
- `stop_manual_ventilation` phải bị từ chối nếu còn hazard hoặc safety policy đang yêu cầu quạt.

`fan_state` hiện là đầu ra được firmware ra lệnh. Không được tự suy diễn `fault` hoặc `blocked` nếu chưa có tachometer, current sensing hay công tắc phản hồi riêng cho quạt.

## Luồng phản ứng offline bắt buộc

1. Firmware lấy mẫu và đánh giá cảm biến tại chỗ.
2. Khi phát hiện gas, khói, lửa, nhiều nguồn nguy hiểm hoặc lỗi cảm biến nghiêm trọng, firmware tạo/cập nhật incident.
3. Firmware kích hoạt còi và quạt theo policy cục bộ, không chờ cloud.
4. Firmware lưu trạng thái incident tối thiểu vào NVS để không mất vòng đời sự cố sau reset.
5. Khi kết nối có lại, thiết bị publish snapshot hiện tại và các event còn lưu được; backend không tái tạo sự thật vật lý từ desired state cũ.

## Đo lường và hiệu chuẩn

Gas và smoke chỉ dùng giá trị normalized cho đến khi xác nhận model cảm biến, dải đo và quy trình hiệu chuẩn. Trạng thái calibration phải được thiết bị báo rõ. Ứng dụng không được gắn đơn vị ppm hay phần trăm vật lý khi catalog chưa xác nhận.

`accumulated_energy` cần tồn tại qua restart nhưng firmware phải áp dụng chiến lược chống mòn flash, ví dụ checkpoint theo chu kỳ hoặc theo mức biến thiên; không ghi NVS ở mỗi mẫu đo.

## Quyền và ACK

- Mọi lệnh từ app/backend vẫn phải được firmware kiểm tra điều kiện an toàn.
- ACK chỉ thành công sau khi firmware áp dụng hoặc lưu trạng thái theo `ack_policy`.
- Lệnh bị safety policy từ chối phải tạo event có nguyên nhân rõ ràng.
- `reset_incident` là thao tác nguy hiểm, yêu cầu xác thực lại ở tầng ứng dụng/backend và xác nhận cuối cùng tại firmware.

## Các điểm cần xác nhận với phần cứng

- Model, dải đo, đơn vị và quy trình hiệu chuẩn của từng cảm biến.
- Còi và quạt có feedback vật lý/tachometer hay chỉ có đầu ra điều khiển.
- Chính sách checkpoint điện năng tích lũy để tránh mòn flash.
- Có relay cắt tải thật hay không, feedback của relay và điều kiện khôi phục điện an toàn.

Khi chưa trả lời các câu hỏi này, catalog không được quảng bá trạng thái lỗi cơ khí của còi/quạt hoặc chức năng cắt tải như một capability hoạt động.
