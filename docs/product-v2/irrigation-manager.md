# Product 4 — Bộ Quản Lý Nước & Tưới Tiêu

## Trạng thái thiết kế

- Product ID: `prod_irrigation_manager`
- Contract maturity: `edge_reviewed`
- Lifecycle: `draft`
- Phạm vi: chuẩn hóa hợp đồng firmware–backend–ứng dụng; chưa nối Catalog V2 vào runtime và chưa migration database.
- `edge_reviewed` xác nhận ranh giới xử lý tại ESP32 đã được rà soát, không xác nhận model bơm/cảm biến hay thiết kế điện đã hoàn tất.

## Phần cứng đang được coi là có thật

- Một cảm biến độ ẩm đất.
- Một cảm biến hoặc đầu vào xác định mực/khả dụng nước trong bể.
- Một đầu ra điều khiển bơm tưới.
- Một nút điều khiển bơm tại chỗ.
- Wi-Fi và chế độ Hub–Node.

Catalog hiện chỉ mô hình hóa một khu vực tưới và một bơm. Không được tự sinh thêm zone, van hoặc lịch tưới khi phần cứng và yêu cầu chưa được xác nhận.

## Ranh giới xử lý

ESP32 là authority cho giá trị cảm biến, quyết định chạy/dừng đầu ra bơm, bộ đếm chu kỳ và automation cục bộ. Backend quản lý quyền, cấu hình mong muốn, truyền lệnh và lưu reported state/event. Khi mất MQTT, các interlock nguồn nước, giới hạn thời gian, cooldown và automation đã được lưu vẫn phải hoạt động cục bộ.

Backend không được đánh dấu bơm đang chạy chỉ vì đã gửi lệnh. Trạng thái chỉ thay đổi sau ACK/reported state của firmware.

## Cảm biến độ ẩm đất

- `moisture_level`: giá trị normalized 0–100 hoặc `null` khi chưa đọc được.
- `sensor_state`: `unknown`, `ready`, `fault`.

Giá trị này chưa phải phần trăm độ ẩm thể tích của đất. Ứng dụng không được hiển thị đơn vị vật lý hoặc suy diễn chất lượng đất cho đến khi xác nhận model cảm biến, môi trường lắp đặt và quy trình hiệu chuẩn khô/ướt.

Automation chỉ được sử dụng `moisture_level` khi `sensor_state = ready`.

## Cảm biến bể nước

- `level_normalized`: giá trị tương đối 0–100 hoặc `null` nếu phần cứng chỉ cung cấp tín hiệu rời rạc.
- `water_availability`: `unknown`, `available`, `low`, `empty`.
- `sensor_state`: `unknown`, `ready`, `fault`.

`water_availability` mặc định là `unknown`, không phải `available`. Firmware phải từ chối bắt đầu chu kỳ khi cảm biến chưa sẵn sàng, bị lỗi hoặc không xác nhận còn đủ nước. Việc này bảo đảm boot/mất cảm biến không thể vô tình vô hiệu hóa chống chạy khô.

## Bơm và chu kỳ tưới

- `pump_output_state`: `stopped`, `running`.
- `active_cycle_id`: định danh chu kỳ đang hoạt động.
- `runtime_seconds`: thời gian đã chạy của chu kỳ hiện tại.
- `stop_reason`: nguyên nhân kết thúc chuẩn hóa.

`pump_output_state` chỉ cho biết firmware đang bật hay tắt đầu ra điều khiển. Nó không chứng minh motor, lưu lượng nước hoặc dòng điện thực tế. Vì chưa có feedback được xác nhận, contract không có `pump_fault` và không được hiển thị “bơm khỏe/hỏng”.

Mọi chu kỳ đều hữu hạn:

- Lệnh từ xa `water_for_duration` chỉ nhận 30–3600 giây.
- Firmware tiếp tục áp dụng `maximum_runtime_seconds`, vì vậy giới hạn cấu hình có thể thấp hơn giá trị lệnh.
- Nút tại chỗ dùng `default_cycle_duration_seconds` và vẫn phải qua toàn bộ interlock.
- Khi boot/reset, đầu ra bơm phải tắt và chu kỳ trước không tự tiếp tục.
- `stop` luôn được ưu tiên thực thi; không được khóa thao tác dừng bởi automation hay cooldown.

