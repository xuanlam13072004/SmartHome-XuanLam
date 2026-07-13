# Phase 2 — Widget Library Implementation Plan

## Mục tiêu
Xây dựng thư viện Neumorphic Widget có thể tái sử dụng cao, tuân thủ Design System đã tạo ở Phase 1. Các widget này sẽ được dùng để lắp ráp các màn hình ở các phase sau.

## Danh sách Widget cần phát triển

### 1. Nền tảng (Primitives)
*   **`NeuContainer`**: Widget nền tảng cơ bản nhất.
    *   *Mục đích*: Cung cấp container với hiệu ứng shadow Neumorphic (raised, flat, pressed, inner).
    *   *Tính năng*: Tự động áp dụng bo góc (border radius), padding, và animation chuyển đổi trạng thái (animated depth). Tự động lấy màu nền (`context.neu.surface`) nếu không truyền.
*   **`NeuCard`**: Widget dùng cho các khối nội dung lớn.
    *   *Mục đích*: Wrapper tiện lợi dựa trên `NeuContainer` với padding và margin mặc định theo hệ thống spacing.
    *   *Tính năng*: Thích hợp bọc ngoài các danh sách, bảng điều khiển thiết bị lớn.

### 2. Tương tác (Interactive)
*   **`NeuButton`**: Nút bấm Neumorphic.
    *   *Mục đích*: Nút bấm có hiệu ứng tactile (nổi lên khi bình thường, lún xuống khi nhấn).
    *   *Tính năng*: Hỗ trợ text, icon, hoặc cả hai. Xử lý sự kiện nhấn (`onTap`, `onLongPress`) và thay đổi trạng thái shadow tương ứng bằng `AnimationController`.
*   **`NeuToggle`**: Switch bật/tắt phong cách Neumorphic.
    *   *Mục đích*: Thay thế `Switch` của Material.
    *   *Tính năng*: Thanh trượt nổi lên khi off, lún xuống khi on. Nút trượt (thumb) có shadow riêng.
*   **`NeuSlider`**: Thanh trượt điều chỉnh giá trị liên tục.
    *   *Mục đích*: Dùng cho độ sáng đèn, nhiệt độ điều hòa.
    *   *Tính năng*: Track lún (inner shadow) và thumb nổi (raised). Có thể truyền icon min/max.
*   **`NeuIconBox`**: Khung chứa icon.
    *   *Mục đích*: Khung vuông/tròn bo góc chứa icon, thường dùng ở góc trái của list item hoặc device card.
    *   *Tính năng*: Flat hoặc raised nhẹ, icon đổi màu theo trạng thái (active/inactive).

### 3. Thành phần chức năng (Functional Components)
*   **`StatusBadge`**: Dấu hiệu trạng thái nhỏ gọn.
    *   *Mục đích*: Hiển thị thiết bị đang online (xanh), offline (xám), pending (cam), error (đỏ).
    *   *Tính năng*: Hình tròn nhỏ với màu sắc lấy từ `NeuColors`.
*   **`DeviceCard`**: Thẻ thiết bị tổng hợp.
    *   *Mục đích*: Hiển thị trên màn hình Dashboard/Rooms.
    *   *Tính năng*: Kết hợp `NeuCard`, `NeuIconBox`, `StatusBadge`, Text và `NeuToggle` (nếu thiết bị hỗ trợ bật/tắt nhanh).
*   **`SectionHeader`**: Tiêu đề phân vùng.
    *   *Mục đích*: Tiêu đề cho các danh sách ("Phòng khách", "Cảnh yêu thích").
    *   *Tính năng*: Typography chuẩn từ `textTheme`, có thể kèm nút "Xem tất cả" (TextButton).

## Chiến lược triển khai (Animated Transitions)
Một trong những điểm yếu của Neumorphism tĩnh là khó nhận biết trạng thái. Do đó, các widget tương tác (`NeuContainer`, `NeuButton`, `NeuToggle`) sẽ kế thừa `ImplicitlyAnimatedWidget` hoặc sử dụng `AnimatedContainer` để chuyển tiếp mượt mà giữa các cấp độ shadow (ví dụ: từ `raisedMedium` xuống `pressed` mất 150ms).

## Quá trình thực hiện
1. Tạo thư mục `lib/widgets`.
2. Lần lượt code các widget theo thứ tự từ nền tảng (Primitives) lên tổng hợp (Functional).
3. Tạo file barrel `lib/widgets/widgets.dart` để export tất cả.
4. (Tùy chọn) Viết widget test nếu cần kiểm tra behavior. Cập nhật `main.dart` để xem preview các widget này.
5. Chạy `flutter analyze` để đảm bảo code sạch.

## User Review Required
Bạn có đồng ý với danh sách widget trên? Có cần thêm widget đặc thù nào khác cho SmartHome (ví dụ: Color Picker cho đèn thông minh) trong phase này không, hay để dành đến khi làm chi tiết từng màn hình?
