import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_vi.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppL10n
/// returned by `AppL10n.of(context)`.
///
/// Applications need to include `AppL10n.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'generated/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppL10n.localizationsDelegates,
///   supportedLocales: AppL10n.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppL10n.supportedLocales
/// property.
abstract class AppL10n {
  AppL10n(String locale)
      : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppL10n? of(BuildContext context) {
    return Localizations.of<AppL10n>(context, AppL10n);
  }

  static const LocalizationsDelegate<AppL10n> delegate = _AppL10nDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates =
      <LocalizationsDelegate<dynamic>>[
    delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
  ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[Locale('vi')];

  /// Tên ứng dụng
  ///
  /// In vi, this message translates to:
  /// **'SmartHome XuanLam'**
  String get appName;

  /// Trạng thái tải
  ///
  /// In vi, this message translates to:
  /// **'Đang tải...'**
  String get loading;

  /// Nút thử lại
  ///
  /// In vi, this message translates to:
  /// **'Thử lại'**
  String get retry;

  /// Nút hủy
  ///
  /// In vi, this message translates to:
  /// **'Hủy'**
  String get cancel;

  /// Nút xác nhận
  ///
  /// In vi, this message translates to:
  /// **'Xác nhận'**
  String get confirm;

  /// Nút lưu
  ///
  /// In vi, this message translates to:
  /// **'Lưu'**
  String get save;

  /// Nút xóa
  ///
  /// In vi, this message translates to:
  /// **'Xóa'**
  String get delete;

  /// Nút chỉnh sửa
  ///
  /// In vi, this message translates to:
  /// **'Chỉnh sửa'**
  String get edit;

  /// Nút đóng
  ///
  /// In vi, this message translates to:
  /// **'Đóng'**
  String get close;

  /// Nút quay lại
  ///
  /// In vi, this message translates to:
  /// **'Quay lại'**
  String get back;

  /// Nút tiếp theo
  ///
  /// In vi, this message translates to:
  /// **'Tiếp theo'**
  String get next;

  /// Lỗi chung
  ///
  /// In vi, this message translates to:
  /// **'Đã có lỗi xảy ra. Vui lòng thử lại.'**
  String get errorGeneric;

  /// Lỗi mạng
  ///
  /// In vi, this message translates to:
  /// **'Không thể kết nối. Kiểm tra kết nối mạng.'**
  String get errorNetwork;

  /// Lỗi timeout
  ///
  /// In vi, this message translates to:
  /// **'Hết thời gian chờ. Vui lòng thử lại.'**
  String get errorTimeout;

  /// Lỗi xác thực
  ///
  /// In vi, this message translates to:
  /// **'Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại.'**
  String get errorUnauthorized;

  /// Tab tổng quan
  ///
  /// In vi, this message translates to:
  /// **'Tổng quan'**
  String get navDashboard;

  /// Tab phòng
  ///
  /// In vi, this message translates to:
  /// **'Phòng'**
  String get navRooms;

  /// Tab cảnh
  ///
  /// In vi, this message translates to:
  /// **'Cảnh'**
  String get navScenes;

  /// Tab tài khoản
  ///
  /// In vi, this message translates to:
  /// **'Tài khoản'**
  String get navProfile;

  /// Tiêu đề trang đăng nhập
  ///
  /// In vi, this message translates to:
  /// **'Đăng nhập'**
  String get authLogin;

  /// Tiêu đề trang đăng ký
  ///
  /// In vi, this message translates to:
  /// **'Đăng ký'**
  String get authRegister;

  /// Label email
  ///
  /// In vi, this message translates to:
  /// **'Email'**
  String get authEmail;

  /// Label mật khẩu
  ///
  /// In vi, this message translates to:
  /// **'Mật khẩu'**
  String get authPassword;

  /// Label xác nhận mật khẩu
  ///
  /// In vi, this message translates to:
  /// **'Xác nhận mật khẩu'**
  String get authPasswordConfirm;

  /// Link quên mật khẩu
  ///
  /// In vi, this message translates to:
  /// **'Quên mật khẩu?'**
  String get authForgotPassword;

  /// Text dẫn sang đăng ký
  ///
  /// In vi, this message translates to:
  /// **'Chưa có tài khoản? '**
  String get authNoAccount;

  /// Text dẫn sang đăng nhập
  ///
  /// In vi, this message translates to:
  /// **'Đã có tài khoản? '**
  String get authHasAccount;

  /// Lỗi validate email
  ///
  /// In vi, this message translates to:
  /// **'Địa chỉ email không hợp lệ'**
  String get authEmailInvalid;

  /// Lỗi validate mật khẩu
  ///
  /// In vi, this message translates to:
  /// **'Mật khẩu phải có ít nhất 8 ký tự'**
  String get authPasswordTooShort;

  /// Lỗi mật khẩu không khớp
  ///
  /// In vi, this message translates to:
  /// **'Mật khẩu xác nhận không khớp'**
  String get authPasswordMismatch;

  /// Lỗi đăng nhập
  ///
  /// In vi, this message translates to:
  /// **'Email hoặc mật khẩu không đúng'**
  String get authLoginError;

  /// Nút đăng xuất
  ///
  /// In vi, this message translates to:
  /// **'Đăng xuất'**
  String get authLogout;

  /// Lời chào buổi sáng
  ///
  /// In vi, this message translates to:
  /// **'Chào buổi sáng'**
  String get dashboardGreetingMorning;

  /// Lời chào buổi chiều
  ///
  /// In vi, this message translates to:
  /// **'Chào buổi chiều'**
  String get dashboardGreetingAfternoon;

  /// Lời chào buổi tối
  ///
  /// In vi, this message translates to:
  /// **'Chào buổi tối'**
  String get dashboardGreetingEvening;

  /// Số thiết bị online
  ///
  /// In vi, this message translates to:
  /// **'{count} thiết bị đang hoạt động'**
  String dashboardDevicesOnline(int count);

  /// Tiêu đề danh sách thiết bị
  ///
  /// In vi, this message translates to:
  /// **'Tất cả thiết bị'**
  String get dashboardAllDevices;

  /// Trạng thái thiết bị online
  ///
  /// In vi, this message translates to:
  /// **'Đang hoạt động'**
  String get deviceOnline;

  /// Trạng thái thiết bị offline
  ///
  /// In vi, this message translates to:
  /// **'Không hoạt động'**
  String get deviceOffline;

  /// Trạng thái lệnh đang xử lý
  ///
  /// In vi, this message translates to:
  /// **'Đang xử lý...'**
  String get devicePending;

  /// Nút điều khiển thiết bị
  ///
  /// In vi, this message translates to:
  /// **'Điều khiển'**
  String get deviceControl;

  /// Tiêu đề trang chi tiết thiết bị
  ///
  /// In vi, this message translates to:
  /// **'Chi tiết thiết bị'**
  String get deviceDetail;

  /// Label đặt tên thiết bị
  ///
  /// In vi, this message translates to:
  /// **'Đặt tên thiết bị'**
  String get deviceRename;

  /// Thời gian thiết bị hoạt động lần cuối
  ///
  /// In vi, this message translates to:
  /// **'Lần cuối: {time}'**
  String deviceLastSeen(String time);

  /// Thông báo lệnh đã gửi
  ///
  /// In vi, this message translates to:
  /// **'Lệnh đã được gửi'**
  String get commandSent;

  /// Thông báo thiết bị xác nhận lệnh
  ///
  /// In vi, this message translates to:
  /// **'Thiết bị đã xác nhận'**
  String get commandAcked;

  /// Thông báo lệnh thất bại
  ///
  /// In vi, this message translates to:
  /// **'Gửi lệnh thất bại'**
  String get commandFailed;

  /// Thông báo lệnh timeout
  ///
  /// In vi, this message translates to:
  /// **'Thiết bị không phản hồi'**
  String get commandTimeout;
}

class _AppL10nDelegate extends LocalizationsDelegate<AppL10n> {
  const _AppL10nDelegate();

  @override
  Future<AppL10n> load(Locale locale) {
    return SynchronousFuture<AppL10n>(lookupAppL10n(locale));
  }

  @override
  bool isSupported(Locale locale) =>
      <String>['vi'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppL10nDelegate old) => false;
}

AppL10n lookupAppL10n(Locale locale) {
  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'vi':
      return AppL10nVi();
  }

  throw FlutterError(
      'AppL10n.delegate failed to load unsupported locale "$locale". This is likely '
      'an issue with the localizations generation tool. Please file an issue '
      'on GitHub with a reproducible sample app and the gen-l10n configuration '
      'that was used.');
}
