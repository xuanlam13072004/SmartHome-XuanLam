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

  /// Map known backend error codes to Vietnamese user messages.
  static String _mapBackendErrorCode(String errorCode) {
    const errorMessages = {
      'ACCOUNT_EXISTS': 'Tài khoản đã tồn tại',
      'EMAIL_EXISTS': 'Email đã được sử dụng',
      'USERNAME_EXISTS': 'Tên người dùng đã tồn tại',
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
      'UNSUPPORTED_COMMAND_ACTION': 'Lệnh không được hỗ trợ',
      'UNSUPPORTED_INSTANCE': 'Phiên bản capability không hợp lệ',
      'COMMAND_VALIDATION_FAILED': 'Giá trị lệnh không hợp lệ',
      'COMMAND_ARGUMENT_INVALID': 'Tham số lệnh không hợp lệ',
      'INSTANCE_REQUIRED': 'Cần chỉ định capability instance',
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
