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
      final errorCode = data['error'] as String?;
      final message = data['message'] as String?;

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
      'INVALID_CREDENTIALS': 'Email hoặc mật khẩu không đúng',
      'ACCOUNT_LOCKED': 'Tài khoản đã bị khoá',
      'SESSION_NOT_FOUND': 'Phiên đăng nhập không hợp lệ',
      'TOKEN_EXPIRED': 'Phiên đăng nhập đã hết hạn',
      'TOKEN_INVALID': 'Token không hợp lệ',
      'DEVICE_NOT_FOUND': 'Không tìm thấy thiết bị',
      'NOT_DEVICE_OWNER': 'Bạn không phải chủ sở hữu thiết bị này',
      'DEVICE_OFFLINE': 'Thiết bị đang ngoại tuyến',
      'UNSUPPORTED_COMMAND_ACTION': 'Lệnh không được hỗ trợ',
      'UNSUPPORTED_INSTANCE': 'Phiên bản capability không hợp lệ',
      'COMMAND_VALIDATION_FAILED': 'Giá trị lệnh không hợp lệ',
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
