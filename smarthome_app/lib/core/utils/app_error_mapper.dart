import 'package:dio/dio.dart';

/// Maps backend error responses to user-friendly Vietnamese messages.
class AppErrorMapper {
  static String mapError(dynamic error) {
    if (error is DioException) {
      return _mapDioError(error);
    }
    if (error is Exception) {
      return _cleanExceptionMessage(error.toString());
    }
    return 'Đã xảy ra lỗi không xác định';
  }

  static String _mapDioError(DioException error) {
    // Try to extract backend error message
    final data = error.response?.data;
    if (data is Map<String, dynamic>) {
      final backendError = data['error'];
      String? errorCode;
      String? message;

      if (backendError is Map) {
        errorCode = backendError['code']?.toString();
        message = backendError['message']?.toString();
      } else if (backendError is String) {
        errorCode = backendError;
      }
      message ??= data['message']?.toString();

      // Voice errors already carry a Vietnamese message meant for the user.
      if (errorCode != null && errorCode.startsWith('VOICE_') && message != null && message.isNotEmpty) {
        return message;
      }
      if (errorCode != null) {
        return _mapBackendErrorCode(errorCode);
      }
      if (message is String && message.isNotEmpty) {
        return message;
      }
    }

    // Fallback based on HTTP status
    switch (error.response?.statusCode) {
      case 400:
        return 'Dữ liệu không hợp lệ';
      case 401:
        return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại';
      case 403:
        return 'Bạn không có quyền thực hiện thao tác này';
      case 404:
        return 'Không tìm thấy tài nguyên yêu cầu';
      case 409:
        return 'Dữ liệu bị trùng lặp';
      case 500:
        return 'Lỗi máy chủ. Vui lòng thử lại sau';
      case 502:
      case 503:
        return 'Máy chủ tạm thời không khả dụng';
      default:
        break;
    }

    // Fallback based on DioException type
    switch (error.type) {
      case DioExceptionType.connectionTimeout:
      case DioExceptionType.sendTimeout:
      case DioExceptionType.receiveTimeout:
        return 'Kết nối quá thời gian. Kiểm tra mạng và thử lại';
      case DioExceptionType.connectionError:
        return 'Không thể kết nối tới máy chủ';
      case DioExceptionType.cancel:
        return 'Yêu cầu đã bị huỷ';
      default:
        return 'Lỗi kết nối. Vui lòng thử lại';
    }
  }

  /// Vietnamese message for a backend or device reason code.
  /// The backend error code of a failed request (`error.code`), if any.
  static String? codeOf(Object? error) {
    if (error is! DioException) return null;
    final data = error.response?.data;
    if (data is! Map) return null;
    final backendError = data['error'];
    if (backendError is Map) return backendError['code']?.toString();
    if (backendError is String) return backendError;
    return null;
  }

  static String messageForCode(String errorCode) =>
      _mapBackendErrorCode(errorCode);

