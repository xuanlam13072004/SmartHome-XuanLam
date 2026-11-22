import '../../../core/utils/time_format.dart';
import '../../payments/data/payment_models.dart';
import 'assistant_models.dart';

/// What the assistant says in the chat about plans and orders made there.
/// The server writes the replies to messages; these are the app's own lines.
abstract final class ChatTexts {
  static String offerFromList(PlanOffer offer) {
    final prices = offer.prices.map((price) => '${price.months} tháng ${formatVnd(price.amount)}').join(', ');
    final terms = offer.prices.map((price) => '${price.months} tháng').join(' hay ');
    return 'Gói ${offer.planName}: $prices. Bạn muốn mua $terms?';
  }

  static const offerDismissed = 'Được, khi nào cần nâng cấp bạn cứ nhắn mình nhé.';

  static String orderCreated(PaymentOrder order) => order.mock
      ? 'Đã tạo đơn ${order.code}: gói ${order.planName} ${order.months} tháng, ${formatVnd(order.amount)}. '
          'Đây là chế độ thử nghiệm, không chuyển tiền thật: bấm "Giả lập đã thanh toán" để thử.'
      : 'Đây là mã thanh toán gói ${order.planName} ${order.months} tháng. Quét mã QR bằng ứng dụng ngân hàng '
          'để chuyển ${formatVnd(order.amount)}, mình sẽ báo ngay khi nhận được tiền.';

  /// What to say when an order changes; null when nothing worth saying changed.
  static String? orderChanged(PaymentOrder before, PaymentOrder after) {
    if (before.status == after.status && before.received == after.received) return null;
    switch (after.status) {
      case 'paid':
        final until = after.planExpiresAt == null ? '' : ' đến ${TimeFormat.date(after.planExpiresAt!)}';
        return 'Thanh toán thành công! Mình đã nhận ${formatVnd(after.received)}, '
            'gói ${after.planName} đã được kích hoạt$until.';
      case 'review':
        return 'Mình mới nhận ${formatVnd(after.received)}, còn thiếu ${formatVnd(after.amount - after.received)}. '
            'Bạn chuyển nốt phần còn lại với cùng nội dung nhé, mã QR đã được cập nhật.';
      case 'expired':
        return 'Mã QR của đơn ${after.code} đã hết hạn mà mình chưa nhận được tiền. Nếu bạn đã chuyển khoản đúng '
            'nội dung, gói vẫn được kích hoạt khi tiền đến; nếu chưa, bấm "Tạo mã mới".';
      case 'cancelled':
        return 'Đã hủy đơn ${after.code}.';
      default:
        return null;
    }
  }
}
