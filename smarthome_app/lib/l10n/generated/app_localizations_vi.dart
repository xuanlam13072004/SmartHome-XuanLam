import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Vietnamese (`vi`).
class AppL10nVi extends AppL10n {
  AppL10nVi([String locale = 'vi']) : super(locale);

  @override
  String get appName => 'SmartHome XuanLam';

  @override
  String get loading => 'Đang tải...';

  @override
  String get retry => 'Thử lại';

  @override
  String get cancel => 'Hủy';

  @override
  String get confirm => 'Xác nhận';

  @override
  String get save => 'Lưu';

  @override
  String get delete => 'Xóa';

  @override
  String get edit => 'Chỉnh sửa';

  @override
  String get close => 'Đóng';

  @override
  String get back => 'Quay lại';

  @override
  String get next => 'Tiếp theo';

  @override
  String get errorGeneric => 'Đã có lỗi xảy ra. Vui lòng thử lại.';

  @override
  String get errorNetwork => 'Không thể kết nối. Kiểm tra kết nối mạng.';

  @override
  String get errorTimeout => 'Hết thời gian chờ. Vui lòng thử lại.';

  @override
  String get errorUnauthorized =>
      'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.';

  @override
  String get navDashboard => 'Tổng quan';

  @override
  String get navRooms => 'Phòng';

  @override
  String get navScenes => 'Cảnh';

  @override
  String get navProfile => 'Tài khoản';

  @override
  String get authLogin => 'Đăng nhập';

  @override
  String get authRegister => 'Đăng ký';

  @override
  String get authEmail => 'Email';

  @override
  String get authPassword => 'Mật khẩu';

  @override
  String get authPasswordConfirm => 'Xác nhận mật khẩu';

  @override
  String get authForgotPassword => 'Quên mật khẩu?';

  @override
  String get authNoAccount => 'Chưa có tài khoản? ';

  @override
  String get authHasAccount => 'Đã có tài khoản? ';

  @override
  String get authEmailInvalid => 'Địa chỉ email không hợp lệ';

  @override
  String get authPasswordTooShort => 'Mật khẩu phải có ít nhất 8 ký tự';

  @override
  String get authPasswordMismatch => 'Mật khẩu xác nhận không khớp';

  @override
  String get authLoginError => 'Email hoặc mật khẩu không đúng';

  @override
  String get authLogout => 'Đăng xuất';

  @override
  String get dashboardGreetingMorning => 'Chào buổi sáng';

  @override
  String get dashboardGreetingAfternoon => 'Chào buổi chiều';

  @override
  String get dashboardGreetingEvening => 'Chào buổi tối';

  @override
  String dashboardDevicesOnline(int count) {
    return '$count thiết bị đang hoạt động';
  }

  @override
  String get dashboardAllDevices => 'Tất cả thiết bị';

  @override
  String get deviceOnline => 'Đang hoạt động';

  @override
  String get deviceOffline => 'Không hoạt động';

  @override
  String get devicePending => 'Đang xử lý...';

  @override
  String get deviceControl => 'Điều khiển';

  @override
  String get deviceDetail => 'Chi tiết thiết bị';

  @override
  String get deviceRename => 'Đặt tên thiết bị';

  @override
  String deviceLastSeen(String time) {
    return 'Lần cuối: $time';
  }

  @override
  String get commandSent => 'Lệnh đã được gửi';

  @override
  String get commandAcked => 'Thiết bị đã xác nhận';

  @override
  String get commandFailed => 'Gửi lệnh thất bại';

  @override
  String get commandTimeout => 'Thiết bị không phản hồi';
}