ACK `water_for_duration` chỉ xác nhận đầu ra đã chuyển sang `running`. Kết thúc chu kỳ được xác nhận bằng reported state và event `watering_stopped`. Transport V2 phải chống phát lại cùng một command ID để retry mạng không tạo hai chu kỳ độc lập.

## Interlock bắt buộc tại firmware

Trước khi bắt đầu chu kỳ, firmware phải kiểm tra:

1. Cảm biến bể đang sẵn sàng.
2. Nguồn nước ở trạng thái `available`.
3. Thời lượng yêu cầu không vượt giới hạn cấu hình.
4. Cooldown từ lần chạy trước đã kết thúc.
5. Không có chu kỳ khác đang hoạt động.

Nếu một điều kiện không đạt, firmware giữ đầu ra tắt và phát `watering_rejected` với lý do chuẩn hóa. Nếu nước cạn hoặc cảm biến bể lỗi giữa chu kỳ, firmware dừng bơm ngay và phát `watering_stopped`.

Không gọi đây là “dry-run được phát hiện” khi hệ thống chưa có flow/current feedback; contract hiện tại chỉ **ngăn nguy cơ chạy khô dựa trên trạng thái bể nước**.

## Automation cục bộ

Cấu hình được firmware lưu trong NVS:

- `control_mode`: `manual` hoặc `automatic`.
- `target_moisture` và `moisture_hysteresis`.
- `default_cycle_duration_seconds`.
- `maximum_runtime_seconds`.
- `cooldown_seconds`.

Khi bật automatic, cả cảm biến đất và thông tin nguồn nước phải đáng tin cậy. Việc chuyển về manual luôn phải được phép kể cả khi cảm biến lỗi. Automation chỉ khởi động chu kỳ hữu hạn, sau đó chờ cooldown và đánh giá lại; nó không được giữ bơm bật vô thời hạn để đuổi theo target.

Catalog không có lịch tưới. Event `schedule_executed` cũ đã được loại bỏ vì không có schedule capability tương ứng.

## Nút tại chỗ

Nút là nguồn event do firmware xử lý, không phải lệnh cloud. Gesture chính xác còn chờ xác nhận phần cứng. Bất kỳ gesture nào được gán chức năng bắt đầu tưới đều phải dùng thời lượng mặc định và chịu interlock giống lệnh từ xa. Event `watering_started.source = local_button` mới chứng minh chu kỳ thật sự đã bắt đầu; riêng `button_pressed` không đủ để suy ra bơm đang chạy.

## Giá trị mặc định tạm thời cần xác nhận

- Chu kỳ mặc định: 300 giây.
- Thời gian chạy tối đa: 900 giây.
- Cooldown: 60 giây.
- Độ ẩm mục tiêu normalized: 50.
- Hysteresis normalized: 5.

Đây là default thiết kế an toàn cho draft, không phải thông số điện/cơ khí được phê duyệt. Trước khi đưa lên thiết bị thật phải đối chiếu công suất bơm, thể tích tưới, khả năng thoát nước và độ trễ cảm biến.

## Các điểm cần xác nhận với phần cứng

- Model, điện áp, dòng định mức, duty cycle và driver của bơm.
- Model cảm biến đất và hiệu chuẩn theo điều kiện lắp đặt.
- Cảm biến bể là continuous hay discrete; có thể cung cấp normalized level hay không.
- Có flow, current hoặc dry-run feedback thật hay không.
- Số zone/van cần hỗ trợ.
- Gesture của nút tại chỗ và bộ giá trị duration/runtime/cooldown được phê duyệt.

Khi chưa có các câu trả lời này, Product vẫn giữ lifecycle `draft` và không được dùng contract để tuyên bố khả năng chẩn đoán bơm vật lý.