  /// Map known backend error codes to Vietnamese user messages.
  static String _mapBackendErrorCode(String errorCode) {
    const errorMessages = {
      'ACCOUNT_EXISTS': 'Tài khoản đã tồn tại',
      'EMAIL_EXISTS': 'Email đã được sử dụng',
      'CONFLICT': 'Dữ liệu đã tồn tại hoặc đang được sử dụng',
      'VALIDATION_ERROR': 'Dữ liệu không hợp lệ',
      'FST_ERR_RATE_LIMIT': 'Bạn thao tác quá nhanh. Vui lòng thử lại sau',
      'INVALID_CREDENTIALS': 'Email hoặc mật khẩu không đúng',
      'ACCOUNT_LOCKED': 'Tài khoản đã bị khoá',
      'SESSION_NOT_FOUND': 'Phiên đăng nhập không hợp lệ',
      'INVALID_SESSION': 'Phiên đăng nhập không hợp lệ',
      'INVALID_REFRESH_TOKEN': 'Refresh token không hợp lệ',
      'TOKEN_EXPIRED': 'Phiên đăng nhập đã hết hạn',
      'TOKEN_INVALID': 'Token không hợp lệ',
      'DEVICE_NOT_FOUND': 'Không tìm thấy thiết bị',
      'DEVICE_NOT_AUTHENTIC': 'Thiết bị không được hệ thống xác thực',
      'INVALID_DEVICE_SECRET': 'Mã xác thực thiết bị không đúng',
      'DEVICE_ALREADY_CLAIMED': 'Thiết bị đã được liên kết với tài khoản khác',
      'INVALID_DEVICE_PRODUCT': 'Sản phẩm của thiết bị không được hỗ trợ',
      'INVALID_DEVICE_NAME': 'Tên thiết bị không hợp lệ',
      'NOT_DEVICE_OWNER': 'Bạn không phải chủ sở hữu thiết bị này',
      'DEVICE_OFFLINE': 'Thiết bị đang ngoại tuyến',
      'INVALID_DEVICE_PRODUCT_REVISION':
          'Phiên bản Product của thiết bị không hợp lệ',
      'PRODUCT_REVISION_UNAVAILABLE': 'Phiên bản Product hiện không khả dụng',
      'OPERATION_NOT_SUPPORTED': 'Thiết bị không hỗ trợ thao tác này',
      'OPERATION_FORBIDDEN': 'Bạn không có quyền thực hiện thao tác này',
      'OPERATION_INPUT_INVALID': 'Dữ liệu thao tác không hợp lệ',
      'RESOURCE_NOT_SUPPORTED': 'Thiết bị không hỗ trợ tài nguyên này',
      'RESOURCE_FORBIDDEN': 'Bạn không có quyền truy cập tài nguyên này',
      'RESOURCE_SESSION_REQUIRED':
          'Tài nguyên này phải được mở bằng phiên truy cập bảo vệ',
      'RESOURCE_SESSION_NOT_FOUND':
          'Phiên truy cập tài nguyên không tồn tại hoặc đã hết hạn',
      'RESOURCE_OPERATION_UNAVAILABLE':
          'Thiết bị chưa hỗ trợ mở tài nguyên này',
      'CREDENTIAL_FORBIDDEN':
          'Chỉ chủ sở hữu thiết bị mới được quản lý thông tin bảo mật',
      'CREDENTIAL_NOT_SUPPORTED':
          'Thiết bị không hỗ trợ loại thông tin bảo mật này',
      'CREDENTIAL_MATERIAL_INVALID':
          'Thông tin bảo mật không đúng định dạng yêu cầu',
      'CREDENTIAL_KEY_UNAVAILABLE':
          'Thiết bị chưa sẵn sàng nhận thông tin bảo mật',
      'REAUTHENTICATION_REQUIRED': 'Thao tác này cần xác minh lại mật khẩu',
      'STATE_VERSION_CONFLICT':
          'Trạng thái thiết bị đã thay đổi. Vui lòng thử lại',
      'DEVICE_FORBIDDEN': 'Bạn không có quyền truy cập thiết bị này',
      'CAMERA_UNAVAILABLE': 'Camera chưa có nguồn hình',
      'CAMERA_OFFLINE': 'Camera đang ngoại tuyến',
      'RECORDING_UNAVAILABLE': 'Không có bản ghi trong khoảng thời gian này',
      'RESOURCE_SESSION_LIMIT':
          'Đã đủ số người xem cùng lúc. Vui lòng thử lại sau',
      'RESOURCE_SESSION_INACTIVE': 'Phiên xem đã kết thúc',
      'MEDIA_RELAY_NOT_CONFIGURED': 'Máy chủ video chưa được cấu hình',
      'MEDIA_INGEST_UNAVAILABLE': 'Camera chưa kết nối được máy chủ video',
      'MEDIA_INGEST_FAILED': 'Camera chưa kết nối được máy chủ video',
      'MEDIA_INGEST_FORBIDDEN': 'Máy chủ video từ chối camera',
      'DEVICE_OPERATION_REJECTED': 'Thiết bị từ chối thao tác',
      'INVALID_INPUT': 'Dữ liệu thao tác không hợp lệ',
      // Account center
      'RATE_LIMITED': 'Bạn thao tác quá nhanh. Vui lòng thử lại sau',
      'ACCOUNT_NOT_FOUND': 'Không tìm thấy tài khoản',
      'ACCESS_TOKEN_REVOKED': 'Phiên đăng nhập đã kết thúc. Vui lòng đăng nhập lại',
      'INVALID_ACCESS_TOKEN': 'Phiên đăng nhập không hợp lệ. Vui lòng đăng nhập lại',
      'INVALID_PASSWORD': 'Mật khẩu không đúng',
      'PASSWORD_UNCHANGED': 'Mật khẩu mới phải khác mật khẩu hiện tại',
      'PASSWORD_CHANGED_CONCURRENTLY':
          'Mật khẩu vừa được đổi ở nơi khác. Vui lòng thử lại',
      'ACCOUNT_OWNS_DEVICES':
          'Bạn cần gỡ hết thiết bị mình sở hữu trước khi xóa tài khoản',
      // Rooms
      'ROOM_NAME_TAKEN': 'Bạn đã có phòng với tên này',
      'ROOM_LIMIT_REACHED': 'Bạn đã tạo đủ số phòng tối đa',
      'ROOM_NOT_FOUND': 'Phòng không còn tồn tại',
      'ROOM_ORDER_MISMATCH': 'Danh sách phòng vừa thay đổi. Vui lòng tải lại',
      // Scenes
      'SCENE_NOT_FOUND': 'Kịch bản không còn tồn tại',
      'SCENE_NAME_TAKEN': 'Bạn đã có kịch bản với tên này',
      'SCENE_LIMIT_REACHED': 'Bạn đã tạo đủ số kịch bản tối đa',
      'SCENE_TOO_MANY_STEPS': 'Kịch bản có quá nhiều bước',
      'SCENE_EMPTY': 'Kịch bản chưa có bước nào',
      'SCENE_ALREADY_RUNNING': 'Kịch bản này đang chạy',
      'SCENE_ACTION_NOT_ALLOWED': 'Thao tác này không dùng được trong kịch bản',
      'SCENE_ORDER_MISMATCH': 'Danh sách kịch bản vừa thay đổi. Vui lòng tải lại',
      'SCENE_RUN_NOT_FOUND': 'Không tìm thấy lần chạy này',
      'SCENE_STEP_FAILED': 'Không gửi được lệnh tới thiết bị',
      'SCENE_SCHEDULE_DUPLICATE': 'Kịch bản đã có lịch vào giờ và ngày này',
      'SCENE_SCHEDULE_LIMIT': 'Kịch bản đã có đủ số lịch tối đa',
      'SCENE_SCHEDULE_NOT_FOUND': 'Lịch hẹn giờ không còn tồn tại',
      'SCENE_PROTECTED_STEPS': 'Kịch bản có thao tác cần mật khẩu nên không thể chạy tự động',
      'SCENE_HAS_SCHEDULES': 'Hãy tắt hẹn giờ của kịch bản trước khi thêm thao tác cần mật khẩu',
      'SCENE_USED_BY_AUTOMATION': 'Kịch bản đang được tự động hóa dùng nên không thể thêm thao tác cần mật khẩu',
      'AUTOMATION_NAME_TAKEN': 'Đã có tự động hóa trùng tên',
      'AUTOMATION_LIMIT': 'Bạn đã tạo đủ số tự động hóa tối đa',
      'AUTOMATION_NOT_FOUND': 'Tự động hóa không còn tồn tại',
      'AUTOMATION_TRIGGER_INVALID': 'Điều kiện kích hoạt không còn dùng được, hãy chọn lại',
      'AUTOMATION_CONDITION_INVALID': 'Có điều kiện không còn dùng được, hãy chọn lại',
      'SUGGESTION_ALREADY_ADDED': 'Gợi ý này đã được thêm',
      'SUGGESTION_NOT_FOUND': 'Gợi ý không còn phù hợp với thiết bị của bạn',
      'INVALID_TIMEZONE': 'Múi giờ không hợp lệ',
      'INVALID_CURSOR': 'Danh sách đã thay đổi. Vui lòng tải lại',
      // Reasons a device operation ended without success
      'DEVICE_REMOVED': 'Thiết bị đã bị gỡ',
      'OPERATION_TIMEOUT': 'Thiết bị không phản hồi kịp',
      'OPERATION_TIMED_OUT': 'Thiết bị không phản hồi kịp',
      'OPERATION_REJECTED': 'Thiết bị từ chối thao tác',
      'OPERATION_FAILED': 'Thiết bị báo lỗi khi thực hiện',
      'OPERATION_CANCELLED': 'Thao tác đã bị hủy',
    };

    return errorMessages[errorCode] ?? 'Lỗi: $errorCode';
  }

  static String _cleanExceptionMessage(String message) {
    // Remove common prefixes
    message = message.replaceFirst(RegExp(r'^Exception:\s*'), '');
    message = message.replaceFirst(RegExp(r'^Error:\s*'), '');

    if (message.length > 100) {
      return 'Đã xảy ra lỗi. Vui lòng thử lại';
    }
    return message;
  }
}
